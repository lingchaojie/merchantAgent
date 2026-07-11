// merchantAgent desktop shell (Electron + Vite + React). Like Cursor/Codex: an
// Electron UI in front of a compiled backend (Go `agentd`) that owns
// orchestration/authz/RAG. This shell owns the window, sandboxed local files,
// and the typed IPC bridge.
import { app, BrowserWindow, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import { register } from "./ipc";
import { Sandbox } from "./fsguard";
import { spawnAgentd } from "./agentd";
import { LocalToolExecutor } from "./local-tools/executor";
import { verifyCapabilityPackage } from "./local-tools/package";
import { ReferenceEnterpriseStore } from "./local-tools/store";
import type { ChildProcess } from "node:child_process";

let agentdChild: ChildProcess | null = null;
let enterpriseStore: ReferenceEnterpriseStore | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    title: "merchantAgent",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true, // renderer can't touch main's globals
      nodeIntegration: false, // no Node in renderer
      sandbox: true, // OS-level renderer sandbox
    },
  });

  // CSP: renderer may only reach loopback agentd; no remote origins.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; connect-src 'self' http://localhost:8765 http://127.0.0.1:8765; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        ],
      },
    });
  });

  // electron-vite injects ELECTRON_RENDERER_URL in dev; load the built file in prod.
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  const dataDir = app.getPath("userData");
  const root = process.env.AGENT_WORKSPACE || path.join(dataDir, "workspace");
  fs.mkdirSync(root, { recursive: true });
  const capabilityDir = app.isPackaged
    ? path.join(process.resourcesPath, "capabilities")
    : path.join(__dirname, "../../resources/capabilities");
  enterpriseStore = new ReferenceEnterpriseStore(path.join(dataDir, "reference-enterprise.db"));
  const pkg = verifyCapabilityPackage(
    path.join(capabilityDir, "reference-manufacturing.cap.json"),
    path.join(capabilityDir, "reference-public.pem"),
  );
  const localToolExecutor = new LocalToolExecutor(pkg, enterpriseStore);
  register(new Sandbox(root), localToolExecutor);

  agentdChild = spawnAgentd(); // null unless AGENTD_BIN set
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  enterpriseStore?.close();
  enterpriseStore = null;
});

app.on("window-all-closed", () => {
  agentdChild?.kill();
  if (process.platform !== "darwin") app.quit();
});

// Defense-in-depth: block new windows and external navigation.
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (e) => e.preventDefault());
});
