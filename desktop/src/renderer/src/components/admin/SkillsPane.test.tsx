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

function button(root: ReactTestInstance, name: string): ReactTestInstance {
  const found = root.findAllByType("button").find((candidate) => nodeText(candidate) === name);
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

function toolCheckbox(root: ReactTestInstance, name: string): ReactTestInstance {
  const label = root.findAllByType("label").find((candidate) => nodeText(candidate).startsWith(name));
  if (!label) throw new Error(`tool not found: ${name}`);
  return label.findByType("input");
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

it("keeps fetched Skills and staged historical removal when the initial tool catalog load fails", async () => {
  const existing = { ...skillDraft(), allowedTools: ["legacy_tool"] };
  const client = {
    listSkills: vi.fn(async () => [existing]),
    listTools: vi.fn()
      .mockRejectedValueOnce(new Error("tool catalog unavailable"))
      .mockResolvedValue([progressTool]),
    listRoles: vi.fn(async () => []),
    listTemplates: vi.fn(async () => [{
      templateId: "progress-template", name: "进度模板", description: "", playbookMd: "",
      allowedTools: ["report_production_progress"], dataDomains: [], suggestedRoles: [],
    }]),
    listDomains: vi.fn(async () => ({ domains: [], grants: [] })),
    cloneTemplate: vi.fn(async () => undefined),
    updateSkill: vi.fn(async () => undefined),
  } as unknown as AdminClient;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<SkillsPane client={client} tenantId="tenant-1" />); });
  await flush();

  expect(nodeText(renderer.root)).toContain("tool catalog unavailable");
  expect(nodeText(renderer.root)).toContain("实时工具目录不可用");
  expect(nodeText(renderer.root)).toContain("生产进度");
  await act(async () => { button(renderer.root, "编辑").props.onClick(); });
  expect(toolCheckbox(renderer.root, "legacy_tool").props.checked).toBe(true);
  expect(toolCheckbox(renderer.root, "legacy_tool").props.disabled).toBe(false);

  const select = renderer.root.findByType("select");
  await act(async () => { select.props.onChange({ target: { value: "progress-template" } }); });
  expect(button(renderer.root, "克隆").props.disabled).toBe(true);
  await act(async () => { button(renderer.root, "克隆").props.onClick(); await Promise.resolve(); });
  expect(client.cloneTemplate).not.toHaveBeenCalled();

  await act(async () => { toolCheckbox(renderer.root, "legacy_tool").props.onChange(); });
  expect(toolCheckbox(renderer.root, "legacy_tool").props.checked).toBe(false);
  expect(toolCheckbox(renderer.root, "legacy_tool").props.disabled).toBe(true);

  const save = button(renderer.root, "保存");
  expect(save.props.disabled).toBe(true);
  await act(async () => { save.props.onClick(); await Promise.resolve(); });
  expect(client.updateSkill).not.toHaveBeenCalled();

  await act(async () => { button(renderer.root, "刷新工具目录").props.onClick(); await Promise.resolve(); });
  await flush();
  expect(toolCheckbox(renderer.root, "report_production_progress").props.disabled).toBe(false);
  await act(async () => { toolCheckbox(renderer.root, "report_production_progress").props.onChange(); });
  await act(async () => { button(renderer.root, "保存").props.onClick(); await Promise.resolve(); });
  expect(client.updateSkill).toHaveBeenCalledWith("production-progress", expect.objectContaining({
    allowedTools: ["report_production_progress"],
  }));
});

it("keeps a successful tool catalog fresh but blocks save when a required editor resource fails", async () => {
  const client = {
    listSkills: vi.fn(async () => [skillDraft()]),
    listTools: vi.fn(async () => [progressTool]),
    listRoles: vi.fn(async () => { throw new Error("role catalog unavailable"); }),
    listTemplates: vi.fn(async () => [{
      templateId: "progress-template", name: "进度模板", description: "", playbookMd: "",
      allowedTools: ["report_production_progress"], dataDomains: [], suggestedRoles: [],
    }]),
    listDomains: vi.fn(async () => ({ domains: [{ domainId: "orders", label: "订单" }], grants: [] })),
    updateSkill: vi.fn(async () => undefined),
  } as unknown as AdminClient;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<SkillsPane client={client} tenantId="tenant-1" />); });
  await flush();

  expect(nodeText(renderer.root)).toContain("role catalog unavailable");
  expect(nodeText(renderer.root)).toContain("实时工具目录已刷新");
  expect(nodeText(renderer.root)).toContain("进度模板");
  await act(async () => { button(renderer.root, "编辑").props.onClick(); });
  expect(toolCheckbox(renderer.root, "report_production_progress").props.disabled).toBe(false);
  expect(nodeText(renderer.root)).toContain("订单");
  expect(button(renderer.root, "保存").props.disabled).toBe(true);
  await act(async () => { button(renderer.root, "保存").props.onClick(); await Promise.resolve(); });
  expect(client.updateSkill).not.toHaveBeenCalled();
});

it("fails closed after a later catalog refresh failure and recovers without deleting historical refs", async () => {
  const existing = { ...skillDraft(), allowedTools: ["legacy_tool"] };
  const client = {
    listSkills: vi.fn(async () => [existing]),
    listTools: vi.fn()
      .mockResolvedValueOnce([progressTool])
      .mockRejectedValueOnce(new Error("catalog refresh failed"))
      .mockResolvedValue([progressTool]),
    listRoles: vi.fn(async () => []),
    listTemplates: vi.fn(async () => []),
    listDomains: vi.fn(async () => ({ domains: [], grants: [] })),
    updateSkill: vi.fn(async () => undefined),
  } as unknown as AdminClient;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<SkillsPane client={client} tenantId="tenant-1" refreshToken={0} />); });
  await flush();
  await act(async () => { button(renderer.root, "编辑").props.onClick(); });
  expect(toolCheckbox(renderer.root, "report_production_progress").props.disabled).toBe(false);

  await act(async () => { renderer.update(<SkillsPane client={client} tenantId="tenant-1" refreshToken={1} />); });
  await flush();

  expect(nodeText(renderer.root)).toContain("catalog refresh failed");
  expect(nodeText(renderer.root)).toContain("legacy_tool");
  expect(toolCheckbox(renderer.root, "legacy_tool").props.checked).toBe(true);
  expect(toolCheckbox(renderer.root, "legacy_tool").props.disabled).toBe(false);
  expect(renderer.root.findAllByType("label")
    .some((candidate) => nodeText(candidate).startsWith("report_production_progress"))).toBe(false);
  const blockedSave = button(renderer.root, "保存");
  expect(blockedSave.props.disabled).toBe(true);
  await act(async () => { blockedSave.props.onClick(); await Promise.resolve(); });
  expect(client.updateSkill).not.toHaveBeenCalled();

  await act(async () => { button(renderer.root, "刷新工具目录").props.onClick(); await Promise.resolve(); });
  await flush();

  expect(nodeText(renderer.root)).toContain("实时工具目录已刷新");
  expect(toolCheckbox(renderer.root, "report_production_progress").props.disabled).toBe(false);
  await act(async () => { toolCheckbox(renderer.root, "report_production_progress").props.onChange(); });
  expect(button(renderer.root, "保存").props.disabled).toBe(false);
  await act(async () => { button(renderer.root, "保存").props.onClick(); await Promise.resolve(); });
  expect(client.updateSkill).toHaveBeenCalledWith("production-progress", expect.objectContaining({
    allowedTools: ["legacy_tool", "report_production_progress"],
  }));
});
