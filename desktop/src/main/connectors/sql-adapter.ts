import crypto from "node:crypto";

import * as mssql from "mssql";

import { canonicalJSONStringify, strictJSONSnapshot } from "./canonical";
import type { CredentialVault } from "./credential-vault";
import type { BeginResult, LedgerEntry, LedgerInput } from "./ledger";
import {
  ConnectorError,
  type ConnectorEnvironment,
  type ConnectorErrorCode,
  type SQLBinding,
  type SQLProjection,
  type SQLReadOperation,
  type SQLServerProfile,
  type SQLUpdateOperation,
} from "./schema";
import {
  prepareMSSQLConfig,
  type PreparedMSSQLConfig,
  withMSSQLCredential,
} from "./source-profile";
import { validateReadOperation, validateUpdateOperation } from "./sql-policy";

export interface SQLPoolFactory {
  open(config: mssql.config): Promise<mssql.ConnectionPool>;
}

export interface UpdatePreview {
  before: Record<string, unknown>;
  proposed: Record<string, unknown>;
}

export interface ResumedUpdate {
  result: Record<string, unknown>;
  before: Record<string, unknown>;
  proposed: Record<string, unknown>;
  confirmedAt: string;
}

export class ResumedUpdateError extends ConnectorError {
  constructor(
    code: "source_conflict" | "unknown" | "failed",
    readonly before: Record<string, unknown>,
    readonly confirmedAt: string,
  ) {
    super(code, code);
    this.name = "ResumedUpdateError";
    this.message = code;
  }
}

export interface ExecutionLedgerStore {
  begin(input: LedgerInput): BeginResult;
  markSucceeded(key: string, allowlistedReadBack: Record<string, unknown>): void;
  markUnknown(key: string): void;
  get(key: string): LedgerEntry | null;
}

export interface SQLWriteOptions {
  ledger: ExecutionLedgerStore;
  connectorId: string;
  version: string;
}

export class MSSQLPoolFactory implements SQLPoolFactory {
  async open(config: mssql.config): Promise<mssql.ConnectionPool> {
    return new mssql.ConnectionPool(config).connect();
  }
}

interface NormalizedFailure {
  error: ConnectorError;
  transientConnection: boolean;
}

const TRANSIENT_CONNECTION_CODES = new Set(["ECONNCLOSED", "EINSTLOOKUP", "ENOTOPEN", "ESOCKET", "ETIMEOUT"]);
const TLS_CODES = new Set([
  "CERT_EXPIRED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const PERMISSION_NUMBERS = new Set([229, 230, 262, 297, 300, 916]);
const POOL_CLOSE_GRACE_MS = 100;
const WORKBENCH_RAW_MAX_BYTES = 1024 * 1024;

function publicError(code: ConnectorErrorCode): ConnectorError {
  const error = new ConnectorError(code, code);
  error.message = code;
  return error;
}

function safeProperty(value: unknown, key: string): unknown {
  try {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

function safeStringProperty(value: unknown, key: string): string | undefined {
  const property = safeProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function containsTLSCode(value: unknown): boolean {
  let current = value;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const code = safeStringProperty(current, "code");
    if (code !== undefined && TLS_CODES.has(code)) return true;
    current = safeProperty(current, "originalError") ?? safeProperty(current, "cause");
  }
  return false;
}

function normalizeFailure(value: unknown): NormalizedFailure {
  const connectorCode = safeStringProperty(value, "code");
  if (value instanceof ConnectorError) {
    return { error: publicError(value.code), transientConnection: false };
  }
  if (connectorCode === "ELOGIN") {
    return { error: publicError("invalid_credentials"), transientConnection: false };
  }
  if (containsTLSCode(value)) {
    return { error: publicError("tls_failed"), transientConnection: false };
  }
  const number = safeProperty(value, "number");
  if (typeof number === "number" && PERMISSION_NUMBERS.has(number)) {
    return { error: publicError("permission_denied"), transientConnection: false };
  }
  const isConnectionError = safeStringProperty(value, "name") === "ConnectionError";
  if (isConnectionError && connectorCode !== undefined && TRANSIENT_CONNECTION_CODES.has(connectorCode)) {
    return { error: publicError("connection_failed"), transientConnection: true };
  }
  return { error: publicError("failed"), transientConnection: false };
}

function abortError(): ConnectorError {
  return publicError("failed");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}

function snapshotRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  failureCode: ConnectorErrorCode = "unsafe_template",
): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw publicError(failureCode);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw publicError(failureCode);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const descriptors = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw publicError(failureCode);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw publicError(failureCode);
    }
    descriptors.set(key, descriptor.value);
  }
  if (requiredKeys.some((key) => !descriptors.has(key))) throw publicError(failureCode);
  return descriptors;
}

function snapshotArray<T>(value: unknown, item: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw publicError("unsafe_template");
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = new Set<PropertyKey>(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (ownKeys.length !== expectedKeys.size || ownKeys.some((key) => !expectedKeys.has(key))) {
    throw publicError("unsafe_template");
  }
  const snapshot: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw publicError("unsafe_template");
    }
    snapshot.push(item(descriptor.value));
  }
  return Object.freeze(snapshot);
}

