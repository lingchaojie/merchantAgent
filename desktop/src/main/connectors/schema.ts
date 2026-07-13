import { validateOperationBeforeExecution } from "./sql-policy";
import { assertM71Contract } from "./m7-contract";

export type ConnectorEnvironment = "test" | "preproduction";
export type ConnectorState =
  | "draft"
  | "locally_validated"
  | "pending_admin_approval"
  | "published"
  | "suspended"
  | "revoked";
export type ConnectorErrorCode =
  | "connector_not_installed"
  | "package_integrity"
  | "package_version"
  | "approval_revoked"
  | "missing_credentials"
  | "invalid_credentials"
  | "connection_failed"
  | "tls_failed"
  | "invalid_argument"
  | "unsafe_template"
  | "permission_denied"
  | "record_not_found"
  | "source_conflict"
  | "source_rejected"
  | "failed"
  | "unknown";

export interface ParameterProperty {
  type: "string" | "integer" | "boolean";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: Array<string | number | boolean>;
}

export interface ParameterSchema {
  type: "object";
  properties: Record<string, ParameterProperty>;
  required: string[];
  additionalProperties: false;
}

export interface PublicToolContract {
  name: string;
  description: string;
  parameters: ParameterSchema;
  resultFields: string[];
  resourceType: "business_record";
  resourceKind: string;
  resourceArg: string;
  resourceRelation: "viewer" | "operator";
  dataDomain: string;
  risk: "read" | "low_write";
  requiresConfirmation: boolean;
  timeoutMS: number;
  maxResults: number;
}

export interface SQLServerProfile {
  profileId: string;
  server: string;
  instance?: string;
  port?: number;
  database: string;
  encrypt: true;
  trustServerCertificate: false;
  caPath?: string;
  connectTimeoutMS: number;
  queryTimeoutMS: number;
  credentialRef: string;
  environment: ConnectorEnvironment;
}

interface SQLBindingBase {
  parameter: string;
  argument: string;
}

export type SQLBinding =
  | (SQLBindingBase & { type: "NVarChar"; maxLength: number })
  | (SQLBindingBase & { type: "Int"; maxLength?: never });

export interface SQLProjection {
  sourceAlias: string;
  resultField: string;
  type: "string" | "integer";
}

export interface ProposedField {
  resultField: string;
  argument?: string;
  preserveIfMissing?: boolean;
}

export interface SQLReadOperation {
  kind: "read";
  tool: string;
  sql: string;
  bindings: SQLBinding[];
  projection: SQLProjection[];
  declaredObjects: string[];
  maxResults: number;
  timeoutMS: number;
}

export interface SQLUpdateOperation {
  kind: "update";
  tool: string;
  beforeSql: string;
  updateSql: string;
  readBackSql: string;
  bindings: SQLBinding[];
  projection: SQLProjection[];
  proposed: ProposedField[];
  declaredObject: string;
  resourceParameter: string;
  concurrencyParameter: string;
  updateColumns: string[];
  versionField: string;
  timeoutMS: number;
}

export type SQLOperation = SQLReadOperation | SQLUpdateOperation;

export interface ConnectorDraft {
  draftId: string;
  tenantId: string;
  deviceId: string;
  state: "draft" | "locally_validated";
  payload: ConnectorPrivatePayload;
}

export interface VerifiedImplementationCredential {
  credentialId: string;
  tenantId: string;
  deviceId: string;
  devicePublicKeyPem: string;
  scopes: Array<"connector:draft" | "connector:test" | "connector:submit">;
  issuedAt: string;
  expiresAt: string;
}

export interface ConnectorPrivatePayload {
  schemaVersion: 1;
  connectorId: string;
  version: string;
  adapter: "sqlserver";
  profile: SQLServerProfile;
  operations: SQLOperation[];
  publicContract: { tools: PublicToolContract[] };
  checker: {
    version: string;
    rulesetVersion: "m7.1-sql-v1";
    testsDigest: string;
  };
}

export interface InstalledConnectorEnvelope {
  manifest: {
    connectorId: string;
    version: string;
    adapter: "sqlserver";
    environment: ConnectorEnvironment;
    digest: string;
    publicContract: { tools: PublicToolContract[] };
    checks: {
      checkerVersion: string;
      rulesetVersion: "m7.1-sql-v1";
      testsDigest: string;
    };
    credentialId: string;
    deviceId: string;
    signedAt: string;
  };
  encryptedPayload: string;
  implementationCredential: string;
  implementationSignature: string;
}

