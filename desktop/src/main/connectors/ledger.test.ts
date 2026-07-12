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

  it("rejects accessors without invoking them in begin or markSucceeded", () => {
    const ledger = new ExecutionLedger(userDataPath);
    let reads = 0;
    const accessorBefore: Record<string, unknown> = {};
    Object.defineProperty(accessorBefore, "version", {
      enumerable: true,
      get() {
        reads += 1;
        return 4;
      },
    });

    expect(() => ledger.begin(input({ idempotencyKey: "k-accessor", before: accessorBefore })))
      .toThrowError("invalid_argument");
    expect(reads).toBe(0);
    expect(ledger.get("k-accessor")).toBeNull();

    ledger.begin(input({ idempotencyKey: "k-readback" }));
    const accessorReadBack: Record<string, unknown> = {};
    Object.defineProperty(accessorReadBack, "version", {
      enumerable: true,
      get() {
        reads += 1;
        return 5;
      },
    });
    expect(() => ledger.markSucceeded("k-readback", accessorReadBack)).toThrowError("invalid_argument");
    expect(reads).toBe(0);
    expect(ledger.get("k-readback")).toMatchObject({ status: "pending" });
    ledger.close();
  });

  it("rejects hidden and symbol fields in every public snapshot input", () => {
    const ledger = new ExecutionLedger(userDataPath);
    const hidden = { version: 4 };
    Object.defineProperty(hidden, "secret", { enumerable: false, value: "hidden" });
    expect(() => ledger.begin(input({ idempotencyKey: "k-hidden", before: hidden })))
      .toThrowError("invalid_argument");

    const symbol = { completionRate: 60 } as Record<PropertyKey, unknown>;
    symbol[Symbol("secret")] = "hidden";
    expect(() => ledger.begin(input({
      idempotencyKey: "k-symbol",
      proposed: symbol as Record<string, unknown>,
    }))).toThrowError("invalid_argument");

    ledger.begin(input({ idempotencyKey: "k-hidden-readback" }));
    expect(() => ledger.markSucceeded("k-hidden-readback", hidden)).toThrowError("invalid_argument");
    expect(ledger.get("k-hidden-readback")).toMatchObject({ status: "pending" });
    ledger.close();
  });

  it.each([
    ["non-plain prototype", { nested: new Date("2026-07-13T00:00:00.000Z") }],
    ["non-finite number", { version: Number.POSITIVE_INFINITY }],
    ["sparse array", { values: Array(2) }],
    ["prototype key", JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>],
  ])("rejects %s in direct ledger snapshots", (_name, snapshot) => {
    const ledger = new ExecutionLedger(userDataPath);
    expect(() => ledger.begin(input({ before: snapshot }))).toThrowError("invalid_argument");
    ledger.close();
  });

  it("rejects cyclic direct ledger snapshots", () => {
    const ledger = new ExecutionLedger(userDataPath);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => ledger.begin(input({ before: cyclic }))).toThrowError("invalid_argument");
    ledger.close();
  });
});
