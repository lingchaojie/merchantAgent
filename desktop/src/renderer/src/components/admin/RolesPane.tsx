import { useCallback, useEffect, useState } from "react";
import type { AdminClient, Role } from "../../admin";

interface RoleRowProps {
  role: Role;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (label: string, description: string) => void;
  onDelete: () => void;
}

export function RoleRow({ role, editing, busy, onEdit, onCancel, onSave, onDelete }: RoleRowProps): JSX.Element {
  const [label, setLabel] = useState(role.label);
  const [description, setDescription] = useState(role.description);

  useEffect(() => {
    setLabel(role.label);
    setDescription(role.description);
  }, [role, editing]);

  if (editing) {
    return (
      <li className="pane-row role-edit">
        <code>{role.roleId}</code>
        <input name="role-label" aria-label="角色显示名" value={label} disabled={busy}
          onChange={(event) => setLabel(event.target.value)} />
        <input name="role-description" aria-label="角色描述" value={description} disabled={busy}
          onChange={(event) => setDescription(event.target.value)} />
        <span className="pane-actions">
          <button className="btn-primary" disabled={busy || !label.trim()}
            onClick={() => onSave(label.trim(), description.trim())}>保存</button>
          <button className="btn" disabled={busy} onClick={onCancel}>取消</button>
        </span>
      </li>
    );
  }

  return (
    <li className="pane-row">
      <span className="role-summary">
        <span><b>{role.label}</b> <code>{role.roleId}</code></span>
        {role.description && <small>{role.description}</small>}
      </span>
      <span className="pane-actions">
        <button className="btn" disabled={busy} onClick={onEdit}>编辑</button>
        <button className="btn-danger" disabled={busy} onClick={onDelete}>删除</button>
      </span>
    </li>
  );
}

export function RolesPane({ client }: { client: AdminClient }): JSX.Element {
  const [roles, setRoles] = useState<Role[]>([]);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const load = useCallback(async () => {
    try {
      setRoles(await client.listRoles());
    } catch (error) {
      setErr(String(error));
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true); setErr(""); setOk("");
    try {
      await client.createRole({ roleId: id.trim(), label: label.trim(), description: description.trim() });
      setId(""); setLabel(""); setDescription("");
      await load(); setOk("已生效");
    } catch (error) {
      setErr(String(error));
    } finally {
      setBusy(false);
    }
  };

  const update = async (roleId: string, nextLabel: string, nextDescription: string) => {
    setBusy(true); setErr(""); setOk("");
    try {
      await client.updateRole(roleId, nextLabel, nextDescription);
      setEditingId(null); await load(); setOk("已生效");
    } catch (error) {
      setErr(String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (roleId: string) => {
    setBusy(true); setErr(""); setOk("");
    try {
      await client.deleteRole(roleId);
      if (editingId === roleId) setEditingId(null);
      await load(); setOk("已生效");
    } catch (error) {
      setErr(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <h3 className="pane-title">角色</h3>
      {err && <div className="pane-err">{err}</div>}
      {ok && <div className="pane-ok">{ok}</div>}
      <ul className="pane-list">
        {roles.map((role) => (
          <RoleRow key={role.roleId} role={role} editing={editingId === role.roleId} busy={busy}
            onEdit={() => setEditingId(role.roleId)} onCancel={() => setEditingId(null)}
            onSave={(nextLabel, nextDescription) => void update(role.roleId, nextLabel, nextDescription)}
            onDelete={() => void remove(role.roleId)} />
        ))}
      </ul>
      <div className="pane-form role-create">
        <input placeholder="role id (如 logistics)" value={id} disabled={busy}
          onChange={(event) => setId(event.target.value)} />
        <input placeholder="显示名 (如 物流)" value={label} disabled={busy}
          onChange={(event) => setLabel(event.target.value)} />
        <input placeholder="描述（可选）" value={description} disabled={busy}
          onChange={(event) => setDescription(event.target.value)} />
        <button className="btn-primary" onClick={() => void create()}
          disabled={busy || !id.trim() || !label.trim()}>新建角色</button>
      </div>
    </div>
  );
}
