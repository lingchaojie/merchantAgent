// Bridge to the Go backend (agentd). Mirrors the Cursor model: an Electron shell
// (thin client) driving a cloud/loopback agentd that owns orchestration/authz.
// Chat is streamed over SSE; login is a plain POST.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import type {
  ChatEvent,
  ChatReq,
  LocalToolRequest,
  LocalToolResponse,
  Principal,
} from "../shared/contract";
import type { ApprovalResolver } from "./connectors/runtime";
import type { ConnectorSigningIdentity } from "./connectors/device-identity";
import type { InstalledConnector } from "./connectors/package-store";
import { parseInstalledConnectorEnvelope } from "./connectors/schema";

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
export interface ChatDeviceOptions { connectorDeviceId?: string }

// chat opens the SSE stream, forwards renderer-safe events to onEvent, handles
// privileged reverse-bridge requests locally, and resolves with the final text.
async function chat(
  req: ChatReq,
  onEvent: (e: ChatEvent) => void,
  onFile?: FileRequestHandler,
  onLocalTool?: LocalToolRequestHandler,
  deviceOptions: ChatDeviceOptions = {},
): Promise<string> {
  const referenceDeviceId = os.hostname();
  const connectorDeviceId = typeof deviceOptions.connectorDeviceId === "string"
    && deviceOptions.connectorDeviceId.length > 0
    ? deviceOptions.connectorDeviceId
    : referenceDeviceId;
  const res = await fetch(BASE + "/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...req, deviceId: referenceDeviceId }),
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
        const eventRequest = ev as unknown as LocalToolRequest;
        const request = {
          ...eventRequest,
          deviceId: eventRequest.packageId === "reference-manufacturing"
            ? referenceDeviceId
            : connectorDeviceId,
        };
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
        try {
          await post("/chat/local-tool-result", {
            reqId: request.reqId,
            data: out.data ?? {},
            meta: out.meta,
            error: out.error ?? "",
          });
        } catch {
          // The SSE stream owns the authoritative terminal state. A lost or
          // expired acknowledgement must not hide a later backend error/done.
        }
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

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const APPROVAL_KEYS = new Set(["connectorId", "version", "digest", "status"]);
const SUBMISSION_RESPONSE_KEYS = new Set([
  "tenantId", "connectorId", "version", "digest", "adapter", "environment", "contract", "checks",
  "implementationCredentialId", "deviceId", "submittedBy", "approvedBy", "status", "createdAt", "updatedAt",
]);

function exactRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error("connector_response_invalid");
  }
  return value as Record<string, unknown>;
}

