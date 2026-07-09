// Bridge to the Go backend (agentd). Mirrors the Codex model: an Electron shell
// driving a compiled backend. Connect to a running agentd (AGENTD_URL) or spawn
// the binary (AGENTD_BIN).
import { spawn, type ChildProcess } from "node:child_process";
import type { Answer, Principal } from "../shared/contract";

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

export const client = {
  base: BASE,
  login: (userId: string) => post<Principal>("/login", { userId }),
  ask: (tenantId: string, userId: string, question: string) =>
    post<Answer>("/ask", { tenantId, userId, question }),
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
