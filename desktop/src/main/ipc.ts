// IPC handlers: the ONLY bridge between the sandboxed renderer and privileged
// main-process capabilities. Every channel is explicit (whitelist); the renderer
// has no Node access (see index.ts webPreferences + preload). Types come from
// the shared contract, so a mismatch is a compile error.
import { ipcMain, dialog } from "electron";
import { Sandbox } from "./fsguard";
import { client } from "./agentd";
import type { LocalToolExecutor } from "./local-tools/executor";
import type { WorkbenchService } from "./connectors/workbench-service";
import {
  WorkbenchChannels,
  type WorkbenchCredentialReq,
  type WorkbenchDraftIdReq,
  type WorkbenchDraftReq,
  type WorkbenchOperationReq,
  type WorkbenchResultReq,
  type WorkbenchSessionReq,
  type WorkbenchUnlockReq,
} from "../shared/connector-contract";
import {
  Channels,
  type ChatEvent,
  type ChatIpcReq,
  type LoginReq,
  type FsReadReq,
  type FsWriteReq,
  type AdminReq,
  type AdminResp,
  type LocalToolRequest,
  type LocalToolResponse,
} from "../shared/contract";

const DEFAULT_LOCAL_TOOL_CONFIRMATION_TIMEOUT_MS = 105_000;

function closedWorkbenchRequest(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workbench_invalid_request");
  }
  const prototype = Object.getPrototypeOf(value);
  const actual = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error("workbench_invalid_request");
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("workbench_invalid_request");
    }
    result[key] = descriptor.value;
  }
  return result;
}

export interface IpcRegistrationOptions {
  localToolConfirmationTimeoutMs?: number;
  openWorkbench?: () => void | Promise<void>;
  connectorDeviceId?: string;
}

function confirmationDetail(preview: unknown): string {
  if (typeof preview !== "object" || preview === null || Array.isArray(preview)) return "Invalid preview";
  const value = preview as Record<string, unknown>;
  if (
    typeof value.orderId === "string"
    && typeof value.workOrderId === "string"
    && typeof value.before === "object"
    && value.before !== null
    && typeof value.proposed === "object"
    && value.proposed !== null
  ) {
    const before = value.before as Record<string, unknown>;
    const proposed = value.proposed as Record<string, unknown>;
    return [
      `订单：${value.orderId}`,
      `工单：${value.workOrderId}`,
      `完成率：${before.completionRate}% → ${proposed.completionRate}%`,
      `备注：${proposed.note || "（无）"}`,
    ].join("\n");
  }
  const before = Object.getOwnPropertyDescriptor(value, "before")?.value;
  const proposed = Object.getOwnPropertyDescriptor(value, "proposed")?.value;
  try {
    return JSON.stringify({ before, proposed }, null, 2);
  } catch {
    return "Invalid preview";
  }
}

