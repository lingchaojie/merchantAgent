import * as mssql from "mssql";

import type { CredentialVault } from "./credential-vault";
import {
  ConnectorError,
  type ConnectorEnvironment,
  type ConnectorErrorCode,
  type SQLBinding,
  type SQLProjection,
  type SQLReadOperation,
  type SQLServerProfile,
} from "./schema";
import {
  prepareMSSQLConfig,
  type PreparedMSSQLConfig,
  withMSSQLCredential,
} from "./source-profile";
import { validateReadOperation } from "./sql-policy";

export interface SQLPoolFactory {
  open(config: mssql.config): Promise<mssql.ConnectionPool>;
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

function validateArguments(operation: SQLReadOperation, args: Record<string, unknown>): Map<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw publicError("invalid_argument");
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) throw publicError("invalid_argument");
  const argumentNames = new Set(operation.bindings.map((binding) => binding.argument));
  const ownKeys = Reflect.ownKeys(args);
  if (
    ownKeys.length !== argumentNames.size
    || ownKeys.some((name) => typeof name !== "string" || !argumentNames.has(name))
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
    values.set(binding.parameter, runtimeValue(argumentValues.get(binding.argument), binding));
  }
  return values;
}

function validateRuntimeOperation(operation: SQLReadOperation): void {
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

function bindRequest(
  request: mssql.Request,
  bindings: readonly SQLBinding[],
  values: ReadonlyMap<string, unknown>,
): void {
  for (const binding of bindings) {
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
  constructor(
    private readonly profile: SQLServerProfile,
    private readonly vault: CredentialVault,
    private readonly pools: SQLPoolFactory,
  ) {}

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

  private async closePool(pool: mssql.ConnectionPool | undefined): Promise<void> {
    await closePoolQuietly(pool);
  }
}
