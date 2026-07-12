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
      sessionId: "s", draftId: "draft", args: { orderId: "ORD-1" },
    });
    expect(service.saveCredential).toHaveBeenCalledWith("s", "erp-test", { username: "svc", password: "secret" });
    expect(service.testOperation).toHaveBeenCalledWith("s", "draft", { orderId: "ORD-1" });

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
