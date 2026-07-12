import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExecutionLedger, type LedgerInput } from "./ledger";

describe("ExecutionLedger", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "execution-ledger-"));
  });

  afterEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  function input(overrides: Partial<LedgerInput> = {}): LedgerInput {
    return {
      idempotencyKey: "k1",
      fingerprint: "f1",
      connectorId: "sql-orders",
      version: "1.0.0",
      tool: "report_production_progress",
      before: { orderId: "ORD-1001", completionRate: 45, version: 4 },
      proposed: { completionRate: 60, version: 5 },
      ...overrides,
    };
  }

  it("persists pending before returning created and recovers it after reopen", () => {
    const first = new ExecutionLedger(userDataPath);
    expect(first.begin(input())).toMatchObject({ kind: "created", entry: { status: "pending" } });
    first.close();

    const reopened = new ExecutionLedger(userDataPath);
    expect(reopened.begin(input())).toMatchObject({
      kind: "recover",
      entry: { status: "pending", before: input().before, proposed: input().proposed },
    });
    reopened.close();
  });

  it("replays a same-key fingerprint and rejects changed semantics", () => {
    const ledger = new ExecutionLedger(userDataPath);
    ledger.begin(input());
    ledger.markSucceeded("k1", { orderId: "ORD-1001", completionRate: 60, version: 5 });

    expect(ledger.begin(input())).toMatchObject({
      kind: "replay",
      entry: {
        status: "succeeded",
        allowlistedReadBack: { orderId: "ORD-1001", completionRate: 60, version: 5 },
      },
    });
    expect(() => ledger.begin(input({ fingerprint: "changed" }))).toThrowError("source_conflict");
    ledger.close();
  });

  it("moves pending to unknown without storing failure detail", () => {
    const ledger = new ExecutionLedger(userDataPath);
    ledger.begin(input());
    ledger.markUnknown("k1");

    expect(ledger.get("k1")).toMatchObject({ status: "unknown" });
    expect(ledger.begin(input())).toMatchObject({ kind: "recover", entry: { status: "unknown" } });
    ledger.close();

    const database = new Database(path.join(userDataPath, "connectors", "executions.db"), { readonly: true });
    const columns = database.pragma("table_info(executions)") as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual([
      "idempotency_key",
      "fingerprint",
      "connector_id",
      "connector_version",
      "tool",
      "before_json",
      "proposed_json",
      "status",
      "read_back_json",
      "created_at",
      "updated_at",
    ]);
    expect(columns.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
      "sql", "profile", "credential", "raw_row", "driver_error",
    ]));
    database.close();
  });

  it("rejects non-JSON snapshots and malformed persisted JSON", () => {
    const ledger = new ExecutionLedger(userDataPath);
    expect(() => ledger.begin(input({ before: { version: Number.NaN } }))).toThrowError();
    ledger.begin(input());
    ledger.close();

    const database = new Database(path.join(userDataPath, "connectors", "executions.db"));
    database.prepare("UPDATE executions SET before_json = ? WHERE idempotency_key = ?").run("[]", "k1");
    database.close();

    const reopened = new ExecutionLedger(userDataPath);
    expect(() => reopened.get("k1")).toThrowError("failed");
    reopened.close();
  });
});