function fixedString(value: unknown): string {
  if (typeof value !== "string") throw publicError("unsafe_template");
  return value;
}

function snapshotBinding(value: unknown): SQLBinding {
  const record = snapshotRecord(value, ["parameter", "argument", "type"], ["maxLength"]);
  const type = record.get("type");
  if (type !== "NVarChar" && type !== "Int") throw publicError("unsafe_template");
  return Object.freeze({
    parameter: fixedString(record.get("parameter")),
    argument: fixedString(record.get("argument")),
    type,
    ...(record.has("maxLength") ? { maxLength: record.get("maxLength") as number } : {}),
  }) as SQLBinding;
}

function snapshotProjection(value: unknown): SQLProjection {
  const record = snapshotRecord(value, ["sourceAlias", "resultField", "type"], []);
  const type = record.get("type");
  if (type !== "string" && type !== "integer") throw publicError("unsafe_template");
  return Object.freeze({
    sourceAlias: fixedString(record.get("sourceAlias")),
    resultField: fixedString(record.get("resultField")),
    type,
  });
}

function snapshotReadOperation(value: unknown): SQLReadOperation {
  const record = snapshotRecord(value, [
    "kind", "tool", "sql", "bindings", "projection", "declaredObjects", "maxResults", "timeoutMS",
  ], []);
  if (record.get("kind") !== "read") throw publicError("unsafe_template");
  return Object.freeze({
    kind: "read",
    tool: fixedString(record.get("tool")),
    sql: fixedString(record.get("sql")),
    bindings: snapshotArray(record.get("bindings"), snapshotBinding) as SQLBinding[],
    projection: snapshotArray(record.get("projection"), snapshotProjection) as SQLProjection[],
    declaredObjects: snapshotArray(record.get("declaredObjects"), fixedString) as string[],
    maxResults: record.get("maxResults") as number,
    timeoutMS: record.get("timeoutMS") as number,
  });
}

function snapshotProposedField(value: unknown) {
  const record = snapshotRecord(value, ["resultField"], ["argument", "preserveIfMissing"]);
  const preserveIfMissing = record.get("preserveIfMissing");
  if (preserveIfMissing !== undefined && typeof preserveIfMissing !== "boolean") {
    throw publicError("unsafe_template");
  }
  return Object.freeze({
    resultField: fixedString(record.get("resultField")),
    ...(record.has("argument") ? { argument: fixedString(record.get("argument")) } : {}),
    ...(preserveIfMissing === undefined ? {} : { preserveIfMissing }),
  });
}

function snapshotUpdateOperation(value: unknown): SQLUpdateOperation {
  const record = snapshotRecord(value, [
    "kind", "tool", "beforeSql", "updateSql", "readBackSql", "bindings", "projection",
    "proposed", "declaredObject", "resourceParameter", "concurrencyParameter", "updateColumns",
    "versionField", "timeoutMS",
  ], []);
  if (record.get("kind") !== "update") throw publicError("unsafe_template");
  return Object.freeze({
    kind: "update",
    tool: fixedString(record.get("tool")),
    beforeSql: fixedString(record.get("beforeSql")),
    updateSql: fixedString(record.get("updateSql")),
    readBackSql: fixedString(record.get("readBackSql")),
    bindings: snapshotArray(record.get("bindings"), snapshotBinding) as SQLBinding[],
    projection: snapshotArray(record.get("projection"), snapshotProjection) as SQLProjection[],
    proposed: snapshotArray(record.get("proposed"), snapshotProposedField) as SQLUpdateOperation["proposed"],
    declaredObject: fixedString(record.get("declaredObject")),
    resourceParameter: fixedString(record.get("resourceParameter")),
    concurrencyParameter: fixedString(record.get("concurrencyParameter")),
    updateColumns: snapshotArray(record.get("updateColumns"), fixedString) as string[],
    versionField: fixedString(record.get("versionField")),
    timeoutMS: record.get("timeoutMS") as number,
  });
}

