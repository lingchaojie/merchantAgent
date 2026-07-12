import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../shared/contract";
import { foldEvent, type Message } from "./types";

const pending: Message = {
  id: "m1",
  role: "assistant",
  text: "",
  pending: true,
  ts: 1,
};

describe("local tool execution state", () => {
  it.each([
    ["executing", "正在执行 生产进度…"],
    ["succeeded", "生产进度执行成功（已验证）"],
    ["failed", "生产进度执行失败"],
    ["cancelled", "生产进度执行已取消"],
    ["source_conflict", "生产进度数据已变化，请重试"],
    ["unknown", "生产进度结果待确认"],
  ])("maps %s to a safe Chinese status", (status, expected) => {
    const event: ChatEvent = {
      kind: "tool_state",
      tool: "report_production_progress",
      data: { status, executionId: "must-not-render" },
    };

    const result = foldEvent(pending, event);

    expect(result.status).toBe(expected);
    expect(result.status).not.toContain("must-not-render");
  });
});
