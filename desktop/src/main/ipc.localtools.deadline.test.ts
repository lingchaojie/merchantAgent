import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalToolRequest } from "../shared/contract";

const electron = vi.hoisted(() => ({
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock("electron", () => electron);

import { register } from "./ipc";
import { Channels } from "../shared/contract";

function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: bytes };
        },
      }),
    },
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const request: LocalToolRequest = {
  reqId: "deadline-1",
  packageId: "reference-manufacturing",
  packageVersion: "1.0.0",
  manifestDigest: "sha256:digest",
  tool: "report_production_progress",
  tenantId: "mock-corp-001",
  userId: "u_plan",
  deviceId: "ignored",
  roleIds: ["planner"],
  skillId: "production-progress",
  callId: "call-deadline",
  idempotencyKey: "idem-deadline",
  risk: "low_write",
  requiresConfirmation: true,
  args: {
    orderId: "SO-1001",
    workOrderId: "WO-1001",
    completionRate: 80,
    expectedVersion: 1,
  },
};

describe("local tool confirmation deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts cancellation at the deadline and ignores a later confirmation", async () => {
    const dialogResult = deferred<{ response: number }>();
    electron.dialog.showMessageBox.mockReturnValue(dialogResult.promise);
    let writes = 0;
    const executor = {
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
          proposed: { completionRate: 80, note: "" },
        });
        if (!approved) {
          return {
            meta: {
              status: "cancelled" as const,
              executionId: "exec-deadline",
              idempotencyKey: "idem-deadline",
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
            executionId: "exec-deadline",
            idempotencyKey: "idem-deadline",
            confirmed: true,
          },
        };
      }),
    };
    const stream =
      `event: local_tool_request\ndata: ${JSON.stringify(request)}\n\n` +
      'event: done\ndata: {"text":"已取消"}\n\n';
    let posted: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: { body?: string }) => {
      if (String(url).endsWith("/chat/local-tool-result")) {
        posted = JSON.parse(options?.body ?? "{}") as Record<string, unknown>;
        return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
      }
      return sseResponse(stream);
    }));
    register({} as never, executor as never, { localToolConfirmationTimeoutMs: 1_000 });
    const registration = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === Channels.chat);
    if (!registration) throw new Error("chat IPC handler was not registered");
    const chatHandler = registration[1] as (...args: unknown[]) => Promise<string>;

    const chat = chatHandler(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      { streamId: "stream-1", req: { sessionId: "s", userId: "u_plan", question: "更新进度" } },
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(posted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(chat).resolves.toBe("已取消");
    expect(posted).toMatchObject({
      reqId: "deadline-1",
      data: {},
      meta: {
        status: "cancelled",
        executionId: "exec-deadline",
        idempotencyKey: "idem-deadline",
        confirmed: false,
      },
      error: "cancelled",
    });
    expect(writes).toBe(0);

    dialogResult.resolve({ response: 1 });
    await Promise.resolve();
    expect(writes).toBe(0);
  });
});