function snapshotProfile(value: unknown): SQLServerProfile {
  const record = snapshotRecord(value, [
    "profileId", "server", "database", "encrypt", "trustServerCertificate", "connectTimeoutMS",
    "queryTimeoutMS", "credentialRef", "environment",
  ], ["instance", "port", "caPath"], "invalid_argument");
  return Object.freeze({
    profileId: record.get("profileId") as string,
    server: record.get("server") as string,
    ...(record.has("instance") ? { instance: record.get("instance") as string } : {}),
    ...(record.has("port") ? { port: record.get("port") as number } : {}),
    database: record.get("database") as string,
    encrypt: record.get("encrypt") as true,
    trustServerCertificate: record.get("trustServerCertificate") as false,
    ...(record.has("caPath") ? { caPath: record.get("caPath") as string } : {}),
    connectTimeoutMS: record.get("connectTimeoutMS") as number,
    queryTimeoutMS: record.get("queryTimeoutMS") as number,
    credentialRef: record.get("credentialRef") as string,
    environment: record.get("environment") as ConnectorEnvironment,
  });
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function runtimeValue(value: unknown, binding: SQLBinding): unknown {
  if (binding.type === "NVarChar") {
    if (
      typeof value !== "string"
      || (binding.maxLength !== undefined && value.length > binding.maxLength)
    ) {
      throw publicError("invalid_argument");
    }
    return value;
  }
  if (binding.type === "Int") {
    if (!Number.isSafeInteger(value) || (value as number) < -2_147_483_648 || (value as number) > 2_147_483_647) {
      throw publicError("invalid_argument");
    }
    return value;
  }
  throw publicError("invalid_argument");
}

function validateArguments(
  operation: Pick<SQLReadOperation | SQLUpdateOperation, "bindings">,
  args: Record<string, unknown>,
  optionalArguments: ReadonlySet<string> = new Set(),
): Map<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw publicError("invalid_argument");
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) throw publicError("invalid_argument");
  const argumentNames = new Set(operation.bindings.map((binding) => binding.argument));
  const requiredNames = new Set([...argumentNames].filter((name) => !optionalArguments.has(name)));
  const ownKeys = Reflect.ownKeys(args);
  if (
    ownKeys.length < requiredNames.size
    || ownKeys.length > argumentNames.size
    || ownKeys.some((name) => typeof name !== "string" || !argumentNames.has(name))
    || [...requiredNames].some((name) => !ownKeys.includes(name))
  ) {
    throw publicError("invalid_argument");
  }
  const argumentValues = new Map<string, unknown>();
  for (const name of ownKeys) {
    if (typeof name !== "string") throw publicError("invalid_argument");
    const descriptor = Object.getOwnPropertyDescriptor(args, name);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw publicError("invalid_argument");
    }
    argumentValues.set(name, descriptor.value);
  }
  const values = new Map<string, unknown>();
  for (const binding of operation.bindings) {
    if (!argumentValues.has(binding.argument) && optionalArguments.has(binding.argument)) continue;
    values.set(binding.parameter, runtimeValue(argumentValues.get(binding.argument), binding));
  }
  return values;
}

function validateUpdateArguments(operation: SQLUpdateOperation, args: Record<string, unknown>): Map<string, unknown> {
  const optional = new Set(operation.proposed
    .filter((field) => field.preserveIfMissing === true && field.argument !== undefined)
    .map((field) => field.argument as string));
  return validateArguments(operation, args, optional);
}

function validateRuntimeOperation(operation: Pick<SQLReadOperation | SQLUpdateOperation, "timeoutMS" | "bindings">): void {
  if (!Number.isSafeInteger(operation.timeoutMS) || operation.timeoutMS < 1) throw publicError("invalid_argument");
  for (const binding of operation.bindings) {
    if (
      (binding.type !== "NVarChar" && binding.type !== "Int")
      || (binding.type === "NVarChar" && (
        !Number.isSafeInteger(binding.maxLength)
        || binding.maxLength < 1
        || binding.maxLength > 4_000
      ))
      || (binding.type === "Int" && binding.maxLength !== undefined)
    ) {
      throw publicError("invalid_argument");
    }
  }
}

function validateRuntimeUpdateOperation(operation: SQLUpdateOperation): void {
  validateRuntimeOperation(operation);
}

function bindRequest(
  request: mssql.Request,
  bindings: readonly SQLBinding[],
  values: ReadonlyMap<string, unknown>,
  parameterNames?: ReadonlySet<string>,
): void {
  for (const binding of bindings) {
    if (parameterNames !== undefined && !parameterNames.has(binding.parameter)) continue;
    const type = binding.type === "Int"
      ? mssql.Int
      : mssql.NVarChar(binding.maxLength);
    request.input(binding.parameter, type, values.get(binding.parameter));
  }
}

function projectedValue(row: Record<string, unknown>, projection: SQLProjection): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, projection.sourceAlias);
  if (descriptor === undefined || !("value" in descriptor)) throw publicError("failed");
  const value = descriptor.value;
  if (
    (projection.type === "string" && typeof value !== "string")
    || (projection.type === "integer" && !Number.isSafeInteger(value))
  ) {
    throw publicError("failed");
  }
  return value;
}

function projectRows(
  recordset: unknown,
  projections: readonly SQLProjection[],
  maxResults: number,
): Record<string, unknown>[] {
  if (!Array.isArray(recordset)) throw publicError("failed");
  return recordset.slice(0, maxResults).map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw publicError("failed");
    const row = value as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const projection of projections) {
      Object.defineProperty(projected, projection.resultField, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: projectedValue(row, projection),
      });
    }
    return projected;
  });
}

function projectSingleRow(
  recordset: unknown,
  projections: readonly SQLProjection[],
): Record<string, unknown> | null {
  if (!Array.isArray(recordset)) throw publicError("failed");
  if (recordset.length === 0) return null;
  if (recordset.length !== 1) throw publicError("source_conflict");
  return projectRows(recordset, projections, 1)[0] ?? null;
}

function immutableRecord(value: unknown, failureCode: ConnectorErrorCode): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw publicError(failureCode);
  try {
    return strictJSONSnapshot(value) as Readonly<Record<string, unknown>>;
  } catch {
    throw publicError(failureCode);
  }
}

