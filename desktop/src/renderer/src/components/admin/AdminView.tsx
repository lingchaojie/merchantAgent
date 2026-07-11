import { useState, useEffect } from "react";
import type { AdminClient } from "../../admin";
import { RolesPane } from "./RolesPane";
import { RulesPane } from "./RulesPane";
import { SkillsPane } from "./SkillsPane";
import { AssignPane } from "./AssignPane";
import { DomainsPane } from "./DomainsPane";

type Tab = "roles" | "rules" | "skills" | "assign" | "domains";
const TABS: { id: Tab; label: string }[] = [
  { id: "roles", label: "角色" }, { id: "rules", label: "职位映射" },
  { id: "skills", label: "技能" }, { id: "assign", label: "分配" },
  { id: "domains", label: "数据域" },
];

export function AdminView({ client, tenantId }: { client: AdminClient; tenantId: string }): JSX.Element {
  const [tab, setTab] = useState<Tab>("roles");
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    client.listRoles().then(() => setDenied(false)).catch((e) =>
      setDenied(String(e).includes("admin") || String(e).includes("403")));
  }, [client]);

  if (denied) {
    return <div className="admin-denied">需要管理员权限。请在左下角切换到管理员身份（如"老板"）。</div>;
  }
  return (
    <div className="admin">
      <nav className="admin-nav">
        {TABS.map((t) => (
          <button key={t.id} className={"admin-tab" + (t.id === tab ? " active" : "")} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="admin-body">
        {tab === "roles" && <RolesPane client={client} />}
        {tab === "rules" && <RulesPane client={client} />}
        {tab === "skills" && <SkillsPane client={client} tenantId={tenantId} />}
        {tab === "assign" && <AssignPane client={client} tenantId={tenantId} />}
        {tab === "domains" && <DomainsPane client={client} tenantId={tenantId} />}
      </div>
    </div>
  );
}
