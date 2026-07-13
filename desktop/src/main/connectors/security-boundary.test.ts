import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatEvent, LocalToolRequest } from "../../shared/contract";
import { client, submitInstalledConnector } from "../agentd";
import type { ConnectorSigningIdentity } from "./device-identity";
import { parseConnectorDraft, type ConnectorDraft, type PublicToolContract, type VerifiedImplementationCredential } from "./schema";
import type { InstalledConnector, LoadedApprovedConnector } from "./package-store";
import { ConnectorRuntime } from "./runtime";
import { WorkbenchService, type WorkbenchServiceDependencies } from "./workbench-service";

const DIGEST = `sha256:${"a".repeat(64)}`;
const CANARIES = Object.freeze({
  object: "secret_schema.secret_orders",
  server: "secret-server.boundary.invalid",
  database: "secret_boundary_database",
  username: "secret-boundary-username",
  credentialRef: "secret-boundary-credential-ref",
  password: "secret-boundary-password-value",
  workbenchOrder: "SECRET-WORKBENCH-ORDER",
  workbenchWorkOrder: "SECRET-WORKBENCH-WORK-ORDER",
  rawRow: "secret-boundary-internal-cost-row",
  rawResponse: "secret-boundary-raw-source-response",
  implementationCredential: "secret-boundary-implementation-credential",
  privateKey: "secret-boundary-private-key",
});

function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: bytes };
        },
      }),
    },
  } as unknown as Response;
}