function projectedRecord(
  value: unknown,
  projections: readonly SQLProjection[],
  failureCode: ConnectorErrorCode,
): Readonly<Record<string, unknown>> {
  const snapshot = immutableRecord(value, failureCode);
  const expected = new Set(projections.map((projection) => projection.resultField));
  const keys = Object.keys(snapshot);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) throw publicError(failureCode);
  for (const projection of projections) {
    const field = snapshot[projection.resultField];
    if (
      (projection.type === "string" && typeof field !== "string")
      || (projection.type === "integer" && !Number.isSafeInteger(field))
    ) {
      throw publicError(failureCode);
    }
  }
  return snapshot;
}

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  try {
    return canonicalJSONStringify(left) === canonicalJSONStringify(right);
  } catch {
    return false;
  }
}

function proposedRecord(
  operation: SQLUpdateOperation,
  values: ReadonlyMap<string, unknown>,
  before: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const proposed: Record<string, unknown> = {};
  for (const field of operation.proposed) {
    if (field.argument === undefined) throw publicError("unsafe_template");
    const binding = operation.bindings.find((candidate) => candidate.argument === field.argument);
    if (binding === undefined) throw publicError("unsafe_template");
    const value = values.get(binding.parameter);
    Object.defineProperty(proposed, field.resultField, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: value === undefined && field.preserveIfMissing === true ? before[field.resultField] : value,
    });
  }
  return immutableRecord(proposed, "invalid_argument");
}

function materializeUpdateValues(
  operation: SQLUpdateOperation,
  values: ReadonlyMap<string, unknown>,
  proposed: Record<string, unknown>,
): ReadonlyMap<string, unknown> {
  const materialized = new Map(values);
  for (const field of operation.proposed) {
    if (field.argument === undefined || materialized.size === operation.bindings.length) continue;
    const binding = operation.bindings.find((candidate) => candidate.argument === field.argument);
    if (binding !== undefined && !materialized.has(binding.parameter) && field.preserveIfMissing === true) {
      materialized.set(binding.parameter, runtimeValue(proposed[field.resultField], binding));
    }
  }
  if (materialized.size !== operation.bindings.length) throw publicError("invalid_argument");
  return materialized;
}

function versionResultField(operation: SQLUpdateOperation): string {
  const versionIndex = operation.updateColumns.findIndex(
    (column) => column.toLowerCase() === operation.versionField.toLowerCase(),
  );
  const field = operation.proposed[versionIndex]?.resultField;
  if (field === undefined) throw publicError("unsafe_template");
  return field;
}

function validateVersionTransition(
  operation: SQLUpdateOperation,
  values: ReadonlyMap<string, unknown>,
  before: Record<string, unknown>,
  proposed: Record<string, unknown>,
): void {
  const field = versionResultField(operation);
  const beforeVersion = before[field];
  const nextVersion = proposed[field];
  const concurrencyBinding = operation.bindings.find(
    (binding) => binding.parameter === operation.concurrencyParameter,
  );
  if (
    concurrencyBinding === undefined
    || !Number.isSafeInteger(beforeVersion)
    || !Number.isSafeInteger(nextVersion)
    || values.get(concurrencyBinding.parameter) !== beforeVersion
    || nextVersion !== (beforeVersion as number) + 1
  ) {
    throw publicError("source_conflict");
  }
}

function matchesProposed(
  operation: SQLUpdateOperation,
  before: Record<string, unknown>,
  proposed: Record<string, unknown>,
  readBack: Record<string, unknown>,
): boolean {
  const versionField = versionResultField(operation);
  if (readBack[versionField] !== (before[versionField] as number) + 1) return false;
  return operation.proposed.every((field) => readBack[field.resultField] === proposed[field.resultField]);
}

function requestFingerprint(
  connectorId: string,
  version: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  const canonical = canonicalJSONStringify({ connectorId, version, tool, args });
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

function transactionRequest(transaction: mssql.Transaction): mssql.Request {
  const candidate = transaction as mssql.Transaction & { request?: () => mssql.Request };
  return typeof candidate.request === "function" ? candidate.request() : new mssql.Request(transaction);
}

async function rollbackQuietly(transaction: mssql.Transaction | undefined): Promise<void> {
  if (transaction === undefined) return;
  const rollingBack = Promise.resolve()
    .then(async () => transaction.rollback())
    .then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, POOL_CLOSE_GRACE_MS);
  });
  await Promise.race([rollingBack, deadline]);
  if (timer !== undefined) clearTimeout(timer);
}

