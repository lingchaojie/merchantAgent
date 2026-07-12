import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { canonicalJSONStringify, strictJSONSnapshot } from "./canonical";
import { ConnectorError, type ConnectorErrorCode } from "./schema";

export type LedgerStatus = "pending" | "succeeded" | "unknown";

export interface LedgerInput {
  idempotencyKey: string;
  fingerprint: string;
  connectorId: string;
  version: string;
  tool: string;
  before: Record<string, unknown>;
  proposed: Record<string, unknown>;
}

export interface LedgerEntry extends LedgerInput {
  status: LedgerStatus;
  allowlistedReadBack?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type BeginResult =
  | { kind: "created"; entry: LedgerEntry }
  | { kind: "replay"; entry: LedgerEntry }
  | { kind: "recover"; entry: LedgerEntry };

interface ExecutionRow {
  idempotency_key: string;
  fingerprint: string;
  connector_id: string;
  connector_version: string;
  tool: string;
  before_json: string;
  proposed_json: string;
  status: string;
  read_back_json: string | null;
  created_at: string;
  updated_at: string;
}

function publicError(code: ConnectorErrorCode): ConnectorError {
  const error = new ConnectorError(code, code);
  error.message = code;
  return error;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw publicError("invalid_argument");
  return value;
}

function encodeRecord(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw publicError("invalid_argument");
  try {
    return canonicalJSONStringify(strictJSONSnapshot(value));
  } catch {
    throw publicError("invalid_argument");
  }
}

function decodeRecord(value: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(value);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error();
    canonicalJSONStringify(decoded);
    return decoded as Record<string, unknown>;
  } catch {
    throw publicError("failed");
  }
}

function decodeStatus(value: string): LedgerStatus {
  if (value === "pending" || value === "succeeded" || value === "unknown") return value;
  throw publicError("failed");
}

function decodeRow(row: ExecutionRow): LedgerEntry {
  const status = decodeStatus(row.status);
  if ((status === "succeeded") !== (row.read_back_json !== null)) throw publicError("failed");
  return {
    idempotencyKey: requiredString(row.idempotency_key),
    fingerprint: requiredString(row.fingerprint),
    connectorId: requiredString(row.connector_id),
    version: requiredString(row.connector_version),
    tool: requiredString(row.tool),
    before: decodeRecord(row.before_json),
    proposed: decodeRecord(row.proposed_json),
    status,
    ...(row.read_back_json === null ? {} : { allowlistedReadBack: decodeRecord(row.read_back_json) }),
    createdAt: requiredString(row.created_at),
    updatedAt: requiredString(row.updated_at),
  };
}

export class ExecutionLedger {
  readonly databasePath: string;
  private readonly database: Database.Database;

  constructor(userDataPath: string) {
    requiredString(userDataPath);
    const directory = path.join(userDataPath, "connectors");
    fs.mkdirSync(directory, { recursive: true });
    this.databasePath = path.join(directory, "executions.db");
    this.database = new Database(this.databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        idempotency_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        connector_version TEXT NOT NULL,
        tool TEXT NOT NULL,
        before_json TEXT NOT NULL,
        proposed_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'unknown')),
        read_back_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((status = 'succeeded' AND read_back_json IS NOT NULL)
          OR (status <> 'succeeded' AND read_back_json IS NULL))
      )
    `);
  }

  begin(input: LedgerInput): BeginResult {
    const normalized = {
      idempotencyKey: requiredString(input.idempotencyKey),
      fingerprint: requiredString(input.fingerprint),
      connectorId: requiredString(input.connectorId),
      version: requiredString(input.version),
      tool: requiredString(input.tool),
      beforeJSON: encodeRecord(input.before),
      proposedJSON: encodeRecord(input.proposed),
    };
    const beginImmediate = this.database.transaction((): BeginResult => {
      const existing = this.select(normalized.idempotencyKey);
      if (existing !== null) {
        if (
          existing.fingerprint !== normalized.fingerprint
          || existing.connectorId !== normalized.connectorId
          || existing.version !== normalized.version
          || existing.tool !== normalized.tool
          || canonicalJSONStringify(existing.before) !== normalized.beforeJSON
          || canonicalJSONStringify(existing.proposed) !== normalized.proposedJSON
        ) {
          throw publicError("source_conflict");
        }
        return existing.status === "succeeded"
          ? { kind: "replay", entry: existing }
          : { kind: "recover", entry: existing };
      }
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO executions (
          idempotency_key, fingerprint, connector_id, connector_version, tool,
          before_json, proposed_json, status, read_back_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `).run(
        normalized.idempotencyKey,
        normalized.fingerprint,
        normalized.connectorId,
        normalized.version,
        normalized.tool,
        normalized.beforeJSON,
        normalized.proposedJSON,
        now,
        now,
      );
      const entry = this.select(normalized.idempotencyKey);
      if (entry === null) throw publicError("failed");
      return { kind: "created", entry };
    });
    return beginImmediate.immediate();
  }

  markSucceeded(key: string, allowlistedReadBack: Record<string, unknown>): void {
    const normalizedKey = requiredString(key);
    const readBackJSON = encodeRecord(allowlistedReadBack);
    const updateImmediate = this.database.transaction(() => {
      const existing = this.select(normalizedKey);
      if (existing === null) throw publicError("failed");
      if (existing.status === "succeeded") {
        if (canonicalJSONStringify(existing.allowlistedReadBack) !== readBackJSON) {
          throw publicError("source_conflict");
        }
        return;
      }
      const result = this.database.prepare(`
        UPDATE executions
        SET status = 'succeeded', read_back_json = ?, updated_at = ?
        WHERE idempotency_key = ? AND status IN ('pending', 'unknown')
      `).run(readBackJSON, new Date().toISOString(), normalizedKey);
      if (result.changes !== 1) throw publicError("failed");
    });
    updateImmediate.immediate();
  }

  markUnknown(key: string): void {
    const normalizedKey = requiredString(key);
    const updateImmediate = this.database.transaction(() => {
      const existing = this.select(normalizedKey);
      if (existing === null) throw publicError("failed");
      if (existing.status === "succeeded" || existing.status === "unknown") return;
      const result = this.database.prepare(`
        UPDATE executions SET status = 'unknown', updated_at = ?
        WHERE idempotency_key = ? AND status = 'pending'
      `).run(new Date().toISOString(), normalizedKey);
      if (result.changes !== 1) throw publicError("failed");
    });
    updateImmediate.immediate();
  }

  get(key: string): LedgerEntry | null {
    return this.select(requiredString(key));
  }

  close(): void {
    this.database.close();
  }

  private select(key: string): LedgerEntry | null {
    const row = this.database.prepare(`
      SELECT idempotency_key, fingerprint, connector_id, connector_version, tool,
             before_json, proposed_json, status, read_back_json, created_at, updated_at
      FROM executions WHERE idempotency_key = ?
    `).get(key) as ExecutionRow | undefined;
    return row === undefined ? null : decodeRow(row);
  }
}
