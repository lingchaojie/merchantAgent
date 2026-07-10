import { useState, useEffect, useCallback } from "react";
import type { AdminClient, Domain, Grant } from "../../admin";

// Raw view of data-domain grants (闸 B). Each grant is a subject → domain edge in
// OpenFGA. Role subjects use the form role:<tenant>/<roleId>#assignee (see the
// hint below); free-text subjects (e.g. a specific user) are also allowed.
export function DomainsPane({ client, tenantId }: { client: AdminClient; tenantId: string }): JSX.Element {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [sel, setSel] = useState("");
  const [subject, setSubject] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    client.listDomains().then((d) => {
      setDomains(d.domains); setGrants(d.grants);
      setSel((s) => s || d.domains[0]?.domainId || "");
    }).catch((e) => setErr(String(e)));
  }, [client]);
  useEffect(load, [load]);

  const add = async () => {
    setErr("");
    try {
      await client.addGrant(sel, subject);
      setSubject(""); load();
    } catch (e) { setErr(String(e)); }
  };
  const remove = async (domainId: string, subj: string) => {
    setErr("");
    try {
      await client.removeGrant(domainId, subj);
      load();
    } catch (e) { setErr(String(e)); }
  };

  return (
    <div className="pane">
      <h3 className="pane-title">数据域</h3>
      <div className="pane-caption">
        角色授予格式：<code>role:{tenantId}/&lt;roleId&gt;#assignee</code>（也可直接授予某个用户）。
      </div>
      {err && <div className="pane-err">{err}</div>}
      {domains.map((d) => (
        <div key={d.domainId} className="domain-block">
          <div className="domain-head"><b>{d.label}</b> <code>{d.domainId}</code></div>
          <ul className="pane-list">
            {grants.filter((g) => g.domainId === d.domainId).map((g) => (
              <li key={g.subject} className="pane-row">
                <code>{g.subject}</code>
                <button className="btn-danger" onClick={() => remove(d.domainId, g.subject)}>删除</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="pane-form">
        <select value={sel} onChange={(e) => setSel(e.target.value)}>
          {domains.map((d) => (
            <option key={d.domainId} value={d.domainId}>{d.label}</option>
          ))}
        </select>
        <input placeholder="subject (如 role:tenant/finance#assignee)" value={subject}
          onChange={(e) => setSubject(e.target.value)} />
        <button className="btn-primary" onClick={add} disabled={!sel || !subject}>添加授予</button>
      </div>
    </div>
  );
}
