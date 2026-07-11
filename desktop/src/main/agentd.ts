// Bridge to the Go backend (agentd). Mirrors the Cursor model: an Electron shell
// (thin client) driving a cloud/loopback agentd that owns orchestration/authz.
// Chat is streamed over SSE; login is a plain POST.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import type {
  ChatEvent,
  ChatReq,
  LocalToolRequest,
  LocalToolResponse,
  Principal,
} from "../shared/contract";

// Use "localhost" (not the 127.0.0.1 IPv4 literal): when agentd runs in WSL2,
// Windows' localhost relay is often IPv6-only (::1), and Node's fetch
// (autoSelectFamily) will pick the family that connects. Resolves to 127.0.0.1
// for a native-Windows agentd too, so this is strictly more portable.
const BASE = process.env.AGENTD_URL || "http://localhost:8765";

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
export type LocalToolRequestHandler = (request: LocalToolRequest) => Promise<LocalToolResponse>;

// chat opens the SSE stream, forwards renderer-safe events to onEvent, handles
// privileged reverse-bridge requests locally, and resolves with the final text.
async function chat(
  req: ChatReq,
  onEvent: (e: ChatEvent) => void,
  onFile?: FileRequestHandler,
  onLocalTool?: LocalToolRequestHandler,
): Promise<string> {
  const deviceId = os.hostname();
  const res = await fetch(BASE + "/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...req, deviceId }),
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
      if (ev.kind === "local_tool_request") {
        const request = { ...(ev as unknown as LocalToolRequest), deviceId };
        let out: LocalToolResponse;
        try {
          out = onLocalTool
            ? await onLocalTool(request)
            : {
                meta: {
                  status: "failed",
                  executionId: crypto.randomUUID(),
                  idempotencyKey: request.idempotencyKey,
                  confirmed: false,
                },
                error: "local tools unavailable",
              };
        } catch (error) {
          out = {
            meta: {
              status: "failed",
              executionId: crypto.randomUUID(),
              idempotencyKey: request.idempotencyKey,
              confirmed: false,
            },
            error: error instanceof Error ? error.message : String(error),
          };
        }
        await post("/chat/local-tool-result", {
          reqId: request.reqId,
          data: out.data ?? {},
          meta: out.meta,
          error: out.error ?? "",
        });
        continue;
      }
      onEvent(ev);
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

// adminRequest proxies a renderer admin call to agentd's /admin/* API, injecting
// the caller's identity as X-User-Id (requireAdmin gates on the backend). Returns
// a discriminated result: parsed JSON on 2xx, or {ok:false,status,error} otherwise.
async function adminRequest(req: {
  method: string; path: string; userId: string; body?: unknown;
}): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  let res: Response;
  try {
    res = await fetch(BASE + req.path, {
      method: req.method,
      headers: { "content-type": "application/json", "x-user-id": req.userId },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
  } catch (e) {
    // Network failure (agentd down, or WSL IPv6 localhost-relay flakiness). Return
    // a typed error so it crosses the IPC bridge as an AdminResp, never a throw.
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
  const text = await res.text().catch(() => "");
  let parsed: unknown = undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* non-json */ }
  if (!res.ok) {
    const error = (parsed && typeof parsed === "object" && "error" in parsed)
      ? String((parsed as { error: unknown }).error) : text;
    return { ok: false, status: res.status, error };
  }
  return { ok: true, status: res.status, data: parsed };
}

export const client = {
  base: BASE,
  login: (userId: string) => post<Principal>("/login", { userId }),
  chat,
  adminRequest,
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
