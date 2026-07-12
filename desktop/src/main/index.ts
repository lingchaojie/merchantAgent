// merchantAgent desktop shell (Electron + Vite + React). Like Cursor/Codex: an
// Electron UI in front of a compiled backend (Go `agentd`) that owns
// orchestration/authz/RAG. This shell owns the window, sandboxed local files,
// and the typed IPC bridge.
import { app, BrowserWindow, safeStorage, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import * as keytar from "keytar";
import { register, registerWorkbench } from "./ipc";
import { Sandbox } from "./fsguard";
import { client, spawnAgentd, submitInstalledConnector } from "./agentd";
import { LocalToolExecutor } from "./local-tools/executor";
import { verifyCapabilityPackage } from "./local-tools/package";
import { ReferenceEnterpriseStore } from "./local-tools/store";
import { initializeDesktop, type DesktopRuntime } from "./startup";
import { DeviceIdentityStore } from "./connectors/device-identity";
import { loadBundledPlatformPublicKey } from "./connectors/implementation-credential";
import {
  ConnectorPackageReader,
  ConnectorPackageStore,
  type InstalledConnectorRef,
} from "./connectors/package-store";
import { KeytarCredentialVault } from "./connectors/credential-vault";
import { ExecutionLedger } from "./connectors/ledger";
import { MSSQLPoolFactory, SQLServerAdapter } from "./connectors/sql-adapter";
import { ConnectorRuntime, LocalToolRouter } from "./connectors/runtime";
import { WorkbenchService } from "./connectors/workbench-service";
import { createWorkbenchWindow } from "./connectors/workbench-window";

let desktopRuntime: DesktopRuntime | null = null;
let workbenchWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
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
  try {
    if (devUrl) {
      await win.loadURL(devUrl);
    } else {
      await win.loadFile(path.join(__dirname, "../renderer/index.html"));
    }
  } catch (error) {
    win.destroy();
    throw error;
  }
}

async function openWorkbench(service: WorkbenchService): Promise<void> {
  if (workbenchWindow !== null && !workbenchWindow.isDestroyed()) {
    workbenchWindow.focus();
    return;
  }
  const devURL = process.env["ELECTRON_RENDERER_URL"];
  workbenchWindow = await createWorkbenchWindow(service, {
    preloadPath: path.join(__dirname, "../preload/workbench.js"),
    rendererFile: path.join(__dirname, "../renderer/workbench.html"),
    ...(devURL === undefined ? {} : { rendererURL: new URL("workbench.html", devURL).toString() }),
    isPackaged: app.isPackaged,
  });
  workbenchWindow.once("closed", () => { workbenchWindow = null; });
}

app.whenReady().then(async () => {
  const dataDir = app.getPath("userData");
  const root = process.env.AGENT_WORKSPACE || path.join(dataDir, "workspace");
  fs.mkdirSync(root, { recursive: true });
  const capabilityDir = app.isPackaged
    ? path.join(process.resourcesPath, "capabilities")
    : path.join(__dirname, "../../resources/capabilities");
  const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../resources");
  const platformPublicKey = loadBundledPlatformPublicKey(resourcesRoot);
  const identityStore = new DeviceIdentityStore(dataDir, safeStorage);
  const enrollment = identityStore.loadOrCreate();
  const tenantId = process.env.AGENT_TENANT_ID || "mock-corp-001";
  const pools = new MSSQLPoolFactory();
  desktopRuntime = await initializeDesktop({
    createStore: () => new ReferenceEnterpriseStore(path.join(dataDir, "reference-enterprise.db")),
    verifyPackage: () => verifyCapabilityPackage(
      path.join(capabilityDir, "reference-manufacturing.cap.json"),
      path.join(capabilityDir, "reference-public.pem"),
    ),
    createExecutor: (pkg, store) => new LocalToolExecutor(pkg, store),
    connectors: {
      createPackageReader: () => ({
        loadApproved: (ref: InstalledConnectorRef, digest: string, requestTenant = tenantId) => new ConnectorPackageReader(
          dataDir,
          safeStorage,
          identityStore.loadPackageReaderIdentity(requestTenant, platformPublicKey),
        ).loadApproved(ref, digest),
      }),
      createVault: () => new KeytarCredentialVault(keytar, tenantId, enrollment.deviceId),
      createLedger: () => new ExecutionLedger(dataDir),
      createRuntime: (packageReader, vault, ledger) => new ConnectorRuntime({
        tenantId,
        approvals: { getApproval: client.getConnectorApproval },
        packages: packageReader as never,
        vault: vault as never,
        createSource: (connector) => new SQLServerAdapter(
          connector.payload.profile,
          vault as never,
          pools,
          {
            ledger: ledger as ExecutionLedger,
            connectorId: connector.ref.connectorId,
            version: connector.ref.version,
          },
        ),
      }),
      createWorkbench: (_packageReader, vault, ledger) => new WorkbenchService({
        tenantId,
        enrollment,
        bindCredential: (encoded, now) => identityStore.bindImplementationCredential(encoded, platformPublicKey, now),
        vault: vault as never,
        createTester: (draft) => {
          const adapter = new SQLServerAdapter(draft.payload.profile, vault as never, pools, {
            ledger: ledger as ExecutionLedger,
            connectorId: draft.payload.connectorId,
            version: draft.payload.version,
          });
          return {
            testConnection: (signal) => adapter.testConnection(signal),
            testOperation: async (operation, args, signal) => {
              if (operation.kind === "read") return adapter.executeWorkbenchRead(operation, args, signal);
              const preview = await adapter.previewUpdate(operation, args, signal);
              return { raw: preview.before, projected: preview.proposed };
            },
            close: () => undefined,
          };
        },
        createPackageStore: (identity) => new ConnectorPackageStore(dataDir, safeStorage, identity),
        submitter: { submit: submitInstalledConnector },
      }),
    },
    register: (executor, connectors) => {
      if (connectors === undefined) return register(new Sandbox(root), executor as LocalToolExecutor);
      const connectorRuntime = connectors.runtime as ConnectorRuntime;
      const workbench = connectors.workbench as WorkbenchService;
      const router = new LocalToolRouter(
        executor as never,
        connectorRuntime as never,
        new Set(["reference-manufacturing"]),
      );
      const cleanupMain = register(new Sandbox(root), router as never, {
        openWorkbench: () => openWorkbench(workbench),
        connectorDeviceId: enrollment.deviceId,
      });
      const cleanupWorkbench = registerWorkbench(
        workbench,
        (event) => workbenchWindow !== null && event.sender === workbenchWindow.webContents,
      );
      return () => {
        cleanupWorkbench();
        cleanupMain();
      };
    },
    spawnAgentd,
    createWindow,
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch((error) => console.error("failed to create window", error));
    }
  });
}).catch((error) => {
  console.error("desktop startup failed", error);
  app.quit();
});

app.on("before-quit", () => {
  workbenchWindow?.destroy();
  workbenchWindow = null;
  const runtime = desktopRuntime;
  desktopRuntime = null;
  runtime?.close();
});

app.on("window-all-closed", () => {
  desktopRuntime?.stopAgentd();
  if (process.platform !== "darwin") app.quit();
});

// Defense-in-depth: block new windows and external navigation.
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (e) => e.preventDefault());
});
