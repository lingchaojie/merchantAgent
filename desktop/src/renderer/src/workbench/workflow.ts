import type {
  WorkbenchConnectorDraft,
  WorkbenchEnvironment,
  WorkbenchPublicToolContract,
  WorkbenchSessionView,
  WorkbenchSQLOperation,
} from "../../../shared/connector-contract";

export type ToolName = "query_order_status" | "report_production_progress";

export interface ProfileForm {
  connectorId: string; version: string; profileId: string; server: string; instance: string;
  port: string; database: string; caPath: string; connectTimeoutMS: number; queryTimeoutMS: number;
  credentialRef: string; environment: WorkbenchEnvironment;
}

export interface OperationForm {
  querySql: string; beforeSql: string; updateSql: string; readBackSql: string;
  orderId: string; workOrderId: string; completionRate: number; expectedVersion: number; note: string;
}

export interface OperationEvidence {
  args: Record<string, unknown>;
  projected: unknown;
  sql: string;
}

export interface WorkbenchEvidence {
  draftKey: string;
  connection?: { environment: WorkbenchEnvironment };
  operations: Partial<Record<ToolName, OperationEvidence>>;
}

export const DEFAULT_PROFILE: ProfileForm = {
  connectorId: "sql-orders", version: "1.0.0", profileId: "erp-test", server: "",
  instance: "", port: "1433", database: "", caPath: "", connectTimeoutMS: 5_000,
  queryTimeoutMS: 5_000, credentialRef: "erp-test-credential", environment: "test",
};

export const DEFAULT_OPERATIONS: OperationForm = {
  querySql: "SELECT TOP 10 o.order_id AS order_id, o.status AS status FROM dbo.production_orders o WHERE o.order_id = @orderId",
  beforeSql: "SELECT o.order_id AS order_id, o.work_order_id AS work_order_id, o.completion_rate AS completion_rate, o.note AS note, o.version AS version FROM dbo.production_orders o WHERE o.order_id = @orderId AND o.work_order_id = @workOrderId",
  updateSql: "UPDATE dbo.production_orders SET completion_rate = @completionRate, note = @note, version = @nextVersion WHERE order_id = @orderId AND work_order_id = @workOrderId AND version = @expectedVersion",
  readBackSql: "SELECT o.order_id AS order_id, o.work_order_id AS work_order_id, o.completion_rate AS completion_rate, o.note AS note, o.version AS version FROM dbo.production_orders o WHERE o.order_id = @orderId AND o.work_order_id = @workOrderId",
  orderId: "ORD-1001", workOrderId: "WO-1001", completionRate: 80, expectedVersion: 1, note: "",
};

export function publicTools(profile: ProfileForm): WorkbenchPublicToolContract[] {
  return [{
    name: "query_order_status", description: "查询订单状态",
    parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"], additionalProperties: false },
    resultFields: ["orderId", "status"], resourceType: "business_record", resourceKind: "order",
    resourceArg: "orderId", resourceRelation: "viewer", dataDomain: "orders", risk: "read",
    requiresConfirmation: false, timeoutMS: profile.queryTimeoutMS, maxResults: 10,
  }, {
    name: "report_production_progress", description: "上报生产进度",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string" }, workOrderId: { type: "string" }, completionRate: { type: "integer" },
        expectedVersion: { type: "integer" }, note: { type: "string" },
      },
      required: ["orderId", "workOrderId", "completionRate", "expectedVersion"], additionalProperties: false,
    },
    resultFields: ["orderId", "workOrderId", "completionRate", "note", "version"],
    resourceType: "business_record", resourceKind: "order", resourceArg: "orderId",
    resourceRelation: "operator", dataDomain: "orders", risk: "low_write", requiresConfirmation: true,
    timeoutMS: profile.queryTimeoutMS, maxResults: 1,
  }];
}

