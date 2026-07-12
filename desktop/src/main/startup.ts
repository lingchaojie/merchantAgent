export interface ClosableStore {
  close(): void;
}

export type OptionalClosable = unknown;

export interface DesktopConnectorFactories {
  createPackageReader(): OptionalClosable;
  createVault(packageReader: OptionalClosable): OptionalClosable;
  createLedger(vault: OptionalClosable): OptionalClosable;
  createRuntime(
    packageReader: OptionalClosable,
    vault: OptionalClosable,
    ledger: OptionalClosable,
  ): OptionalClosable;
  createWorkbench(
    packageReader: OptionalClosable,
    vault: OptionalClosable,
    ledger: OptionalClosable,
    runtime: OptionalClosable,
  ): OptionalClosable;
}

export interface DesktopConnectorStack {
  packageReader: OptionalClosable;
  vault: OptionalClosable;
  ledger: OptionalClosable;
  runtime: OptionalClosable;
  workbench: OptionalClosable;
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
  register(executor: TExecutor, connectors?: DesktopConnectorStack): () => void;
  spawnAgentd(): KillableChild | null | Promise<KillableChild | null>;
  createWindow(connectors?: DesktopConnectorStack): void | Promise<void>;
  connectors?: DesktopConnectorFactories;
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
  const connectorResources: OptionalClosable[] = [];
  let connectors: DesktopConnectorStack | undefined;
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
    const closeConnectors = connectorResources
      .slice()
      .reverse()
      .map((resource) => {
        if (
          typeof resource !== "object"
          || resource === null
          || !("close" in resource)
          || typeof (resource as { close?: unknown }).close !== "function"
        ) return undefined;
        return () => { void (resource as { close: () => unknown }).close(); };
      });
    for (const dispose of [stopAgentd, unregister, ...closeConnectors, store ? () => store?.close() : undefined]) {
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
    if (dependencies.connectors !== undefined) {
      const packageReader = dependencies.connectors.createPackageReader();
      connectorResources.push(packageReader);
      const vault = dependencies.connectors.createVault(packageReader);
      connectorResources.push(vault);
      const ledger = dependencies.connectors.createLedger(vault);
      connectorResources.push(ledger);
      const connectorRuntime = dependencies.connectors.createRuntime(packageReader, vault, ledger);
      connectorResources.push(connectorRuntime);
      const workbench = dependencies.connectors.createWorkbench(packageReader, vault, ledger, connectorRuntime);
      connectorResources.push(workbench);
      connectors = { packageReader, vault, ledger, runtime: connectorRuntime, workbench };
    }
    unregister = dependencies.register(executor, connectors);
    child = await dependencies.spawnAgentd();
    await dependencies.createWindow(connectors);
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
