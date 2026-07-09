// IPC handlers: the ONLY bridge between the sandboxed renderer and privileged
// main-process capabilities. Every channel is explicit (whitelist); the renderer
// has no Node access (see index.ts webPreferences + preload). Types come from
// the shared contract, so a mismatch is a compile error.
import { ipcMain } from "electron";
import { Sandbox } from "./fsguard";
import { client } from "./agentd";
import { Channels, type AskReq, type LoginReq, type FsReadReq, type FsWriteReq } from "../shared/contract";

export function register(sandbox: Sandbox): void {
  // ask: proxy to the Go backend.
  // SECURITY (Phase 0 demo): userId comes from the renderer. Production derives
  // the principal from a WeCom-authenticated session, never the renderer.
  ipcMain.handle(Channels.ask, (_e, req: AskReq) =>
    client.ask(req.tenantId, req.userId, req.question),
  );
  ipcMain.handle(Channels.login, (_e, req: LoginReq) => client.login(req.userId));

  // Local file ops — confined to the sandbox root.
  ipcMain.handle(Channels.fsRead, (_e, req: FsReadReq) => sandbox.read(req.rel));
  ipcMain.handle(Channels.fsWrite, (_e, req: FsWriteReq) =>
    sandbox.write(req.rel, req.contents, !!req.confirmed),
  );
}
