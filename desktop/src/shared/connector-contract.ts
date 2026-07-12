export interface WorkbenchCredential { username: string; password: string }
export type WorkbenchEnvironment = "test" | "preproduction";
export interface WorkbenchParameterProperty {
  type: "string" | "integer" | "boolean";
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  enum?: Array<string | number | boolean>;
}
export interface WorkbenchPublicToolContract {
  name: string; description: string;
  parameters: {
    type: "object";
    properties: Record<string, WorkbenchParameterProperty>;
    required: string[];
    additionalProperties: false;
  };
  resultFields: string[];
  resourceType: "business_record";
  resourceKind: string; resourceArg: string;
  resourceRelation: "viewer" | "operator";
  dataDomain: string;
  risk: "read" | "low_write";
  requiresConfirmation: boolean; timeoutMS: number; maxResults: number;
}
export type WorkbenchSQLBinding =
  | { parameter: string; argument: string; type: "NVarChar"; maxLength: number }
  | { parameter: string; argument: string; type: "Int" };
export interface WorkbenchSQLProjection {
  sourceAlias: string; resultField: string; type: "string" | "integer";
}
export type WorkbenchSQLOperation = {
  kind: "read"; tool: string; sql: string;
  bindings: WorkbenchSQLBinding[]; projection: WorkbenchSQLProjection[];
  declaredObjects: string[]; maxResults: number; timeoutMS: number;
} | {
  kind: "update"; tool: string; beforeSql: string; updateSql: string; readBackSql: string;
  bindings: WorkbenchSQLBinding[]; projection: WorkbenchSQLProjection[];
  proposed: Array<{ resultField: string; argument?: string; preserveIfMissing?: boolean }>;
  declaredObject: string; resourceParameter: string; concurrencyParameter: string;
  updateColumns: string[]; versionField: string; timeoutMS: number;
};
export interface WorkbenchConnectorDraft {
  draftId: string; tenantId: string; deviceId: string; state: "draft" | "locally_validated";
  payload: {
    schemaVersion: 1; connectorId: string; version: string; adapter: "sqlserver";
    profile: {
      profileId: string; server: string; instance?: string; port?: number; database: string;
      encrypt: true; trustServerCertificate: false; caPath?: string;
      connectTimeoutMS: number; queryTimeoutMS: number; credentialRef: string;
      environment: WorkbenchEnvironment;
    };
    operations: WorkbenchSQLOperation[];
    publicContract: { tools: WorkbenchPublicToolContract[] };
    checker: { version: string; rulesetVersion: "m7.1-sql-v1"; testsDigest: string };
  };
}
export interface WorkbenchSessionView {
  sessionId: string; tenantId: string; deviceId: string; expiresAt: string; scopes: string[];
}
export interface WorkbenchConnectionTestView { environment: WorkbenchEnvironment; latencyMS: number }
export interface WorkbenchTestResultView {
  resultId: string; raw: unknown;
  projected: Record<string, unknown> | Record<string, unknown>[];
  expiresAt: string;
}
export interface WorkbenchValidationSummary {
  digest: string; checkerVersion: string; rulesetVersion: "m7.1-sql-v1"; testsDigest: string;
  publicContract: { tools: WorkbenchPublicToolContract[] };
}
export interface WorkbenchAPI {
  getEnrollment(): Promise<{ deviceId: string; devicePublicKeyPem: string; fingerprint: string }>;
  unlock(encodedCredential: string): Promise<WorkbenchSessionView>;
  saveCredential(sessionId: string, ref: string, credential: WorkbenchCredential): Promise<void>;
  saveDraft(sessionId: string, draft: WorkbenchConnectorDraft): Promise<{ draftId: string }>;
  testConnection(sessionId: string, draftId: string): Promise<WorkbenchConnectionTestView>;
  testOperation(sessionId: string, draftId: string, args: Record<string, unknown>): Promise<WorkbenchTestResultView>;
  closeResult(sessionId: string, resultId: string): Promise<void>;
  validateAndFreeze(sessionId: string, draftId: string): Promise<WorkbenchValidationSummary>;
  submit(sessionId: string, draftId: string): Promise<{ digest: string; status: "pending_admin_approval" }>;
  lock(sessionId: string): Promise<void>;
}
export const WorkbenchChannels = {
  enrollment: "workbench:enrollment", unlock: "workbench:unlock",
  saveCredential: "workbench:credential:save", saveDraft: "workbench:draft:save",
  testConnection: "workbench:test:connection", testOperation: "workbench:test:operation",
  closeResult: "workbench:result:close", validateAndFreeze: "workbench:draft:freeze",
  submit: "workbench:draft:submit", lock: "workbench:lock",
} as const;
export interface WorkbenchSessionReq { sessionId: string }
export interface WorkbenchUnlockReq { encodedCredential: string }
export interface WorkbenchCredentialReq extends WorkbenchSessionReq { ref: string; credential: WorkbenchCredential }
export interface WorkbenchDraftReq extends WorkbenchSessionReq { draft: WorkbenchConnectorDraft }
export interface WorkbenchDraftIdReq extends WorkbenchSessionReq { draftId: string }
export interface WorkbenchOperationReq extends WorkbenchDraftIdReq { args: Record<string, unknown> }
export interface WorkbenchResultReq extends WorkbenchSessionReq { resultId: string }
