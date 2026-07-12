export interface ClosableStore {
  close(): void;
}

export interface KillableChild {
  kill(): unknown;
}

export interface DesktopStartupDependencies<
  TStore extends ClosableStore,
  TPackage,
  TExecutor,
> {
  createStore(): TStore;
  verifyPackage(): TPackage;
  createExecutor(pkg: TPackage, store: TStore): TExecutor;
  register(executor: TExecutor): () => void;
  spawnAgentd(): KillableChild | null | Promise<KillableChild | null>;
  createWindow(): void | Promise<void>;
}

export interface DesktopRuntime {
  stopAgentd(): void;
  close(): void;
}

export async function initializeDesktop<
  TStore extends ClosableStore,
  TPackage,
  TExecutor,
>(dependencies: DesktopStartupDependencies<TStore, TPackage, TExecutor>): Promise<DesktopRuntime> {
  let store: TStore | undefined;
  let unregister: (() => void) | undefined;
  let child: KillableChild | null = null;
  let agentdStopped = false;
  let closed = false;

  const stopAgentd = (): void => {
    if (agentdStopped) return;
    agentdStopped = true;
    child?.kill();
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    let firstError: unknown;
    for (const dispose of [stopAgentd, unregister, store ? () => store?.close() : undefined]) {
      if (!dispose) continue;
      try {
        dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  };
  const runtime = { stopAgentd, close };

  try {
    store = dependencies.createStore();
    const pkg = dependencies.verifyPackage();
    const executor = dependencies.createExecutor(pkg, store);
    unregister = dependencies.register(executor);
    child = await dependencies.spawnAgentd();
    await dependencies.createWindow();
    return runtime;
  } catch (error) {
    try {
      close();
    } catch {
      // Preserve the startup error after attempting every owned cleanup.
    }
    throw error;
  }
}
