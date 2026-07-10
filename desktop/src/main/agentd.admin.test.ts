import { describe, it, expect, vi, afterEach } from "vitest";
import { client } from "./agentd";

// Build a fetch Response-like with a given status and text body. adminRequest
// reads the body via res.text(), so json() is not needed here.
function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("client.adminRequest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns {ok:true,status,data} on an ok JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(200, JSON.stringify([{ roleId: "sales" }]))),
    );
    const r = await client.adminRequest({ method: "GET", path: "/admin/roles", userId: "u_boss" });
    expect(r).toEqual({ ok: true, status: 200, data: [{ roleId: "sales" }] });
  });

  it("returns {ok:false,status,error} using the JSON error field on non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(403, JSON.stringify({ error: "admin only" }))),
    );
    const r = await client.adminRequest({ method: "GET", path: "/admin/roles", userId: "u_sales1" });
    expect(r).toEqual({ ok: false, status: 403, error: "admin only" });
  });

  it("returns {ok:false,status:0,error} when fetch rejects (network failure), never throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const r = await client.adminRequest({ method: "GET", path: "/admin/roles", userId: "u_boss" });
    expect(r).toEqual({ ok: false, status: 0, error: "ECONNREFUSED" });
  });
});
