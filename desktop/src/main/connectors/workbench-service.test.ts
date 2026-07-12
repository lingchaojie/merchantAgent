import { describe, expect, it, vi } from "vitest";

import type { ConnectorDraft, VerifiedImplementationCredential } from "./schema";
import { WorkbenchService, type WorkbenchServiceDependencies } from "./workbench-service";

const DIGEST = `sha256:${"b".repeat(64)}`;
const NOW = new Date("2026-07-13T10:00:00Z");

function draft(draftId = "draft-1"): ConnectorDraft {
  return {
    draftId,
    tenantId: "tenant-1",
    deviceId: "device-1",
    state: "draft",
    payload: {
      schemaVersion: 1,
      connectorId: "sql-orders",
      version: "1.0.0",
      adapter: "sqlserver",
      profile: {
        profileId: "erp-test",
        server: "sql.test.internal",
        port: 1433,
        database: "erp",
        encrypt: true,
        trustServerCertificate: false,
        connectTimeoutMS: 5_000,
        queryTimeoutMS: 5_000,
        credentialRef: "erp-test",
        environment: "test",
      },
      operations: [{
        kind: "read",
        tool: "query_order_status",
        sql: "SELECT TOP 10 o.order_id AS order_id FROM dbo.orders o WHERE o.order_id = @order_id",
        bindings: [{ parameter: "order_id", argument: "orderId", type: "NVarChar", maxLength: 32 }],
        projection: [{ sourceAlias: "order_id", resultField: "orderId", type: "string" }],
        declaredObjects: ["dbo.orders"],
        maxResults: 10,
        timeoutMS: 5_000,
      }],
      publicContract: { tools: [{
        name: "query_order_status",
        description: "query order",
        parameters: {
          type: "object",
          properties: { orderId: { type: "string", minLength: 1, maxLength: 32 } },
          required: ["orderId"],
          additionalProperties: false,
        },
        resultFields: ["orderId"],
        resourceType: "business_record",
        resourceKind: "order",
        resourceArg: "orderId",
        resourceRelation: "viewer",
        dataDomain: "manufacturing",
        risk: "read",
        requiresConfirmation: false,
        timeoutMS: 5_000,
        maxResults: 10,
      }] },
      checker: { version: "checker-1", rulesetVersion: "m7.1-sql-v1", testsDigest: DIGEST },
    },
  };
}

function credential(overrides: Partial<VerifiedImplementationCredential> = {}): VerifiedImplementationCredential {
  return {
    credentialId: "implementation-1",
    tenantId: "tenant-1",
    deviceId: "device-1",
    devicePublicKeyPem: "PUBLIC KEY",
    scopes: ["connector:draft", "connector:test", "connector:submit"],
    issuedAt: "2026-07-13T09:00:00.000Z",
    expiresAt: "2026-07-13T11:00:00.000Z",
    ...overrides,
  };
}

function fixture() {
  let now = NOW;
  let sequence = 0;
  const signingIdentity = { verifiedCredential: credential(), implementationCredential: "encoded" };
  const tester = {
    testConnection: vi.fn(async (_signal?: AbortSignal) => ({ environment: "test" as const, latencyMS: 12 })),
    testOperation: vi.fn(async (_operation?: unknown, _args?: unknown, _signal?: AbortSignal) => ({
      raw: [{ order_id: "ORD-1001", internal_cost: 900 }],
      projected: [{ orderId: "ORD-1001" }],
    })),
    close: vi.fn(async () => undefined),
  };
  const install = vi.fn(() => ({
    ref: { connectorId: "sql-orders", version: "1.0.0" },
    path: "fixture.ma-connector",
    manifest: { digest: DIGEST },
  }));
  const deps: WorkbenchServiceDependencies = {
    enrollment: { deviceId: "device-1", devicePublicKeyPem: "PUBLIC KEY", fingerprint: DIGEST },
    bindCredential: vi.fn(() => signingIdentity as never),
    vault: { put: vi.fn(async () => undefined) },
    createTester: vi.fn(() => tester),
    createPackageStore: vi.fn(() => ({ install }) as never),
    submitter: { submit: vi.fn(async () => ({ digest: DIGEST, status: "pending_admin_approval" as const })) },
    now: () => now,
    id: () => `id-${++sequence}`,
    resultTTLMS: 30_000,
  };
  const service = new WorkbenchService(deps);
  return { service, deps, tester, install, advance: (value: Date) => { now = value; } };
}

