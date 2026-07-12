import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as mssql from "mssql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CredentialVault } from "./credential-vault";
import { ExecutionLedger } from "./ledger";
import type { SQLServerProfile, SQLUpdateOperation } from "./schema";
import { MSSQLPoolFactory, SQLServerAdapter, type SQLPoolFactory, type SQLWriteOptions } from "./sql-adapter";

function profile(): SQLServerProfile {
  return {
    profileId: "erp-test",
    server: "sql.test.internal",
    port: 1433,
    database: "merchant_test",
    encrypt: true,
    trustServerCertificate: false,
    connectTimeoutMS: 5_000,
    queryTimeoutMS: 8_000,
    credentialRef: "erp-test",
    environment: "test",
  };
}

function operation(): SQLUpdateOperation {
  const select = [
    "SELECT o.order_id AS order_id, o.work_order_id AS work_order_id,",
    "o.completion_rate AS completion_rate, o.note AS progress_note, o.version AS record_version",
    "FROM dbo.production_orders AS o WHERE o.order_id = @orderId",
  ].join(" ");
  return {
    kind: "update",
    tool: "report_production_progress",
    beforeSql: select,
    updateSql: [
      "UPDATE dbo.production_orders",
      "SET completion_rate = @completionRate, note = @note, version = @nextVersion",
      "WHERE order_id = @orderId AND version = @expectedVersion",
    ].join(" "),
    readBackSql: select,
    bindings: [
      { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 },
      { parameter: "completionRate", argument: "completionRate", type: "Int" },
      { parameter: "note", argument: "note", type: "NVarChar", maxLength: 256 },
      { parameter: "nextVersion", argument: "nextVersion", type: "Int" },
      { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" },
    ],
    projection: [
      { sourceAlias: "order_id", resultField: "orderId", type: "string" },
      { sourceAlias: "work_order_id", resultField: "workOrderId", type: "string" },
      { sourceAlias: "completion_rate", resultField: "completionRate", type: "integer" },
      { sourceAlias: "progress_note", resultField: "note", type: "string" },
      { sourceAlias: "record_version", resultField: "version", type: "integer" },
    ],
    proposed: [
      { resultField: "completionRate", argument: "completionRate" },
      { resultField: "note", argument: "note" },
      { resultField: "version", argument: "nextVersion" },
    ],
    declaredObject: "dbo.production_orders",
    resourceParameter: "orderId",
    concurrencyParameter: "expectedVersion",
    updateColumns: ["completion_rate", "note", "version"],
    versionField: "version",
    timeoutMS: 3_000,
  };
}

const args = {
  orderId: "ORD-1001",
  completionRate: 60,
  note: "line stable",
  nextVersion: 5,
  expectedVersion: 4,
};
const before = {
  orderId: "ORD-1001",
  workOrderId: "WO-2001",
  completionRate: 45,
  note: "fixture row one",
  version: 4,
};
const after = { ...before, completionRate: 60, note: "line stable", version: 5 };

interface FakeRequest {
  input: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

function request(result: unknown): FakeRequest {
  const value: FakeRequest = {
    input: vi.fn(),
    query: result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result),
    cancel: vi.fn(),
  };
  value.input.mockReturnValue(value);
  return value;
}

function readResult(row: Record<string, unknown>) {
  return {
    recordset: [{
      order_id: row.orderId,
      work_order_id: row.workOrderId,
      completion_rate: row.completionRate,
      progress_note: row.note,
      record_version: row.version,
    }],
    rowsAffected: [1],
  };
}

function vault(): CredentialVault {
  return {
    put: vi.fn(),
    get: vi.fn().mockResolvedValue({ username: "agent", password: "test-only" }),
    remove: vi.fn(),
    listRefs: vi.fn(),
  };
}

interface ScriptedFixture {
  pools: SQLPoolFactory & { open: ReturnType<typeof vi.fn> };
  queries: FakeRequest[];
  transaction: { begin: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> };
}

function scriptedFixture(sourceResults: unknown[], readResults: unknown[] = []): ScriptedFixture {
  const queries = sourceResults.map(request);
  const readQueries = readResults.map(request);
  const transaction = {
    begin: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockImplementation(() => {
      const next = queries.shift();
      if (next === undefined) throw new Error("unexpected transaction request");
      return next;
    }),
  };
  const openedPools = [
    ...(sourceResults.length === 0 ? [] : [{
      transaction: vi.fn().mockReturnValue(transaction),
      close: vi.fn().mockResolvedValue(undefined),
    }]),
    ...readQueries.map((next) => ({ request: vi.fn().mockReturnValue(next), close: vi.fn().mockResolvedValue(undefined) })),
  ];
  const open = vi.fn().mockImplementation(async () => {
    const next = openedPools.shift();
    if (next === undefined) throw new Error("unexpected pool open");
    return next as unknown as mssql.ConnectionPool;
  });
  return { pools: { open }, queries: [...readQueries, ...queries], transaction };
}

describe("SQLServerAdapter transactional updates", () => {
  let userDataPath: string;
  let ledger: ExecutionLedger;

  beforeEach(() => {
    userDataPath = fs.mkdtempSync(`${os.tmpdir()}\\sql-write-`);
    ledger = new ExecutionLedger(userDataPath);
  });

  afterEach(() => {
    ledger.close();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  function options(overrides: Partial<SQLWriteOptions> = {}): SQLWriteOptions {
    return { ledger, connectorId: "sql-orders", version: "1.0.0", ...overrides };
  }

  it("previews immutable allowlisted before and proposed values", async () => {
    const fixture = scriptedFixture([], [readResult(before)]);
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());

    const preview = await adapter.previewUpdate(operation(), { ...args });

    expect(preview).toEqual({
      before,
      proposed: { completionRate: 60, note: "line stable", version: 5 },
    });
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.before)).toBe(true);
  });

  it("uses one source transaction and marks success only after commit", async () => {
    const fixture = scriptedFixture([
      readResult(before),
      { recordset: [], rowsAffected: [1] },
      readResult(after),
    ]);
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());

    const result = await adapter.executeConfirmedUpdate(
      operation(), { ...args }, "k-success", { before, proposed: { completionRate: 60, note: "line stable", version: 5 } },
    );

    expect(result).toEqual(after);
    expect(fixture.transaction.begin).toHaveBeenCalledOnce();
    expect(fixture.transaction.commit).toHaveBeenCalledOnce();
    expect(fixture.transaction.rollback).not.toHaveBeenCalled();
    expect(ledger.get("k-success")).toMatchObject({ status: "succeeded", allowlistedReadBack: after });
    expect(fixture.queries[0]?.input.mock.calls.map(([name]) => name)).toEqual(["orderId"]);
    expect(fixture.queries[1]?.input.mock.calls.map(([name]) => name)).toEqual([
      "orderId", "completionRate", "note", "nextVersion", "expectedVersion",
    ]);
    expect(fixture.queries[2]?.input.mock.calls.map(([name]) => name)).toEqual(["orderId"]);
  });

  it("materializes a preserve-if-missing field from the confirmed before snapshot", async () => {
    const preserveOperation = operation();
    preserveOperation.proposed[1] = {
      ...preserveOperation.proposed[1],
      preserveIfMissing: true,
    };
    const omittedArgs = { ...args } as Partial<typeof args>;
    delete omittedArgs.note;
    const expectedAfter = { ...after, note: before.note };
    const previewFixture = scriptedFixture([], [readResult(before)]);
    const previewAdapter = new SQLServerAdapter(profile(), vault(), previewFixture.pools, options());
    const preview = await previewAdapter.previewUpdate(preserveOperation, omittedArgs as Record<string, unknown>);

    expect(preview.proposed).toMatchObject({ note: before.note });
    const fixture = scriptedFixture([
      readResult(before), { recordset: [], rowsAffected: [1] }, readResult(expectedAfter),
    ]);
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());
    await expect(adapter.executeConfirmedUpdate(
      preserveOperation, omittedArgs as Record<string, unknown>, "k-preserve", preview,
    )).resolves.toEqual(expectedAfter);
    const updateNoteBinding = fixture.queries[1]?.input.mock.calls.find(([name]) => name === "note");
    expect(updateNoteBinding?.[2]).toBe(before.note);
  });

  it("rolls back without UPDATE when the confirmed before snapshot changed", async () => {
    const fixture = scriptedFixture([readResult({ ...before, version: 5 })]);
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());

    await expect(adapter.executeConfirmedUpdate(
      operation(), { ...args }, "k-stale", { before, proposed: { completionRate: 60, note: "line stable", version: 5 } },
    )).rejects.toMatchObject({ code: "source_conflict" });
    expect(fixture.transaction.rollback).toHaveBeenCalledOnce();
    expect(fixture.transaction.commit).not.toHaveBeenCalled();
  });

  it("rejects non-projected preview fields before creating a ledger row", async () => {
    const fixture = scriptedFixture([]);
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());

    await expect(adapter.executeConfirmedUpdate(
      operation(),
      { ...args },
      "k-extra-preview",
      {
        before: { ...before, secretCost: 999 },
        proposed: { completionRate: 60, note: "line stable", version: 5 },
      },
    )).rejects.toMatchObject({ code: "invalid_argument" });
    expect(ledger.get("k-extra-preview")).toBeNull();
    expect(fixture.pools.open).not.toHaveBeenCalled();
  });

  it("fails closed when affected rows is not exactly one", async () => {
    const fixture = scriptedFixture([readResult(before), { recordset: [], rowsAffected: [2] }]);
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());

    await expect(adapter.executeConfirmedUpdate(
      operation(), { ...args }, "k-many", { before, proposed: { completionRate: 60, note: "line stable", version: 5 } },
    )).rejects.toMatchObject({ code: "source_conflict" });
    expect(fixture.transaction.rollback).toHaveBeenCalledOnce();
  });

  it("rolls back a read-back mismatch as source_rejected", async () => {
    const fixture = scriptedFixture([
      readResult(before),
      { recordset: [], rowsAffected: [1] },
      readResult({ ...after, completionRate: 59 }),
    ]);
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());

    await expect(adapter.executeConfirmedUpdate(
      operation(), { ...args }, "k-rejected", { before, proposed: { completionRate: 60, note: "line stable", version: 5 } },
    )).rejects.toMatchObject({ code: "source_rejected" });
    expect(fixture.transaction.rollback).toHaveBeenCalledOnce();
    expect(fixture.transaction.commit).not.toHaveBeenCalled();
  });

  it("marks an ambiguous commit failure unknown", async () => {
    const fixture = scriptedFixture([
      readResult(before), { recordset: [], rowsAffected: [1] }, readResult(after),
    ]);
    fixture.transaction.commit.mockRejectedValueOnce(new Error("connection dropped during commit"));
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());

    await expect(adapter.executeConfirmedUpdate(
      operation(), { ...args }, "k-commit", { before, proposed: { completionRate: 60, note: "line stable", version: 5 } },
    )).rejects.toMatchObject({ code: "unknown" });
    expect(ledger.get("k-commit")).toMatchObject({ status: "unknown" });
    expect(fixture.transaction.rollback).not.toHaveBeenCalled();
  });

  it("returns unknown promptly when commit never settles before the operation deadline", async () => {
    const fixture = scriptedFixture([
      readResult(before), { recordset: [], rowsAffected: [1] }, readResult(after),
    ]);
    fixture.transaction.commit.mockReturnValueOnce(new Promise(() => undefined));
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());
    const timedOperation = { ...operation(), timeoutMS: 50 };
    const execution = adapter.executeConfirmedUpdate(
      timedOperation, { ...args }, "k-commit-deadline",
      { before, proposed: { completionRate: 60, note: "line stable", version: 5 } },
    ).then(
      () => "unexpected-success",
      (error: { code?: string }) => error.code,
    );

    await expect(Promise.race([
      execution,
      new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 250)),
    ])).resolves.toBe("unknown");
    expect(ledger.get("k-commit-deadline")).toMatchObject({ status: "unknown" });
    expect(fixture.transaction.rollback).not.toHaveBeenCalled();
  });

  it("returns unknown on abort during commit and consumes a late commit rejection", async () => {
    const fixture = scriptedFixture([
      readResult(before), { recordset: [], rowsAffected: [1] }, readResult(after),
    ]);
    let rejectCommit!: (error: Error) => void;
    fixture.transaction.commit.mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectCommit = reject;
    }));
    const controller = new AbortController();
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const execution = adapter.executeConfirmedUpdate(
        operation(), { ...args }, "k-commit-abort",
        { before, proposed: { completionRate: 60, note: "line stable", version: 5 } },
        controller.signal,
      );
      await vi.waitFor(() => expect(fixture.transaction.commit).toHaveBeenCalledOnce());
      controller.abort();

      await expect(Promise.race([
        execution.then(() => "unexpected-success", (error: { code?: string }) => error.code),
        new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 250)),
      ])).resolves.toBe("unknown");
      rejectCommit(new Error("late commit rejection with secret detail"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(ledger.get("k-commit-abort")).toMatchObject({ status: "unknown" });
      expect(fixture.transaction.rollback).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not retry a write after a transient-looking connection failure", async () => {
    const connectionError = Object.assign(new Error("socket timeout"), {
      name: "ConnectionError",
      code: "ETIMEOUT",
    });
    const pools: SQLPoolFactory & { open: ReturnType<typeof vi.fn> } = {
      open: vi.fn().mockRejectedValue(connectionError),
    };
    const adapter = new SQLServerAdapter(profile(), vault(), pools, options());

    await expect(adapter.executeConfirmedUpdate(
      operation(), { ...args }, "k-no-retry", { before, proposed: { completionRate: 60, note: "line stable", version: 5 } },
    )).rejects.toMatchObject({ code: "connection_failed" });
    expect(pools.open).toHaveBeenCalledOnce();
    expect(ledger.get("k-no-retry")).toMatchObject({ status: "pending" });
  });

  it("returns a static source failure when driver rollback stalls", async () => {
    const fixture = scriptedFixture([readResult({ ...before, version: 6 })]);
    fixture.transaction.rollback.mockReturnValueOnce(new Promise(() => undefined));
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());
    const execution = adapter.executeConfirmedUpdate(
      operation(), { ...args }, "k-stalled-rollback", { before, proposed: { completionRate: 60, note: "line stable", version: 5 } },
    ).then(
      () => "unexpected-success",
      (error: { code?: string }) => error.code,
    );

    await expect(Promise.race([
      execution,
      new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 250)),
    ])).resolves.toBe("source_conflict");
  });

  it("replays terminal success without opening SQL and rejects a changed fingerprint", async () => {
    const fixture = scriptedFixture([readResult(before), { recordset: [], rowsAffected: [1] }, readResult(after)]);
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options());
    const preview = { before, proposed: { completionRate: 60, note: "line stable", version: 5 } };
    await adapter.executeConfirmedUpdate(operation(), { ...args }, "k-replay", preview);
    const opens = fixture.pools.open.mock.calls.length;

    await expect(adapter.executeConfirmedUpdate(operation(), { ...args }, "k-replay", preview)).resolves.toEqual(after);
    expect(fixture.pools.open).toHaveBeenCalledTimes(opens);
    await expect(adapter.executeConfirmedUpdate(
      operation(), { ...args, note: "changed" }, "k-replay", preview,
    )).rejects.toMatchObject({ code: "source_conflict" });
    await expect(adapter.executeConfirmedUpdate(
      operation(), { ...args, completionRate: "invalid" }, "k-replay", preview,
    )).rejects.toMatchObject({ code: "source_conflict" });
    let accessorReads = 0;
    const accessorArgs = { ...args };
    Object.defineProperty(accessorArgs, "completionRate", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 60;
      },
    });
    await expect(adapter.executeConfirmedUpdate(operation(), accessorArgs, "k-replay", preview))
      .rejects.toMatchObject({ code: "invalid_argument" });
    expect(accessorReads).toBe(0);
    expect(fixture.pools.open).toHaveBeenCalledTimes(opens);
  });

  it("marks unknown after source commit and recovery never repeats UPDATE", async () => {
    const fixture = scriptedFixture(
      [readResult(before), { recordset: [], rowsAffected: [1] }, readResult(after)],
      [readResult(after)],
    );
    let failFinalization = true;
    const failingLedger = {
      begin: ledger.begin.bind(ledger),
      get: ledger.get.bind(ledger),
      markUnknown: ledger.markUnknown.bind(ledger),
      markSucceeded(key: string, result: Record<string, unknown>) {
        if (failFinalization) {
          failFinalization = false;
          throw new Error("simulated local disk failure");
        }
        ledger.markSucceeded(key, result);
      },
    };
    const adapter = new SQLServerAdapter(profile(), vault(), fixture.pools, options({ ledger: failingLedger }));
    const preview = { before, proposed: { completionRate: 60, note: "line stable", version: 5 } };

    await expect(adapter.executeConfirmedUpdate(operation(), { ...args }, "k-crash", preview))
      .rejects.toMatchObject({ code: "unknown" });
    expect(ledger.get("k-crash")).toMatchObject({ status: "unknown" });
    const recovered = await adapter.recoverUnknown(operation(), { ...args }, "k-crash");
    expect(recovered).toEqual(after);
    expect(fixture.queries.filter((query) => query.query.mock.calls.some(([sql]) => sql === operation().updateSql))).toHaveLength(1);
    expect(ledger.get("k-crash")).toMatchObject({ status: "succeeded" });
  });

  it("keeps inconclusive recovery unknown and treats proven unchanged as conflict", async () => {
    const preview = { before, proposed: { completionRate: 60, note: "line stable", version: 5 } };
    const unknownFixture = scriptedFixture([new Error("source unavailable")], [{ recordset: [], rowsAffected: [] }]);
    const unknownAdapter = new SQLServerAdapter(profile(), vault(), unknownFixture.pools, options());
    await expect(unknownAdapter.executeConfirmedUpdate(operation(), { ...args }, "k-unknown", preview)).rejects.toBeDefined();
    ledger.markUnknown("k-unknown");
    await expect(unknownAdapter.recoverUnknown(operation(), { ...args }, "k-unknown"))
      .rejects.toMatchObject({ code: "unknown" });

    const unchangedFixture = scriptedFixture([new Error("source unavailable")], [readResult(before)]);
    const unchangedAdapter = new SQLServerAdapter(profile(), vault(), unchangedFixture.pools, options());
    await expect(unchangedAdapter.executeConfirmedUpdate(operation(), { ...args }, "k-unchanged", preview)).rejects.toBeDefined();
    ledger.markUnknown("k-unchanged");
    await expect(unchangedAdapter.recoverUnknown(operation(), { ...args }, "k-unchanged"))
      .rejects.toMatchObject({ code: "source_conflict" });
  });

  const integration = process.env.M7_SQLSERVER_TEST === "1" ? it : it.skip;

  integration("commits and recovers a real strict-TLS SQL Server update", async () => {
    const caPath = path.resolve(__dirname, "../../../../test/sqlserver/tls/ca.crt");
    expect(fs.existsSync(caPath)).toBe(true);
    const liveProfile = {
      ...profile(),
      server: "localhost",
      port: 11433,
      caPath,
      queryTimeoutMS: 10_000,
    };
    const liveVault: CredentialVault = {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue({ username: "merchant_agent_test", password: "M7SqlTest!2026" }),
      remove: vi.fn(),
      listRefs: vi.fn(),
    };
    const firstArgs = { ...args, expectedVersion: 1, nextVersion: 2 };
    const adapter = new SQLServerAdapter(liveProfile, liveVault, new MSSQLPoolFactory(), options());
    const preview = await adapter.previewUpdate(operation(), firstArgs);
    expect(preview.before).toMatchObject({ orderId: "ORD-1001", completionRate: 45, version: 1 });

    const committed = await adapter.executeConfirmedUpdate(operation(), firstArgs, "live-commit", preview);
    expect(committed).toMatchObject({ completionRate: 60, version: 2 });
    await expect(adapter.executeConfirmedUpdate(operation(), firstArgs, "live-commit", preview)).resolves.toEqual(committed);

    const secondArgs = { ...args, completionRate: 61, expectedVersion: 2, nextVersion: 3 };
    const secondPreview = await adapter.previewUpdate(operation(), secondArgs);
    let failFinalization = true;
    const failingLedger = {
      begin: ledger.begin.bind(ledger),
      get: ledger.get.bind(ledger),
      markUnknown: ledger.markUnknown.bind(ledger),
      markSucceeded(key: string, result: Record<string, unknown>) {
        if (failFinalization) {
          failFinalization = false;
          throw new Error("simulated local finalization failure");
        }
        ledger.markSucceeded(key, result);
      },
    };
    const recoveringAdapter = new SQLServerAdapter(
      liveProfile, liveVault, new MSSQLPoolFactory(), options({ ledger: failingLedger }),
    );
    await expect(recoveringAdapter.executeConfirmedUpdate(
      operation(), secondArgs, "live-recover", secondPreview,
    )).rejects.toMatchObject({ code: "unknown" });
    await expect(recoveringAdapter.recoverUnknown(operation(), secondArgs, "live-recover"))
      .resolves.toMatchObject({ completionRate: 61, version: 3 });
  });
});
