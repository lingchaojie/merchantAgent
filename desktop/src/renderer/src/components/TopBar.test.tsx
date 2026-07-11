import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

it("disables management entry for a non-admin", () => {
  const html = renderToStaticMarkup(
    <TopBar
      title="会话"
      userId="u_sales1"
      onCommand={vi.fn()}
      view="chat"
      onToggleView={vi.fn()}
      canAdmin={false}
    />,
  );

  expect(html).toContain("disabled");
  expect(html).toContain("需要管理员身份");
});

it("keeps the back-to-chat action enabled", () => {
  const html = renderToStaticMarkup(
    <TopBar
      title="会话"
      userId="u_sales1"
      onCommand={vi.fn()}
      view="admin"
      onToggleView={vi.fn()}
      canAdmin={false}
    />,
  );

  expect(html).toContain("← 聊天");
  expect(html).not.toContain("disabled");
});
