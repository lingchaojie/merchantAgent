import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalToolRequest } from "../shared/contract";

const electron = vi.hoisted(() => ({
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
const agentd = vi.hoisted(() => ({
  client: { login: vi.fn(), chat: vi.fn(), adminRequest: vi.fn() },
}));

vi.mock("electron", () => electron);
vi.mock("./agentd", () => agentd);

import { register } from "./ipc";
import { Channels } from "../shared/contract";

const request: LocalToolRequest = {
  reqId: "local-1",
  packageId: "reference-manufacturing",
  packageVersion: "1.0.0",
  manifestDigest: "sha256:digest",
  tool: "report_production_progress",
  tenantId: "mock-corp-001",
  userId: "u_plan",
  deviceId: "DESKTOP-01",
  roleIds: ["planner"],
  skillId: "production-progress",
  callId: "call-1",
  idempotencyKey: "idem-1",
  risk: "low_write",
  requiresConfirmation: true,
  args: {
    orderId: "SO-1001",
    workOrderId: "WO-1001",
    completionRate: 80,
    expectedVersion: 1,
    note: "总装完成",
  },
};

function chatIpcHandler(): (...args: unknown[]) => unknown {
  const registration = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === Channels.chat);
  if (!registration) throw new Error("chat IPC handler was not registered");
  return registration[1] as (...args: unknown[]) => unknown;
}

function fakeExecutor() {
  let writes = 0;
  return {
    get writes() { return writes; },
    execute: vi.fn(async (_req, confirm) => {
      const approved = await confirm({
        orderId: "SO-1001",
        workOrderId: "WO-1001",
        before: {
          orderId: "SO-1001",
          workOrderId: "WO-1001",
          status: "生产中",
          promiseDate: "2026-07-20",
          completionRate: 60,
          note: "装配中",
          version: 1,
        },
        proposed: { completionRate: 80, note: "总装完成" },
      });
      if (!approved) {
        return {
          meta: {
            status: "cancelled" as const,
            executionId: "exec-1",
            idempotencyKey: "idem-1",
            confirmed: false,
          },
          error: "cancelled" as const,
        };
      }
      writes += 1;
      return {
        data: { orderId: "SO-1001" },
        meta: {
          status: "succeeded" as const,
          executionId: "exec-1",
          idempotencyKey: "idem-1",
          confirmed: true,
        },
      };
    }),
  };
}

async function invokeChatWithLocalRequest(executor: ReturnType<typeof fakeExecutor>) {
  agentd.client.chat.mockImplementation(async (_req, _onEvent, _onFile, onLocalTool) =>
    onLocalTool(request));
  register({} as never, executor as never);
  return chatIpcHandler()(
    { sender: { isDestroyed: () => false, send: vi.fn() } },
    { streamId: "stream-1", req: { sessionId: "s", userId: "u_plan", question: "更新进度" } },
  );
}

describe("local tool confirmation in Electron main", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults and cancels a local write without executing it", async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 });
    const executor = fakeExecutor();

    const response = await invokeChatWithLocalRequest(executor);

    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: "warning",
      buttons: ["取消", "确认写入"],
      defaultId: 0,
      cancelId: 0,
      message: "确认更新生产进度",
    }));
    expect(response).toMatchObject({ meta: { status: "cancelled", confirmed: false } });
    expect(executor.writes).toBe(0);
  });

  it("executes a local write once after explicit confirmation", async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    const executor = fakeExecutor();

    const response = await invokeChatWithLocalRequest(executor);

    expect(response).toMatchObject({ meta: { status: "succeeded", confirmed: true } });
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(executor.writes).toBe(1);
  });

  it("removes partially installed IPC handlers when registration throws", () => {
    electron.ipcMain.handle
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error("registration failed"); });

    expect(() => register({} as never, fakeExecutor() as never)).toThrow("registration failed");

    expect(electron.ipcMain.removeHandler).toHaveBeenCalledOnce();
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith(Channels.login);
  });

  it("returns an idempotent cleanup for successfully installed IPC handlers", () => {
    const cleanup = register({} as never, fakeExecutor() as never);

    cleanup();
    cleanup();

    expect(electron.ipcMain.removeHandler).toHaveBeenCalledTimes(5);
    expect(electron.ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      Channels.admin,
      Channels.fsWrite,
      Channels.fsRead,
      Channels.chat,
      Channels.login,
    ]);
  });
});
