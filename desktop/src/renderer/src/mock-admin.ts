import type { AdminReq, AdminResp } from "../../shared/contract";
import type { Domain, Grant, Role, Rule, Skill, Template, ToolInfo } from "./admin";

const TENANT_ID = "mock-corp-001";
const ADMINS = new Set(["u_smgr", "u_boss"]);

const SEED_ROLES: Role[] = [
  { roleId: "manager_tier", label: "管理层", description: "经理/主管/总监等" },
  { roleId: "sales", label: "销售", description: "销售/业务/外贸" },
  { roleId: "purchasing", label: "采购", description: "" },
  { roleId: "planner", label: "计划员", description: "PMC/排产" },
  { roleId: "qc", label: "质检", description: "QC/品控" },
  { roleId: "finance", label: "财务", description: "财务/会计/出纳" },
  { roleId: "staff", label: "员工", description: "默认兜底角色" },
];

const SEED_RULES: Rule[] = [
  { match: ["经理", "主管", "总监", "厂长", "负责人", "总经理"], roleId: "manager_tier" },
  { match: ["销售", "业务", "外贸", "BD"], roleId: "sales" },
  { match: ["采购"], roleId: "purchasing" },
  { match: ["计划", "PMC", "排产"], roleId: "planner" },
  { match: ["质检", "QC", "IQC", "IPQC", "OQC", "品控"], roleId: "qc" },
  { match: ["财务", "会计", "出纳"], roleId: "finance" },
];

const SEED_DOMAINS: Domain[] = [
  { domainId: "cost", label: "成本" },
  { domainId: "pricing", label: "定价" },
];

const SEED_GRANTS: Grant[] = [
  { domainId: "cost", subject: "user:u_fin" },
  { domainId: "cost", subject: "department:mock-corp-001/d_sales#manager" },
  { domainId: "cost", subject: "department:mock-corp-001/d_root#manager" },
];

const SEED_TOOLS: ToolInfo[] = [
  { name: "query_order_status", description: "查询订单进度/交期", dataDomain: "orders" },
  { name: "query_order_financials", description: "查询订单成本/利润", dataDomain: "cost" },
  { name: "check_material_kitting", description: "查询齐套/欠料", dataDomain: "orders" },
  { name: "query_customer_orders", description: "查询客户订单", dataDomain: "orders" },
  { name: "query_customer_contacts", description: "查询客户联系人", dataDomain: "customer" },
  { name: "query_customer_followups", description: "查询客户跟进", dataDomain: "customer" },
  { name: "query_customer_opportunities", description: "查询客户商机", dataDomain: "customer" },
];

const ORDER_PLAYBOOK = "当用户问某订单情况时：\n1. query_order_status 取状态/交期/客户\n2. check_material_kitting 看齐套欠料\n3. 若用户有财务权限，query_order_financials 补成本/利润\n4. 汇总成话；欠料且临近交期→标红预警";

const SEED_TEMPLATES: Template[] = [{
  templateId: "order-360",
  name: "订单360",
  description: "查订单全景：进度/交期/齐套/财务（财务按权限展示）",
  playbookMd: ORDER_PLAYBOOK,
  allowedTools: ["query_order_status", "query_order_financials", "check_material_kitting"],
  dataDomains: ["cost", "pricing"],
  suggestedRoles: ["sales", "manager_tier"],
}];

const SEED_SKILLS: Skill[] = [
  {
    tenantId: TENANT_ID,
    skillId: "order360",
    name: "订单360",
    description: "查订单全景：进度/交期/齐套/财务（财务按权限展示）",
    playbookMd: ORDER_PLAYBOOK,
    allowedTools: ["query_order_status", "query_order_financials", "check_material_kitting"],
    dataDomains: ["cost", "pricing"],
    roles: ["sales", "manager_tier"],
    sourceTemplateId: "order-360",
  },
  {
    tenantId: TENANT_ID,
    skillId: "customer360",
    name: "客户360",
    description: "跨 ERP+CRM 拼客户全景：订单+联系人+跟进+商机",
    playbookMd: "查询客户订单、联系人、最近跟进和商机，并汇总成客户档案卡。",
    allowedTools: [
      "query_customer_orders",
      "query_customer_contacts",
      "query_customer_followups",
      "query_customer_opportunities",
    ],
    dataDomains: [],
    roles: ["sales", "manager_tier"],
  },
];

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ok(data: unknown = undefined): AdminResp {
  return { ok: true, data };
}

function fail(status: number, error: string): AdminResp {
  return { ok: false, status, error };
}

