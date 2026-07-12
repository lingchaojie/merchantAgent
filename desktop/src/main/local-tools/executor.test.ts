import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalDataSourceError,
  LocalToolExecutor,
  type LocalDataSource,
  type LocalToolRequest,
  type SQLUpdateRuntime,
} from "./executor";
import type { SQLUpdateOperation } from "../connectors/schema";
import { verifyCapabilityPackage, type VerifiedPackage } from "./package";
import { ReferenceEnterpriseStore } from "./store";

const desktopRoot = path.resolve(import.meta.dirname, "../../..");
const packagePath = path.join(
  desktopRoot,
  "resources/capabilities/reference-manufacturing.cap.json",
);
const publicKeyPath = path.join(desktopRoot, "resources/capabilities/reference-public.pem");

describe("LocalToolExecutor", () => {
  let directory: string;
  let store: ReferenceEnterpriseStore;
  let pkg: VerifiedPackage;
  let executor: LocalToolExecutor;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-executor-"));
    store = new ReferenceEnterpriseStore(path.join(directory, "reference.sqlite"));
    pkg = verifyCapabilityPackage(packagePath, publicKeyPath);
    executor = new LocalToolExecutor(pkg, store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function request(overrides: Partial<LocalToolRequest> = {}): LocalToolRequest {
    return {
      packageId: pkg.manifest.packageId,
      packageVersion: pkg.manifest.version,
      manifestDigest: pkg.manifestDigest,
      tool: "query_order_status",
      tenantId: "mock-corp-001",
      userId: "u_plan",
      deviceId: "DESKTOP-01",
      roleIds: ["planner"],
      skillId: "production-progress",
      callId: "call-1",
      idempotencyKey: "idem-1",
      risk: "read",
      requiresConfirmation: false,
      args: { orderId: "SO-1001" },
      ...overrides,
    };
  }

  function progressRequest(overrides: Partial<LocalToolRequest> = {}): LocalToolRequest {
    return request({
      tool: "report_production_progress",
      risk: "low_write",
      requiresConfirmation: true,
      args: {
        orderId: "SO-1001",
        workOrderId: "WO-1001",
        completionRate: 80,
        expectedVersion: 1,
        note: "waiting for QA",
      },
      ...overrides,
    });
  }

  it("dispatches reads without requesting confirmation", async () => {
    const confirm = vi.fn();

    const response = await executor.execute(request(), confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      data: { orderId: "SO-1001", workOrderId: "WO-1001", version: 1 },
      meta: { status: "succeeded", idempotencyKey: "idem-1", confirmed: false },
    });
    expect(response.meta.executionId).toEqual(expect.any(String));
  });

  it("previews the current and proposed progress before writing", async () => {
    const confirm = vi.fn().mockResolvedValue(false);

    await executor.execute(progressRequest(), confirm);

    expect(confirm).toHaveBeenCalledWith({
      orderId: "SO-1001",
      workOrderId: "WO-1001",
      before: expect.objectContaining({ completionRate: 60, note: expect.any(String), version: 1 }),
      proposed: { completionRate: 80, note: "waiting for QA" },
    });
  });

  it("returns cancelled and does not mutate when confirmation is declined", async () => {
    const before = store.queryOrderStatus("SO-1001");

    const response = await executor.execute(progressRequest(), async () => false);

    expect(response).toMatchObject({
      error: "cancelled",
      meta: { status: "cancelled", confirmed: false, before },
    });
    expect(store.queryOrderStatus("SO-1001")).toEqual(before);
  });

  it("returns confirmed execution metadata and verified before/after values", async () => {
    const response = await executor.execute(progressRequest(), async () => true);

    expect(response).toMatchObject({
      data: { orderId: "SO-1001", completionRate: 80, version: 2 },
      meta: {
        status: "succeeded",
        executionId: expect.any(String),
        idempotencyKey: "idem-1",
        confirmed: true,
        confirmedAt: expect.any(String),
        before: { orderId: "SO-1001", completionRate: 60, version: 1 },
        after: { orderId: "SO-1001", completionRate: 80, version: 2 },
      },
    });
  });

  it("writes the approved snapshot when confirmation mutates the original request", async () => {
    const input = progressRequest();

    const response = await executor.execute(input, async (preview) => {
      expect(preview.proposed).toEqual({ completionRate: 80, note: "waiting for QA" });
      input.idempotencyKey = "mutated-idempotency-key";
      input.userId = "mutated-user";
      input.args.orderId = "SO-OTHER";
      input.args.workOrderId = "WO-OTHER";
      input.args.completionRate = 99;
      input.args.expectedVersion = 999;
      input.args.note = "not approved";
      return true;
    });

    expect(response).toMatchObject({
      data: { orderId: "SO-1001", workOrderId: "WO-1001", completionRate: 80, version: 2 },
      meta: {
        status: "succeeded",
        idempotencyKey: "idem-1",
        before: { completionRate: 60, version: 1 },
        after: { completionRate: 80, note: "waiting for QA", version: 2 },
      },
    });
    expect(store.queryOrderStatus("SO-1001")).toMatchObject({
      completionRate: 80,
      note: "waiting for QA",
      version: 2,
    });
  });

  it("returns the stored result for a duplicate idempotency key", async () => {
    const first = await executor.execute(progressRequest(), async () => true);
    const second = await executor.execute(progressRequest(), async () => true);

    expect(second.data).toEqual(first.data);
    expect(second.meta.before).toEqual(first.meta.before);
    expect(second.meta.after).toEqual(first.meta.after);
    expect(store.queryOrderStatus("SO-1001").version).toBe(2);
  });

  it("keeps omitted note distinct from an explicitly empty note for idempotency", async () => {
    const original = store.queryOrderStatus("SO-1001");
    const withoutNote = progressRequest({
      args: {
        orderId: "SO-1001",
        workOrderId: "WO-1001",
        completionRate: 80,
        expectedVersion: 1,
      },
    });
    const first = await executor.execute(withoutNote, async () => true);
    const changed = await executor.execute(
      progressRequest({
        args: {
          orderId: "SO-1001",
          workOrderId: "WO-1001",
          completionRate: 80,
          expectedVersion: 1,
          note: "",
        },
      }),
      async () => true,
    );

    expect(first).toMatchObject({
      data: { note: original.note, version: 2 },
      meta: { status: "succeeded" },
    });
    expect(changed).toMatchObject({ error: "source_conflict", meta: { status: "source_conflict" } });
    expect(store.queryOrderStatus("SO-1001")).toMatchObject({ note: original.note, version: 2 });
  });

  it.each([
    ["unknown tool", { tool: "execute_sql" }, "tool_not_installed"],
    ["mismatched version", { packageVersion: "2.0.0" }, "package_version"],
    ["mismatched digest", { manifestDigest: "sha256:wrong" }, "package_version"],
    ["invalid arguments", { args: { orderId: "SO-1001", sql: "SELECT *" } }, "invalid_argument"],
    ["invalid credentials", { userId: "" }, "invalid_credentials"],
    ["risk downgrade", { risk: "read", requiresConfirmation: false }, "invalid_argument"],
  ] as const)("maps %s to %s", async (_name, overrides, error) => {
    const input = error === "invalid_argument" && "risk" in overrides
      ? progressRequest(overrides)
      : request(overrides);
    const response = await executor.execute(input, vi.fn());

    expect(response).toMatchObject({ error, meta: { status: "failed", confirmed: false } });
  });

  it("rejects invocation argument names inherited by ordinary objects", async () => {
    const args = JSON.parse('{"orderId":"SO-1001","constructor":"attacker"}') as Record<
      string,
      unknown
    >;

    const response = await executor.execute(request({ args }), vi.fn());

    expect(response).toMatchObject({
      error: "invalid_argument",
      meta: { status: "failed", confirmed: false },
    });
  });

  it("maps a missing datasource without attempting dispatch", async () => {
    const response = await new LocalToolExecutor(pkg).execute(request(), vi.fn());

    expect(response).toMatchObject({
      error: "missing_datasource",
      meta: { status: "failed", confirmed: false },
    });
  });

  it("maps datasource credential failures", async () => {
    const unavailableStore: LocalDataSource = {
      queryOrderStatus() {
        throw new LocalDataSourceError("invalid_credentials", "login rejected");
      },
      reportProductionProgress() {
        throw new Error("unexpected write");
      },
    };

    const response = await new LocalToolExecutor(pkg, unavailableStore).execute(request(), vi.fn());

    expect(response).toMatchObject({
      error: "invalid_credentials",
      meta: { status: "failed", confirmed: false },
    });
  });

  it("maps optimistic concurrency failures to source_conflict", async () => {
    const response = await executor.execute(
      progressRequest({
        idempotencyKey: "idem-stale",
        args: {
          orderId: "SO-1001",
          workOrderId: "WO-1001",
          completionRate: 80,
          expectedVersion: 0,
        },
      }),
      async () => true,
    );

    expect(response).toMatchObject({
      error: "source_conflict",
      meta: { status: "source_conflict", confirmed: false },
    });
    expect(store.queryOrderStatus("SO-1001").version).toBe(1);
  });

  it("rejects a mismatched work order before confirmation", async () => {
    const confirm = vi.fn();
    const response = await executor.execute(
      progressRequest({
        args: {
          orderId: "SO-1001",
          workOrderId: "WO-OTHER",
          completionRate: 80,
          expectedVersion: 1,
        },
      }),
      confirm,
    );

    expect(response.error).toBe("source_conflict");
    expect(confirm).not.toHaveBeenCalled();
  });

  function sqlRuntime(overrides: Partial<SQLUpdateRuntime["adapter"]> = {}): SQLUpdateRuntime {
    return {
      operation: {
        kind: "update",
        tool: "report_production_progress",
        bindings: [
          { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 },
          { parameter: "workOrderId", argument: "workOrderId", type: "NVarChar", maxLength: 64 },
          { parameter: "completionRate", argument: "completionRate", type: "Int" },
          { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" },
          { parameter: "nextVersion", argument: "nextVersion", type: "Int" },
          { parameter: "note", argument: "note", type: "NVarChar", maxLength: 256 },
        ],
      } as SQLUpdateOperation,
      adapter: {
        resumeUpdate: vi.fn().mockResolvedValue(null),
        previewUpdate: vi.fn().mockResolvedValue({
          before: store.queryOrderStatus("SO-1001"),
          proposed: { completionRate: 80, note: "waiting for QA", version: 2 },
        }),
        executeConfirmedUpdate: vi.fn().mockResolvedValue({
          ...store.queryOrderStatus("SO-1001"), completionRate: 80, note: "waiting for QA", version: 2,
        }),
        ...overrides,
      },
    };
  }

  it("routes SQL writes through preview, native confirmation, and confirmed execution", async () => {
    const runtime = sqlRuntime();
    const sqlExecutor = new LocalToolExecutor(pkg, store, runtime);

    const response = await sqlExecutor.execute(progressRequest(), async (preview) => {
      expect(preview).toMatchObject({
        orderId: "SO-1001",
        workOrderId: "WO-1001",
        before: { completionRate: 60, version: 1 },
        proposed: { completionRate: 80, note: "waiting for QA" },
      });
      return true;
    });

    expect(runtime.adapter.resumeUpdate).toHaveBeenCalledWith(
      runtime.operation,
      { orderId: "SO-1001", workOrderId: "WO-1001", completionRate: 80, expectedVersion: 1, nextVersion: 2, note: "waiting for QA" },
      "idem-1",
    );
    expect(runtime.adapter.executeConfirmedUpdate).toHaveBeenCalledOnce();
    expect(response).toMatchObject({
      data: { completionRate: 80, version: 2 },
      meta: { status: "succeeded", confirmed: true, before: { version: 1 }, after: { version: 2 } },
    });
    expect(store.queryOrderStatus("SO-1001")).toMatchObject({ completionRate: 60, version: 1 });
  });

  it("cancels a SQL preview without beginning a ledger write", async () => {
    const runtime = sqlRuntime();
    const sqlExecutor = new LocalToolExecutor(pkg, store, runtime);

    const response = await sqlExecutor.execute(progressRequest(), async () => false);

    expect(response).toMatchObject({ error: "cancelled", meta: { status: "cancelled", confirmed: false } });
    expect(runtime.adapter.executeConfirmedUpdate).not.toHaveBeenCalled();
  });

  it("returns SQL terminal replay without preview or reconfirmation", async () => {
    const prior = {
      result: { ...store.queryOrderStatus("SO-1001"), completionRate: 80, version: 2 },
      before: store.queryOrderStatus("SO-1001"),
      proposed: { completionRate: 80, note: "waiting for QA", version: 2 },
      confirmedAt: "2026-07-13T00:00:00.000Z",
    };
    const runtime = sqlRuntime({ resumeUpdate: vi.fn().mockResolvedValue(prior) });
    const confirm = vi.fn();

    const response = await new LocalToolExecutor(pkg, store, runtime).execute(progressRequest(), confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.adapter.previewUpdate).not.toHaveBeenCalled();
    expect(runtime.adapter.executeConfirmedUpdate).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      data: prior.result,
      meta: { status: "succeeded", confirmed: true, confirmedAt: prior.confirmedAt },
    });
  });

  it("checks an existing SQL idempotency key before ordinary argument type validation", async () => {
    const runtime = sqlRuntime({
      resumeUpdate: vi.fn().mockRejectedValue(Object.assign(new Error("static"), { code: "source_conflict" })),
    });
    const confirm = vi.fn();
    const changed = progressRequest({
      args: {
        orderId: "SO-1001",
        workOrderId: "WO-1001",
        completionRate: "type-invalid",
        expectedVersion: 1,
        note: "waiting for QA",
      },
    });

    const response = await new LocalToolExecutor(pkg, store, runtime).execute(changed, confirm);

    expect(runtime.adapter.resumeUpdate).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ error: "source_conflict", meta: { status: "source_conflict" } });
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.adapter.previewUpdate).not.toHaveBeenCalled();
    expect(runtime.adapter.executeConfirmedUpdate).not.toHaveBeenCalled();
  });

  it("keeps a missing-key invalid SQL request out of pending state", async () => {
    const runtime = sqlRuntime();
    const invalid = progressRequest({
      args: {
        orderId: "SO-1001",
        workOrderId: "WO-1001",
        completionRate: "type-invalid",
        expectedVersion: 1,
        note: "waiting for QA",
      },
    });

    const response = await new LocalToolExecutor(pkg, store, runtime).execute(invalid, vi.fn());

    expect(runtime.adapter.resumeUpdate).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ error: "invalid_argument", meta: { status: "failed" } });
    expect(runtime.adapter.previewUpdate).not.toHaveBeenCalled();
    expect(runtime.adapter.executeConfirmedUpdate).not.toHaveBeenCalled();
  });

  it("preserves confirmation metadata when SQL finalization is unknown", async () => {
    const runtime = sqlRuntime({
      executeConfirmedUpdate: vi.fn().mockRejectedValue(Object.assign(new Error("hidden"), { code: "unknown" })),
    });

    const response = await new LocalToolExecutor(pkg, store, runtime).execute(progressRequest(), async () => true);

    expect(response).toMatchObject({
      error: "unknown",
      meta: {
        status: "unknown",
        confirmed: true,
        confirmedAt: expect.any(String),
        before: { orderId: "SO-1001", version: 1 },
      },
    });
  });

  it("preserves prior confirmation metadata when unknown recovery is inconclusive", async () => {
    const priorBefore = store.queryOrderStatus("SO-1001");
    const runtime = sqlRuntime({
      resumeUpdate: vi.fn().mockRejectedValue(Object.assign(new Error("unknown"), {
        name: "ResumedUpdateError",
        code: "unknown",
        confirmedAt: "2026-07-13T01:02:03.000Z",
        before: priorBefore,
      })),
    });

    const response = await new LocalToolExecutor(pkg, store, runtime).execute(progressRequest(), vi.fn());

    expect(response).toMatchObject({
      error: "unknown",
      meta: {
        status: "unknown",
        confirmed: true,
        confirmedAt: "2026-07-13T01:02:03.000Z",
        before: priorBefore,
      },
    });
  });
});
