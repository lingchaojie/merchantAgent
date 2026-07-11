import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalToolExecutor, type LocalToolRequest } from "./executor";
import { verifyCapabilityPackage, type VerifiedPackage } from "./package";
import { ReferenceEnterpriseStore } from "./store";

const desktopRoot = path.resolve(import.meta.dirname, "../../..");
const packagePath = path.join(
  desktopRoot,
  "resources/capabilities/reference-manufacturing.cap.json",
);
const publicKeyPath = path.join(desktopRoot, "resources/capabilities/reference-public.pem");

describe("desktop local tool vertical", () => {
  let directory: string;
  let store: ReferenceEnterpriseStore;
  let pkg: VerifiedPackage;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-tool-vertical-"));
    store = new ReferenceEnterpriseStore(path.join(directory, "reference-enterprise.db"));
    pkg = verifyCapabilityPackage(packagePath, publicKeyPath);
  });

  afterEach(() => {
    store?.close();
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
      callId: "desktop-read-1",
      idempotencyKey: "desktop-read-1",
      risk: "read",
      requiresConfirmation: false,
      args: { orderId: "SO-1001" },
      ...overrides,
    };
  }

  function progressRequest(overrides: Partial<LocalToolRequest> = {}): LocalToolRequest {
    return request({
      tool: "report_production_progress",
      callId: "desktop-write-80",
      idempotencyKey: "desktop-write-80",
      risk: "low_write",
      requiresConfirmation: true,
      args: {
        orderId: "SO-1001",
        workOrderId: "WO-1001",
        completionRate: 80,
        expectedVersion: 1,
        note: "ready for QA",
      },
      ...overrides,
    });
  }

  it("reads 60, confirms 80 once, reads version 2, and preserves cancellation", async () => {
    const executor = new LocalToolExecutor(pkg, store);

    const initial = await executor.execute(request(), vi.fn());
    expect(initial).toMatchObject({
      data: { orderId: "SO-1001", completionRate: 60, version: 1 },
      meta: { status: "succeeded", confirmed: false },
    });

    const confirm = vi.fn().mockResolvedValue(true);
    const written = await executor.execute(progressRequest(), confirm);
    expect(confirm).toHaveBeenCalledWith({
      orderId: "SO-1001",
      workOrderId: "WO-1001",
      before: expect.objectContaining({ completionRate: 60, version: 1 }),
      proposed: { completionRate: 80, note: "ready for QA" },
    });
    expect(written).toMatchObject({
      data: { completionRate: 80, version: 2 },
      meta: {
        status: "succeeded",
        confirmed: true,
        before: { completionRate: 60, version: 1 },
        after: { completionRate: 80, version: 2 },
      },
    });

    const readBack = await executor.execute(
      request({ callId: "desktop-read-2", idempotencyKey: "desktop-read-2" }),
      vi.fn(),
    );
    expect(readBack.data).toMatchObject({ completionRate: 80, version: 2 });

    const duplicate = await executor.execute(progressRequest(), async () => true);
    expect(duplicate.data).toEqual(written.data);
    expect(store.queryOrderStatus("SO-1001")).toMatchObject({ completionRate: 80, version: 2 });

    const cancelled = await executor.execute(
      progressRequest({
        callId: "desktop-write-cancelled",
        idempotencyKey: "desktop-write-cancelled",
        args: {
          orderId: "SO-1001",
          workOrderId: "WO-1001",
          completionRate: 90,
          expectedVersion: 2,
          note: "not approved",
        },
      }),
      async () => false,
    );
    expect(cancelled).toMatchObject({ error: "cancelled", meta: { status: "cancelled" } });
    expect(store.queryOrderStatus("SO-1001")).toMatchObject({ completionRate: 80, version: 2 });
  });

  it.each([
    [
      "version",
      (capability: Record<string, string>) => {
        const manifest = JSON.parse(
          Buffer.from(capability.payload, "base64").toString("utf8"),
        ) as Record<string, unknown>;
        manifest.version = "2.0.0";
        capability.payload = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
      },
    ],
    [
      "signature",
      (capability: Record<string, string>) => {
        capability.signature = `${capability.signature[0] === "A" ? "B" : "A"}${capability.signature.slice(1)}`;
      },
    ],
  ] as const)("rejects a tampered package %s before calling the store", async (_name, tamper) => {
    const capability = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, string>;
    tamper(capability);
    const candidatePath = path.join(directory, "tampered.cap.json");
    fs.writeFileSync(candidatePath, JSON.stringify(capability), "utf8");
    const query = vi.spyOn(store, "queryOrderStatus");
    const write = vi.spyOn(store, "reportProductionProgress");

    const executeCandidate = async () => {
      const candidate = verifyCapabilityPackage(candidatePath, publicKeyPath);
      return new LocalToolExecutor(candidate, store).execute(request(), vi.fn());
    };

    await expect(executeCandidate()).rejects.toThrow(/package_integrity/);
    expect(query).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
