import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import type { WorkbenchAPI, WorkbenchTestResultView } from "../../../shared/connector-contract";
import {
  WorkbenchOperationResult,
  closeWorkbenchResult,
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
