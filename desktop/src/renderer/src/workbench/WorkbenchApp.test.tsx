import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WorkbenchAPI,
  WorkbenchConnectorDraft,
  WorkbenchTestResultView,
} from "../../../shared/connector-contract";
import {
  WorkbenchApp,
  WorkbenchOperationResult,
  closeWorkbenchResult,
  evidenceDigest,
  freezeCurrentWorkbenchDraft,
  resultExpiryDelay,
} from "./WorkbenchApp";

function workbenchAPI(): WorkbenchAPI {
  return {
    getEnrollment: vi.fn(),
    unlock: vi.fn(),
    saveCredential: vi.fn(),
    saveDraft: vi.fn(),
    testConnection: vi.fn(),
    testOperation: vi.fn(),
    closeResult: vi.fn(async () => undefined),
    validateAndFreeze: vi.fn(),
    submit: vi.fn(),
    lock: vi.fn(),
  };
}

function nodeText(node: ReactTestInstance | string | number): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node.children.map((child) => nodeText(child as ReactTestInstance | string | number)).join("");
}

function button(root: ReactTestInstance, name: string): ReactTestInstance {
  const found = root.findAllByType("button").find((candidate) => nodeText(candidate) === name);
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

function field(root: ReactTestInstance, name: string): ReactTestInstance {
  const label = root.findAllByType("label").find((candidate) => nodeText(candidate).startsWith(name));
  if (!label) throw new Error(`field not found: ${name}`);
  return label.find((candidate) => candidate.type === "input" || candidate.type === "textarea");
}

async function click(root: ReactTestInstance, name: string): Promise<void> {
  await act(async () => {
    const pending = button(root, name).props.onClick();
    if (pending && typeof pending.then === "function") await pending;
    await Promise.resolve();
  });
}

async function change(root: ReactTestInstance, name: string, value: string): Promise<void> {
  await act(async () => { field(root, name).props.onChange({ target: { value } }); });
}

interface WorkbenchFixture {
  api: WorkbenchAPI;
  renderer: ReactTestRenderer;
  drafts: WorkbenchConnectorDraft[];
}

async function mountedWorkbench(options: { closeRejects?: boolean; expiresAt?: string } = {}): Promise<WorkbenchFixture> {
  const drafts: WorkbenchConnectorDraft[] = [];
  const api = workbenchAPI();
  vi.mocked(api.getEnrollment).mockResolvedValue({ deviceId: "device-1", devicePublicKeyPem: "pem", fingerprint: "fp" });
  vi.mocked(api.unlock).mockResolvedValue({
    sessionId: "session-1", tenantId: "tenant-1", deviceId: "device-1",
    expiresAt: options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    scopes: ["connector:draft", "connector:test", "connector:submit"],
  });
  vi.mocked(api.saveDraft).mockImplementation(async (_sessionId, draft) => {
    drafts.push(draft); return { draftId: draft.draftId };
  });
  vi.mocked(api.testConnection).mockResolvedValue({ environment: "test", latencyMS: 8 });
  vi.mocked(api.testOperation).mockImplementation(async (_sessionId, _draftId, tool) => tool === "query_order_status"
    ? { resultId: "read-result", raw: [{ order_id: "ORD-1", internal_cost: 99 }], projected: [{ orderId: "ORD-1", status: "ready" }], expiresAt: new Date(Date.now() + 60_000).toISOString() }
    : { resultId: "write-result", raw: { orderId: "ORD-1", completionRate: 40, version: 7 }, projected: { completionRate: 80, version: 8 }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  if (options.closeRejects) vi.mocked(api.closeResult).mockRejectedValue(new Error("native close failed"));
  vi.mocked(api.validateAndFreeze).mockImplementation(async () => {
    const current = drafts.at(-1)!;
    return {
      digest: `sha256:${"f".repeat(64)}`, checkerVersion: "checker-1", rulesetVersion: "m7.1-sql-v1",
      testsDigest: current.payload.checker.testsDigest, publicContract: current.payload.publicContract,
    };
  });
  vi.mocked(api.submit).mockResolvedValue({ digest: `sha256:${"f".repeat(64)}`, status: "pending_admin_approval" });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<WorkbenchApp api={api} />); await Promise.resolve(); });
  await change(renderer.root, "实现凭据", "encoded");
  await click(renderer.root, "解锁工作台");
  await change(renderer.root, "服务器", "sql.test.internal");
  await change(renderer.root, "数据库", "erp");
  return { api, renderer, drafts };
}