export class ConnectorSchemaError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ConnectorSchemaError";
  }
}

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ConnectorError";
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SOURCE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CREDENTIAL_REF = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PACKAGE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isCredentialRef(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL_REF.test(value);
}

export function isSourceProfileId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_PROFILE_ID.test(value);
}

function fail(path: string, detail: string): never {
  throw new ConnectorSchemaError(`${path} ${detail}`);
}

function object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (PROTOTYPE_KEYS.has(key) || !allowedKeys.has(key)) fail(`${path}.${key}`, "is not allowed");
  }
  return record;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) return fail(path, "must be a non-empty string");
  return value;
}

function credentialRef(value: unknown, path: string): string {
  if (!isCredentialRef(value)) return fail(path, "must be an opaque credential ref");
  return value;
}

function sourceProfileId(value: unknown, path: string): string {
  if (!isSourceProfileId(value)) return fail(path, "must be a public source profile ID");
  return value;
}

function identifier(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!IDENTIFIER.test(parsed)) return fail(path, "is not a safe identifier");
  return parsed;
}

function packageSegment(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!PACKAGE_SEGMENT.test(parsed)) return fail(path, "is not a safe package segment");
  return parsed;
}

function integer(value: unknown, path: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, "must be boolean");
  return value;
}

function enumValue<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    return fail(path, `must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function array<T>(value: unknown, path: string, parse: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) return fail(path, "must be an array");
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function stringArray(value: unknown, path: string, requireNonEmpty = false): string[] {
  const parsed = array(value, path, string);
  if (requireNonEmpty && parsed.length === 0) fail(path, "must not be empty");
  if (new Set(parsed).size !== parsed.length) fail(path, "must not contain duplicates");
  return parsed;
}

function optionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  return record[key] === undefined ? undefined : string(record[key], `${path}.${key}`);
}

function optionalInteger(record: Record<string, unknown>, key: string, path: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return record[key] === undefined ? undefined : integer(record[key], `${path}.${key}`, minimum, maximum);
}

function parseParameterProperty(value: unknown, path: string): ParameterProperty {
  const raw = object(value, path, ["type", "minLength", "maxLength", "minimum", "maximum", "enum"]);
  const type = enumValue(raw.type, `${path}.type`, ["string", "integer", "boolean"] as const);
  const minLength = optionalInteger(raw, "minLength", path, 0);
  const maxLength = optionalInteger(raw, "maxLength", path, 0);
  const minimum = optionalInteger(raw, "minimum", path, Number.MIN_SAFE_INTEGER);
  const maximum = optionalInteger(raw, "maximum", path, Number.MIN_SAFE_INTEGER);
  if (type !== "string" && (minLength !== undefined || maxLength !== undefined)) {
    fail(path, "length constraints require a string property");
  }
  if (type !== "integer" && (minimum !== undefined || maximum !== undefined)) {
    fail(path, "numeric constraints require an integer property");
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) fail(path, "has inverted length bounds");
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) fail(path, "has inverted numeric bounds");
  let enumValues: Array<string | number | boolean> | undefined;
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0) fail(`${path}.enum`, "must be a non-empty array");
    enumValues = raw.enum.map((item, index) => {
      if (
        (type === "string" && typeof item !== "string") ||
        (type === "integer" && (!Number.isSafeInteger(item))) ||
        (type === "boolean" && typeof item !== "boolean")
      ) {
        return fail(`${path}.enum[${index}]`, `must match ${type}`);
      }
      return item as string | number | boolean;
    });
    if (new Set(enumValues).size !== enumValues.length) fail(`${path}.enum`, "must not contain duplicates");
  }
  return {
    type,
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
    ...(enumValues === undefined ? {} : { enum: enumValues }),
  };
}

function parseParameterSchema(value: unknown, path: string): ParameterSchema {
  const raw = object(value, path, ["type", "properties", "required", "additionalProperties"]);
  if (raw.type !== "object" || raw.additionalProperties !== false) fail(path, "must be a closed object schema");
  const propertiesRaw = object(raw.properties, `${path}.properties`, Object.keys((raw.properties ?? {}) as object));
  const properties: Record<string, ParameterProperty> = Object.create(null) as Record<string, ParameterProperty>;
  for (const [name, property] of Object.entries(propertiesRaw)) {
    if (!IDENTIFIER.test(name) || PROTOTYPE_KEYS.has(name)) fail(`${path}.properties.${name}`, "has an unsafe name");
    properties[name] = parseParameterProperty(property, `${path}.properties.${name}`);
  }
  const required = stringArray(raw.required, `${path}.required`);
  for (const name of required) if (!Object.hasOwn(properties, name)) fail(`${path}.required`, `contains undeclared property ${name}`);
  return { type: "object", properties, required, additionalProperties: false };
}

function parsePublicTool(value: unknown, path: string): PublicToolContract {
  const raw = object(value, path, [
    "name", "description", "parameters", "resultFields", "resourceType", "resourceKind", "resourceArg",
    "resourceRelation", "dataDomain", "risk", "requiresConfirmation", "timeoutMS", "maxResults",
  ]);
  const parameters = parseParameterSchema(raw.parameters, `${path}.parameters`);
  const risk = enumValue(raw.risk, `${path}.risk`, ["read", "low_write"] as const);
  const requiresConfirmation = boolean(raw.requiresConfirmation, `${path}.requiresConfirmation`);
  if ((risk === "read" && requiresConfirmation) || (risk === "low_write" && !requiresConfirmation)) {
    fail(path, "has an invalid confirmation policy");
  }
  const resourceArg = identifier(raw.resourceArg, `${path}.resourceArg`);
  if (!Object.hasOwn(parameters.properties, resourceArg)) fail(`${path}.resourceArg`, "must name a declared parameter");
  return {
    name: identifier(raw.name, `${path}.name`),
    description: string(raw.description, `${path}.description`),
    parameters,
    resultFields: stringArray(raw.resultFields, `${path}.resultFields`, true),
    resourceType: enumValue(raw.resourceType, `${path}.resourceType`, ["business_record"] as const),
    resourceKind: identifier(raw.resourceKind, `${path}.resourceKind`),
    resourceArg,
    resourceRelation: enumValue(raw.resourceRelation, `${path}.resourceRelation`, ["viewer", "operator"] as const),
    dataDomain: identifier(raw.dataDomain, `${path}.dataDomain`),
    risk,
    requiresConfirmation,
    timeoutMS: integer(raw.timeoutMS, `${path}.timeoutMS`),
    maxResults: integer(raw.maxResults, `${path}.maxResults`, 1, 100),
  };
}

function parsePublicContract(value: unknown, path: string): { tools: PublicToolContract[] } {
  const raw = object(value, path, ["tools"]);
  const tools = array(raw.tools, `${path}.tools`, parsePublicTool);
  if (tools.length === 0) fail(`${path}.tools`, "must not be empty");
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) fail(`${path}.tools`, "contains duplicate tool names");
  return { tools };
}

function parseProfile(value: unknown, path: string): SQLServerProfile {
  const raw = object(value, path, [
    "profileId", "server", "instance", "port", "database", "encrypt", "trustServerCertificate", "caPath",
    "connectTimeoutMS", "queryTimeoutMS", "credentialRef", "environment",
  ]);
  if (raw.encrypt !== true || raw.trustServerCertificate !== false) fail(path, "must require verified TLS");
  const profileId = sourceProfileId(raw.profileId, `${path}.profileId`);
  const parsedCredentialRef = credentialRef(raw.credentialRef, `${path}.credentialRef`);
  if (profileId === parsedCredentialRef) {
    fail(`${path}.credentialRef`, "must be distinct from profileId");
  }
  return {
    profileId,
    server: string(raw.server, `${path}.server`),
    ...(raw.instance === undefined ? {} : { instance: string(raw.instance, `${path}.instance`) }),
    ...(raw.port === undefined ? {} : { port: integer(raw.port, `${path}.port`, 1, 65535) }),
    database: string(raw.database, `${path}.database`),
    encrypt: true,
    trustServerCertificate: false,
    ...(raw.caPath === undefined ? {} : { caPath: string(raw.caPath, `${path}.caPath`) }),
    connectTimeoutMS: integer(raw.connectTimeoutMS, `${path}.connectTimeoutMS`, 1_000, 30_000),
    queryTimeoutMS: integer(raw.queryTimeoutMS, `${path}.queryTimeoutMS`, 1_000, 10_000),
    credentialRef: parsedCredentialRef,
    environment: enumValue(raw.environment, `${path}.environment`, ["test", "preproduction"] as const),
  };
}

function parseBinding(value: unknown, path: string): SQLBinding {
  const raw = object(value, path, ["parameter", "argument", "type", "maxLength"]);
  const type = enumValue(raw.type, `${path}.type`, ["NVarChar", "Int"] as const);
  const parameter = identifier(raw.parameter, `${path}.parameter`);
  const argument = identifier(raw.argument, `${path}.argument`);
  if (type === "NVarChar") {
    const maxLength = optionalInteger(raw, "maxLength", path, 1, 4_000);
    if (maxLength === undefined) fail(`${path}.maxLength`, "is required for NVarChar");
    return { parameter, argument, type, maxLength };
  }
  if (raw.maxLength !== undefined) fail(`${path}.maxLength`, "is only valid for NVarChar");
  return { parameter, argument, type };
}

function parseProjection(value: unknown, path: string): SQLProjection {
  const raw = object(value, path, ["sourceAlias", "resultField", "type"]);
  return {
    sourceAlias: identifier(raw.sourceAlias, `${path}.sourceAlias`),
    resultField: identifier(raw.resultField, `${path}.resultField`),
    type: enumValue(raw.type, `${path}.type`, ["string", "integer"] as const),
  };
}

function parseProposed(value: unknown, path: string): ProposedField {
  const raw = object(value, path, ["resultField", "argument", "preserveIfMissing"]);
  return {
    resultField: identifier(raw.resultField, `${path}.resultField`),
    ...(raw.argument === undefined ? {} : { argument: identifier(raw.argument, `${path}.argument`) }),
    ...(raw.preserveIfMissing === undefined ? {} : { preserveIfMissing: boolean(raw.preserveIfMissing, `${path}.preserveIfMissing`) }),
  };
}

function parseOperation(value: unknown, path: string): SQLOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(path, "must be an object");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "read") {
    const raw = object(value, path, ["kind", "tool", "sql", "bindings", "projection", "declaredObjects", "maxResults", "timeoutMS"]);
    return {
      kind: "read",
      tool: identifier(raw.tool, `${path}.tool`),
      sql: string(raw.sql, `${path}.sql`),
      bindings: array(raw.bindings, `${path}.bindings`, parseBinding),
      projection: array(raw.projection, `${path}.projection`, parseProjection),
      declaredObjects: stringArray(raw.declaredObjects, `${path}.declaredObjects`, true),
      maxResults: integer(raw.maxResults, `${path}.maxResults`, 1, 100),
      timeoutMS: integer(raw.timeoutMS, `${path}.timeoutMS`),
    };
  }
  if (kind === "update") {
    const raw = object(value, path, [
      "kind", "tool", "beforeSql", "updateSql", "readBackSql", "bindings", "projection", "proposed",
      "declaredObject", "resourceParameter", "concurrencyParameter", "updateColumns", "versionField", "timeoutMS",
    ]);
    return {
      kind: "update",
      tool: identifier(raw.tool, `${path}.tool`),
      beforeSql: string(raw.beforeSql, `${path}.beforeSql`),
      updateSql: string(raw.updateSql, `${path}.updateSql`),
      readBackSql: string(raw.readBackSql, `${path}.readBackSql`),
      bindings: array(raw.bindings, `${path}.bindings`, parseBinding),
      projection: array(raw.projection, `${path}.projection`, parseProjection),
      proposed: array(raw.proposed, `${path}.proposed`, parseProposed),
      declaredObject: string(raw.declaredObject, `${path}.declaredObject`),
      resourceParameter: identifier(raw.resourceParameter, `${path}.resourceParameter`),
      concurrencyParameter: identifier(raw.concurrencyParameter, `${path}.concurrencyParameter`),
      updateColumns: stringArray(raw.updateColumns, `${path}.updateColumns`, true),
      versionField: identifier(raw.versionField, `${path}.versionField`),
      timeoutMS: integer(raw.timeoutMS, `${path}.timeoutMS`),
    };
  }
  return fail(`${path}.kind`, "must be read or update");
}

export function parseConnectorPrivatePayload(value: unknown): ConnectorPrivatePayload {
  const raw = object(value, "payload", ["schemaVersion", "connectorId", "version", "adapter", "profile", "operations", "publicContract", "checker"]);
  if (raw.schemaVersion !== 1 || raw.adapter !== "sqlserver") fail("payload", "has an unsupported schema or adapter");
  const profile = parseProfile(raw.profile, "payload.profile");
  const operations = array(raw.operations, "payload.operations", parseOperation);
  for (const operation of operations) validateOperationBeforeExecution(operation);
  const publicContract = parsePublicContract(raw.publicContract, "payload.publicContract");
  const operationTools = new Set(operations.map((operation) => operation.tool));
  if (operationTools.size !== operations.length) fail("payload.operations", "contains duplicate tool operations");
  if (operations.length !== publicContract.tools.length || publicContract.tools.some((tool) => !operationTools.has(tool.name))) {
    fail("payload", "operations and public tools must have a one-to-one mapping");
  }
  const checkerRaw = object(raw.checker, "payload.checker", ["version", "rulesetVersion", "testsDigest"]);
  if (checkerRaw.rulesetVersion !== "m7.1-sql-v1") fail("payload.checker.rulesetVersion", "is unsupported");
  const testsDigest = string(checkerRaw.testsDigest, "payload.checker.testsDigest");
  if (!DIGEST.test(testsDigest)) fail("payload.checker.testsDigest", "must be a SHA-256 digest");
  return {
    schemaVersion: 1,
    connectorId: packageSegment(raw.connectorId, "payload.connectorId"),
    version: packageSegment(raw.version, "payload.version"),
    adapter: "sqlserver",
    profile,
    operations,
    publicContract,
    checker: {
      version: string(checkerRaw.version, "payload.checker.version"),
      rulesetVersion: "m7.1-sql-v1",
      testsDigest,
    },
  };
}

export function parseConnectorDraft(value: unknown): ConnectorDraft {
  const raw = object(value, "draft", ["draftId", "tenantId", "deviceId", "state", "payload"]);
  const draft = {
    draftId: identifier(raw.draftId, "draft.draftId"),
    tenantId: identifier(raw.tenantId, "draft.tenantId"),
    deviceId: identifier(raw.deviceId, "draft.deviceId"),
    state: enumValue(raw.state, "draft.state", ["draft", "locally_validated"] as const),
    payload: parseConnectorPrivatePayload(raw.payload),
  };
  try {
    assertM71Contract(draft.payload.publicContract, draft.payload.operations);
  } catch {
    fail("draft.payload.publicContract", "must match the fixed M7.1 tool contract");
  }
  return draft;
}

export function parseInstalledConnectorEnvelope(value: unknown): InstalledConnectorEnvelope {
  const raw = object(value, "envelope", ["manifest", "encryptedPayload", "implementationCredential", "implementationSignature"]);
  const manifestRaw = object(raw.manifest, "envelope.manifest", [
    "connectorId", "version", "adapter", "environment", "digest", "publicContract", "checks", "credentialId", "deviceId", "signedAt",
  ]);
  if (manifestRaw.adapter !== "sqlserver") fail("envelope.manifest.adapter", "is unsupported");
  const digest = string(manifestRaw.digest, "envelope.manifest.digest");
  if (!DIGEST.test(digest)) fail("envelope.manifest.digest", "must be a SHA-256 digest");
  const checksRaw = object(manifestRaw.checks, "envelope.manifest.checks", ["checkerVersion", "rulesetVersion", "testsDigest"]);
  if (checksRaw.rulesetVersion !== "m7.1-sql-v1") fail("envelope.manifest.checks.rulesetVersion", "is unsupported");
  const testsDigest = string(checksRaw.testsDigest, "envelope.manifest.checks.testsDigest");
  if (!DIGEST.test(testsDigest)) fail("envelope.manifest.checks.testsDigest", "must be a SHA-256 digest");
  const encryptedPayload = string(raw.encryptedPayload, "envelope.encryptedPayload");
  if (!BASE64.test(encryptedPayload) || Buffer.from(encryptedPayload, "base64").toString("base64") !== encryptedPayload) {
    fail("envelope.encryptedPayload", "must be canonical base64");
  }
  const implementationSignature = string(raw.implementationSignature, "envelope.implementationSignature");
  if (!BASE64URL.test(implementationSignature) || Buffer.from(implementationSignature, "base64url").toString("base64url") !== implementationSignature) {
    fail("envelope.implementationSignature", "must be canonical base64url");
  }
  return {
    manifest: {
      connectorId: packageSegment(manifestRaw.connectorId, "envelope.manifest.connectorId"),
      version: packageSegment(manifestRaw.version, "envelope.manifest.version"),
      adapter: "sqlserver",
      environment: enumValue(manifestRaw.environment, "envelope.manifest.environment", ["test", "preproduction"] as const),
      digest,
      publicContract: parsePublicContract(manifestRaw.publicContract, "envelope.manifest.publicContract"),
      checks: {
        checkerVersion: string(checksRaw.checkerVersion, "envelope.manifest.checks.checkerVersion"),
        rulesetVersion: "m7.1-sql-v1",
        testsDigest,
      },
      credentialId: identifier(manifestRaw.credentialId, "envelope.manifest.credentialId"),
      deviceId: identifier(manifestRaw.deviceId, "envelope.manifest.deviceId"),
      signedAt: string(manifestRaw.signedAt, "envelope.manifest.signedAt"),
    },
    encryptedPayload,
    implementationCredential: string(raw.implementationCredential, "envelope.implementationCredential"),
    implementationSignature,
  };
}
