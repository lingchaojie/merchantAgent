import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SkillEditor } from "./SkillsPane";

it("renders every editable skill field and supplied domains", () => {
  const html = renderToStaticMarkup(
    <SkillEditor
      skill={{
        tenantId: "t",
        skillId: "s",
        name: "技能",
        description: "说明",
        playbookMd: "剧本",
        allowedTools: [],
        dataDomains: [],
        roles: [],
      }}
      isNew
      busy={false}
      tools={[]}
      roles={[]}
      domains={[{ domainId: "custom", label: "自定义域" }]}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

  expect(html).toContain('name="skill-id"');
  expect(html).toContain('name="skill-name"');
  expect(html).toContain('name="skill-description"');
  expect(html).toContain('name="skill-playbook"');
  expect(html).toContain("自定义域");
});