async function completeEvidence(renderer: ReactTestRenderer): Promise<void> {
  await click(renderer.root, "3 测试与提交");
  await click(renderer.root, "测试连接");
  await click(renderer.root, "运行测试");
  await click(renderer.root, "2 操作定义");
  await click(renderer.root, "report_production_progress");
  await click(renderer.root, "3 测试与提交");
  await click(renderer.root, "运行测试");
}

beforeEach(() => {
  const listeners = new Map<string, Set<EventListener>>();
  vi.stubGlobal("window", {
    setTimeout: (callback: TimerHandler, timeout?: number) => globalThis.setTimeout(callback, timeout),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    addEventListener: (name: string, listener: EventListener) => {
      const values = listeners.get(name) ?? new Set<EventListener>(); values.add(listener); listeners.set(name, values);
    },
    removeEventListener: (name: string, listener: EventListener) => listeners.get(name)?.delete(listener),
    confirm: vi.fn(() => true),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows SQL only in Workbench and clears raw results when closed", async () => {
  const api = workbenchAPI();
  const result: WorkbenchTestResultView = {
    resultId: "result-1",
    raw: [{ order_id: "ORD-1", internal_cost: 900 }],
    projected: [{ orderId: "ORD-1" }],
    expiresAt: "2026-07-13T12:00:00.000Z",
  };

  const html = renderToStaticMarkup(
    <WorkbenchOperationResult
      sql="SELECT order_id FROM dbo.production_orders"
      result={result}
      onClose={vi.fn()}
    />,
  );
  expect(html).toContain("SELECT order_id FROM dbo.production_orders");
  expect(html).toContain("internal_cost");

  const cleared = await closeWorkbenchResult(api, "session-1", result);
  expect(cleared).toBeNull();
  expect(api.closeResult).toHaveBeenCalledWith("session-1", "result-1");
});

it("expires raw results at their own ephemeral deadline", () => {
  expect(resultExpiryDelay({
    resultId: "result-1", raw: [], projected: [], expiresAt: "2026-07-13T12:00:01.000Z",
  }, new Date("2026-07-13T12:00:00.000Z").getTime())).toBe(1_000);
});

it("persists the latest editor state before freezing", async () => {
  const api = workbenchAPI();
  const summary = {
    digest: "sha256:digest", checkerVersion: "checker-1", rulesetVersion: "m7.1-sql-v1" as const,
    testsDigest: "sha256:tests", publicContract: { tools: [] },
  };
  vi.mocked(api.validateAndFreeze).mockResolvedValue(summary);
  const persist = vi.fn(async () => "draft-latest");

  await expect(freezeCurrentWorkbenchDraft(api, "session-1", persist)).resolves.toBe(summary);
  expect(persist).toHaveBeenCalledOnce();
  expect(api.validateAndFreeze).toHaveBeenCalledWith("session-1", "draft-latest");
});

describe("WorkbenchApp workflow", () => {
  it("requires current connection and both operation tests before freeze and submits that exact digest", async () => {
    const fixture = await mountedWorkbench();
    await click(fixture.renderer.root, "3 测试与提交");
    expect(button(fixture.renderer.root, "校验并冻结").props.disabled).toBe(true);

    await completeEvidence(fixture.renderer);

    const markup = JSON.stringify(fixture.renderer.toJSON());
    const visible = nodeText(fixture.renderer.root);
    expect(markup).toContain("连接 · 已通过");
    expect(markup).toContain("query_order_status · 已通过");
    expect(markup).toContain("report_production_progress · 已通过");
    expect(button(fixture.renderer.root, "校验并冻结").props.disabled).toBe(false);
    expect(visible).toContain('"version": 7');
    expect(visible).toContain('"version": 8');
    expect(visible).toContain("UPDATE dbo.production_orders");
    expect(visible).toContain(`结果快照 · report_production_progress · ${fixture.drafts.at(-1)!.draftId}`);
    await click(fixture.renderer.root, "校验并冻结");
    const frozenDraft = fixture.drafts.at(-1)!;
    expect(frozenDraft.payload.checker.testsDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(frozenDraft.payload.checker.testsDigest).not.toBe(`sha256:${"0".repeat(64)}`);
    expect(button(fixture.renderer.root, "提交管理员审批").props.disabled).toBe(false);
    await click(fixture.renderer.root, "提交管理员审批");
    expect(fixture.api.submit).toHaveBeenCalledWith("session-1", frozenDraft.draftId);
  });

  it("invalidates evidence, frozen summary, and submit eligibility after a draft-affecting edit", async () => {
    const fixture = await mountedWorkbench();
    await completeEvidence(fixture.renderer);
    await click(fixture.renderer.root, "校验并冻结");
    expect(button(fixture.renderer.root, "提交管理员审批").props.disabled).toBe(false);

    await change(fixture.renderer.root, "orderId", "ORD-CHANGED");

    expect(button(fixture.renderer.root, "校验并冻结").props.disabled).toBe(true);
    expect(button(fixture.renderer.root, "提交管理员审批").props.disabled).toBe(true);
    expect(JSON.stringify(fixture.renderer.toJSON())).not.toContain("冻结摘要");
  });

  it("locks fail-closed and surfaces a blocking error when native result deletion fails", async () => {
    const fixture = await mountedWorkbench({ closeRejects: true });
    await click(fixture.renderer.root, "3 测试与提交");
    await click(fixture.renderer.root, "运行测试");

    await click(fixture.renderer.root, "关闭测试结果");

    expect(fixture.api.lock).toHaveBeenCalledWith("session-1");
    const markup = JSON.stringify(fixture.renderer.toJSON());
    expect(markup).toContain("原始结果清理失败");
    expect(markup).toContain("解锁工作台");
    expect(markup).not.toContain("internal_cost");
  });

  it("closes the current raw result before switching operations", async () => {
    const fixture = await mountedWorkbench();
    await click(fixture.renderer.root, "3 测试与提交");
    await click(fixture.renderer.root, "运行测试");
    expect(nodeText(fixture.renderer.root)).toContain("internal_cost");

    await click(fixture.renderer.root, "2 操作定义");
    await click(fixture.renderer.root, "report_production_progress");
    await act(async () => { await Promise.resolve(); });

    expect(fixture.api.closeResult).toHaveBeenCalledWith("session-1", "read-result");
    expect(nodeText(fixture.renderer.root)).not.toContain("internal_cost");
  });

  it("removes raw rows after a successful explicit close", async () => {
    const fixture = await mountedWorkbench();
    await click(fixture.renderer.root, "3 测试与提交");
    await click(fixture.renderer.root, "运行测试");

    await click(fixture.renderer.root, "关闭测试结果");

    expect(fixture.api.closeResult).toHaveBeenCalledWith("session-1", "read-result");
    expect(nodeText(fixture.renderer.root)).not.toContain("internal_cost");
    expect(fixture.api.lock).not.toHaveBeenCalled();
  });

  it("closes raw results and locks when the implementation session expires", async () => {
    vi.useFakeTimers();
    const fixture = await mountedWorkbench({ expiresAt: new Date(Date.now() + 1_000).toISOString() });
    await click(fixture.renderer.root, "3 测试与提交");
    await click(fixture.renderer.root, "运行测试");

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(fixture.api.closeResult).toHaveBeenCalledWith("session-1", "read-result");
    expect(fixture.api.lock).toHaveBeenCalledWith("session-1");
    expect(JSON.stringify(fixture.renderer.toJSON())).toContain("会话已过期");
  });

  it("binds the evidence digest to the current draft and operation evidence", async () => {
    const first = await evidenceDigest({ draftKey: "draft-a", connection: { environment: "test" }, operations: { query_order_status: { args: { orderId: "A" }, projected: [], sql: "SELECT A" } } });
    const second = await evidenceDigest({ draftKey: "draft-a", connection: { environment: "test" }, operations: { query_order_status: { args: { orderId: "B" }, projected: [], sql: "SELECT A" } } });
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });
});