async function commitBeforeDeadline(
  transaction: mssql.Transaction,
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const committing = Promise.resolve(transaction.commit());
  const observed = committing.then(
    () => "committed" as const,
    () => "rejected" as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), Math.max(0, deadlineAt - Date.now()));
  });
  const aborted = signal === undefined
    ? new Promise<never>(() => undefined)
    : new Promise<"aborted">((resolve) => {
      onAbort = (): void => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  try {
    const outcome = await Promise.race([observed, deadline, aborted]);
    if (outcome !== "committed") throw publicError("unknown");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function queryWithAbort(
  request: mssql.Request,
  sql: string,
  signal: AbortSignal | undefined,
): Promise<mssql.IResult<Record<string, unknown>>> {
  throwIfAborted(signal);
  const query = request.query<Record<string, unknown>>(sql);
  if (signal === undefined) return query;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      try {
        request.cancel();
      } catch {
        // Cancellation is best effort; the public result is still a static abort failure.
      }
      finish(() => reject(abortError()));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    query.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function closePoolQuietly(pool: mssql.ConnectionPool | undefined): Promise<void> {
  if (pool === undefined) return;
  const closing = Promise.resolve()
    .then(async () => pool.close())
    .then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, POOL_CLOSE_GRACE_MS);
  });
  await Promise.race([closing, deadline]);
  if (timer !== undefined) clearTimeout(timer);
}

async function openPoolWithAbort(
  pools: SQLPoolFactory,
  config: mssql.config,
  signal: AbortSignal | undefined,
): Promise<mssql.ConnectionPool> {
  throwIfAborted(signal);
  const opening = pools.open(config);
  if (signal === undefined) return opening;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    opening.then(
      (pool) => {
        if (settled) {
          void closePoolQuietly(pool);
          return;
        }
        finish(() => resolve(pool));
      },
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export class SQLServerAdapter {
  private readonly writeOptions?: SQLWriteOptions;

  constructor(
    private readonly profile: SQLServerProfile,
    private readonly vault: CredentialVault,
    private readonly pools: SQLPoolFactory,
    writeOptions?: SQLWriteOptions,
  ) {
    this.writeOptions = writeOptions === undefined ? undefined : Object.freeze({
      ledger: writeOptions.ledger,
      connectorId: fixedString(writeOptions.connectorId),
      version: fixedString(writeOptions.version),
    });
  }

  async testConnection(signal?: AbortSignal): Promise<{ environment: ConnectorEnvironment; latencyMS: number }> {
    throwIfAborted(signal);
    const startedAt = Date.now();
    let pool: mssql.ConnectionPool | undefined;
    try {
      const profile = snapshotProfile(this.profile);
      const prepared = prepareMSSQLConfig(profile);
      const credential = await this.requireCredential(profile.credentialRef, signal);
      throwIfAborted(signal);
      pool = await openPoolWithAbort(this.pools, withMSSQLCredential(prepared, credential), signal);
      throwIfAborted(signal);
      const request = pool.request();
      const result = await queryWithAbort(request, "SELECT 1 AS connection_ok", signal);
      if (result.recordset[0]?.connection_ok !== 1) throw publicError("connection_failed");
      return { environment: profile.environment, latencyMS: Date.now() - startedAt };
    } catch (error) {
      throw normalizeFailure(error).error;
    } finally {
      await this.closePool(pool);
    }
  }

  async executeRead(
    operation: SQLReadOperation,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    try {
      throwIfAborted(signal);
      const snapshot = snapshotReadOperation(operation);
      validateRuntimeOperation(snapshot);
      validateReadOperation(snapshot);
      const values = validateArguments(snapshot, args);
      const profile = snapshotProfile(this.profile);
      const prepared = prepareMSSQLConfig(profile);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await this.readOnce(snapshot, values, profile, prepared, signal);
        } catch (error) {
          const normalized = normalizeFailure(error);
          if (attempt === 0 && normalized.transientConnection && signal?.aborted !== true) continue;
          throw normalized.error;
        }
      }
      throw publicError("failed");
    } catch (error) {
      throw normalizeFailure(error).error;
    }
  }

  async executeWorkbenchRead(
    operation: SQLReadOperation,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ raw: Record<string, unknown>[]; projected: Record<string, unknown>[] }> {
    try {
      throwIfAborted(signal);
      const snapshot = snapshotReadOperation(operation);
      validateRuntimeOperation(snapshot);
      validateReadOperation(snapshot);
      const values = validateArguments(snapshot, args);
      const profile = snapshotProfile(this.profile);
      const prepared = prepareMSSQLConfig(profile);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await this.workbenchReadOnce(snapshot, values, profile, prepared, signal);
        } catch (error) {
          const normalized = normalizeFailure(error);
          if (attempt === 0 && normalized.transientConnection && signal?.aborted !== true) continue;
          throw normalized.error;
        }
      }
      throw publicError("failed");
    } catch (error) {
      throw normalizeFailure(error).error;
    }
  }

  async previewUpdate(
    operation: SQLUpdateOperation,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<UpdatePreview> {
    try {
      throwIfAborted(signal);
      const snapshot = snapshotUpdateOperation(operation);
      validateRuntimeUpdateOperation(snapshot);
      validateUpdateOperation(snapshot);
      const values = validateUpdateArguments(snapshot, args);
      const before = await this.readUpdateRow(snapshot, values, snapshot.beforeSql, signal);
      if (before === null) throw publicError("record_not_found");
      const proposed = proposedRecord(snapshot, values, before);
      validateVersionTransition(snapshot, values, before, proposed);
      return Object.freeze({
        before: immutableRecord(before, "failed") as Record<string, unknown>,
        proposed: proposed as Record<string, unknown>,
      });
    } catch (error) {
      throw normalizeFailure(error).error;
    }
  }

  async executeConfirmedUpdate(
    operation: SQLUpdateOperation,
    args: Record<string, unknown>,
    idempotencyKey: string,
    preview: UpdatePreview,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    try {
      throwIfAborted(signal);
      const write = this.requireWriteOptions();
      const snapshot = snapshotUpdateOperation(operation);
      const deadlineAt = Date.now() + snapshot.timeoutMS;
      validateRuntimeUpdateOperation(snapshot);
      validateUpdateOperation(snapshot);
      const argsSnapshot = immutableRecord(args, "invalid_argument") as Record<string, unknown>;
      const fingerprint = requestFingerprint(write.connectorId, write.version, snapshot.tool, argsSnapshot);
      const existing = write.ledger.get(idempotencyKey);
      if (existing !== null && existing.fingerprint !== fingerprint) throw publicError("source_conflict");
      const values = validateUpdateArguments(snapshot, argsSnapshot);
      const before = projectedRecord(
        preview.before,
        snapshot.projection,
        "invalid_argument",
      ) as Record<string, unknown>;
      const proposed = immutableRecord(preview.proposed, "invalid_argument") as Record<string, unknown>;
      const expectedProposed = proposedRecord(snapshot, values, before);
      if (!sameRecord(proposed, expectedProposed)) throw publicError("invalid_argument");
      validateVersionTransition(snapshot, values, before, proposed);
      const materializedValues = materializeUpdateValues(snapshot, values, proposed);
      const begin = write.ledger.begin({
        idempotencyKey,
        fingerprint,
        connectorId: write.connectorId,
        version: write.version,
        tool: snapshot.tool,
        before,
        proposed,
      });
      if (begin.kind === "replay") {
        if (begin.entry.allowlistedReadBack === undefined) throw publicError("failed");
        return immutableRecord(begin.entry.allowlistedReadBack, "failed") as Record<string, unknown>;
      }
      if (begin.kind === "recover") {
        return this.recoverEntry(snapshot, materializedValues, fingerprint, begin.entry, signal);
      }
      return this.executeCreatedUpdate(snapshot, materializedValues, begin.entry, deadlineAt, signal);
    } catch (error) {
      throw normalizeFailure(error).error;
    }
  }

  async resumeUpdate(
    operation: SQLUpdateOperation,
    args: Record<string, unknown>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ResumedUpdate | null> {
    try {
      throwIfAborted(signal);
      const write = this.requireWriteOptions();
      const snapshot = snapshotUpdateOperation(operation);
      validateRuntimeUpdateOperation(snapshot);
      validateUpdateOperation(snapshot);
      const argsSnapshot = immutableRecord(args, "invalid_argument") as Record<string, unknown>;
      const fingerprint = requestFingerprint(write.connectorId, write.version, snapshot.tool, argsSnapshot);
      const entry = write.ledger.get(idempotencyKey);
      if (
        entry !== null && (entry.fingerprint !== fingerprint
        || entry.connectorId !== write.connectorId
        || entry.version !== write.version
        || entry.tool !== snapshot.tool)
      ) {
        throw publicError("source_conflict");
      }
      if (entry === null) {
        validateUpdateArguments(snapshot, argsSnapshot);
        return null;
      }
      try {
        const values = validateUpdateArguments(snapshot, argsSnapshot);
        validateVersionTransition(snapshot, values, entry.before, entry.proposed);
        const materializedValues = materializeUpdateValues(snapshot, values, entry.proposed);
        let result: Record<string, unknown>;
        if (entry.status === "succeeded") {
          if (entry.allowlistedReadBack === undefined) throw publicError("failed");
          result = immutableRecord(entry.allowlistedReadBack, "failed") as Record<string, unknown>;
        } else {
          result = await this.recoverEntry(snapshot, materializedValues, fingerprint, entry, signal);
        }
        return Object.freeze({
          result,
          before: immutableRecord(entry.before, "failed") as Record<string, unknown>,
          proposed: immutableRecord(entry.proposed, "failed") as Record<string, unknown>,
          confirmedAt: entry.createdAt,
        });
      } catch (error) {
        const normalized = normalizeFailure(error).error;
        const code = normalized.code === "unknown" || normalized.code === "source_conflict"
          ? normalized.code
          : "failed";
        throw new ResumedUpdateError(
          code,
          immutableRecord(entry.before, "failed") as Record<string, unknown>,
          entry.createdAt,
        );
      }
    } catch (error) {
      if (error instanceof ResumedUpdateError) throw error;
      throw normalizeFailure(error).error;
    }
  }

  async recoverUnknown(
    operation: SQLUpdateOperation,
    args: Record<string, unknown>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    try {
      throwIfAborted(signal);
      const write = this.requireWriteOptions();
      const snapshot = snapshotUpdateOperation(operation);
      validateRuntimeUpdateOperation(snapshot);
      validateUpdateOperation(snapshot);
      const argsSnapshot = immutableRecord(args, "invalid_argument") as Record<string, unknown>;
      const fingerprint = requestFingerprint(write.connectorId, write.version, snapshot.tool, argsSnapshot);
      const entry = write.ledger.get(idempotencyKey);
      if (
        entry === null
        || entry.fingerprint !== fingerprint
        || entry.connectorId !== write.connectorId
        || entry.version !== write.version
        || entry.tool !== snapshot.tool
      ) {
        throw publicError("source_conflict");
      }
      const values = validateUpdateArguments(snapshot, argsSnapshot);
      if (entry.status === "succeeded") {
        if (entry.allowlistedReadBack === undefined) throw publicError("failed");
        return immutableRecord(entry.allowlistedReadBack, "failed") as Record<string, unknown>;
      }
      validateVersionTransition(snapshot, values, entry.before, entry.proposed);
      const materializedValues = materializeUpdateValues(snapshot, values, entry.proposed);
      return this.recoverEntry(snapshot, materializedValues, fingerprint, entry, signal);
    } catch (error) {
      throw normalizeFailure(error).error;
    }
  }

  private requireWriteOptions(): SQLWriteOptions {
    if (this.writeOptions === undefined) throw publicError("failed");
    return this.writeOptions;
  }

  private async executeCreatedUpdate(
    operation: SQLUpdateOperation,
    values: ReadonlyMap<string, unknown>,
    entry: LedgerEntry,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const write = this.requireWriteOptions();
    const profile = snapshotProfile(this.profile);
    const prepared = prepareMSSQLConfig(profile);
    let pool: mssql.ConnectionPool | undefined;
    let transaction: mssql.Transaction | undefined;
    let commitAttempted = false;
    try {
      const credential = await this.requireCredential(profile.credentialRef, signal);
      const config = withMSSQLCredential(prepared, credential);
      config.requestTimeout = Math.min(profile.queryTimeoutMS, operation.timeoutMS);
      pool = await openPoolWithAbort(this.pools, config, signal);
      transaction = pool.transaction();
      await awaitWithAbort(transaction.begin(mssql.ISOLATION_LEVEL.READ_COMMITTED), signal);

      const beforeRequest = transactionRequest(transaction);
      validateRuntimeUpdateOperation(operation);
      const beforeValidation = validateUpdateOperation(operation);
      bindRequest(beforeRequest, operation.bindings, values, beforeValidation.before.parameterNames);
      const currentResult = await queryWithAbort(beforeRequest, operation.beforeSql, signal);
      const current = projectSingleRow(currentResult.recordset, operation.projection);
      if (current === null || !sameRecord(current, entry.before)) throw publicError("source_conflict");

      const updateRequest = transactionRequest(transaction);
      validateRuntimeUpdateOperation(operation);
      const updateValidation = validateUpdateOperation(operation);
      bindRequest(updateRequest, operation.bindings, values, updateValidation.update.parameterNames);
      const updateResult = await queryWithAbort(updateRequest, operation.updateSql, signal);
      if (
        !Array.isArray(updateResult.rowsAffected)
        || updateResult.rowsAffected.length !== 1
        || updateResult.rowsAffected[0] !== 1
      ) {
        throw publicError("source_conflict");
      }

      const readBackRequest = transactionRequest(transaction);
      validateRuntimeUpdateOperation(operation);
      const readBackValidation = validateUpdateOperation(operation);
      bindRequest(readBackRequest, operation.bindings, values, readBackValidation.readBack.parameterNames);
      const readBackResult = await queryWithAbort(readBackRequest, operation.readBackSql, signal);
      const readBack = projectSingleRow(readBackResult.recordset, operation.projection);
      if (readBack === null || !matchesProposed(operation, entry.before, entry.proposed, readBack)) {
        throw publicError("source_rejected");
      }

      commitAttempted = true;
      await commitBeforeDeadline(transaction, deadlineAt, signal);
      try {
        write.ledger.markSucceeded(entry.idempotencyKey, readBack);
      } catch {
        try {
          write.ledger.markUnknown(entry.idempotencyKey);
        } catch {
          // The public state remains unknown even if the local ledger is unavailable.
        }
        throw publicError("unknown");
      }
      return immutableRecord(readBack, "failed") as Record<string, unknown>;
    } catch (error) {
      if (commitAttempted) {
        try {
          write.ledger.markUnknown(entry.idempotencyKey);
        } catch {
          // A failed local finalization cannot make a possibly committed update safe to retry.
        }
        throw publicError("unknown");
      }
      await rollbackQuietly(transaction);
      throw normalizeFailure(error).error;
    } finally {
      await this.closePool(pool);
    }
  }

  private async recoverEntry(
    operation: SQLUpdateOperation,
    values: ReadonlyMap<string, unknown>,
    fingerprint: string,
    entry: LedgerEntry,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const write = this.requireWriteOptions();
    if (entry.fingerprint !== fingerprint) throw publicError("source_conflict");
    let readBack: Record<string, unknown> | null;
    try {
      readBack = await this.readUpdateRow(operation, values, operation.readBackSql, signal);
    } catch {
      try {
        write.ledger.markUnknown(entry.idempotencyKey);
      } catch {
        // Recovery remains unknown regardless of local diagnostic persistence.
      }
      throw publicError("unknown");
    }
    if (readBack !== null && matchesProposed(operation, entry.before, entry.proposed, readBack)) {
      try {
        write.ledger.markSucceeded(entry.idempotencyKey, readBack);
      } catch {
        try {
          write.ledger.markUnknown(entry.idempotencyKey);
        } catch {
          // Recovery remains unknown when local terminal persistence fails.
        }
        throw publicError("unknown");
      }
      return immutableRecord(readBack, "failed") as Record<string, unknown>;
    }
    if (readBack !== null && sameRecord(readBack, entry.before)) throw publicError("source_conflict");
    try {
      write.ledger.markUnknown(entry.idempotencyKey);
    } catch {
      // The operation was already non-terminal; keep the public result unknown.
    }
    throw publicError("unknown");
  }

  private async readUpdateRow(
    operation: SQLUpdateOperation,
    values: ReadonlyMap<string, unknown>,
    sql: string,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown> | null> {
    const profile = snapshotProfile(this.profile);
    const prepared = prepareMSSQLConfig(profile);
    let pool: mssql.ConnectionPool | undefined;
    try {
      const credential = await this.requireCredential(profile.credentialRef, signal);
      const config = withMSSQLCredential(prepared, credential);
      config.requestTimeout = Math.min(profile.queryTimeoutMS, operation.timeoutMS);
      pool = await openPoolWithAbort(this.pools, config, signal);
      const request = pool.request();
      validateRuntimeUpdateOperation(operation);
      const validation = validateUpdateOperation(operation);
      const parameters = sql === operation.beforeSql
        ? validation.before.parameterNames
        : validation.readBack.parameterNames;
      bindRequest(request, operation.bindings, values, parameters);
      const result = await queryWithAbort(request, sql, signal);
      return projectSingleRow(result.recordset, operation.projection);
    } finally {
      await this.closePool(pool);
    }
  }

  private async requireCredential(credentialRef: string, signal: AbortSignal | undefined) {
    throwIfAborted(signal);
    const credential = await awaitWithAbort(this.vault.get(credentialRef), signal);
    if (credential === null) throw publicError("missing_credentials");
    return credential;
  }

  private async readOnce(
    operation: SQLReadOperation,
    values: ReadonlyMap<string, unknown>,
    profile: SQLServerProfile,
    prepared: PreparedMSSQLConfig,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>[]> {
    let pool: mssql.ConnectionPool | undefined;
    try {
      throwIfAborted(signal);
      const credential = await this.requireCredential(profile.credentialRef, signal);
      throwIfAborted(signal);
      const config = withMSSQLCredential(prepared, credential);
      config.requestTimeout = Math.min(profile.queryTimeoutMS, operation.timeoutMS);
      pool = await openPoolWithAbort(this.pools, config, signal);
      throwIfAborted(signal);
      const request = pool.request();
      bindRequest(request, operation.bindings, values);
      validateRuntimeOperation(operation);
      validateReadOperation(operation);
      const result = await queryWithAbort(request, operation.sql, signal);
      return projectRows(result.recordset, operation.projection, operation.maxResults);
    } finally {
      await this.closePool(pool);
    }
  }

  private async workbenchReadOnce(
    operation: SQLReadOperation,
    values: ReadonlyMap<string, unknown>,
    profile: SQLServerProfile,
    prepared: PreparedMSSQLConfig,
    signal: AbortSignal | undefined,
  ): Promise<{ raw: Record<string, unknown>[]; projected: Record<string, unknown>[] }> {
    let pool: mssql.ConnectionPool | undefined;
    try {
      throwIfAborted(signal);
      const credential = await this.requireCredential(profile.credentialRef, signal);
      throwIfAborted(signal);
      const config = withMSSQLCredential(prepared, credential);
      config.requestTimeout = Math.min(profile.queryTimeoutMS, operation.timeoutMS);
      pool = await openPoolWithAbort(this.pools, config, signal);
      throwIfAborted(signal);
      const request = pool.request();
      bindRequest(request, operation.bindings, values);
      validateRuntimeOperation(operation);
      validateReadOperation(operation);
      const result = await queryWithAbort(request, operation.sql, signal);
      if (!Array.isArray(result.recordset)) throw publicError("failed");
      const raw = strictJSONSnapshot(result.recordset.slice(0, operation.maxResults));
      if (!Array.isArray(raw) || raw.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
        throw publicError("failed");
      }
      const encoded = canonicalJSONStringify(raw);
      if (Buffer.byteLength(encoded, "utf8") > WORKBENCH_RAW_MAX_BYTES) throw publicError("failed");
      return {
        raw: raw as Record<string, unknown>[],
        projected: projectRows(raw, operation.projection, operation.maxResults),
      };
    } finally {
      await this.closePool(pool);
    }
  }

  private async closePool(pool: mssql.ConnectionPool | undefined): Promise<void> {
    await closePoolQuietly(pool);
  }
}
