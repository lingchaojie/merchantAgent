// Bridge to the Go backend (agentd). Mirrors the Cursor model: an Electron shell
// (thin client) driving a cloud/loopback agentd that owns orchestration/authz.
// Chat is streamed over SSE; login is a plain POST.
import { spawn, type ChildProcess } from "node:child_process";
import type { ChatEvent, ChatReq, Principal } from "../shared/contract";

const BASE = process.env.AGENTD_URL || "http://127.0.0.1:8765";

async function post<T>(pathname: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agentd ${pathname} ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

// FileRequestHandler executes a backend file_request on the client (fsguard),
// returning the read content or a write confirmation (or an error string).
export type FileRequestHandler = (e: ChatEvent) => Promise<{ content?: string; error?: string }>;

// chat opens the SSE stream, forwards each event to onEvent, handles file_request
// events via onFile (M4b reverse bridge), and resolves with the final answer text.
async function chat(
  req: ChatReq,
  onEvent: (e: ChatEvent) => void,
  onFile?: FileRequestHandler,
): Promise<string> {
  const res = await fetch(BASE + "/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`agentd /chat ${res.status}: ${text}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const ev = parseSSE(block);
      if (!ev) continue;
      if (ev.kind === "error") throw new Error(ev.error || "agentd chat error");
      if (ev.kind === "done" || ev.kind === "final") {
        if (ev.text) final = ev.text;
      }
      onEvent(ev); // always surface to the UI
      if (ev.kind === "file_request" && ev.reqId) {
        // Execute the file op on the client and post the result back so the
        // blocked backend tool resumes. If no handler, report unavailable.
        const out = onFile ? await onFile(ev) : { error: "local files unavailable" };
        await post("/chat/file-result", { reqId: ev.reqId, content: out.content ?? "", error: out.error ?? "" });
      }
    }
  }
  return final;
}

// parseSSE turns one "event: X\ndata: {json}" block into a ChatEvent. Exported
// for tests.
export function parseSSE(block: string): ChatEvent | null {
  let kind = "";
  let dataLine = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) kind = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (!kind) return null;
  let payload: Record<string, unknown> = {};
  if (dataLine) {
    try {
      payload = JSON.parse(dataLine) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  return { ...(payload as object), kind } as ChatEvent;
}

export const client = {
  base: BASE,
  login: (userId: string) => post<Principal>("/login", { userId }),
  chat,
};

// spawnAgentd optionally launches the Go binary; returns the child (or null if
// AGENTD_BIN unset → assume an external agentd is already running).
export function spawnAgentd(): ChildProcess | null {
  const bin = process.env.AGENTD_BIN;
  if (!bin) return null;
  const child = spawn(bin, [], {
    env: { ...process.env, ADDR: BASE.replace(/^https?:\/\//, "") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[agentd] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[agentd] ${d}`));
  return child;
}
