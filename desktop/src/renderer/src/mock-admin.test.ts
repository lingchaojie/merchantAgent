import { describe, expect, it } from "vitest";
import type { Grant, Role, Rule, Skill } from "./admin";
import { createMockAdmin } from "./mock-admin";

const adminUser = "u_boss";

describe("browser admin mock", () => {
  it("rejects non-admin callers", async () => {
    const admin = createMockAdmin();

    expect(await admin({ method: "GET", path: "/admin/roles", userId: "u_sales1" }))
      .toMatchObject({ ok: false, status: 403 });
  });

  it("persists role updates and deletes their references", async () => {
    const admin = createMockAdmin();
    await admin({
      method: "POST",
      path: "/admin/roles",
      userId: adminUser,
      body: { roleId: "logistics", label: "物流", description: "发运" },
    });
    await admin({
      method: "PUT",
      path: "/admin/roles/logistics",
      userId: adminUser,
      body: { label: "物流主管", description: "发运管理" },
    });

    const listed = await admin({ method: "GET", path: "/admin/roles", userId: adminUser });
    expect(listed.ok && (listed.data as Role[])).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: "logistics", label: "物流主管", description: "发运管理" }),
    ]));

    await admin({
      method: "PUT",
      path: "/admin/rules",
      userId: adminUser,
      body: [{ match: ["物流"], roleId: "logistics" }],
    });
    await admin({ method: "DELETE", path: "/admin/roles/logistics", userId: adminUser });
    const afterDelete = await admin({ method: "GET", path: "/admin/rules", userId: adminUser });
    expect(afterDelete.ok && afterDelete.data).toEqual([]);
  });

  it("persists ordered rules and both skill creation paths", async () => {
    const admin = createMockAdmin();
    const rules: Rule[] = [
      { match: ["物流"], roleId: "staff" },
      { match: ["销售"], roleId: "sales" },
    ];
    const skill: Skill = {
      tenantId: "mock-corp-001",
      skillId: "shipping",
      name: "物流",
      description: "",
      playbookMd: "",
      allowedTools: [],
      dataDomains: [],
      roles: [],
    };

    await admin({ method: "PUT", path: "/admin/rules", userId: adminUser, body: rules });
    await admin({ method: "POST", path: "/admin/skills", userId: adminUser, body: { skill } });
    await admin({
      method: "POST",
      path: "/admin/skills",
      userId: adminUser,
      body: { templateId: "order-360" },
    });

    const gotRules = await admin({ method: "GET", path: "/admin/rules", userId: adminUser });
    const gotSkills = await admin({ method: "GET", path: "/admin/skills", userId: adminUser });
    expect(gotRules.ok && gotRules.data).toEqual(rules);
    expect(gotSkills.ok && (gotSkills.data as Skill[])).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: "shipping" }),
      expect.objectContaining({ sourceTemplateId: "order-360" }),
    ]));
  });

  it("adds and removes a valid data-domain grant", async () => {
    const admin = createMockAdmin();
    const subject = "role:mock-corp-001/staff#assignee";

    await admin({
      method: "POST",
      path: "/admin/domains/cost/grants",
      userId: adminUser,
      body: { subject },
    });
    const afterAdd = await admin({ method: "GET", path: "/admin/domains", userId: adminUser });
    expect(afterAdd.ok && (afterAdd.data as { grants: Grant[] }).grants).toEqual(expect.arrayContaining([
      { domainId: "cost", subject },
    ]));

    await admin({
      method: "DELETE",
      path: "/admin/domains/cost/grants",
      userId: adminUser,
      body: { subject },
    });
    const afterRemove = await admin({ method: "GET", path: "/admin/domains", userId: adminUser });
    expect(afterRemove.ok && (afterRemove.data as { grants: Grant[] }).grants)
      .not.toEqual(expect.arrayContaining([{ domainId: "cost", subject }]));
  });
});
