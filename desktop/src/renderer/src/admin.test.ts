import { describe, it, expect, vi } from "vitest";
import { makeAdminClient } from "./admin";

describe("admin client", () => {
  it("listRoles unwraps AdminResp data", async () => {
    const admin = vi.fn().mockResolvedValue({ ok: true, data: [{ roleId: "sales", label: "销售" }] });
    const c = makeAdminClient(admin, "u_boss");
    const roles = await c.listRoles();
    expect(roles[0].roleId).toBe("sales");
    expect(admin).toHaveBeenCalledWith({ method: "GET", path: "/admin/roles", userId: "u_boss" });
  });

  it("throws on AdminResp error", async () => {
    const admin = vi.fn().mockResolvedValue({ ok: false, status: 403, error: "admin only" });
    const c = makeAdminClient(admin, "u_sales1");
    await expect(c.listRoles()).rejects.toThrow("admin only");
  });

  it("builds typed blank-skill and template-clone requests", async () => {
    const admin = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const client = makeAdminClient(admin, "u_boss");
    const skill = {
      tenantId: "mock-corp-001",
      skillId: "shipping",
      name: "物流",
      description: "",
      playbookMd: "",
      allowedTools: [],
      dataDomains: [],
      roles: [],
    };

    await client.createBlankSkill(skill);
    await client.cloneTemplate("order-360");
    await client.deleteSkill("shipping");

    expect(admin).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/admin/skills",
      userId: "u_boss",
      body: { skill },
    });
    expect(admin).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/admin/skills",
      userId: "u_boss",
      body: { templateId: "order-360" },
    });
    expect(admin).toHaveBeenNthCalledWith(3, {
      method: "DELETE",
      path: "/admin/skills/shipping",
      userId: "u_boss",
    });
  });
});
