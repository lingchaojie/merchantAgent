import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoleRow } from "./RolesPane";

describe("RoleRow", () => {
  it("renders editable label and description fields", () => {
    const html = renderToStaticMarkup(
      <RoleRow
        role={{ roleId: "sales", label: "销售", description: "业务" }}
        editing
        busy={false}
        onEdit={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(html).toContain('name="role-label"');
    expect(html).toContain('name="role-description"');
    expect(html).toContain("保存");
  });

  it("renders the description and edit action in display mode", () => {
    const html = renderToStaticMarkup(
      <RoleRow
        role={{ roleId: "sales", label: "销售", description: "业务" }}
        editing={false}
        busy={false}
        onEdit={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(html).toContain("业务");
    expect(html).toContain("编辑");
  });
});
