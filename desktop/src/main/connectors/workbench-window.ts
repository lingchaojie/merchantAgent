import { randomUUID } from "node:crypto";

import { BrowserWindow } from "electron";

import type { WorkbenchService } from "./workbench-service";

export interface WorkbenchWindowOptions {
  preloadPath: string;
  rendererFile: string;
  rendererURL?: string;
  isPackaged: boolean;
}

export async function createWorkbenchWindow(
  service: Pick<WorkbenchService, "lock">,
  options: WorkbenchWindowOptions,
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: "Connector Workbench",
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !options.isPackaged,
      partition: `workbench:${randomUUID()}`,
    },
  });
  const lock = (): void => service.lock();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", lock);
  win.on("closed", lock);
  try {
    if (options.rendererURL !== undefined) await win.loadURL(options.rendererURL);
    else await win.loadFile(options.rendererFile);
    win.show();
    return win;
  } catch (error) {
    lock();
    win.destroy();
    throw error;
  }
}
