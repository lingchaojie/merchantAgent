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
});
