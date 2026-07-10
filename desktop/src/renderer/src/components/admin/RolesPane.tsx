import { useState, useEffect, useCallback } from "react";
import type { AdminClient, Role } from "../../admin";

export function RolesPane({ client }: { client: AdminClient }): JSX.Element {
  const [roles, setRoles] = useState<Role[]>([]);
  const [id, setId] = useState(""); const [label, setLabel] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(() => { client.listRoles().then(setRoles).catch((e) => setErr(String(e))); }, [client]);
  useEffect(load, [load]);

  const create = async () => {
    setErr("");
    try {
      await client.createRole({ roleId: id, label, description: "" });
      setId(""); setLabel(""); load();
    } catch (e) { setErr(String(e)); }
  };
  const del = async (rid: string) => {
    setErr("");
    try { await client.deleteRole(rid); load(); } catch (e) { setErr(String(e)); }
  };

  return (
    <div className="pane">
      <h3 className="pane-title">角色</h3>
      {err && <div className="pane-err">{err}</div>}
      <ul className="pane-list">
        {roles.map((r) => (
          <li key={r.roleId} className="pane-row">
            <span><b>{r.label}</b> <code>{r.roleId}</code></span>
            <button className="btn-danger" onClick={() => del(r.roleId)}>删除</button>
          </li>
        ))}
      </ul>
      <div className="pane-form">
        <input placeholder="role id (如 logistics)" value={id} onChange={(e) => setId(e.target.value)} />
        <input placeholder="显示名 (如 物流)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn-primary" onClick={create} disabled={!id || !label}>新建角色</button>
      </div>
    </div>
  );
}
