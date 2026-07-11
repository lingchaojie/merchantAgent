import { useCallback, useEffect, useState } from "react";
import type { AdminClient, Rule, Role } from "../../admin";
import { moveItem } from "../../admin-ui";

export function RulesPane({ client }: { client: AdminClient }): JSX.Element {
  const [rules, setRules] = useState<Rule[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const load = useCallback(async () => {
    try {
      const [nextRules, nextRoles] = await Promise.all([client.getRules(), client.listRoles()]);
      setRules(nextRules); setRoles(nextRoles);
    } catch (error) {
      setErr(String(error));
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const setMatch = (index: number, raw: string) => setRules((items) => items.map((rule, i) => i === index
    ? { ...rule, match: raw.split(",").map((term) => term.trim()) }
    : rule));
  const setRole = (index: number, roleId: string) => setRules((items) => items.map((rule, i) => i === index
    ? { ...rule, roleId }
    : rule));
  const removeRule = (index: number) => setRules((items) => items.filter((_, i) => i !== index));
  const addRule = () => setRules((items) => [...items, { match: [], roleId: roles[0]?.roleId ?? "" }]);

  const save = async () => {
    const cleaned = rules.map((rule) => ({ ...rule, match: rule.match.filter(Boolean) }));
    setBusy(true); setErr(""); setOk("");
    try {
      await client.putRules(cleaned);
      await load(); setOk("已生效");
    } catch (error) {
      setErr(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <h3 className="pane-title">职位映射</h3>
      <div className="pane-caption">规则自上而下匹配，命中第一条即生效。</div>
      {err && <div className="pane-err">{err}</div>}
      {ok && <div className="pane-ok">{ok}</div>}
      <ul className="pane-list">
        {rules.map((rule, index) => (
          <li key={index} className="pane-row rule-row">
            <span className="rule-order">{index + 1}</span>
            <input placeholder="关键词，逗号分隔 (如 利润,成本)" value={rule.match.join(",")}
              disabled={busy} onChange={(event) => setMatch(index, event.target.value)} />
            <select value={rule.roleId} disabled={busy} onChange={(event) => setRole(index, event.target.value)}>
              {roles.map((role) => <option key={role.roleId} value={role.roleId}>{role.label}</option>)}
            </select>
            <span className="pane-actions">
              <button className="icon-btn" title="上移" disabled={busy || index === 0}
                onClick={() => setRules((items) => moveItem(items, index, -1))}>↑</button>
              <button className="icon-btn" title="下移" disabled={busy || index === rules.length - 1}
                onClick={() => setRules((items) => moveItem(items, index, 1))}>↓</button>
              <button className="btn-danger" disabled={busy} onClick={() => removeRule(index)}>删除</button>
            </span>
          </li>
        ))}
      </ul>
      <div className="pane-form">
        <button className="btn" disabled={busy || roles.length === 0} onClick={addRule}>添加规则</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>保存</button>
      </div>
    </div>
  );
}
