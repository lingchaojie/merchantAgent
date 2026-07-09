// Shared IPC contract — the single source of truth for the main↔renderer bridge.
// Imported by main (handlers), preload (exposeInMainWorld), and renderer (typed
// window.agent). Changing a shape here surfaces as a compile error on every side.

/** Principal returned by the backend on login. */
export interface Principal {
  TenantID: string;
  UserID: string;
  DisplayName: string;
}

/** Answer from the agent runtime (mirrors Go runtime.Answer JSON). */
export interface Answer {
  text: string;
  tool?: string;
  data?: Record<string, unknown>;
  denied?: boolean;
}

/** The API surface exposed to the renderer via contextBridge (window.agent). */
export interface AgentAPI {
  login(userId: string): Promise<Principal>;
  ask(tenantId: string, userId: string, question: string): Promise<Answer>;
  readFile(rel: string): Promise<string>;
  writeFile(rel: string, contents: string, confirmed: boolean): Promise<string>;
}

/** IPC channel names — one place, referenced by main + preload. */
export const Channels = {
  login: "agent:login",
  ask: "agent:ask",
  fsRead: "fs:read",
  fsWrite: "fs:write",
} as const;

// Request payload shapes (what preload sends, what main handlers receive).
export interface LoginReq { userId: string }
export interface AskReq { tenantId: string; userId: string; question: string }
export interface FsReadReq { rel: string }
export interface FsWriteReq { rel: string; contents: string; confirmed: boolean }
