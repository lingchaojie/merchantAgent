import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  class Emitter {
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    on(name: string, listener: (...args: unknown[]) => void) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), listener]);
      return this;
    }
    emit(name: string, ...args: unknown[]) {
      for (const listener of this.handlers.get(name) ?? []) listener(...args);
    }
  }
  const windows: FakeWindow[] = [];
  class FakeContents extends Emitter {
    setWindowOpenHandler = vi.fn();
    openDevTools = vi.fn();
  }
  class FakeWindow extends Emitter {
    webContents = new FakeContents();
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
    destroy = vi.fn();
    show = vi.fn();
    constructor(readonly options: unknown) {
      super();
      windows.push(this);
    }
  }
  return { BrowserWindow: FakeWindow, windows };
});
type FakeWindow = InstanceType<typeof electron.BrowserWindow>;

vi.mock("electron", () => ({ BrowserWindow: electron.BrowserWindow }));

import { createWorkbenchWindow } from "./workbench-window";

describe("Workbench BrowserWindow isolation", () => {
  beforeEach(() => {
    electron.windows.splice(0);
    vi.unstubAllEnvs();
  });

  it("uses a dedicated sandboxed partition/preload and denies navigation/popups", async () => {
    const service = { lock: vi.fn() };
    const win = await createWorkbenchWindow(service as never, {
      preloadPath: "C:\\app\\workbench.js",
      rendererFile: "C:\\app\\workbench.html",
      isPackaged: true,
    });
    const created = electron.windows[0];

    expect(created.options).toMatchObject({
      webPreferences: {
        preload: "C:\\app\\workbench.js",
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    expect((created.options as { webPreferences: { partition: string } }).webPreferences.partition).toMatch(/^workbench:/);
    expect(created.webContents.setWindowOpenHandler).toHaveBeenCalled();
    const navigate = { preventDefault: vi.fn() };
    created.webContents.emit("will-navigate", navigate);
    expect(navigate.preventDefault).toHaveBeenCalledOnce();
    expect(created.webContents.openDevTools).not.toHaveBeenCalled();

    created.emit("closed");
    expect(service.lock).toHaveBeenCalled();
    expect(win).toBe(created);
  });

  it("locks on renderer crash", async () => {
    const service = { lock: vi.fn() };
    await createWorkbenchWindow(service as never, {
      preloadPath: "preload.js", rendererFile: "workbench.html", isPackaged: true,
    });
    electron.windows[0].webContents.emit("render-process-gone");
    expect(service.lock).toHaveBeenCalledOnce();
  });
});
