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
    "SELECT o.order_id AS order_id, o.work_order_id AS work_order_id, o.status AS order_status,",
    "o.promise_date AS promise_date, o.completion_rate AS completion_rate, o.note AS progress_note,",
    "o.version AS record_version",
    "FROM dbo.production_orders AS o",
    "WHERE o.order_id = @orderId AND o.work_order_id = @workOrderId",
  ].join(" ");
  return {
    kind: "update",
    tool: "report_production_progress",
    beforeSql: readSql,
    updateSql: [
      "UPDATE dbo.production_orders",
      "SET completion_rate = @completionRate, note = @note, version = @nextVersion",
      "WHERE order_id = @orderId AND work_order_id = @workOrderId AND version = @expectedVersion",
    ].join(" "),
    readBackSql: readSql,
    bindings: [
      { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 32 },
      { parameter: "workOrderId", argument: "workOrderId", type: "NVarChar", maxLength: 32 },
      { parameter: "completionRate", argument: "completionRate", type: "Int" },
      { parameter: "note", argument: "note", type: "NVarChar", maxLength: 100 },
      { parameter: "nextVersion", argument: "nextVersion", type: "Int" },
      { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" },
    ],
    projection: [
      { sourceAlias: "order_id", resultField: "orderId", type: "string" },
      { sourceAlias: "work_order_id", resultField: "workOrderId", type: "string" },
      { sourceAlias: "order_status", resultField: "status", type: "string" },
      { sourceAlias: "promise_date", resultField: "promiseDate", type: "string" },
      { sourceAlias: "completion_rate", resultField: "completionRate", type: "integer" },
      { sourceAlias: "progress_note", resultField: "note", type: "string" },
      { sourceAlias: "record_version", resultField: "version", type: "integer" },
    ],
    proposed: [
      { resultField: "completionRate", argument: "completionRate" },
      { resultField: "note", argument: "note", preserveIfMissing: true },
      { resultField: "version", argument: "nextVersion" },
    ],
    declaredObject: "dbo.production_orders",
    resourceParameter: "orderId",
    concurrencyParameter: "expectedVersion",
    updateColumns: ["completion_rate", "note", "version"],
    versionField: "version",
    timeoutMS: 5_000,
  };
}

function readTool(operation: SQLReadOperation): PublicToolContract {
  return {
    name: "query_order_status",
    description: "query order status",
    parameters: {
      type: "object" as const,
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false as const,
    },
    resultFields: operation.projection.map((projection) => projection.resultField),
    resourceType: "business_record" as const,
    resourceKind: "order",
    resourceArg: "orderId",
    resourceRelation: "viewer",
    dataDomain: "manufacturing",
    risk: "read",
    requiresConfirmation: false,
    timeoutMS: 5_000,
    maxResults: 10,
  };
}

function writeTool(operation: SQLUpdateOperation): PublicToolContract {
  return {
    name: "report_production_progress",
    description: "report production progress",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        workOrderId: { type: "string" },
        completionRate: { type: "integer" },
        expectedVersion: { type: "integer" },
        note: { type: "string" },
      },
      required: ["orderId", "workOrderId", "completionRate", "expectedVersion"],
      additionalProperties: false,
    },
    resultFields: operation.projection.map((projection) => projection.resultField),
    resourceType: "business_record",
    resourceKind: "order",
    resourceArg: "orderId",
    resourceRelation: "operator",
    dataDomain: "manufacturing",
    risk: "low_write",
    requiresConfirmation: true,
    timeoutMS: 5_000,
    maxResults: 1,
  };
}

function loaded(replacement?: SQLReadOperation | SQLUpdateOperation): LoadedApprovedConnector {
  const read = replacement?.kind === "read" ? replacement : readOperation();
  const update = replacement?.kind === "update" ? replacement : updateOperation();
  const publicContract = { tools: [readTool(read), writeTool(update)] };
  return {
    ref: { connectorId: "sql-orders", version: "1.0.0" },
    path: "fixture.ma-connector",
    manifest: {
      connectorId: "sql-orders",
      version: "1.0.0",
      adapter: "sqlserver",
      environment: "test",
      digest: DIGEST,
      publicContract,
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
      operations: [read, update],
      publicContract,
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
    expect(f.dependencies.createSource).not.toHaveBeenCalled();
  });

  it.each(["beforeSql", "updateSql", "readBackSql"] as const)(
    "rejects workOrderId targeting an unrelated column in %s before credential or source access",
    async (target) => {
      const f = fixture();
      const connector = loaded();
      const operation = connector.payload.operations[1];
      if (operation.kind !== "update") throw new Error("test fixture");
      operation[target] = operation[target].replace(
        "work_order_id = @workOrderId",
        "status = @workOrderId",
      );
      f.loadApproved.mockReturnValue(connector);

      const result = await f.runtime.execute(request({
        tool: "report_production_progress",
        risk: "low_write",
        requiresConfirmation: true,
        args: {
          orderId: "ORD-1001",
          workOrderId: "WO-1001",
          completionRate: 80,
          expectedVersion: 1,
        },
      }), async () => true);

      expect(result.error).toBe("permission_denied");
      expect(f.credentialGet).not.toHaveBeenCalled();
      expect(f.dependencies.createSource).not.toHaveBeenCalled();
    },
  );

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
      tool: "report_production_progress",
      risk: "low_write",
      requiresConfirmation: true,
      args: {
        orderId: "ORD-1001",
        workOrderId: "WO-1001",
        completionRate: 80,
        expectedVersion: 1,
        note: "done",
      },
    });

    const denied = await f.runtime.execute(write, async () => false);
    const accepted = await f.runtime.execute({ ...write, idempotencyKey: "idem-2" }, async () => true);

    expect(denied.meta.status).toBe("cancelled");
    expect(f.source.previewUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedVersion: 1, nextVersion: 2 }),
      expect.any(AbortSignal),
    );
    expect(f.source.executeConfirmedUpdate).toHaveBeenCalledOnce();
    expect(accepted).toMatchObject({ data: { orderId: "ORD-1001", version: 2 }, meta: { confirmed: true } });
  });

  it("defensively denies an arbitrary manifest tool before credentials", async () => {
    const f = fixture();
    const connector = loaded();
    connector.manifest.publicContract.tools[1].name = "update_order_status";
    connector.payload.publicContract.tools[1].name = "update_order_status";
    connector.payload.operations[1].tool = "update_order_status";
    f.loadApproved.mockReturnValue(connector);

    const result = await f.runtime.execute(request({
      tool: "update_order_status",
      risk: "low_write",
      requiresConfirmation: true,
      args: { orderId: "ORD-1001" },
    }), async () => true);

    expect(result.error).toBe("permission_denied");
    expect(f.credentialGet).not.toHaveBeenCalled();
  });

  it("defensively denies a malformed fixed binding before credential or source access", async () => {
    const f = fixture();
    const connector = loaded();
    const operation = connector.payload.operations[1];
    operation.bindings[2] = {
      parameter: "completionRate",
      argument: "completionRate",
      type: "NVarChar",
      maxLength: 16,
    };
    f.loadApproved.mockReturnValue(connector);

    const result = await f.runtime.execute(request({
      tool: "report_production_progress",
      risk: "low_write",
      requiresConfirmation: true,
      args: {
        orderId: "ORD-1001",
        workOrderId: "WO-1001",
        completionRate: 80,
        expectedVersion: 1,
      },
    }), async () => true);

    expect(result.error).toBe("permission_denied");
    expect(f.credentialGet).not.toHaveBeenCalled();
    expect(f.dependencies.createSource).not.toHaveBeenCalled();
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
