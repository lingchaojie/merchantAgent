import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";

import type { AdminClient, ConnectorVersionView } from "../../admin";
import { ConnectorVersionCard, ConnectorsPane, runConnectorLifecycleAction } from "./ConnectorsPane";

function nodeText(node: ReactTestInstance | string | number): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node.children.map((child) => nodeText(child as ReactTestInstance | string | number)).join("");
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => vi.unstubAllGlobals());

function pendingContract(): ConnectorVersionView {
  return {
    tenantId: "mock-corp-001",
    connectorId: "sql-orders",
    version: "1.0.0",
    digest: "sha256:approved-digest",
    adapter: "sqlserver",
    environment: "test",
    status: "pending_admin_approval",
    checks: {
      checkerVersion: "checker-1",
      rulesetVersion: "m7.1-sql-v1",
      testsDigest: "sha256:tests-digest",
    },
    contract: {
      tools: [{
        name: "query_order_status",
        description: "查询订单状态",
        execution: "desktop",
        resourceType: "business_record",
        resourceKind: "order",
        resourceArg: "orderId",
        resourceRelation: "viewer",
        dataDomain: "orders",
        params: [{ name: "orderId", description: "订单编号", type: "string", required: true }],
        resultFields: ["orderId", "status"],
        risk: "read",
        requiresConfirmation: false,
        timeoutMS: 5_000,
        maxResults: 10,
      }],
    },
    submittedBy: "implementation-1",
  };
}

it("admin reviews public fields but never local implementation", () => {
  const html = renderToStaticMarkup(
    <ConnectorVersionCard connector={pendingContract()} busy={false} onAction={vi.fn()} />,
  );
  expect(html).toContain("query_order_status");
  expect(html).toContain("sha256:approved-digest");
  for (const secret of ["SELECT", "dbo.", "sql.internal", "credentialRef"]) {
    expect(html).not.toMatch(new RegExp(secret, "i"));
  }
});

it("invalidates connectors and live tools after lifecycle transitions", async () => {
  const client = {
    publishConnector: vi.fn(async () => undefined),
    listConnectors: vi.fn(async () => []),
    listTools: vi.fn(async () => []),
  } as unknown as AdminClient;

  await runConnectorLifecycleAction(client, pendingContract(), "publish");

  expect(client.publishConnector).toHaveBeenCalledWith("sql-orders", "1.0.0");
  expect(client.listConnectors).toHaveBeenCalledOnce();
  expect(client.listTools).toHaveBeenCalledOnce();
});

it("notifies Skills and disables stale lifecycle actions when connector refresh fails", async () => {
  const connector = pendingContract();
  const client = {
    listConnectors: vi.fn()
      .mockResolvedValueOnce([connector])
      .mockRejectedValueOnce(new Error("connector reload failed")),
    listTools: vi.fn(async () => []),
    publishConnector: vi.fn(async () => undefined),
  } as unknown as AdminClient;
  const onLifecycle = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ConnectorsPane client={client} onLifecycle={onLifecycle} />); });
  await flush();

  const publish = renderer.root.findAllByType("button")
    .find((candidate) => nodeText(candidate) === "发布")!;
  await act(async () => { publish.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  await flush();

  expect(client.publishConnector).toHaveBeenCalledWith("sql-orders", "1.0.0");
  expect(onLifecycle).toHaveBeenCalledOnce();
  expect(nodeText(renderer.root)).toContain("connector reload failed");
  expect(renderer.root.findAllByType("button")
    .find((candidate) => nodeText(candidate) === "发布")?.props.disabled).toBe(true);
});

it("applies a successful connector refresh when only the tool refresh fails", async () => {
  const connector = pendingContract();
  const published = { ...connector, status: "published" as const, approvedBy: "admin-1" };
  const client = {
    listConnectors: vi.fn().mockResolvedValueOnce([connector]).mockResolvedValueOnce([published]),
    listTools: vi.fn().mockRejectedValueOnce(new Error("tool reload failed")),
    publishConnector: vi.fn(async () => undefined),
  } as unknown as AdminClient;
  const onLifecycle = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ConnectorsPane client={client} onLifecycle={onLifecycle} />); });
  await flush();

  const publish = renderer.root.findAllByType("button")
    .find((candidate) => nodeText(candidate) === "发布")!;
  await act(async () => { publish.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  await flush();

  expect(onLifecycle).toHaveBeenCalledOnce();
  expect(nodeText(renderer.root)).toContain("tool reload failed");
  expect(renderer.root.findAllByType("button")
    .find((candidate) => nodeText(candidate) === "暂停")?.props.disabled).toBe(false);
});

it("confirms revoke before transitioning and refreshes both registries", async () => {
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  const connector = { ...pendingContract(), status: "published" as const };
  const client = {
    listConnectors: vi.fn().mockResolvedValueOnce([connector]).mockResolvedValueOnce([]),
    listTools: vi.fn(async () => []),
    revokeConnector: vi.fn(async () => undefined),
  } as unknown as AdminClient;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ConnectorsPane client={client} />); });
  await flush();

  const revoke = renderer.root.findAllByType("button")
    .find((candidate) => nodeText(candidate) === "撤销")!;
  await act(async () => { revoke.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  await flush();

  expect(window.confirm).toHaveBeenCalledOnce();
  expect(client.revokeConnector).toHaveBeenCalledWith("sql-orders", "1.0.0");
  expect(client.listConnectors).toHaveBeenCalledTimes(2);
  expect(client.listTools).toHaveBeenCalledOnce();
});

it("recovers a stale disabled connector after a later successful pane refresh", async () => {
  const connector = pendingContract();
  const published = { ...connector, status: "published" as const, approvedBy: "admin-1" };
  const client = {
    listConnectors: vi.fn()
      .mockResolvedValueOnce([connector])
      .mockRejectedValueOnce(new Error("connector reload failed"))
      .mockResolvedValueOnce([published]),
    listTools: vi.fn(async () => []),
    publishConnector: vi.fn(async () => undefined),
  } as unknown as AdminClient;
  const onLifecycle = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ConnectorsPane client={client} onLifecycle={onLifecycle} />); });
  await flush();

  const publish = renderer.root.findAllByType("button")
    .find((candidate) => nodeText(candidate) === "发布")!;
  await act(async () => { publish.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  await flush();
  expect(publish.props.disabled).toBe(true);
  expect(onLifecycle).toHaveBeenCalledOnce();

  const refresh = renderer.root.findAllByType("button")
    .find((candidate) => nodeText(candidate) === "刷新连接器")!;
  await act(async () => { refresh.props.onClick(); await Promise.resolve(); });
  await flush();

  expect(nodeText(renderer.root)).not.toContain("connector reload failed");
  expect(renderer.root.findAllByType("button")
    .find((candidate) => nodeText(candidate) === "暂停")?.props.disabled).toBe(false);
});
