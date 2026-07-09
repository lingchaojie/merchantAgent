import { describe, it, expect, vi, afterEach } from "vitest";
import { parseSSE, client } from "./agentd";
import type { ChatEvent } from "../shared/contract";

describe("parseSSE", () => {
  it("parses an event block into a ChatEvent (event line = kind)", () => {
    const ev = parseSSE('event: tool_call\ndata: {"kind":"tool_call","tool":"query_order_status","data":{"orderId":"SO-1001"}}');
    expect(ev).toMatchObject({ kind: "tool_call", tool: "query_order_status" });
    expect(ev?.data).toEqual({ orderId: "SO-1001" });
  });

  it("returns null when no event line", () => {
    expect(parseSSE("data: {}")).toBeNull();
  });

  it("tolerates malformed data json", () => {
    expect(parseSSE("event: done\ndata: not-json")).toMatchObject({ kind: "done" });
  });
});

// Build a Response-like whose body streams the given SSE text in chunks, to
// exercise the reader loop + \n\n framing across chunk boundaries.
function sseResponse(text: string, chunkSize = 7): Response {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  let pos = 0;
  const body = {
    getReader() {
      return {
        read(): Promise<{ done: boolean; value?: Uint8Array }> {
          if (pos >= bytes.length) return Promise.resolve({ done: true });
          const chunk = bytes.slice(pos, pos + chunkSize);
          pos += chunkSize;
          return Promise.resolve({ done: false, value: chunk });
        },
      };
    },
  };
  return { ok: true, body } as unknown as Response;
}

describe("client.chat streaming", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards events and resolves with the final text", async () => {
    const stream =
      'event: tool_call\ndata: {"kind":"tool_call","tool":"query_order_status"}\n\n' +
      'event: tool_result\ndata: {"kind":"tool_result","tool":"query_order_status","data":{"status":"生产中"}}\n\n' +
      'event: final\ndata: {"kind":"final","text":"订单进行中"}\n\n' +
      'event: done\ndata: {"text":"订单进行中"}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(stream)));

    const got: ChatEvent[] = [];
    const final = await client.chat({ sessionId: "s", userId: "u_sales1", question: "SO-1001 进度" }, (e) => got.push(e));

    expect(final).toBe("订单进行中");
    expect(got.map((e) => e.kind)).toEqual(["tool_call", "tool_result", "final", "done"]);
    expect(got[1].data).toEqual({ status: "生产中" });
  });

  it("throws on an error event", async () => {
    const stream = 'event: error\ndata: {"error":"boom"}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(stream)));
    await expect(
      client.chat({ sessionId: "s", userId: "u", question: "q" }, () => {}),
    ).rejects.toThrow("boom");
  });

  it("handles a file_request: runs onFile and POSTs the result back", async () => {
    const stream =
      'event: file_request\ndata: {"kind":"file_request","reqId":"r1","op":"read","path":"notes.txt"}\n\n' +
      'event: done\ndata: {"text":"读完了"}\n\n';
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts?: { body?: string }) => {
        if (String(url).endsWith("/chat/file-result")) {
          posted = JSON.parse(opts?.body ?? "{}");
          return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
        }
        return sseResponse(stream);
      }),
    );

    const onFile = vi.fn().mockResolvedValue({ content: "待办清单" });
    const final = await client.chat(
      { sessionId: "s", userId: "u", question: "读 notes.txt" },
      () => {},
      onFile,
    );

    expect(final).toBe("读完了");
    expect(onFile).toHaveBeenCalledOnce();
    expect(posted).toMatchObject({ reqId: "r1", content: "待办清单" });
  });
});
