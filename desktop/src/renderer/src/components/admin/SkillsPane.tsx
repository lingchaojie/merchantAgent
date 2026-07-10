import { useState, useEffect, useCallback } from "react";
import type { AdminClient, Skill, ToolInfo, Role, Template } from "../../admin";

export function SkillsPane({ client }: { client: AdminClient }): JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tplId, setTplId] = useState("");
  const [edit, setEdit] = useState<Skill | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    client.listSkills().then(setSkills).catch((e) => setErr(String(e)));
    client.listTools().then(setTools).catch(() => {});
    client.listRoles().then(setRoles).catch(() => {});
    client.listTemplates().then(setTemplates).catch(() => {});
  }, [client]);
  useEffect(load, [load]);

  const save = async () => {
    if (!edit) return;
    setErr("");
    try {
      await client.updateSkill(edit.skillId, edit);
      setEdit(null); load();
    } catch (e) { setErr(String(e)); }
  };
  const clone = async () => {
    if (!tplId) return;
    setErr("");
    try {
      await client.createSkill({ templateId: tplId });
      setTplId(""); load();
    } catch (e) { setErr(String(e)); }
  };
  const toggle = (arr: string[], v: string): string[] =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  return (
    <div className="pane">
      <h3 className="pane-title">技能</h3>
      {err && <div className="pane-err">{err}</div>}
      <div className="pane-form">
        <select value={tplId} onChange={(e) => setTplId(e.target.value)}>
          <option value="">从模板新建…</option>
          {templates.map((t) => (
            <option key={t.templateId} value={t.templateId}>{t.name} ({t.templateId})</option>
          ))}
        </select>
        <button className="btn-primary" onClick={clone} disabled={!tplId || templates.length === 0}>克隆</button>
      </div>
      <ul className="pane-list">
        {skills.map((s) => (
          <li key={s.skillId} className="pane-row">
            <span><b>{s.name}</b> <code>{s.skillId}</code></span>
            <button className="btn" onClick={() => setEdit({ ...s })}>编辑</button>
          </li>
        ))}
      </ul>
      {edit && (
        <div className="skill-editor">
          <label>名称<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label>剧本(playbook)
            <textarea rows={5} value={edit.playbookMd} onChange={(e) => setEdit({ ...edit, playbookMd: e.target.value })} />
          </label>
          <fieldset><legend>工具</legend>
            {tools.map((t) => (
              <label key={t.name} className="chk">
                <input type="checkbox" checked={edit.allowedTools.includes(t.name)}
                  onChange={() => setEdit({ ...edit, allowedTools: toggle(edit.allowedTools, t.name) })} />
                {t.name}{t.dataDomain ? <span className="warn"> ⚠ {t.dataDomain}</span> : null}
              </label>
            ))}
          </fieldset>
          <fieldset><legend>data domains (声明，非授权)</legend>
            {["cost", "pricing"].map((d) => (
              <label key={d} className="chk">
                <input type="checkbox" checked={edit.dataDomains.includes(d)}
                  onChange={() => setEdit({ ...edit, dataDomains: toggle(edit.dataDomains, d) })} />{d}
              </label>
            ))}
          </fieldset>
          <fieldset><legend>可用角色 (闸 A：能力)</legend>
            {roles.map((r) => (
              <label key={r.roleId} className="chk">
                <input type="checkbox" checked={edit.roles.includes(r.roleId)}
                  onChange={() => setEdit({ ...edit, roles: toggle(edit.roles, r.roleId) })} />{r.label}
              </label>
            ))}
          </fieldset>
          <div className="pane-form">
            <button className="btn-primary" onClick={save}>保存</button>
            <button className="btn" onClick={() => setEdit(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
