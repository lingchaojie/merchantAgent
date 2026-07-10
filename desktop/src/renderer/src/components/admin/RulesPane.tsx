import { useState, useEffect, useCallback } from "react";
import type { AdminClient, Rule, Role } from "../../admin";

// Rules map free-text (job/position keywords) → a roleId. They are evaluated
// top-to-bottom, first match wins. Each rule's `match` is a list of substrings;
// here it's edited as a comma-joined string and split back into a trimmed array.
export function RulesPane({ client }: { client: AdminClient }): JSX.Element {
  const [rules, setRules] = useState<Rule[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    client.getRules().then(setRules).catch((e) => setErr(String(e)));
    client.listRoles().then(setRoles).catch(() => {});
  }, [client]);
  useEffect(load, [load]);

  // Split + trim only (NO filter): keep empty tokens so a trailing comma survives
  // a render — otherwise the controlled input erases the separator as it's typed
  // and keywords merge. Empty terms are dropped at save time instead.
  const setMatch = (i: number, raw: string) =>
    setRules((rs) => rs.map((r, j) =>
      j === i ? { ...r, match: raw.split(",").map((s) => s.trim()) } : r));
  const setRole = (i: number, roleId: string) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, roleId } : r)));
  const removeRule = (i: number) => setRules((rs) => rs.filter((_, j) => j !== i));
  const addRule = () =>
    setRules((rs) => [...rs, { match: [], roleId: roles[0]?.roleId ?? "" }]);

  const save = async () => {
    setErr("");
    try {
      // Drop empty match terms only on save, so smooth typing doesn't persist blanks.
      const cleaned = rules.map((r) => ({ ...r, match: r.match.filter((s) => s !== "") }));
      await client.putRules(cleaned);
      load();
    } catch (e) { setErr(String(e)); }
  };

  return (
    <div className="pane">
      <h3 className="pane-title">职位映射</h3>
      <div className="pane-caption">规则自上而下匹配，命中第一条即生效。</div>
      {err && <div className="pane-err">{err}</div>}
      <ul className="pane-list">
        {rules.map((r, i) => (
          <li key={i} className="pane-row">
            <input
              placeholder="关键词，逗号分隔 (如 利润,成本)"
              value={r.match.join(",")}
              onChange={(e) => setMatch(i, e.target.value)}
            />
            <select value={r.roleId} onChange={(e) => setRole(i, e.target.value)}>
              {roles.map((ro) => (
                <option key={ro.roleId} value={ro.roleId}>{ro.label}</option>
              ))}
            </select>
            <button className="btn-danger" onClick={() => removeRule(i)}>删除</button>
          </li>
        ))}
      </ul>
      <div className="pane-form">
        <button className="btn" onClick={addRule}>添加规则</button>
        <button className="btn-primary" onClick={save}>保存</button>
      </div>
    </div>
  );
}
