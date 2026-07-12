import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
const agentd = vi.hoisted(() => ({
  client: { login: vi.fn(), chat: vi.fn(), adminRequest: vi.fn() },
}));

vi.mock("electron", () => electron);
vi.mock("./agentd", () => agentd);

import { register, registerWorkbench } from "./ipc";
import { Channels } from "../shared/contract";
import { WorkbenchChannels } from "../shared/connector-contract";

function handler(channel: string) {
  const found = electron.ipcMain.handle.mock.calls.find(([candidate]) => candidate === channel);
  if (!found) throw new Error(`missing handler ${channel}`);
  return found[1] as (...args: unknown[]) => unknown;
}

describe("isolated Workbench IPC", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds only openWorkbench to the ordinary renderer API path", async () => {
    const openWorkbench = vi.fn(async () => undefined);
    register({} as never, { execute: vi.fn() } as never, { openWorkbench });

    await handler(Channels.openWorkbench)({});

    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(Object.values(Channels)).not.toContain(WorkbenchChannels.testOperation);
  });

  it("projects connector registry responses before they cross into the ordinary renderer", async () => {
    agentd.client.adminRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: [{
        tenantId: "tenant-1", connectorId: "sql-orders", version: "1.0.0",
        digest: `sha256:${"a".repeat(64)}`, adapter: "sqlserver", environment: "test",
        status: "pending_admin_approval", submittedBy: "implementation-1",
        implementationCredentialId: "private-credential", deviceId: "private-device",
        createdAt: "private-time", unknown: "private-unknown",
        checks: { checkerVersion: "checker-1", rulesetVersion: "m7.1-sql-v1", testsDigest: "sha256:tests", privateCheck: true },
        contract: { tools: [{
          name: "query_order_status", description: "query", execution: "desktop",
          resourceType: "business_record", resourceKind: "order", resourceArg: "orderId",
          resourceRelation: "viewer", dataDomain: "orders",
          params: [{ name: "orderId", description: "id", type: "string", required: true, privateParam: "drop" }],
          resultFields: ["orderId", "status"], risk: "read", requiresConfirmation: false,
          timeoutMS: 5_000, maxResults: 10, sql: "SELECT secret",
        }], privateContract: true },
      }],
    });
    register({} as never, { execute: vi.fn() } as never);

    const response = await handler(Channels.admin)({}, {
      method: "GET", path: "/admin/connectors", userId: "u_admin",
    });

    expect(response).toEqual({
      ok: true,
      data: [{
        tenantId: "tenant-1", connectorId: "sql-orders", version: "1.0.0",
        digest: `sha256:${"a".repeat(64)}`, adapter: "sqlserver", environment: "test",
        status: "pending_admin_approval", submittedBy: "implementation-1",
        checks: { checkerVersion: "checker-1", rulesetVersion: "m7.1-sql-v1", testsDigest: "sha256:tests" },
        contract: { tools: [{
          name: "query_order_status", description: "query", execution: "desktop",
          resourceType: "business_record", resourceKind: "order", resourceArg: "orderId",
          resourceRelation: "viewer", dataDomain: "orders",
          params: [{ name: "orderId", description: "id", type: "string", required: true }],
          resultFields: ["orderId", "status"], risk: "read", requiresConfirmation: false,
          timeoutMS: 5_000, maxResults: 10,
        }] },
      }],
    });
    expect(JSON.stringify(response)).not.toMatch(/private|SELECT|deviceId|implementationCredentialId/);
  });

  it("maps dedicated closed commands and removes every handler in reverse order", async () => {
    const service = {
      getEnrollment: vi.fn(async () => ({ deviceId: "d", devicePublicKeyPem: "pem", fingerprint: "fp" })),
      unlock: vi.fn(async () => ({ sessionId: "s" })),
      saveCredential: vi.fn(async () => undefined),
      saveDraft: vi.fn(async () => ({ draftId: "draft" })),
      testConnection: vi.fn(async () => ({ environment: "test", latencyMS: 1 })),
      testOperation: vi.fn(async () => ({ resultId: "r", raw: [], projected: [], expiresAt: "later" })),
      closeResult: vi.fn(),
      validateAndFreeze: vi.fn(async () => ({ digest: "digest" })),
      submit: vi.fn(async () => ({ digest: "digest", status: "pending_admin_approval" })),
      lock: vi.fn(),
    };
    const cleanup = registerWorkbench(service as never, () => true);

    await handler(WorkbenchChannels.saveCredential)({}, {
      sessionId: "s",
      ref: "erp-test",
      credential: { username: "svc", password: "secret" },
    });
    await handler(WorkbenchChannels.testOperation)({}, {
      sessionId: "s", draftId: "draft", tool: "query_order_status", args: { orderId: "ORD-1" },
    });
    expect(service.saveCredential).toHaveBeenCalledWith("s", "erp-test", { username: "svc", password: "secret" });
    expect(service.testOperation).toHaveBeenCalledWith("s", "draft", "query_order_status", { orderId: "ORD-1" });

    cleanup();
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledTimes(Object.values(WorkbenchChannels).length);
    expect(electron.ipcMain.removeHandler.mock.calls[0][0]).toBe(WorkbenchChannels.lock);
  });

  it("rejects an open IPC envelope before calling the service", async () => {
    const service = {
      getEnrollment: vi.fn(), unlock: vi.fn(), saveCredential: vi.fn(), saveDraft: vi.fn(),
      testConnection: vi.fn(), testOperation: vi.fn(), closeResult: vi.fn(),
      validateAndFreeze: vi.fn(), submit: vi.fn(), lock: vi.fn(),
    };
    registerWorkbench(service as never, () => true);

    expect(() => handler(WorkbenchChannels.testOperation)({}, {
      sessionId: "s", draftId: "draft", args: {}, extra: "rejected",
    })).toThrow("workbench_invalid_request");
    expect(service.testOperation).not.toHaveBeenCalled();
  });

  it("rejects Workbench commands from a non-Workbench renderer", async () => {
    const service = {
      getEnrollment: vi.fn(), unlock: vi.fn(), saveCredential: vi.fn(), saveDraft: vi.fn(),
      testConnection: vi.fn(), testOperation: vi.fn(), closeResult: vi.fn(),
      validateAndFreeze: vi.fn(), submit: vi.fn(), lock: vi.fn(),
    };
    registerWorkbench(service as never, () => false);

    expect(() => handler(WorkbenchChannels.enrollment)({ sender: {} })).toThrow("workbench_sender_denied");
    expect(service.getEnrollment).not.toHaveBeenCalled();
  });
});
