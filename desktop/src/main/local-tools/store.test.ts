import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReferenceEnterpriseStore,
  ReferenceEnterpriseStoreError,
  type ProductionProgressInput,
} from "./store";

const initialStatus = {
  orderId: "SO-1001",
  workOrderId: "WO-1001",
  status: "生产中",
  promiseDate: "2026-07-20",
  completionRate: 60,
  note: "装配中",
  version: 1,
};

const progressInput: ProductionProgressInput = {
  orderId: "SO-1001",
  workOrderId: "WO-1001",
  completionRate: 80,
  expectedVersion: 1,
  note: "等待质检",
  idempotencyKey: "idem-1",
};

function expectStoreError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected store operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ReferenceEnterpriseStoreError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).toContain(code);
  }
}

describe("ReferenceEnterpriseStore", () => {
  let directory: string;
  let databasePath: string;
  let store: ReferenceEnterpriseStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "reference-erp-"));
    databasePath = path.join(directory, "reference-erp.sqlite");
    store = new ReferenceEnterpriseStore(databasePath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reads only allowlisted order progress fields", () => {
    expect(store.queryOrderStatus("SO-1001")).toEqual(initialStatus);
  });

  it("writes once, verifies, and returns the saved idempotent result", () => {
    const expectedAfter = {
      ...initialStatus,
      completionRate: 80,
      note: "等待质检",
      version: 2,
    };

    const first = store.reportProductionProgress(progressInput);
    const second = store.reportProductionProgress(progressInput);

    expect(first).toEqual({ data: expectedAfter, before: initialStatus, after: expectedAfter });
    expect(second).toEqual(first);
    expect(store.queryOrderStatus("SO-1001").version).toBe(2);
  });

  it("rejects stale versions without changing the work order", () => {
    expectStoreError(
      () =>
        store.reportProductionProgress({
          ...progressInput,
          expectedVersion: 0,
          idempotencyKey: "idem-stale",
        }),
      "source_conflict",
    );

    expect(store.queryOrderStatus("SO-1001")).toEqual(initialStatus);
  });

  it("preserves the current note when a valid update omits it", () => {
    const { note: _note, ...inputWithoutNote } = progressInput;

    expect(store.reportProductionProgress(inputWithoutNote).after).toEqual({
      ...initialStatus,
      completionRate: 80,
      version: 2,
    });
  });

  it.each([-1, 101])("rejects completion rate %i outside the allowed range", (completionRate) => {
    expectStoreError(
      () =>
        store.reportProductionProgress({
          ...progressInput,
          completionRate,
          idempotencyKey: `idem-rate-${completionRate}`,
        }),
      "invalid_argument",
    );
  });

  it.each([
    ["SO-9999", "WO-1001"],
    ["SO-1001", "WO-9999"],
  ])("rejects unknown order/work-order pair %s/%s", (orderId, workOrderId) => {
    expectStoreError(
      () =>
        store.reportProductionProgress({
          ...progressInput,
          orderId,
          workOrderId,
          idempotencyKey: `idem-pair-${orderId}-${workOrderId}`,
        }),
      "source_conflict",
    );
  });

  it("persists progress across close and reopen", () => {
    store.reportProductionProgress(progressInput);
    store.close();

    store = new ReferenceEnterpriseStore(databasePath);

    expect(store.queryOrderStatus("SO-1001")).toEqual({
      ...initialStatus,
      completionRate: 80,
      note: "等待质检",
      version: 2,
    });
  });

  it("never returns cost, price, database paths, or SQL", () => {
    const returnedJson = JSON.stringify({
      query: store.queryOrderStatus("SO-1001"),
      write: store.reportProductionProgress(progressInput),
    });

    expect(returnedJson).not.toContain("cost");
    expect(returnedJson).not.toContain("price");
    expect(returnedJson).not.toContain(databasePath);
    expect(returnedJson.toLowerCase()).not.toMatch(/\b(select|update|insert|delete|create table)\b/);
  });
});
