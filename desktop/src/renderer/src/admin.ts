// Typed admin client over the generic AdminReq IPC channel. Each helper unwraps
// AdminResp: returns data on ok, throws the server error otherwise.
import type { AdminReq, AdminResp } from "../../shared/contract";

export interface Role { roleId: string; label: string; description: string }
export interface Rule { match: string[]; roleId: string }
export interface Domain { domainId: string; label: string }
export interface Grant { domainId: string; subject: string }
export interface Skill {
  tenantId: string; skillId: string; name: string; description: string;
  playbookMd: string; allowedTools: string[]; dataDomains: string[];
  roles: string[]; sourceTemplateId?: string;
}
export interface ToolInfo { name: string; description: string; dataDomain?: string }
export interface Template {
  templateId: string; name: string; description: string;
  playbookMd: string; allowedTools: string[]; dataDomains: string[];
  suggestedRoles: string[];
}

type AdminFn = (req: AdminReq) => Promise<AdminResp>;

export function makeAdminClient(admin: AdminFn, userId: string) {
  async function call<T>(method: AdminReq["method"], path: string, body?: unknown): Promise<T> {
    const resp = await admin({ method, path, userId, ...(body !== undefined ? { body } : {}) });
    if (!resp.ok) throw new Error(resp.error || `HTTP ${resp.status}`);
    return resp.data as T;
  }
  return {
    listTools: () => call<ToolInfo[]>("GET", "/admin/tools"),
    listRoles: () => call<Role[]>("GET", "/admin/roles"),
    createRole: (r: Role) => call<void>("POST", "/admin/roles", r),
    updateRole: (id: string, label: string, description: string) =>
      call<void>("PUT", `/admin/roles/${id}`, { label, description }),
    deleteRole: (id: string) => call<void>("DELETE", `/admin/roles/${id}`),
    getRules: () => call<Rule[]>("GET", "/admin/rules"),
    putRules: (rules: Rule[]) => call<void>("PUT", "/admin/rules", rules),
    listSkills: () => call<Skill[]>("GET", "/admin/skills"),
    listTemplates: () => call<Template[]>("GET", "/admin/templates"),
    createBlankSkill: (skill: Skill) => call<void>("POST", "/admin/skills", { skill }),
    cloneTemplate: (templateId: string) => call<void>("POST", "/admin/skills", { templateId }),
    updateSkill: (id: string, skill: Skill) => call<void>("PUT", `/admin/skills/${id}`, skill),
    deleteSkill: (id: string) => call<void>("DELETE", `/admin/skills/${id}`),
    listDomains: () => call<{ domains: Domain[]; grants: Grant[] }>("GET", "/admin/domains"),
    addGrant: (d: string, subject: string) => call<void>("POST", `/admin/domains/${d}/grants`, { subject }),
    removeGrant: (d: string, subject: string) => call<void>("DELETE", `/admin/domains/${d}/grants`, { subject }),
  };
}
export type AdminClient = ReturnType<typeof makeAdminClient>;
