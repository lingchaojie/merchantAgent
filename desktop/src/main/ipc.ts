// IPC handlers: the ONLY bridge between the sandboxed renderer and privileged
// main-process capabilities. Every channel is explicit (whitelist); the renderer
// has no Node access (see index.ts webPreferences + preload). Types come from
// the shared contract, so a mismatch is a compile error.
import { ipcMain, dialog } from "electron";
import { Sandbox } from "./fsguard";
import { client } from "./agentd";
import {
  Channels,
  type ChatEvent,
  type ChatIpcReq,
  type LoginReq,
  type FsReadReq,
  type FsWriteReq,
  type AdminReq,
  type AdminResp,
} from "../shared/contract";

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

export function register(sandbox: Sandbox): void {
  ipcMain.handle(Channels.login, (_e, req: LoginReq) => client.login(req.userId));

  // chat: proxy to agentd's SSE stream, forwarding each event to the renderer on
  // a per-call channel; file_request events are executed locally via fsguard.
  // The invoke resolves with the final answer text.
  // SECURITY (demo): userId comes from the renderer. Production derives the
  // principal from a WeCom-authenticated session, never the renderer.
  ipcMain.handle(Channels.chat, (e, { streamId, req }: ChatIpcReq) => {
    const chan = Channels.chatEventPrefix + streamId;
    return client.chat(
      req,
      (ev) => {
        if (!e.sender.isDestroyed()) e.sender.send(chan, ev);
      },
      (ev) => handleFileRequest(sandbox, ev),
    );
  });

  // Local file ops — confined to the sandbox root (fsguard).
  ipcMain.handle(Channels.fsRead, (_e, req: FsReadReq) => sandbox.read(req.rel));
  ipcMain.handle(Channels.fsWrite, (_e, req: FsWriteReq) =>
    sandbox.write(req.rel, req.contents, !!req.confirmed),
  );

  // admin: generic proxy to agentd's /admin/* API. X-User-Id is injected in
  // agentd.adminRequest; the backend's requireAdmin gate authorizes. Errors are
  // returned as a typed AdminResp (never thrown across the bridge).
  ipcMain.handle(Channels.admin, async (_e, req: AdminReq): Promise<AdminResp> => {
    const r = await client.adminRequest(req);
    return r.ok ? { ok: true, data: r.data } : { ok: false, status: r.status, error: r.error ?? "error" };
  });
}
