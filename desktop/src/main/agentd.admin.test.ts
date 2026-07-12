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

describe("client connector lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches a member approval with exact connector identity", async () => {
    const fetch = vi.fn().mockResolvedValue(textResponse(200, JSON.stringify({
      connectorId: "sql-orders",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      status: "published",
    })));
    vi.stubGlobal("fetch", fetch);

    const approval = await client.getConnectorApproval("tenant-1", "user-1", "sql-orders", "1.0.0");

    expect(approval).toMatchObject({ status: "published" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/connectors/sql-orders/versions/1.0.0/approval"),
      expect.objectContaining({ headers: { "x-user-id": "user-1" } }),
    );
  });

  it("returns null for a missing approval and rejects open response objects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(textResponse(404, "not found")));
    await expect(client.getConnectorApproval("tenant-1", "user-1", "sql-orders", "1.0.0")).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse(200, JSON.stringify({
      connectorId: "sql-orders",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      status: "published",
      privateConfig: "leak",
    }))));
    await expect(client.getConnectorApproval("tenant-1", "user-1", "sql-orders", "1.0.0"))
      .rejects.toThrow("approval_unavailable");
  });

  it("submits only the public version and attestation with implementation auth", async () => {
    const fetch = vi.fn().mockResolvedValue(textResponse(201, JSON.stringify({
      digest: `sha256:${"a".repeat(64)}`,
      status: "pending_admin_approval",
    })));
    vi.stubGlobal("fetch", fetch);
    const body = {
      version: { connectorId: "sql-orders", version: "1.0.0" },
      signedAt: "2026-07-13T10:00:00Z",
      implementationSignature: "signature",
    };

    await expect(client.submitConnector("credential", body as never)).resolves.toMatchObject({
      status: "pending_admin_approval",
    });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/implementation/connectors"), expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Implementation credential" },
    }));
  });
});