export function operations(profile: ProfileForm, form: OperationForm): WorkbenchSQLOperation[] {
  return [{
    kind: "read", tool: "query_order_status", sql: form.querySql,
    bindings: [{ parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 }],
    projection: [
      { sourceAlias: "order_id", resultField: "orderId", type: "string" },
      { sourceAlias: "status", resultField: "status", type: "string" },
    ],
    declaredObjects: ["dbo.production_orders"], maxResults: 10, timeoutMS: profile.queryTimeoutMS,
  }, {
    kind: "update", tool: "report_production_progress", beforeSql: form.beforeSql,
    updateSql: form.updateSql, readBackSql: form.readBackSql,
    bindings: [
      { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 },
      { parameter: "workOrderId", argument: "workOrderId", type: "NVarChar", maxLength: 64 },
      { parameter: "completionRate", argument: "completionRate", type: "Int" },
      { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" },
      { parameter: "note", argument: "note", type: "NVarChar", maxLength: 200 },
      { parameter: "nextVersion", argument: "nextVersion", type: "Int" },
    ],
    projection: [
      { sourceAlias: "order_id", resultField: "orderId", type: "string" },
      { sourceAlias: "work_order_id", resultField: "workOrderId", type: "string" },
      { sourceAlias: "completion_rate", resultField: "completionRate", type: "integer" },
      { sourceAlias: "note", resultField: "note", type: "string" },
      { sourceAlias: "version", resultField: "version", type: "integer" },
    ],
    proposed: [
      { resultField: "completionRate", argument: "completionRate" },
      { resultField: "note", argument: "note", preserveIfMissing: true },
      { resultField: "version", argument: "nextVersion" },
    ],
    declaredObject: "dbo.production_orders", resourceParameter: "orderId",
    concurrencyParameter: "expectedVersion", updateColumns: ["completion_rate", "note", "version"],
    versionField: "version", timeoutMS: profile.queryTimeoutMS,
  }];
}

export function operationArgs(tool: ToolName, form: OperationForm): Record<string, unknown> {
  return tool === "query_order_status"
    ? { orderId: form.orderId }
    : {
      orderId: form.orderId, workOrderId: form.workOrderId, completionRate: form.completionRate,
      expectedVersion: form.expectedVersion, ...(form.note ? { note: form.note } : {}),
    };
}

export function operationSQL(tool: ToolName, profile: ProfileForm, form: OperationForm): string {
  const operation = operations(profile, form).find((candidate) => candidate.tool === tool)!;
  return operation.kind === "read"
    ? operation.sql
    : `${operation.beforeSql}\n${operation.updateSql}\n${operation.readBackSql}`;
}

export function currentDraftKey(profile: ProfileForm, form: OperationForm): string {
  return canonicalJSON({ profile, operations: operations(profile, form), args: {
    query_order_status: operationArgs("query_order_status", form),
    report_production_progress: operationArgs("report_production_progress", form),
  } });
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function evidenceDigest(evidence: WorkbenchEvidence): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJSON(evidence));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function evidenceComplete(evidence: WorkbenchEvidence, draftKey: string): boolean {
  return evidence.draftKey === draftKey
    && evidence.connection !== undefined
    && evidence.operations.query_order_status !== undefined
    && evidence.operations.report_production_progress !== undefined;
}

export function makeDraft(
  enrollment: { deviceId: string }, session: WorkbenchSessionView, profile: ProfileForm,
  form: OperationForm, draftId: string, testsDigest: string,
): WorkbenchConnectorDraft {
  return {
    draftId, tenantId: session.tenantId, deviceId: enrollment.deviceId, state: "draft",
    payload: {
      schemaVersion: 1, connectorId: profile.connectorId, version: profile.version, adapter: "sqlserver",
      profile: {
        profileId: profile.profileId, server: profile.server,
        ...(profile.instance ? { instance: profile.instance } : {}),
        ...(profile.port ? { port: Number(profile.port) } : {}), database: profile.database,
        encrypt: true, trustServerCertificate: false, ...(profile.caPath ? { caPath: profile.caPath } : {}),
        connectTimeoutMS: profile.connectTimeoutMS, queryTimeoutMS: profile.queryTimeoutMS,
        credentialRef: profile.credentialRef, environment: profile.environment,
      },
      operations: operations(profile, form), publicContract: { tools: publicTools(profile) },
      checker: { version: "m7.1-checker-1", rulesetVersion: "m7.1-sql-v1", testsDigest },
    },
  };
}
