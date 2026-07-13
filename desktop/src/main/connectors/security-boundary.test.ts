import { describe, expect, it, vi } from "vitest";

import type { LocalToolRequest } from "../../shared/contract";
import type { ConnectorDraft, PublicToolContract, VerifiedImplementationCredential } from "./schema";
import type { LoadedApprovedConnector } from "./package-store";
import { ConnectorRuntime } from "./runtime";
import { WorkbenchService, type WorkbenchServiceDependencies } from "./workbench-service";

const DIGEST = `sha256:${"a".repeat(64)}`;

function boundaryDraft(): ConnectorDraft {
  const columns = "o.order_id AS order_id, o.work_order_id AS work_order_id, o.status AS order_status, o.promise_date AS promise_date, o.completion_rate AS completion_rate, o.note AS progress_note, o.version AS record_version";
  const readSql = `SELECT TOP 1 ${columns} FROM dbo.production_orders AS o WHERE o.order_id = @orderId`;
  const beforeSql = `SELECT ${columns} FROM dbo.production_orders AS o WHERE o.order_id = @orderId AND o.work_order_id = @workOrderId`;
  const projection = [
    { sourceAlias: "order_id", resultField: "orderId", type: "string" as const },
    { sourceAlias: "work_order_id", resultField: "workOrderId", type: "string" as const },
    { sourceAlias: "order_status", resultField: "status", type: "string" as const },
    { sourceAlias: "promise_date", resultField: "promiseDate", type: "string" as const },
    { sourceAlias: "completion_rate", resultField: "completionRate", type: "integer" as const },
    { sourceAlias: "progress_note", resultField: "note", type: "string" as const },
    { sourceAlias: "record_version", resultField: "version", type: "integer" as const },
  ];
  const read = {
    kind: "read" as const,
    tool: "query_order_status",
    sql: readSql,
    bindings: [{ parameter: "orderId", argument: "orderId", type: "NVarChar" as const, maxLength: 64 }],
    projection,
    declaredObjects: ["dbo.production_orders"],
    maxResults: 1,
    timeoutMS: 10_000,
  };
  const update = {
    kind: "update" as const,
    tool: "report_production_progress",
    beforeSql,
    updateSql: "UPDATE dbo.production_orders SET completion_rate = @completionRate, note = @note, version = @nextVersion WHERE order_id = @orderId AND work_order_id = @workOrderId AND version = @expectedVersion",
    readBackSql: beforeSql,
    bindings: [
      { parameter: "orderId", argument: "orderId", type: "NVarChar" as const, maxLength: 64 },
      { parameter: "workOrderId", argument: "workOrderId", type: "NVarChar" as const, maxLength: 64 },
      { parameter: "completionRate", argument: "completionRate", type: "Int" as const },
      { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" as const },
      { parameter: "note", argument: "note", type: "NVarChar" as const, maxLength: 256 },
      { parameter: "nextVersion", argument: "nextVersion", type: "Int" as const },
    ],
    projection,
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
    timeoutMS: 10_000,
  };
  const resultFields = projection.map((field) => field.resultField);
  const publicContract: { tools: PublicToolContract[] } = { tools: [{
    name: "query_order_status",
    description: "Query order status",
    parameters: {
      type: "object" as const,
      properties: { orderId: { type: "string" as const } },
      required: ["orderId"],
      additionalProperties: false as const,
    },
    resultFields,
    resourceType: "business_record" as const,
    resourceKind: "order",
    resourceArg: "orderId",
    resourceRelation: "viewer",
    dataDomain: "operations",
    risk: "read" as const,
    requiresConfirmation: false,
    timeoutMS: 10_000,
    maxResults: 1,
  }, {
    name: "report_production_progress",
    description: "Report production progress",
    parameters: {
      type: "object" as const,
      properties: {
        orderId: { type: "string" as const },
        workOrderId: { type: "string" as const },
        completionRate: { type: "integer" as const },
        expectedVersion: { type: "integer" as const },
        note: { type: "string" as const },
      },
      required: ["orderId", "workOrderId", "completionRate", "expectedVersion"],
      additionalProperties: false as const,
    },
    resultFields,
    resourceType: "business_record" as const,
    resourceKind: "order",
    resourceArg: "orderId",
    resourceRelation: "operator",
    dataDomain: "operations",
    risk: "low_write" as const,
    requiresConfirmation: true,
    timeoutMS: 10_000,
    maxResults: 1,
  }] };
  return {
    draftId: "draft-m71",
    tenantId: "mock-corp-001",
    deviceId: "device-m71",
    state: "draft",
    payload: {
      schemaVersion: 1,
      connectorId: "sql-orders",
      version: "1.0.0",
      adapter: "sqlserver",
      profile: {
        profileId: "erp-test",
        server: "sql.internal",
        port: 11433,
        database: "merchant_test",
        encrypt: true,
        trustServerCertificate: false,
        connectTimeoutMS: 5_000,
        queryTimeoutMS: 10_000,
        credentialRef: "erp-test",
        environment: "test",
      },
      operations: [read, update],
      publicContract,
      checker: { version: "1.0.0", rulesetVersion: "m7.1-sql-v1", testsDigest: DIGEST },
    },
  };
}

function loadedConnector(draft: ConnectorDraft): LoadedApprovedConnector {
  return {
    ref: { connectorId: draft.payload.connectorId, version: draft.payload.version },
    path: "fixture.ma-connector",
    manifest: {
      connectorId: draft.payload.connectorId,
      version: draft.payload.version,
      adapter: "sqlserver",
      environment: draft.payload.profile.environment,
      digest: DIGEST,
      publicContract: draft.payload.publicContract,
      checks: { checkerVersion: "1.0.0", rulesetVersion: "m7.1-sql-v1", testsDigest: DIGEST },
      credentialId: "implementation-m71",
      deviceId: draft.deviceId,
      signedAt: "2026-07-13T10:00:00Z",
    },
    payload: draft.payload,
  };
}

async function runM71BoundaryScenario() {
  const draft = boundaryDraft();
  const connector = loadedConnector(draft);
  const credential: VerifiedImplementationCredential = {
    credentialId: "implementation-m71",
    tenantId: draft.tenantId,
    deviceId: draft.deviceId,
    devicePublicKeyPem: "PUBLIC KEY",
    scopes: ["connector:draft", "connector:test", "connector:submit"],
    issuedAt: "2026-07-13T09:00:00.000Z",
    expiresAt: "2026-07-13T11:00:00.000Z",
  };
  let submissionBody = "";
  const workbenchDependencies: WorkbenchServiceDependencies = {
    tenantId: draft.tenantId,
    enrollment: { deviceId: draft.deviceId, devicePublicKeyPem: "PUBLIC KEY", fingerprint: DIGEST },
    bindCredential: vi.fn(() => ({ verifiedCredential: credential, implementationCredential: "encoded" }) as never),
    vault: { put: vi.fn(async () => undefined) },
    createTester: vi.fn(() => ({
      testConnection: vi.fn(async () => ({ environment: "test" as const, latencyMS: 3 })),
      testOperation: vi.fn(async () => ({
        raw: [{ order_id: "ORD-1001", internal_cost: 900 }],
        projected: [{ orderId: "ORD-1001" }],
      })),
      close: vi.fn(async () => undefined),
    })),
    createPackageStore: vi.fn(() => ({ install: () => connector }) as never),
    submitter: { submit: vi.fn(async (installed) => {
      submissionBody = JSON.stringify({
        version: {
          connectorId: installed.manifest.connectorId,
          version: installed.manifest.version,
          digest: installed.manifest.digest,
          adapter: installed.manifest.adapter,
          environment: installed.manifest.environment,
          contract: installed.manifest.publicContract,
          checks: installed.manifest.checks,
        },
      });
      return { digest: installed.manifest.digest, status: "pending_admin_approval" as const };
    }) },
    now: () => new Date("2026-07-13T10:00:00Z"),
    id: (() => { let id = 0; return () => `boundary-${++id}`; })(),
  };
  const workbench = new WorkbenchService(workbenchDependencies);
  const session = await workbench.unlock("encoded");
  await workbench.saveDraft(session.sessionId, draft);
  const testResult = await workbench.testOperation(
    session.sessionId,
    draft.draftId,
    "query_order_status",
    { orderId: "ORD-1001", probe: "S3cret" },
  ).catch(async () => workbench.testOperation(
    session.sessionId,
    draft.draftId,
    "query_order_status",
    { orderId: "ORD-1001" },
  ));
  const workbenchRawDuringTest = JSON.stringify(testResult.raw);
  workbench.closeResult(session.sessionId, testResult.resultId);
  let workbenchRawAfterClose = "";
  try {
    workbenchRawAfterClose = JSON.stringify(workbench.readResult(session.sessionId, testResult.resultId).raw);
  } catch {
    workbenchRawAfterClose = "";
  }
  await workbench.validateAndFreeze(session.sessionId, draft.draftId);
  await workbench.submit(session.sessionId, draft.draftId);

  const source = {
    executeRead: vi.fn(async () => [{ orderId: "ORD-1001", workOrderId: "WO-2001", status: "in_production", promiseDate: "2026-07-20", completionRate: 45, note: "line stable", version: 4 }]),
    resumeUpdate: vi.fn(async () => null),
    previewUpdate: vi.fn(),
    executeConfirmedUpdate: vi.fn(),
  };
  const runtime = new ConnectorRuntime({
    tenantId: draft.tenantId,
    approvals: { getApproval: vi.fn(async () => ({ digest: DIGEST, status: "published" as const })) },
    packages: { loadApproved: vi.fn(() => connector) },
    vault: { get: vi.fn(async () => ({ username: "svc", password: "S3cret" })) },
    createSource: vi.fn(() => source),
    executionId: () => "execution-m71",
  });
  const request: LocalToolRequest = {
    reqId: "request-m71",
    packageId: "sql-orders",
    packageVersion: "1.0.0",
    manifestDigest: DIGEST,
    tool: "query_order_status",
    tenantId: draft.tenantId,
    userId: "u_sales1",
    deviceId: draft.deviceId,
    roleIds: ["sales"],
    skillId: "order-status",
    callId: "call-m71",
    idempotencyKey: "one-way-idempotency-id",
    risk: "read",
    requiresConfirmation: false,
    args: { orderId: "ORD-1001" },
  };
  const response = await runtime.execute(request, async () => false);
  const publicExecution = { tool: request.tool, ...response.meta };
  return {
    submissionBody,
    agentdLogs: JSON.stringify({ tool: request.tool, status: response.meta.status }),
    auditJSON: JSON.stringify({ connector: publicExecution }),
    chatEvents: JSON.stringify([{ kind: "tool_state", tool: request.tool, data: { status: response.meta.status } }]),
    diagnosticJSON: JSON.stringify(workbench.diagnosticState()),
    workbenchRawDuringTest,
    workbenchRawAfterClose,
  };
}

describe("M7.1 security boundary", () => {
  it("finds no secret material in cloud payloads, logs, audit, chat IPC, or diagnostic views", async () => {
    const evidence = await runM71BoundaryScenario();
    expect(evidence.auditJSON).toContain('"sourceProfileId":"erp-test"');
    expect(evidence.auditJSON).toContain('"environment":"test"');
    expect(evidence.auditJSON).toContain('"readBackStatus":"not_applicable"');
    expect(evidence.auditJSON).toMatch(/"durationMs":\d+/);
    for (const surface of [evidence.submissionBody, evidence.agentdLogs, evidence.auditJSON, evidence.chatEvents, evidence.diagnosticJSON]) {
      expect(surface).not.toMatch(/SELECT|UPDATE|dbo\.|sql\.internal|S3cret|credentialRef|internal_cost/i);
    }
    expect(evidence.workbenchRawDuringTest).toContain("internal_cost");
    expect(evidence.workbenchRawAfterClose).toBe("");
  });
});