async function getConnectorApproval(
  tenantId: string,
  userId: string,
  connectorId: string,
  version: string,
): ReturnType<ApprovalResolver["getApproval"]> {
  if ([tenantId, userId, connectorId, version].some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("approval_unavailable");
  }
  let response: Response;
  try {
    response = await fetch(
      `${BASE}/connectors/${encodeURIComponent(connectorId)}/versions/${encodeURIComponent(version)}/approval`,
      { headers: { "x-user-id": userId } },
    );
  } catch {
    throw new Error("approval_unavailable");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("approval_unavailable");
  try {
    const raw = exactRecord(JSON.parse(await response.text()), APPROVAL_KEYS);
    if (
      Object.keys(raw).length !== APPROVAL_KEYS.size
      || raw.connectorId !== connectorId
      || raw.version !== version
      || typeof raw.digest !== "string"
      || !DIGEST.test(raw.digest)
      || !["pending_admin_approval", "published", "suspended", "revoked"].includes(raw.status as string)
    ) {
      throw new Error();
    }
    return {
      digest: raw.digest,
      status: raw.status as "pending_admin_approval" | "published" | "suspended" | "revoked",
    };
  } catch {
    throw new Error("approval_unavailable");
  }
}

export interface ConnectorSubmissionBody {
  version: Record<string, unknown>;
  signedAt: string;
  implementationSignature: string;
}

async function submitConnector(
  encodedCredential: string,
  body: ConnectorSubmissionBody,
): Promise<{ digest: string; status: "pending_admin_approval" }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/implementation/connectors`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Implementation ${encodedCredential}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("connector_submit_failed");
  }
  if (!response.ok) throw new Error("connector_submit_failed");
  try {
    const raw = exactRecord(JSON.parse(await response.text()), SUBMISSION_RESPONSE_KEYS);
    if (
      typeof raw.digest !== "string"
      || !DIGEST.test(raw.digest)
      || raw.status !== "pending_admin_approval"
    ) {
      throw new Error();
    }
    return { digest: raw.digest, status: "pending_admin_approval" };
  } catch {
    throw new Error("connector_submit_failed");
  }
}

export async function submitInstalledConnector(
  installed: InstalledConnector,
  identity: ConnectorSigningIdentity,
): Promise<{ digest: string; status: "pending_admin_approval" }> {
  let envelope;
  try {
    envelope = parseInstalledConnectorEnvelope(JSON.parse(fs.readFileSync(installed.path, "utf8")));
  } catch {
    throw new Error("connector_submit_failed");
  }
  const manifest = installed.manifest;
  if (
    envelope.manifest.connectorId !== manifest.connectorId
    || envelope.manifest.version !== manifest.version
    || envelope.manifest.digest !== manifest.digest
    || envelope.implementationCredential !== identity.implementationCredential
  ) {
    throw new Error("connector_submit_failed");
  }
  const tools = manifest.publicContract.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    execution: "desktop",
    resourceType: tool.resourceType,
    resourceKind: tool.resourceKind,
    resourceArg: tool.resourceArg,
    resourceRelation: tool.resourceRelation,
    dataDomain: tool.dataDomain,
    params: Object.entries(tool.parameters.properties).map(([name, property]) => ({
      name,
      description: name,
      type: property.type,
      required: tool.parameters.required.includes(name),
      ...(property.minLength === undefined ? {} : { minLength: property.minLength }),
      ...(property.maxLength === undefined ? {} : { maxLength: property.maxLength }),
      ...(property.minimum === undefined ? {} : { minimum: property.minimum }),
      ...(property.maximum === undefined ? {} : { maximum: property.maximum }),
      ...(property.enum === undefined ? {} : { enum: property.enum }),
    })),
    resultFields: tool.resultFields,
    risk: tool.risk,
    requiresConfirmation: tool.requiresConfirmation,
    timeoutMS: tool.timeoutMS,
    maxResults: tool.maxResults,
  }));
  return client.submitConnector(identity.implementationCredential, {
    version: {
      tenantId: identity.tenantId,
      connectorId: manifest.connectorId,
      version: manifest.version,
      digest: manifest.digest,
      adapter: manifest.adapter,
      environment: manifest.environment,
      contract: { tools },
      checks: manifest.checks,
      implementationCredentialId: manifest.credentialId,
      deviceId: manifest.deviceId,
    },
    signedAt: manifest.signedAt,
    implementationSignature: envelope.implementationSignature,
  });
}

export const client = {
  base: BASE,
  login: (userId: string) => post<Principal>("/login", { userId }),
  chat,
  adminRequest,
  getConnectorApproval,
  submitConnector,
};

// spawnAgentd optionally launches the Go binary and waits until the OS confirms
// the process spawned. AGENTD_BIN unset means an external agentd is in use.
export async function spawnAgentd(): Promise<ChildProcess | null> {
  const bin = process.env.AGENTD_BIN;
  if (!bin) return null;
  const child = spawn(bin, [], {
    env: { ...process.env, ADDR: BASE.replace(/^https?:\/\//, "") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[agentd] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[agentd] ${d}`));
  child.on("error", (error) => console.error("[agentd] process error", error));
  return new Promise<ChildProcess>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onStartupError);
      resolve(child);
    };
    const onStartupError = (error: Error): void => {
      child.off("spawn", onSpawn);
      try {
        child.kill();
      } catch {
        // Preserve the spawn error after best-effort child cleanup.
      }
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onStartupError);
  });
}
