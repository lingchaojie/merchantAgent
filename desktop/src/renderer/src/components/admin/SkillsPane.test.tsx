import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Skill, ToolInfo } from "../../admin";
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

const progressTool: ToolInfo = {
  name: "report_production_progress",
  description: "更新订单的本地生产进度",
  packageId: "reference-manufacturing",
  version: "1.0.0",
  execution: "desktop",
  risk: "low_write",
  requiresConfirmation: true,
};

function skillDraft(): Skill {
  return {
    tenantId: "t",
    skillId: "production-progress",
    name: "生产进度",
    description: "",
    playbookMd: "",
    allowedTools: [],
    dataDomains: ["orders"],
    roles: ["planner"],
  };
}

it("renders desktop write-risk and confirmation metadata beside a tool", () => {
  const html = renderToStaticMarkup(
    <SkillEditor
      skill={skillDraft()}
      isNew={false}
      busy={false}
      tools={[progressTool]}
      roles={[]}
      domains={[]}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

  expect(html).toContain("reference-manufacturing");
  expect(html).toContain("1.0.0");
  expect(html).toContain("本地执行");
  expect(html).toContain("低风险写入");
  expect(html).toContain("需确认");
});

it("tool checkbox changes only allowedTools", () => {
  const skill = skillDraft();
  const onChange = vi.fn();
  const editor = SkillEditor({
    skill,
    isNew: false,
    busy: false,
    tools: [progressTool],
    roles: [],
    domains: [],
    onChange,
    onSave: vi.fn(),
    onCancel: vi.fn(),
  });
  const children = editor.props.children as Array<React.ReactElement>;
  const toolsFieldset = children.find((child) => child?.type === "fieldset");
  const toolChildren = toolsFieldset?.props.children as Array<React.ReactElement | React.ReactElement[]>;
  const toolLabel = (toolChildren[1] as React.ReactElement[])[0];
  const toolInput = toolLabel.props.children[0] as React.ReactElement;

  toolInput.props.onChange();

  expect(onChange).toHaveBeenCalledWith({
    ...skill,
    allowedTools: ["report_production_progress"],
  });
});