describe("WorkbenchService isolation", () => {
  it("keeps raw test rows only in the active result and evicts them on close", async () => {
    const f = fixture();
    const session = await f.service.unlock("encoded");
    await f.service.saveDraft(session.sessionId, draft());

    const result = await f.service.testOperation(session.sessionId, "draft-1", { orderId: "ORD-1001" });

    expect(result.raw).toEqual([{ order_id: "ORD-1001", internal_cost: 900 }]);
    expect(f.service.readResult(session.sessionId, result.resultId).raw).toEqual(result.raw);
    f.service.closeResult(session.sessionId, result.resultId);
    expect(() => f.service.readResult(session.sessionId, result.resultId)).toThrowError("workbench_result_expired");
    expect(JSON.stringify(f.service.diagnosticState())).not.toContain("internal_cost");
  });

  it("actively erases raw rows when the result TTL elapses", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const session = await f.service.unlock("encoded");
      await f.service.saveDraft(session.sessionId, draft());
      await f.service.testOperation(session.sessionId, "draft-1", { orderId: "ORD-1001" });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(f.service.diagnosticState().resultCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears results and tester resources on draft switch and lock", async () => {
    const f = fixture();
    const session = await f.service.unlock("encoded");
    await f.service.saveDraft(session.sessionId, draft());
    const result = await f.service.testOperation(session.sessionId, "draft-1", { orderId: "ORD-1001" });

    await f.service.saveDraft(session.sessionId, draft("draft-2"));

    expect(() => f.service.readResult(session.sessionId, result.resultId)).toThrowError("workbench_result_expired");
    expect(f.tester.close).toHaveBeenCalledOnce();
    f.service.lock(session.sessionId);
    await expect(f.service.testConnection(session.sessionId, "draft-2")).rejects.toThrow("workbench_session_locked");
  });

  it("aborts an in-flight SQL test when the session locks", async () => {
    const f = fixture();
    let observedSignal: AbortSignal | undefined;
    f.tester.testOperation.mockImplementation(async (_operation, _args, signal) => {
      if (signal === undefined) throw new Error("missing signal");
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { raw: [], projected: [] };
    });
    const session = await f.service.unlock("encoded");
    await f.service.saveDraft(session.sessionId, draft());

    const testing = f.service.testOperation(session.sessionId, "draft-1", { orderId: "ORD-1001" });
    await Promise.resolve();
    f.service.lock(session.sessionId);

    await expect(testing).rejects.toThrow("aborted");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("aborts a test of the old payload when the active draft is replaced", async () => {
    const f = fixture();
    let observedSignal: AbortSignal | undefined;
    f.tester.testConnection.mockImplementation(async (signal?: AbortSignal) => {
      if (signal === undefined) throw new Error("missing signal");
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { environment: "test", latencyMS: 1 };
    });
    const session = await f.service.unlock("encoded");
    await f.service.saveDraft(session.sessionId, draft());

    const testing = f.service.testConnection(session.sessionId, "draft-1");
    await Promise.resolve();
    await f.service.saveDraft(session.sessionId, draft());

    await expect(testing).rejects.toThrow("aborted");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("expires the session and raw results at the credential boundary", async () => {
    const f = fixture();
    const session = await f.service.unlock("encoded");
    await f.service.saveDraft(session.sessionId, draft());
    const result = await f.service.testOperation(session.sessionId, "draft-1", { orderId: "ORD-1001" });
    f.advance(new Date("2026-07-13T11:00:00Z"));

    expect(() => f.service.readResult(session.sessionId, result.resultId)).toThrowError("workbench_session_expired");
    await expect(f.service.saveDraft(session.sessionId, draft())).rejects.toThrow("workbench_session_expired");
  });

  it("rejects tenant/device mismatches, missing scopes, and open request objects", async () => {
    const f = fixture();
    const session = await f.service.unlock("encoded");

    await expect(f.service.saveDraft(session.sessionId, { ...draft(), tenantId: "other" })).rejects.toThrow("workbench_draft_owner");
    await expect(f.service.saveDraft(session.sessionId, { ...draft(), unexpected: true } as never)).rejects.toThrow();

    (f.deps.bindCredential as ReturnType<typeof vi.fn>).mockReturnValue({
      verifiedCredential: credential({ scopes: ["connector:draft"] }),
      implementationCredential: "limited",
    });
    const limited = await f.service.unlock("limited");
    await f.service.saveDraft(limited.sessionId, draft());
    await expect(f.service.testConnection(limited.sessionId, "draft-1")).rejects.toThrow("workbench_scope_denied");
  });

  it("rejects an implementation credential for another configured tenant", async () => {
    const f = fixture();
    f.deps.tenantId = "tenant-1";
    (f.deps.bindCredential as ReturnType<typeof vi.fn>).mockReturnValue({
      verifiedCredential: credential({ tenantId: "tenant-2" }),
      implementationCredential: "other-tenant",
    });

    await expect(f.service.unlock("other-tenant")).rejects.toThrow("workbench_credential_invalid");
  });

  it("writes credentials without exposing a read method and freezes before submit", async () => {
    const f = fixture();
    const session = await f.service.unlock("encoded");
    await f.service.saveCredential(session.sessionId, "erp-test", { username: "svc", password: "secret" });
    await f.service.saveDraft(session.sessionId, draft());

    const summary = await f.service.validateAndFreeze(session.sessionId, "draft-1");
    const submitted = await f.service.submit(session.sessionId, "draft-1");

    expect(summary).toMatchObject({ checkerVersion: "checker-1", rulesetVersion: "m7.1-sql-v1" });
    expect(summary.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(f.install).toHaveBeenCalledWith(expect.objectContaining({ state: "locally_validated" }));
    expect(submitted.status).toBe("pending_admin_approval");
    expect("getCredential" in f.service).toBe(false);
  });
});
