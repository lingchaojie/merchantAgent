import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: childProcess.spawn }));

import { spawnAgentd } from "./agentd";
import { initializeDesktop } from "./startup";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function startup(child: ReturnType<typeof fakeChild>) {
  const store = { close: vi.fn() };
  const unregister = vi.fn();
  const createWindow = vi.fn(async () => undefined);
  childProcess.spawn.mockReturnValue(child);
  const starting = initializeDesktop({
    createStore: () => store,
    verifyPackage: () => ({ packageId: "verified" }),
    createExecutor: () => ({ execute: vi.fn() }),
    register: () => unregister,
    spawnAgentd,
    createWindow,
  });
  return { store, unregister, createWindow, starting };
}

describe("agentd asynchronous startup", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTD_BIN", "Z:\\missing-agentd.exe");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    childProcess.spawn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rolls back startup when the child emits ENOENT after spawn returns", async () => {
    const child = fakeChild();
    const observedErrors: Error[] = [];
    child.on("error", (error) => observedErrors.push(error as Error));
    const { store, unregister, createWindow, starting } = startup(child);
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });

    child.emit("error", error);

    await expect(starting).rejects.toBe(error);
    expect(createWindow).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
    expect(observedErrors).toEqual([error]);
    expect(child.listenerCount("error")).toBeGreaterThan(1);
  });

  it("waits for spawn and retains safe error handling for the child lifetime", async () => {
    const child = fakeChild();
    child.on("error", () => undefined);
    const { store, unregister, createWindow, starting } = startup(child);

    await Promise.resolve();
    expect(createWindow).not.toHaveBeenCalled();
    child.emit("spawn");
    const runtime = await starting;

    expect(createWindow).toHaveBeenCalledOnce();
    expect(child.listenerCount("error")).toBeGreaterThan(1);
    expect(() => child.emit("error", new Error("runtime error"))).not.toThrow();

    runtime.close();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });
});
