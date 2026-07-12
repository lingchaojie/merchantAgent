import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { AdminClient, Skill, ToolInfo } from "../../admin";
import { SkillEditor, SkillsPane, unavailableToolReferences } from "./SkillsPane";

const css = readFileSync(new URL("../../app.css", import.meta.url), "utf8");

function nodeText(node: ReactTestInstance | string | number): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node.children.map((child) => nodeText(child as ReactTestInstance | string | number)).join("");
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

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

it("keeps checkbox rows as inline flex inside the admin pane", () => {
  expect(css).toMatch(/\.pane\s+\.chk\s*\{[^}]*display:\s*inline-flex;/s);
  expect(css).toMatch(/\.pane\s+\.tool-choice\s*\{[^}]*align-items:\s*flex-start;/s);
});

it("preserves historical unavailable tools but rejects newly added unavailable references", () => {
  expect(unavailableToolReferences(["legacy_tool"], [], [])).toEqual(["legacy_tool"]);
  expect(unavailableToolReferences(["legacy_tool"], ["legacy_tool"], [])).toEqual([]);
  expect(unavailableToolReferences(["legacy_tool", "missing_tool"], ["legacy_tool"], []))
    .toEqual(["missing_tool"]);

  const html = renderToStaticMarkup(
    <SkillEditor
      skill={{ ...skillDraft(), allowedTools: ["legacy_tool"] }}
      originalAllowedTools={["legacy_tool"]}
      isNew={false}
      busy={false}
      tools={[]}
      roles={[]}
      domains={[]}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(html).toContain("legacy_tool");
  expect(html).toContain("不可用");
});

it("does not allow a removed historical tool to be selected again", () => {
  const html = renderToStaticMarkup(
    <SkillEditor
      skill={{ ...skillDraft(), allowedTools: [] }}
      originalAllowedTools={["legacy_tool"]}
      isNew={false}
      busy={false}
      tools={[]}
      roles={[]}
      domains={[]}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(html).toMatch(/unavailable-tool[^>]*>\s*<input type="checkbox" disabled/);
});

it("rejects template cloning when the template references unavailable live tools", async () => {
  const client = {
    listSkills: vi.fn(async () => []),
    listTools: vi.fn(async () => [progressTool]),
    listRoles: vi.fn(async () => []),
    listTemplates: vi.fn(async () => [{
      templateId: "restricted-template",
      name: "受限模板",
      description: "",
      playbookMd: "",
      allowedTools: ["report_production_progress", "unpublished_tool"],
      dataDomains: [],
      suggestedRoles: [],
    }]),
    listDomains: vi.fn(async () => ({ domains: [], grants: [] })),
    cloneTemplate: vi.fn(async () => undefined),
  } as unknown as AdminClient;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<SkillsPane client={client} tenantId="tenant-1" />); });
  await flush();

  const select = renderer.root.findByType("select");
  await act(async () => { select.props.onChange({ target: { value: "restricted-template" } }); });
  const clone = renderer.root.findAllByType("button")
    .find((candidate) => nodeText(candidate) === "克隆")!;
  await act(async () => { clone.props.onClick(); await Promise.resolve(); });

  expect(client.cloneTemplate).not.toHaveBeenCalled();
  expect(nodeText(renderer.root)).toContain("unpublished_tool");
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
});
