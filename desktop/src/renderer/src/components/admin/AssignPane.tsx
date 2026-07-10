import { useState, useEffect, useCallback } from "react";
import type { AdminClient, Skill, Role, Domain, Grant } from "../../admin";

// The OpenFGA subject for "role R (of this tenant) is assignee of a data domain".
// This EXACT template is used both to test the checkbox state and to add/remove
// the grant — they must be identical or the checkbox won't reflect reality.
const roleSubject = (tenantId: string, roleId: string): string =>
  `role:${tenantId}/${roleId}#assignee`;

export function AssignPane({ client, tenantId }: { client: AdminClient; tenantId: string }): JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [err, setErr] = useState("");
  // In-flight guard: serialize mutations so a second toggle can't start from a
  // stale roles/grants base and overwrite the first (lost update).
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    client.listSkills().then(setSkills).catch((e) => setErr(String(e)));
    client.listRoles().then(setRoles).catch(() => {});
    client.listDomains().then((d) => { setDomains(d.domains); setGrants(d.grants); }).catch(() => {});
  }, [client]);
  useEffect(load, [load]);

  const toggle = (arr: string[], v: string): string[] =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  // Gate A: a skill is usable by a role (capability).
  const toggleSkillRole = async (skill: Skill, roleId: string) => {
    if (busy) return;
    setErr(""); setBusy(true);
    try {
      await client.updateSkill(skill.skillId, { ...skill, roles: toggle(skill.roles, roleId) });
      load();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  // Gate B: a role may view a data domain (data visibility, via OpenFGA grant).
  const toggleDomainRole = async (domainId: string, roleId: string) => {
    if (busy) return;
    setErr(""); setBusy(true);
    const subject = roleSubject(tenantId, roleId);
    const has = grants.some((g) => g.domainId === domainId && g.subject === subject);
    try {
      if (has) await client.removeGrant(domainId, subject);
      else await client.addGrant(domainId, subject);
      load();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="pane">
      <h3 className="pane-title">分配</h3>
      <div className="pane-caption">能力 ≠ 数据（技能可用 ≠ 能看敏感数据）</div>
      {err && <div className="pane-err">{err}</div>}

      <h4 className="pane-subhead">① 能力：技能 → 角色 (闸 A)</h4>
      <ul className="pane-list">
        {skills.map((s) => (
          <li key={s.skillId} className="pane-row">
            <span><b>{s.name}</b> <code>{s.skillId}</code></span>
            <span className="assign-checks">
              {roles.map((r) => (
                <label key={r.roleId} className="chk">
                  <input type="checkbox" checked={s.roles.includes(r.roleId)} disabled={busy}
                    onChange={() => toggleSkillRole(s, r.roleId)} />{r.label}
                </label>
              ))}
            </span>
          </li>
        ))}
      </ul>

      <h4 className="pane-subhead">② 数据：数据域 → 角色 (闸 B)</h4>
      <ul className="pane-list">
        {domains.map((d) => (
          <li key={d.domainId} className="pane-row">
            <span><b>{d.label}</b> <code>{d.domainId}</code></span>
            <span className="assign-checks">
              {roles.map((r) => {
                const subject = roleSubject(tenantId, r.roleId);
                const checked = grants.some((g) => g.domainId === d.domainId && g.subject === subject);
                return (
                  <label key={r.roleId} className="chk">
                    <input type="checkbox" checked={checked} disabled={busy}
                      onChange={() => toggleDomainRole(d.domainId, r.roleId)} />{r.label}
                  </label>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
