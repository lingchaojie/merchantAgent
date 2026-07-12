import { useCallback, useEffect, useState } from "react";
import type { AdminClient, Domain, Role, Skill, Template, ToolInfo } from "../../admin";
import { newSkillDraft } from "../../admin-ui";

interface SkillEditorProps {
  skill: Skill;
  originalAllowedTools?: string[];
  isNew: boolean;
  busy: boolean;
  toolsFresh?: boolean;
  tools: ToolInfo[];
  roles: Role[];
  domains: Domain[];
  onChange: (skill: Skill) => void;
  onSave: () => void;
  onCancel: () => void;
}

function toggle(items: string[], value: string): string[] {
  return items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
}

export function unavailableToolReferences(
  selected: string[], original: string[], tools: ToolInfo[],
): string[] {
  const live = new Set(tools.map((tool) => tool.name));
  const historical = new Set(original);
  return selected.filter((name) => !live.has(name) && !historical.has(name));
}

export function unavailableTemplateTools(template: Template, tools: ToolInfo[]): string[] {
  const live = new Set(tools.map((tool) => tool.name));
  return template.allowedTools.filter((name) => !live.has(name));
}

export function SkillEditor({
  skill,
  originalAllowedTools = skill.allowedTools,
  isNew,
  busy,
  toolsFresh = true,
  tools,
  roles,
  domains,
  onChange,
  onSave,
  onCancel,
}: SkillEditorProps): JSX.Element {
  const update = <K extends keyof Skill>(key: K, value: Skill[K]) => onChange({ ...skill, [key]: value });
  const liveNames = new Set(tools.map((tool) => tool.name));
  const historicalUnavailable = originalAllowedTools.filter((name) => !liveNames.has(name));
  const invalidTools = unavailableToolReferences(skill.allowedTools, originalAllowedTools, tools);

  return (
    <div className="skill-editor">
      <div className="skill-fields">
        <label>Skill ID
          <input name="skill-id" value={skill.skillId} disabled={busy || !isNew}
            onChange={(event) => update("skillId", event.target.value)} />
        </label>
        <label>名称
          <input name="skill-name" value={skill.name} disabled={busy}
            onChange={(event) => update("name", event.target.value)} />
        </label>
      </div>
      <label>描述
        <input name="skill-description" value={skill.description} disabled={busy}
          onChange={(event) => update("description", event.target.value)} />
      </label>
      <label>剧本 (playbook)
        <textarea name="skill-playbook" rows={7} value={skill.playbookMd} disabled={busy}
          onChange={(event) => update("playbookMd", event.target.value)} />
      </label>
      <fieldset><legend>工具</legend>
        {tools.map((tool) => (
          <label key={tool.name} className="chk tool-choice">
            <input type="checkbox" checked={skill.allowedTools.includes(tool.name)} disabled={busy || !toolsFresh}
              onChange={() => update("allowedTools", toggle(skill.allowedTools, tool.name))} />
            <span className="tool-choice-details">
              <span>{tool.name}{tool.dataDomain ? <span className="warn"> ⚠ {tool.dataDomain}</span> : null}</span>
              <span className="tool-meta">
                {(tool.packageId || tool.version) && (
                  <code>{tool.packageId}{tool.packageId && tool.version ? "@" : ""}{tool.version}</code>
                )}
                <span>{tool.execution === "desktop" ? "本地执行" : "服务端执行"}</span>
                <span>{tool.risk === "low_write" ? "低风险写入" : tool.risk === "high_write" ? "高风险写入" : "只读"}</span>
                {tool.requiresConfirmation && <span>需确认</span>}
              </span>
            </span>
          </label>
        ))}
        {historicalUnavailable.map((name) => (
          <label key={name} className="chk tool-choice unavailable-tool">
            <input type="checkbox" checked={skill.allowedTools.includes(name)} disabled={busy || !skill.allowedTools.includes(name)}
              onChange={() => update("allowedTools", skill.allowedTools.filter((tool) => tool !== name))} />
            <span className="tool-choice-details"><span>{name}</span><span className="tool-meta">不可用 · 仅保留历史引用，可移除但不可重新添加</span></span>
          </label>
        ))}
      </fieldset>
      <fieldset><legend>数据域（声明，非授权）</legend>
        {domains.map((domain) => (
          <label key={domain.domainId} className="chk">
            <input type="checkbox" checked={skill.dataDomains.includes(domain.domainId)} disabled={busy}
              onChange={() => update("dataDomains", toggle(skill.dataDomains, domain.domainId))} />
            {domain.label} <code>{domain.domainId}</code>
          </label>
        ))}
      </fieldset>
      <fieldset><legend>可用角色（闸 A：能力）</legend>
        {roles.map((role) => (
          <label key={role.roleId} className="chk">
            <input type="checkbox" checked={skill.roles.includes(role.roleId)} disabled={busy}
              onChange={() => update("roles", toggle(skill.roles, role.roleId))} />
            {role.label}
          </label>
        ))}
      </fieldset>
      <div className="pane-form">
        <button className="btn-primary" disabled={busy || !toolsFresh || !skill.skillId.trim() || !skill.name.trim() || invalidTools.length > 0}
          onClick={onSave}>保存</button>
        <button className="btn" disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

export function SkillsPane({ client, tenantId, refreshToken = 0 }: { client: AdminClient; tenantId: string; refreshToken?: number }): JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [edit, setEdit] = useState<Skill | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [originalAllowedTools, setOriginalAllowedTools] = useState<string[]>([]);
  const [toolsFresh, setToolsFresh] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const load = useCallback(async () => {
    setCatalogLoading(true); setToolsFresh(false); setTools([]); setErr("");
    try {
      const [nextSkills, nextTools, nextRoles, nextTemplates, domainData] = await Promise.all([
        client.listSkills(), client.listTools(), client.listRoles(), client.listTemplates(), client.listDomains(),
      ]);
      setSkills(nextSkills); setTools(nextTools); setRoles(nextRoles);
      setTemplates(nextTemplates); setDomains(domainData.domains);
      setToolsFresh(true);
    } catch (error) {
      setErr(String(error));
    } finally {
      setCatalogLoading(false);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const save = async () => {
    if (!edit) return;
    if (!toolsFresh) {
      setErr("实时工具目录不可用，无法保存技能");
      return;
    }
    const invalid = unavailableToolReferences(edit.allowedTools, originalAllowedTools, tools);
    if (invalid.length > 0) {
      setErr(`不可保存未发布工具：${invalid.join("、")}`);
      return;
    }
    setBusy(true); setErr(""); setOk("");
    try {
      if (isNew) await client.createBlankSkill({ ...edit, skillId: edit.skillId.trim(), name: edit.name.trim() });
      else await client.updateSkill(edit.skillId, { ...edit, name: edit.name.trim() });
      setEdit(null); setIsNew(false); await load(); setOk("已生效");
    } catch (error) {
      setErr(String(error));
    } finally {
      setBusy(false);
    }
  };

  const clone = async () => {
    if (!templateId) return;
    const template = templates.find((candidate) => candidate.templateId === templateId);
    if (!toolsFresh) {
      setErr("实时工具目录尚未刷新，无法克隆模板");
      return;
    }
    if (!template) {
      setErr("所选模板已不可用");
      return;
    }
    const unavailable = unavailableTemplateTools(template, tools);
    if (unavailable.length > 0) {
      setErr(`模板包含未发布工具：${unavailable.join("、")}`);
      return;
    }
    setBusy(true); setErr(""); setOk("");
    try {
      await client.cloneTemplate(templateId);
      setTemplateId(""); await load(); setOk("已生效");
    } catch (error) {
      setErr(String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (skillId: string) => {
    setBusy(true); setErr(""); setOk("");
    try {
      await client.deleteSkill(skillId);
      if (edit?.skillId === skillId) setEdit(null);
      await load(); setOk("已生效");
    } catch (error) {
      setErr(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <h3 className="pane-title">技能</h3>
      {err && <div className="pane-err" role="alert">{err}</div>}
      {ok && <div className="pane-ok" role="status">{ok}</div>}
      <div className="pane-form" role="status">
        <span>{catalogLoading ? "正在刷新实时工具目录…" : toolsFresh ? "实时工具目录已刷新" : "实时工具目录不可用，新增、保存与克隆已禁用"}</span>
        <button className="btn" disabled={busy || catalogLoading} onClick={() => void load()}>刷新工具目录</button>
      </div>
      <div className="pane-form skill-create-actions">
        <button className="btn" disabled={busy || edit !== null}
          onClick={() => { setEdit(newSkillDraft(tenantId)); setOriginalAllowedTools([]); setIsNew(true); }}>新建空白技能</button>
        <select value={templateId} disabled={busy} onChange={(event) => setTemplateId(event.target.value)}>
          <option value="">从模板新建…</option>
          {templates.map((template) => (
            <option key={template.templateId} value={template.templateId}>{template.name} ({template.templateId})</option>
          ))}
        </select>
        <button className="btn-primary" onClick={() => void clone()}
          disabled={busy || !toolsFresh || !templateId || templates.length === 0}>克隆</button>
      </div>
      <ul className="pane-list skill-list">
        {skills.map((skill) => (
          <li key={skill.skillId} className="pane-row">
            <span className="role-summary">
              <span><b>{skill.name}</b> <code>{skill.skillId}</code></span>
              {skill.description && <small>{skill.description}</small>}
            </span>
            <span className="pane-actions">
              <button className="btn" disabled={busy}
                onClick={() => { setEdit({ ...skill }); setOriginalAllowedTools([...skill.allowedTools]); setIsNew(false); }}>编辑</button>
              <button className="btn-danger" disabled={busy} onClick={() => void remove(skill.skillId)}>删除</button>
            </span>
          </li>
        ))}
      </ul>
      {edit && (
        <SkillEditor skill={edit} originalAllowedTools={originalAllowedTools} isNew={isNew} busy={busy} toolsFresh={toolsFresh} tools={tools} roles={roles} domains={domains}
          onChange={setEdit} onSave={() => void save()}
          onCancel={() => { setEdit(null); setIsNew(false); }} />
      )}
    </div>
  );
}
