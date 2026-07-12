import { describe, expect, it, vi } from "vitest";

import type { LocalToolRequest } from "../../shared/contract";
import { ConnectorPackageError, type LoadedApprovedConnector } from "./package-store";
import type { PublicToolContract, SQLReadOperation, SQLUpdateOperation } from "./schema";
import { ConnectorRuntime, LocalToolRouter, type ConnectorRuntimeDependencies } from "./runtime";

const DIGEST = `sha256:${"a".repeat(64)}`;

function readOperation(): SQLReadOperation {
  return {
    kind: "read",
    tool: "query_order_status",
    sql: "SELECT TOP 10 o.order_id AS order_id FROM dbo.orders o WHERE o.order_id = @order_id",
    bindings: [{ parameter: "order_id", argument: "orderId", type: "NVarChar", maxLength: 32 }],
    projection: [{ sourceAlias: "order_id", resultField: "orderId", type: "string" }],
    declaredObjects: ["dbo.orders"],
    maxResults: 10,
    timeoutMS: 5_000,
  };
}

function updateOperation(): SQLUpdateOperation {
  const readSql = [
    "SELECT o.order_id AS order_id, o.status AS order_status, o.row_version AS row_version",
    "FROM dbo.production_orders AS o",
    "WHERE o.order_id = @orderId",
  ].join(" ");
  return {
    kind: "update",
    tool: "update_order_status",
    beforeSql: readSql,
    updateSql: "UPDATE dbo.production_orders SET status = @status, row_version = @nextVersion WHERE order_id = @orderId AND row_version = @expectedVersion",
    readBackSql: readSql,
    bindings: [
      { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 32 },
      { parameter: "status", argument: "status", type: "NVarChar", maxLength: 32 },
      { parameter: "nextVersion", argument: "nextVersion", type: "Int" },
      { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" },
    ],
    projection: [
      { sourceAlias: "order_id", resultField: "orderId", type: "string" },
      { sourceAlias: "order_status", resultField: "status", type: "string" },
      { sourceAlias: "row_version", resultField: "rowVersion", type: "integer" },
    ],
    proposed: [
      { resultField: "status", argument: "status" },
      { resultField: "rowVersion", argument: "nextVersion" },
    ],
    declaredObject: "dbo.production_orders",
    resourceParameter: "orderId",
    concurrencyParameter: "expectedVersion",
    updateColumns: ["status", "row_version"],
    versionField: "row_version",
    timeoutMS: 5_000,
  };
}

function loaded(operation: SQLReadOperation | SQLUpdateOperation = readOperation()): LoadedApprovedConnector {
  const isRead = operation.kind === "read";
  const properties: PublicToolContract["parameters"]["properties"] = isRead
    ? { orderId: { type: "string", minLength: 1, maxLength: 32 } }
    : {
        orderId: { type: "string", minLength: 1, maxLength: 32 },
        status: { type: "string", maxLength: 32 },
        expectedVersion: { type: "integer", minimum: 0 },
        nextVersion: { type: "integer", minimum: 1 },
      };
  const tool: PublicToolContract = {
    name: operation.tool,
    description: "fixture tool",
    parameters: {
      type: "object" as const,
      properties,
      required: isRead ? ["orderId"] : ["orderId", "status", "expectedVersion", "nextVersion"],
      additionalProperties: false as const,
    },
    resultFields: isRead ? ["orderId"] : ["orderId", "status", "rowVersion"],
    resourceType: "business_record" as const,
    resourceKind: "order",
    resourceArg: "orderId",
    resourceRelation: isRead ? "viewer" as const : "operator" as const,
    dataDomain: "manufacturing",
    risk: isRead ? "read" as const : "low_write" as const,
    requiresConfirmation: !isRead,
    timeoutMS: 5_000,
    maxResults: isRead ? 10 : 1,
  };
  return {
    ref: { connectorId: "sql-orders", version: "1.0.0" },
    path: "fixture.ma-connector",
    manifest: {
      connectorId: "sql-orders",
      version: "1.0.0",
      adapter: "sqlserver",
      environment: "test",
      digest: DIGEST,
      publicContract: { tools: [tool] },
      checks: { checkerVersion: "1", rulesetVersion: "m7.1-sql-v1", testsDigest: DIGEST },
      credentialId: "implementation-1",
      deviceId: "device-1",
      signedAt: "2026-07-13T00:00:00Z",
    },
    payload: {
      schemaVersion: 1,
      connectorId: "sql-orders",
      version: "1.0.0",
      adapter: "sqlserver",
      profile: {
        profileId: "test",
        server: "sql.test.internal",
        port: 1433,
        database: "erp",
        encrypt: true,
        trustServerCertificate: false,
        connectTimeoutMS: 5_000,
        queryTimeoutMS: 5_000,
        credentialRef: "erp-test",
        environment: "test",
      },
      operations: [operation],
      publicContract: { tools: [tool] },
      checker: { version: "1", rulesetVersion: "m7.1-sql-v1", testsDigest: DIGEST },
    },
  };
}

function request(overrides: Partial<LocalToolRequest> = {}): LocalToolRequest {
  return {
    reqId: "request-1",
    packageId: "sql-orders",
    packageVersion: "1.0.0",
    manifestDigest: DIGEST,
    tool: "query_order_status",
    tenantId: "tenant-1",
    userId: "user-1",
    deviceId: "device-1",
    roleIds: ["sales"],
    skillId: "orders",
    callId: "call-1",
    idempotencyKey: "idem-1",
    risk: "read",
    requiresConfirmation: false,
    args: { orderId: "ORD-1001" },
    ...overrides,
  };
}

function fixture(operation: SQLReadOperation | SQLUpdateOperation = readOperation()) {
  const connector = loaded(operation);
  const approval = vi.fn<ConnectorRuntimeDependencies["approvals"]["getApproval"]>(
    async () => ({ digest: DIGEST, status: "published" }),
  );
  const loadApproved = vi.fn(() => connector);
  const credentialGet = vi.fn(async () => ({ username: "svc", password: "secret" }));
  const source = {
    executeRead: vi.fn(async () => [{ orderId: "ORD-1001" }]),
    resumeUpdate: vi.fn(async () => null),
    previewUpdate: vi.fn(async () => ({ before: { orderId: "ORD-1001", version: 1, note: "" }, proposed: { note: "done", version: 2 } })),
    executeConfirmedUpdate: vi.fn(async () => ({ orderId: "ORD-1001", version: 2, note: "done" })),
  };
  const dependencies: ConnectorRuntimeDependencies = {
    approvals: { getApproval: approval },
    packages: { loadApproved },
    vault: { get: credentialGet },
    createSource: vi.fn(() => source),
    executionId: () => "execution-1",
  };
  return { runtime: new ConnectorRuntime(dependencies), approval, loadApproved, credentialGet, source, dependencies };
}

describe("ConnectorRuntime Gate C", () => {
  it("denies an approval/package digest mismatch before credentials or source access", async () => {
    const f = fixture();
    f.loadApproved.mockImplementation(() => {
      throw new ConnectorPackageError("package_version", "digest differs");
    });

    const result = await f.runtime.execute(request(), async () => true);

    expect(result.error).toBe("package_version");
    expect(f.credentialGet).not.toHaveBeenCalled();
    expect(f.dependencies.createSource).not.toHaveBeenCalled();
  });

  it("fetches approval on every call and immediately denies suspension", async () => {
    const f = fixture();
    f.approval
      .mockResolvedValueOnce({ digest: DIGEST, status: "published" })
      .mockResolvedValueOnce({ digest: DIGEST, status: "suspended" });

    expect((await f.runtime.execute(request(), async () => true)).error).toBeUndefined();
    expect((await f.runtime.execute(request(), async () => true)).error).toBe("approval_revoked");
    expect(f.approval).toHaveBeenCalledTimes(2);
    expect(f.source.executeRead).toHaveBeenCalledOnce();
  });

  it("rejects a request outside the configured tenant before approval", async () => {
    const f = fixture();
    f.dependencies.tenantId = "tenant-1";

    const result = await f.runtime.execute(request({ tenantId: "tenant-2" }), async () => true);

    expect(result.error).toBe("permission_denied");
    expect(f.approval).not.toHaveBeenCalled();
  });

  it("denies a missing package with a static error", async () => {
    const f = fixture();
    f.loadApproved.mockImplementation(() => {
      const error = new Error("C:\\Users\\employee\\secret.ma-connector");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const result = await f.runtime.execute(request(), async () => true);

    expect(result.error).toBe("connector_not_installed");
    expect(JSON.stringify(result)).not.toContain("employee");
  });

  it("checks the closed public request schema before credential access", async () => {
    const f = fixture();

    const result = await f.runtime.execute(request({ args: { orderId: "ORD-1001", injected: true } }), async () => true);

    expect(result.error).toBe("invalid_argument");
    expect(f.credentialGet).not.toHaveBeenCalled();
  });

  it("denies when private SQL projections exceed the approved public result fields", async () => {
    const f = fixture();
    f.loadApproved.mockReturnValue({
      ...loaded(),
      manifest: {
        ...loaded().manifest,
        publicContract: { tools: [{ ...loaded().manifest.publicContract.tools[0], resultFields: ["status"] }] },
      },
    });

    const result = await f.runtime.execute(request(), async () => true);

    expect(result.error).toBe("permission_denied");
    expect(f.credentialGet).not.toHaveBeenCalled();
  });

  it("binds the cloud-authorized resource argument to the private SQL predicate", async () => {
    const f = fixture();
    const connector = loaded();
    const operation = connector.payload.operations[0] as SQLReadOperation;
    operation.bindings = [{ ...operation.bindings[0], argument: "targetOrderId" }];
    f.loadApproved.mockReturnValue(connector);

    const result = await f.runtime.execute(request(), async () => true);

    expect(result.error).toBe("permission_denied");
    expect(f.credentialGet).not.toHaveBeenCalled();
  });

  it("rejects a read that filters an unrelated column with the authorized resource value", async () => {
    const f = fixture();
    const connector = loaded();
    const operation = connector.payload.operations[0] as SQLReadOperation;
    operation.sql = "SELECT TOP 10 o.order_id AS order_id FROM dbo.orders o WHERE o.status = @order_id";
    f.loadApproved.mockReturnValue(connector);

    const result = await f.runtime.execute(request(), async () => true);

    expect(result.error).toBe("permission_denied");
    expect(f.credentialGet).not.toHaveBeenCalled();
  });

  it("dispatches an approved read and returns only projected rows", async () => {
    const f = fixture();

    const result = await f.runtime.execute(request(), async () => true);

    expect(result).toMatchObject({
      data: { rows: [{ orderId: "ORD-1001" }] },
      meta: { status: "succeeded", executionId: "execution-1", confirmed: false },
    });
  });

  it("executes a low write only after confirmation", async () => {
    const f = fixture(updateOperation());
    const write = request({
      tool: "update_order_status",
      risk: "low_write",
      requiresConfirmation: true,
      args: { orderId: "ORD-1001", status: "done", expectedVersion: 1, nextVersion: 2 },
    });

    const denied = await f.runtime.execute(write, async () => false);
    const accepted = await f.runtime.execute({ ...write, idempotencyKey: "idem-2" }, async () => true);

    expect(denied.meta.status).toBe("cancelled");
    expect(f.source.executeConfirmedUpdate).toHaveBeenCalledOnce();
    expect(accepted).toMatchObject({ data: { orderId: "ORD-1001", version: 2 }, meta: { confirmed: true } });
  });
});

describe("LocalToolRouter", () => {
  it("preserves the reference executor and routes all other packages through Gate C", async () => {
    const reference = { execute: vi.fn(async () => ({ meta: { status: "succeeded" }, data: { source: "reference" } })) };
    const published = { execute: vi.fn(async () => ({ meta: { status: "succeeded" }, data: { source: "connector" } })) };
    const router = new LocalToolRouter(reference as never, published as never, new Set(["reference-manufacturing"]));

    await router.execute(request({ packageId: "reference-manufacturing" }), async () => true);
    await router.execute(request(), async () => true);

    expect(reference.execute).toHaveBeenCalledOnce();
    expect(published.execute).toHaveBeenCalledOnce();
  });
});
