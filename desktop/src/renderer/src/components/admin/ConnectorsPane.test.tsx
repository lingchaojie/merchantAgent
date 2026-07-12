import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import type { AdminClient, ConnectorVersionView } from "../../admin";
import { ConnectorVersionCard, runConnectorLifecycleAction } from "./ConnectorsPane";

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