function validID(id: string): boolean {
  return id !== "" && !/[\s:#]/u.test(id);
}

function validSubject(subject: string): boolean {
  return /^[^\s:#]+:[^\s:#]+(?:#[^\s:#]+)?$/u.test(subject);
}

export function createMockAdmin(): (req: AdminReq) => Promise<AdminResp> {
  let roles = copy(SEED_ROLES);
  let rules = copy(SEED_RULES);
  let skills = copy(SEED_SKILLS);
  const templates = copy(SEED_TEMPLATES);
  const tools = copy(SEED_TOOLS);
  const domains = copy(SEED_DOMAINS);
  let grants = copy(SEED_GRANTS);

  return async (req: AdminReq): Promise<AdminResp> => {
    if (!ADMINS.has(req.userId)) return fail(403, "admin only");

    const rolePath = req.path.match(/^\/admin\/roles\/([^/]+)$/u);
    const skillPath = req.path.match(/^\/admin\/skills\/([^/]+)$/u);
    const grantPath = req.path.match(/^\/admin\/domains\/([^/]+)\/grants$/u);

    if (req.method === "GET" && req.path === "/admin/tools") return ok(copy(tools));
    if (req.method === "GET" && req.path === "/admin/roles") return ok(copy(roles));
    if (req.method === "POST" && req.path === "/admin/roles") {
      const role = req.body as Role;
      if (!role?.roleId || !role.label) return fail(400, "role id and label required");
      if (!validID(role.roleId)) return fail(400, "invalid role id");
      if (roles.some((item) => item.roleId === role.roleId)) return fail(400, "role already exists");
      roles = [...roles, { ...copy(role), description: role.description ?? "" }];
      return ok();
    }
    if (req.method === "PUT" && rolePath) {
      const roleId = decodeURIComponent(rolePath[1]);
      const body = req.body as Pick<Role, "label" | "description">;
      const index = roles.findIndex((item) => item.roleId === roleId);
      if (index < 0) return fail(404, "role not found");
      if (!body?.label) return fail(400, "role label required");
      roles = roles.map((item, i) => i === index
        ? { ...item, label: body.label, description: body.description ?? "" }
        : item);
      return ok();
    }
    if (req.method === "DELETE" && rolePath) {
      const roleId = decodeURIComponent(rolePath[1]);
      const subject = `role:${TENANT_ID}/${roleId}#assignee`;
      roles = roles.filter((item) => item.roleId !== roleId);
      rules = rules.filter((item) => item.roleId !== roleId);
      skills = skills.map((item) => ({ ...item, roles: item.roles.filter((id) => id !== roleId) }));
      grants = grants.filter((item) => item.subject !== subject);
      return ok();
    }

    if (req.method === "GET" && req.path === "/admin/rules") return ok(copy(rules));
    if (req.method === "PUT" && req.path === "/admin/rules") {
      rules = copy(req.body as Rule[]);
      return ok();
    }

    if (req.method === "GET" && req.path === "/admin/templates") return ok(copy(templates));
    if (req.method === "GET" && req.path === "/admin/skills") return ok(copy(skills));
    if (req.method === "POST" && req.path === "/admin/skills") {
      const body = req.body as { skill?: Skill; templateId?: string };
      if (body?.skill) {
        if (!body.skill.skillId || !body.skill.name) return fail(400, "skill id and name required");
        if (!validID(body.skill.skillId)) return fail(400, "invalid skill id");
        if (skills.some((item) => item.skillId === body.skill!.skillId)) return fail(400, "skill already exists");
        skills = [...skills, { ...copy(body.skill), tenantId: TENANT_ID }];
        return ok();
      }
      const template = templates.find((item) => item.templateId === body?.templateId);
      if (!template) return fail(400, "template not found");
      let skillId = template.templateId;
      for (let suffix = 1; skills.some((item) => item.skillId === skillId); suffix++) {
        skillId = `${template.templateId}-${suffix}`;
      }
      skills = [...skills, {
        tenantId: TENANT_ID,
        skillId,
        name: template.name,
        description: template.description,
        playbookMd: template.playbookMd,
        allowedTools: copy(template.allowedTools),
        dataDomains: copy(template.dataDomains),
        roles: copy(template.suggestedRoles),
        sourceTemplateId: template.templateId,
      }];
      return ok();
    }
    if (req.method === "PUT" && skillPath) {
      const skillId = decodeURIComponent(skillPath[1]);
      const index = skills.findIndex((item) => item.skillId === skillId);
      if (index < 0) return fail(404, "skill not found");
      const skill = req.body as Skill;
      if (!skill?.name) return fail(400, "skill name required");
      skills = skills.map((item, i) => i === index
        ? { ...copy(skill), tenantId: TENANT_ID, skillId }
        : item);
      return ok();
    }
    if (req.method === "DELETE" && skillPath) {
      const skillId = decodeURIComponent(skillPath[1]);
      skills = skills.filter((item) => item.skillId !== skillId);
      return ok();
    }

    if (req.method === "GET" && req.path === "/admin/domains") {
      return ok({ domains: copy(domains), grants: copy(grants) });
    }
    if ((req.method === "POST" || req.method === "DELETE") && grantPath) {
      const domainId = decodeURIComponent(grantPath[1]);
      const { subject } = req.body as { subject?: string };
      if (!domains.some((item) => item.domainId === domainId)) return fail(404, "domain not found");
      if (!subject || !validSubject(subject)) return fail(400, "invalid subject");
      if (req.method === "POST" && !grants.some((item) => item.domainId === domainId && item.subject === subject)) {
        grants = [...grants, { domainId, subject }];
      }
      if (req.method === "DELETE") {
        grants = grants.filter((item) => item.domainId !== domainId || item.subject !== subject);
      }
      return ok();
    }

    return fail(404, "not found");
  };
}
