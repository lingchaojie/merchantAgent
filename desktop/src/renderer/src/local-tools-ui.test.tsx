import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ResultCard } from "./components/ResultCard";

it("omits fields that are not declared by a narrow connector result", () => {
  const html = renderToStaticMarkup(
    <ResultCard
      tool="query_order_status"
      data={{ orderId: "ORD-1001", status: "in_production" }}
    />,
  );

  expect(html).toContain("ORD-1001");
  expect(html).toContain("in_production");
  expect(html).not.toContain("undefined");
});

it("renders a verified production progress result without execution internals", () => {
  const html = renderToStaticMarkup(
    <ResultCard
      tool="report_production_progress"
      data={{
        orderId: "SO-1001",
        workOrderId: "WO-1001",
        completionRate: 80,
        note: "等待质检",
        executionId: "must-not-render",
        before: { completionRate: 60 },
      }}
    />,
  );

  expect(html).toContain("生产进度");
  expect(html).toContain("SO-1001");
  expect(html).toContain("WO-1001");
  expect(html).toContain("80%");
  expect(html).toContain("等待质检");
  expect(html).toContain("已验证");
  expect(html).not.toContain("must-not-render");
  expect(html).not.toContain("60");
});