function boundaryDraft(): ConnectorDraft {
  const columns = "o.order_id AS order_id, o.work_order_id AS work_order_id, o.status AS order_status, o.promise_date AS promise_date, o.completion_rate AS completion_rate, o.note AS progress_note, o.version AS record_version";
  const readSql = `SELECT TOP 1 ${columns} FROM ${CANARIES.object} AS o WHERE o.order_id = @orderId`;
  const beforeSql = `SELECT ${columns} FROM ${CANARIES.object} AS o WHERE o.order_id = @orderId AND o.work_order_id = @workOrderId`;
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
    declaredObjects: [CANARIES.object],
    maxResults: 1,
    timeoutMS: 10_000,
  };
  const update = {
    kind: "update" as const,
    tool: "report_production_progress",
    beforeSql,
    updateSql: `UPDATE ${CANARIES.object} SET completion_rate = @completionRate, note = @note, version = @nextVersion WHERE order_id = @orderId AND work_order_id = @workOrderId AND version = @expectedVersion`,
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
    declaredObject: CANARIES.object,
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
        server: CANARIES.server,
        port: 11433,
        database: CANARIES.database,
        encrypt: true,
        trustServerCertificate: false,
        connectTimeoutMS: 5_000,
        queryTimeoutMS: 10_000,
        credentialRef: CANARIES.credentialRef,
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
  parseConnectorDraft(draft);
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
  const identity: ConnectorSigningIdentity = {
    deviceId: draft.deviceId,
    devicePublicKeyPem: credential.devicePublicKeyPem,
    fingerprint: DIGEST,
    tenantId: draft.tenantId,
    platformPublicKeyPem: "PUBLIC PLATFORM KEY",
    implementationCredential: CANARIES.implementationCredential,
    verifiedCredential: credential,
    assertCurrentAuthorization: () => credential,
    sign: () => Buffer.from(CANARIES.privateKey).toString("base64url"),
  };
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "merchant-agent-boundary-"));
  const packagePath = path.join(temporaryDirectory, "fixture.ma-connector");
  const installed: InstalledConnector = { ref: connector.ref, path: packagePath, manifest: connector.manifest };
  fs.writeFileSync(packagePath, JSON.stringify({
    manifest: connector.manifest,
    encryptedPayload: Buffer.from(JSON.stringify(draft.payload)).toString("base64"),
    implementationCredential: CANARIES.implementationCredential,
    implementationSignature: Buffer.from("boundary-signature").toString("base64url"),
  }));

  const localRequest: LocalToolRequest = {
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
    idempotencyKey: "public-idempotency-id",
    risk: "read",
    requiresConfirmation: false,
    args: { orderId: "ORD-PUBLIC-1001" },
  };
  const stream = `event: local_tool_request\ndata: ${JSON.stringify({ kind: "local_tool_request", ...localRequest })}\n\n`
    + 'event: done\ndata: {"kind":"done","text":"done"}\n\n';
  let submissionBody = "";
  let chatBody = "";
  let localResultBody = "";
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: { body?: string }) => {
    const target = String(url);
    if (target.endsWith("/implementation/connectors")) {
      submissionBody = options?.body ?? "";
      return { ok: true, text: async () => JSON.stringify({ digest: DIGEST, status: "pending_admin_approval" }) } as Response;
    }
    if (target.endsWith("/chat/local-tool-result")) {
      localResultBody = options?.body ?? "";
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    if (target.endsWith("/chat")) {
      chatBody = options?.body ?? "";
      return sseResponse(stream);
    }
    throw new Error(`unexpected fetch ${target}`);
  }));

  const testedArguments: Record<string, unknown>[] = [];
  const workbenchDependencies: WorkbenchServiceDependencies = {
    tenantId: draft.tenantId,
    enrollment: identity,
    bindCredential: vi.fn(() => identity),
    vault: { put: vi.fn(async () => undefined) },
    createTester: vi.fn(() => ({
      testConnection: vi.fn(async () => ({ environment: "test" as const, latencyMS: 3 })),
      testOperation: vi.fn(async (operation, args) => {
        testedArguments.push(args);
        return operation.kind === "read"
          ? { raw: [{ internal_cost: CANARIES.rawRow }], projected: [{ orderId: CANARIES.workbenchOrder }] }
          : { raw: [], projected: { completionRate: 80, version: 2 } };
      }),
      close: vi.fn(async () => undefined),
    })),
    createPackageStore: vi.fn(() => ({ install: () => installed })),
    submitter: { submit: submitInstalledConnector },
    now: () => new Date("2026-07-13T10:00:00Z"),
    id: (() => { let id = 0; return () => `boundary-${++id}`; })(),
  };
  const workbench = new WorkbenchService(workbenchDependencies);
  const source = {
    executeRead: vi.fn(async () => [{
      orderId: "ORD-PUBLIC-1001", workOrderId: "WO-PUBLIC-2001", status: "in_production",
      promiseDate: "2026-07-20", completionRate: 45, note: "line stable", version: 4,
      rawResponse: CANARIES.rawResponse,
    }]),
    resumeUpdate: vi.fn(async () => null),
    previewUpdate: vi.fn(),
    executeConfirmedUpdate: vi.fn(),
  };
  const runtime = new ConnectorRuntime({
    tenantId: draft.tenantId,
    approvals: { getApproval: vi.fn(async () => ({ digest: DIGEST, status: "published" as const })) },
    packages: { loadApproved: vi.fn(() => connector) },
    vault: { get: vi.fn(async () => ({ username: CANARIES.username, password: CANARIES.password })) },
    createSource: vi.fn(() => source),
    executionId: () => "execution-m71",
  });

  try {
    const session = await workbench.unlock(CANARIES.implementationCredential);
    await workbench.saveDraft(session.sessionId, draft);
    const readTest = await workbench.testOperation(
      session.sessionId, draft.draftId, "query_order_status", { orderId: CANARIES.workbenchOrder },
    );
    await workbench.testOperation(session.sessionId, draft.draftId, "report_production_progress", {
      orderId: CANARIES.workbenchOrder,
      workOrderId: CANARIES.workbenchWorkOrder,
      completionRate: 80,
      expectedVersion: 1,
    });
    expect(testedArguments).toEqual([
      { orderId: CANARIES.workbenchOrder },
      expect.objectContaining({ orderId: CANARIES.workbenchOrder, workOrderId: CANARIES.workbenchWorkOrder }),
    ]);
    const workbenchRawDuringTest = JSON.stringify(readTest.raw);
    workbench.closeResult(session.sessionId, readTest.resultId);
    let workbenchRawAfterClose = "";
    try {
      workbenchRawAfterClose = JSON.stringify(workbench.readResult(session.sessionId, readTest.resultId).raw);
    } catch {
      workbenchRawAfterClose = "";
    }
    await workbench.validateAndFreeze(session.sessionId, draft.draftId);
    await workbench.submit(session.sessionId, draft.draftId);

    const ordinaryEvents: ChatEvent[] = [];
    await client.chat(
      { sessionId: "session-public", userId: "u_sales1", question: "public status request" },
      (event) => ordinaryEvents.push(event),
      undefined,
      (request) => runtime.execute(request, async () => false),
    );

    return {
      surfaces: [
        submissionBody,
        chatBody,
        localResultBody,
        JSON.stringify(ordinaryEvents),
        JSON.stringify(workbench.diagnosticState()),
      ],
      privateCanaries: [
        (draft.payload.operations[0] as { sql: string }).sql,
        (draft.payload.operations[1] as { updateSql: string }).updateSql,
        ...Object.values(CANARIES),
      ],
      localResultBody,
      ordinaryEvents,
      workbenchRawDuringTest,
      workbenchRawAfterClose,
    };
  } finally {
    workbench.close();
    await runtime.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

describe("M7.1 security boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("captures real cloud and ordinary UI boundaries without private implementation material", async () => {
    const evidence = await runM71BoundaryScenario();
    expect(evidence.localResultBody).toContain('"sourceProfileId":"erp-test"');
    expect(evidence.localResultBody).toContain('"environment":"test"');
    expect(evidence.localResultBody).toContain('"readBackStatus":"not_applicable"');
    expect(evidence.localResultBody).toMatch(/"durationMs":\d+/);
    expect(evidence.ordinaryEvents).toEqual([{ kind: "done", text: "done" }]);
    for (const surface of evidence.surfaces) {
      for (const canary of evidence.privateCanaries) {
        expect(surface).not.toContain(canary);
      }
    }
    for (const canary of evidence.privateCanaries) {
      if (canary !== CANARIES.rawRow) expect(evidence.workbenchRawDuringTest).not.toContain(canary);
    }
    expect(evidence.workbenchRawDuringTest).toContain(CANARIES.rawRow);
    expect(evidence.workbenchRawAfterClose).toBe("");
  });
});
