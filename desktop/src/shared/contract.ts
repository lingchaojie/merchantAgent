// Shared IPC contract — the single source of truth for the main↔renderer bridge.
// Imported by main (handlers), preload (exposeInMainWorld), and renderer (typed
// window.agent). Changing a shape here surfaces as a compile error on every side.

/** Principal returned by the backend on login. */
export interface Principal {
  TenantID: string;
  UserID: string;
  DisplayName: string;
}

/** A streamed step of one chat turn (mirrors Go runtime.Event + SSE control). */
export interface ChatEvent {
  kind:
    | "assistant" // interim assistant text
    | "tool_call" // model invoked a tool
    | "tool_result" // tool returned data
    | "skill_loaded" // a skill's playbook was loaded (progressive disclosure)
    | "denied" // guard refused a tool
    | "final" // final assistant text
    | "done" // stream complete
    | "error" // turn failed
    | "file_request" // (M4b) backend asks the client to read/write a local file
    | "local_tool_request" // backend asks Electron main to execute a verified local tool
    | "tool_state"; // local tool execution state
  text?: string;
  tool?: string;
  data?: Record<string, unknown>;
  error?: string;
  // file_request fields (M4b reverse bridge): the backend asks the client to
  // read/write a local file; the main process handles it via fsguard.
  reqId?: string;
  op?: "read" | "write";
  path?: string;
  content?: string;
}

export interface LocalToolRequest {
  reqId: string;
  packageId: string;
  packageVersion: string;
  manifestDigest: string;
  tool: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  roleIds: string[];
  skillId: string;
  callId: string;
  idempotencyKey: string;
  risk: "read" | "low_write" | "high_write";
  requiresConfirmation: boolean;
  args: Record<string, unknown>;
}

export interface ExecutionMeta {
  status: "succeeded" | "failed" | "cancelled" | "source_conflict" | "unknown";
  executionId: string;
  idempotencyKey: string;
  confirmed: boolean;
  confirmedAt?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface LocalToolResponse {
  data?: Record<string, unknown>;
  meta: ExecutionMeta;
  error?: string;
}

/** Request payload for a chat turn. */
export interface ChatReq {
  sessionId: string;
  userId: string;
  question: string;
}

/** Generic admin request — proxied to agentd's /admin/* with X-User-Id injected. */
export interface AdminReq {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // e.g. "/admin/roles" or "/admin/skills/order360"
  userId: string; // current identity → injected as X-User-Id by main
  body?: unknown;
}
export type AdminResp =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string };

/** The API surface exposed to the renderer via contextBridge (window.agent). */
export interface AgentAPI {
  login(userId: string): Promise<Principal>;
  /** Streams events via onEvent; resolves to the final answer text. */
  chat(req: ChatReq, onEvent: (e: ChatEvent) => void): Promise<string>;
  readFile(rel: string): Promise<string>;
  writeFile(rel: string, contents: string, confirmed: boolean): Promise<string>;
  admin(req: AdminReq): Promise<AdminResp>;
}

/** IPC channel names — one place, referenced by main + preload. */
export const Channels = {
  login: "agent:login",
  chat: "agent:chat",
  chatEventPrefix: "agent:chat:event:", // + streamId (main→renderer stream)
  fsRead: "fs:read",
  fsWrite: "fs:write",
  admin: "agent:admin",
} as const;

// Request payload shapes (what preload sends, what main handlers receive).
export interface LoginReq { userId: string }
export interface ChatIpcReq { streamId: string; req: ChatReq }
export interface FsReadReq { rel: string }
export interface FsWriteReq { rel: string; contents: string; confirmed: boolean }
