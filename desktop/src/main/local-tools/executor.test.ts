import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalDataSourceError,
  LocalToolExecutor,
  type LocalDataSource,
  type LocalToolRequest,
} from "./executor";
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
});
