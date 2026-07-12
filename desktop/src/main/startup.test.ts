import { describe, expect, it, vi } from "vitest";
import { initializeDesktop } from "./startup";

type FailureStage = "verify" | "register" | "spawn" | "window";

function setup(failure?: FailureStage) {
  const store = { close: vi.fn() };
  const unregister = vi.fn();
  const child = { kill: vi.fn() };
  const dependencies = {
    createStore: vi.fn(() => store),
    verifyPackage: vi.fn(() => {
      if (failure === "verify") throw new Error("verify failed");
      return { packageId: "verified" };
    }),
    createExecutor: vi.fn(() => ({ execute: vi.fn() })),
    register: vi.fn(() => {
      if (failure === "register") throw new Error("register failed");
      return unregister;
    }),
    spawnAgentd: vi.fn(() => {
      if (failure === "spawn") throw new Error("spawn failed");
      return child;
    }),
    createWindow: vi.fn(async () => {
      if (failure === "window") throw new Error("window failed");
    }),
  };
  return { store, unregister, child, dependencies };
}

describe("desktop startup lifecycle", () => {
  it.each<FailureStage>(["verify", "register", "spawn", "window"])(
    "rolls back resources when %s startup fails",
    async (failure) => {
      const { store, unregister, child, dependencies } = setup(failure);

      await expect(initializeDesktop(dependencies)).rejects.toThrow(`${failure} failed`);

      expect(store.close).toHaveBeenCalledOnce();
      expect(unregister).toHaveBeenCalledTimes(failure === "spawn" || failure === "window" ? 1 : 0);
      expect(child.kill).toHaveBeenCalledTimes(failure === "window" ? 1 : 0);
    },
  );

  it("closes a successfully initialized runtime exactly once for before-quit", async () => {
    const { store, unregister, child, dependencies } = setup();
    const runtime = await initializeDesktop(dependencies);

    runtime.close();
    runtime.close();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });

  it("rolls back partially constructed connector resources in reverse order", async () => {
    const order: string[] = [];
    const resource = (name: string) => ({ close: vi.fn(() => order.push(name)) });
    const reader = resource("reader");
    const vault = resource("vault");
    const ledger = resource("ledger");
    const runtime = { ...resource("runtime"), execute: vi.fn() };
    const { dependencies } = setup();
    Object.assign(dependencies, {
      connectors: {
        createPackageReader: () => reader,
        createVault: () => vault,
        createLedger: () => ledger,
        createRuntime: () => runtime,
        createWorkbench: () => { throw new Error("workbench failed"); },
      },
    });

    await expect(initializeDesktop(dependencies as never)).rejects.toThrow("workbench failed");

    expect(order).toEqual(["runtime", "ledger", "vault", "reader"]);
  });
});
