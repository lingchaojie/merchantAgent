import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
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

  it("handles a local_tool_request in main and posts its structured result", async () => {
    const stream =
      'event: local_tool_request\ndata: {"kind":"local_tool_request","reqId":"local-1","packageId":"reference-manufacturing","packageVersion":"1.0.0","manifestDigest":"sha256:digest","tool":"query_order_status","tenantId":"mock-corp-001","userId":"u_sales1","deviceId":"renderer-spoof","roleIds":["sales"],"skillId":"order-360","callId":"call-1","idempotencyKey":"idem-1","risk":"read","requiresConfirmation":false,"args":{"orderId":"SO-1001"}}\n\n' +
      'event: done\ndata: {"text":"查询完成"}\n\n';
    const posted: Record<string, unknown>[] = [];
    let chatBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts?: { body?: string }) => {
        const body = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>;
        if (String(url).endsWith("/chat/local-tool-result")) {
          posted.push(body);
          return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
        }
        chatBody = body;
        return sseResponse(stream);
      }),
    );
    const onEvent = vi.fn();
    const onLocalTool = vi.fn().mockResolvedValue({
      data: { orderId: "SO-1001", status: "生产中" },
      meta: {
        status: "succeeded",
        executionId: "exec-1",
        idempotencyKey: "idem-1",
        confirmed: false,
      },
    });

    const final = await client.chat(
      { sessionId: "s", userId: "u_sales1", question: "查询订单" },
      onEvent,
      undefined,
      onLocalTool,
    );

    expect(final).toBe("查询完成");
    expect(chatBody).toMatchObject({ deviceId: os.hostname() });
    expect(onLocalTool).toHaveBeenCalledOnce();
    expect(onLocalTool).toHaveBeenCalledWith(expect.objectContaining({
      reqId: "local-1",
      deviceId: os.hostname(),
      idempotencyKey: "idem-1",
    }));
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "done" }));
    expect(posted).toEqual([{
      reqId: "local-1",
      data: { orderId: "SO-1001", status: "生产中" },
      meta: {
        status: "succeeded",
        executionId: "exec-1",
        idempotencyKey: "idem-1",
        confirmed: false,
      },
      error: "",
    }]);
  });

  it("preserves backend connector identity and binds reference tools to the hostname", async () => {
    const stream =
      'event: local_tool_request\ndata: {"kind":"local_tool_request","reqId":"connector-1","packageId":"sql-orders","packageVersion":"1.0.0","manifestDigest":"sha256:digest","tool":"query_order_status","tenantId":"mock-corp-001","userId":"u_sales1","deviceId":"backend-value","roleIds":["sales"],"skillId":"order-360","callId":"call-connector","idempotencyKey":"idem-connector","risk":"read","requiresConfirmation":false,"args":{"orderId":"SO-1001"}}\n\n' +
      'event: local_tool_request\ndata: {"kind":"local_tool_request","reqId":"reference-1","packageId":"reference-manufacturing","packageVersion":"1.0.0","manifestDigest":"sha256:digest","tool":"query_order_status","tenantId":"mock-corp-001","userId":"u_sales1","deviceId":"backend-value","roleIds":["sales"],"skillId":"order-360","callId":"call-reference","idempotencyKey":"idem-reference","risk":"read","requiresConfirmation":false,"args":{"orderId":"SO-1001"}}\n\n' +
      'event: done\ndata: {"text":"done"}\n\n';
    let chatBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts?: { body?: string }) => {
      if (String(url).endsWith("/chat/local-tool-result")) {
        return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
      }
      chatBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>;
      return sseResponse(stream);
    }));
    const connectorRuntime = vi.fn().mockResolvedValue({
      data: { rows: [{ orderId: "SO-1001" }] },
      meta: { status: "succeeded", executionId: "exec", idempotencyKey: "idem-connector", confirmed: false },
    });

    await client.chat(
      { sessionId: "s", userId: "u_sales1", question: "status" },
      () => undefined,
      undefined,
      connectorRuntime,
      { connectorDeviceId: "desktop-option-must-not-rewrite" },
    );

    expect(chatBody).toMatchObject({ deviceId: os.hostname() });
    expect(connectorRuntime).toHaveBeenCalledWith(expect.objectContaining({
      packageId: "sql-orders",
      deviceId: "backend-value",
    }));
    expect(connectorRuntime).toHaveBeenCalledWith(expect.objectContaining({
      packageId: "reference-manufacturing",
      deviceId: os.hostname(),
    }));
  });

  it("posts a failed local result when the local handler throws and keeps reading", async () => {
    const stream =
      'event: local_tool_request\ndata: {"kind":"local_tool_request","reqId":"local-2","packageId":"reference-manufacturing","packageVersion":"1.0.0","manifestDigest":"sha256:digest","tool":"query_order_status","tenantId":"mock-corp-001","userId":"u_sales1","deviceId":"ignored","roleIds":["sales"],"skillId":"order-360","callId":"call-2","idempotencyKey":"idem-2","risk":"read","requiresConfirmation":false,"args":{"orderId":"SO-1001"}}\n\n' +
      'event: done\ndata: {"text":"本地执行失败"}\n\n';
    let posted: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts?: { body?: string }) => {
        if (String(url).endsWith("/chat/local-tool-result")) {
          posted = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>;
          return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
        }
        return sseResponse(stream);
      }),
    );

    const final = await client.chat(
      { sessionId: "s", userId: "u_sales1", question: "查询订单" },
      () => {},
      undefined,
      async () => { throw new Error("handler boom"); },
    );

    expect(final).toBe("本地执行失败");
    expect(posted).toMatchObject({
      reqId: "local-2",
      data: {},
      meta: {
        status: "failed",
        executionId: expect.any(String),
        idempotencyKey: "idem-2",
        confirmed: false,
      },
      error: "handler boom",
    });
  });

  it("keeps reading through done when the local result POST is rejected", async () => {
    const stream =
      'event: local_tool_request\ndata: {"reqId":"local-network","packageId":"reference-manufacturing","packageVersion":"1.0.0","manifestDigest":"sha256:digest","tool":"query_order_status","tenantId":"mock-corp-001","userId":"u_sales1","deviceId":"ignored","roleIds":["sales"],"skillId":"order-360","callId":"call-network","idempotencyKey":"idem-network","risk":"read","requiresConfirmation":false,"args":{"orderId":"SO-1001"}}\n\n' +
      'event: done\ndata: {"text":"流继续完成"}\n\n';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/chat/local-tool-result")) throw new Error("network unavailable");
        return sseResponse(stream);
      }),
    );
    const onEvent = vi.fn();

    const final = await client.chat(
      { sessionId: "s", userId: "u_sales1", question: "查询订单" },
      onEvent,
      undefined,
      async () => ({
        data: { orderId: "SO-1001" },
        meta: {
          status: "succeeded",
          executionId: "exec-network",
          idempotencyKey: "idem-network",
          confirmed: false,
        },
      }),
    );

    expect(final).toBe("流继续完成");
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "done" }));
  });

  it("surfaces a later backend error instead of a local result POST non-2xx", async () => {
    const stream =
      'event: local_tool_request\ndata: {"reqId":"local-expired","packageId":"reference-manufacturing","packageVersion":"1.0.0","manifestDigest":"sha256:digest","tool":"query_order_status","tenantId":"mock-corp-001","userId":"u_sales1","deviceId":"ignored","roleIds":["sales"],"skillId":"order-360","callId":"call-expired","idempotencyKey":"idem-expired","risk":"read","requiresConfirmation":false,"args":{"orderId":"SO-1001"}}\n\n' +
      'event: error\ndata: {"error":"backend request expired"}\n\n';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/chat/local-tool-result")) {
          return {
            ok: false,
            status: 404,
            text: async () => "unknown or expired reqId",
          } as unknown as Response;
        }
        return sseResponse(stream);
      }),
    );

    await expect(client.chat(
      { sessionId: "s", userId: "u_sales1", question: "查询订单" },
      () => {},
      undefined,
      async () => ({
        data: { orderId: "SO-1001" },
        meta: {
          status: "succeeded",
          executionId: "exec-expired",
          idempotencyKey: "idem-expired",
          confirmed: false,
        },
      }),
    )).rejects.toThrow("backend request expired");
  });

  it("keeps reading when a successful local result POST has malformed JSON", async () => {
    const stream =
      'event: local_tool_request\ndata: {"reqId":"local-json","packageId":"reference-manufacturing","packageVersion":"1.0.0","manifestDigest":"sha256:digest","tool":"query_order_status","tenantId":"mock-corp-001","userId":"u_sales1","deviceId":"ignored","roleIds":["sales"],"skillId":"order-360","callId":"call-json","idempotencyKey":"idem-json","risk":"read","requiresConfirmation":false,"args":{"orderId":"SO-1001"}}\n\n' +
      'event: done\ndata: {"text":"解析失败后完成"}\n\n';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/chat/local-tool-result")) {
          return { ok: true, json: async () => { throw new SyntaxError("bad json"); } } as unknown as Response;
        }
        return sseResponse(stream);
      }),
    );

    const final = await client.chat(
      { sessionId: "s", userId: "u_sales1", question: "查询订单" },
      () => {},
      undefined,
      async () => ({
        data: { orderId: "SO-1001" },
        meta: {
          status: "succeeded",
          executionId: "exec-json",
          idempotencyKey: "idem-json",
          confirmed: false,
        },
      }),
    );

    expect(final).toBe("解析失败后完成");
  });
});