// handleFileRequest executes a backend file_request on the client via fsguard.
// Reads are direct (path jail only); overwriting an existing file needs an
// explicit user confirmation dialog (design §2 — local files self-gate here).
async function handleFileRequest(sandbox: Sandbox, ev: ChatEvent): Promise<{ content?: string; error?: string }> {
  try {
    if (ev.op === "read") return { content: sandbox.read(ev.path ?? "") };
    if (ev.op === "write") {
      try {
        return { content: sandbox.write(ev.path ?? "", ev.content ?? "", false) };
      } catch (e) {
        if (!String(e).includes("overwrite requires confirmation")) throw e;
        const { response } = await dialog.showMessageBox({
          type: "warning",
          buttons: ["取消", "覆盖"],
          defaultId: 0,
          cancelId: 0,
          message: `Agent 请求覆盖本地文件：${ev.path}`,
          detail: "确认后将写入并覆盖已存在的文件。",
        });
        if (response !== 1) return { error: "用户取消了覆盖" };
        return { content: sandbox.write(ev.path ?? "", ev.content ?? "", true) };
      }
    }
    return { error: `unknown file op ${ev.op}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function handleLocalToolRequest(
  executor: LocalToolExecutor,
  request: LocalToolRequest,
  confirmationTimeoutMs: number,
): Promise<LocalToolResponse> {
  const response = await executor.execute(request, async (preview) => {
    const answer = dialog.showMessageBox({
      type: "warning",
      buttons: ["取消", "确认写入"],
      defaultId: 0,
      cancelId: 0,
      message: "确认更新生产进度",
      detail: confirmationDetail(preview),
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), confirmationTimeoutMs);
    });
    try {
      return await Promise.race([
        answer.then(({ response }) => response === 1, () => false),
        expired,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  });
  return {
    data: response.data ? { ...response.data } : undefined,
    meta: {
      ...response.meta,
      before: response.meta.before ? { ...response.meta.before } : undefined,
      after: response.meta.after ? { ...response.meta.after } : undefined,
    },
    error: response.error,
  };
}

export function register(
  sandbox: Sandbox,
  localToolExecutor: LocalToolExecutor,
  options: IpcRegistrationOptions = {},
): () => void {
  const installed: string[] = [];
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const channel of installed.reverse()) ipcMain.removeHandler(channel);
  };
  const install: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, listener);
    installed.push(channel);
  };
  const confirmationTimeoutMs =
    options.localToolConfirmationTimeoutMs ?? DEFAULT_LOCAL_TOOL_CONFIRMATION_TIMEOUT_MS;

  try {
    install(Channels.login, (_e, req: LoginReq) => client.login(req.userId));

    // chat: proxy to agentd's SSE stream, forwarding each event to the renderer on
    // a per-call channel; file_request events are executed locally via fsguard.
    // The invoke resolves with the final answer text.
    // SECURITY (demo): userId comes from the renderer. Production derives the
    // principal from a WeCom-authenticated session, never the renderer.
    install(Channels.chat, (e, { streamId, req }: ChatIpcReq) => {
      const chan = Channels.chatEventPrefix + streamId;
      return client.chat(
        req,
        (ev) => {
          if (!e.sender.isDestroyed()) e.sender.send(chan, ev);
        },
        (ev) => handleFileRequest(sandbox, ev),
        (request) => handleLocalToolRequest(localToolExecutor, request, confirmationTimeoutMs),
        { connectorDeviceId: options.connectorDeviceId },
      );
    });

    // Local file ops — confined to the sandbox root (fsguard).
    install(Channels.fsRead, (_e, req: FsReadReq) => sandbox.read(req.rel));
    install(Channels.fsWrite, (_e, req: FsWriteReq) =>
      sandbox.write(req.rel, req.contents, !!req.confirmed),
    );

    // admin: generic proxy to agentd's /admin/* API. X-User-Id is injected in
    // agentd.adminRequest; the backend's requireAdmin gate authorizes. Errors are
    // returned as a typed AdminResp (never thrown across the bridge).
    install(Channels.admin, async (_e, req: AdminReq): Promise<AdminResp> => {
      const r = await client.adminRequest(req);
      return r.ok ? { ok: true, data: r.data } : { ok: false, status: r.status, error: r.error || "error" };
    });
    if (options.openWorkbench !== undefined) {
      install(Channels.openWorkbench, () => options.openWorkbench?.());
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}

export function registerWorkbench(
  service: WorkbenchService,
  isSenderAllowed: (event: Electron.IpcMainInvokeEvent) => boolean,
): () => void {
  const installed: string[] = [];
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const channel of installed.reverse()) ipcMain.removeHandler(channel);
  };
  const install: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isSenderAllowed(event)) throw new Error("workbench_sender_denied");
      return listener(event, ...args);
    });
    installed.push(channel);
  };
  try {
    install(WorkbenchChannels.enrollment, () => service.getEnrollment());
    install(WorkbenchChannels.unlock, (_event, req: WorkbenchUnlockReq) => {
      const value = closedWorkbenchRequest(req, ["encodedCredential"]);
      return service.unlock(value.encodedCredential as string);
    });
    install(WorkbenchChannels.saveCredential, (_event, req: WorkbenchCredentialReq) => {
      const value = closedWorkbenchRequest(req, ["sessionId", "ref", "credential"]);
      return service.saveCredential(value.sessionId as string, value.ref as string, value.credential as never);
    });
    install(WorkbenchChannels.saveDraft, (_event, req: WorkbenchDraftReq) => {
      const value = closedWorkbenchRequest(req, ["sessionId", "draft"]);
      return service.saveDraft(value.sessionId as string, value.draft as never);
    });
    install(WorkbenchChannels.testConnection, (_event, req: WorkbenchDraftIdReq) => {
      const value = closedWorkbenchRequest(req, ["sessionId", "draftId"]);
      return service.testConnection(value.sessionId as string, value.draftId as string);
    });
    install(WorkbenchChannels.testOperation, (_event, req: WorkbenchOperationReq) => {
      const value = closedWorkbenchRequest(req, ["sessionId", "draftId", "tool", "args"]);
      return service.testOperation(
        value.sessionId as string,
        value.draftId as string,
        value.tool as string,
        value.args as never,
      );
    });
    install(WorkbenchChannels.closeResult, (_event, req: WorkbenchResultReq) => {
      const value = closedWorkbenchRequest(req, ["sessionId", "resultId"]);
      return service.closeResult(value.sessionId as string, value.resultId as string);
    });
    install(WorkbenchChannels.validateAndFreeze, (_event, req: WorkbenchDraftIdReq) => {
      const value = closedWorkbenchRequest(req, ["sessionId", "draftId"]);
      return service.validateAndFreeze(value.sessionId as string, value.draftId as string);
    });
    install(WorkbenchChannels.submit, (_event, req: WorkbenchDraftIdReq) => {
      const value = closedWorkbenchRequest(req, ["sessionId", "draftId"]);
      return service.submit(value.sessionId as string, value.draftId as string);
    });
    install(WorkbenchChannels.lock, (_event, req: WorkbenchSessionReq) => {
      const value = closedWorkbenchRequest(req, ["sessionId"]);
      return service.lock(value.sessionId as string);
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}
