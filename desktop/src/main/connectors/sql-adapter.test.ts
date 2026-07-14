import fs from "node:fs";
import path from "node:path";

import * as mssql from "mssql";
import { describe, expect, it, vi } from "vitest";

import type { CredentialVault } from "./credential-vault";
import type { SQLReadOperation, SQLServerProfile } from "./schema";
import { SQLServerAdapter, type SQLPoolFactory } from "./sql-adapter";

function fixtureProfile(overrides: Partial<SQLServerProfile> = {}): SQLServerProfile {
  return {
    profileId: "erp-test",
    server: "sql.test.internal",
    port: 1433,
    database: "merchant_test",
    encrypt: true,
    trustServerCertificate: false,
    connectTimeoutMS: 5_000,
    queryTimeoutMS: 8_000,
    credentialRef: "erp-test-credential",
    environment: "test",
    ...overrides,
  };
}

function fixtureReadOperation(overrides: Partial<SQLReadOperation> = {}): SQLReadOperation {
  return {
    kind: "read",
    tool: "query_order_status",
    sql: [
      "SELECT TOP 2 o.order_id AS order_id, o.status AS order_status",
      "FROM dbo.production_orders AS o",
      "WHERE o.order_id = @orderId",
      "ORDER BY o.order_id ASC",
    ].join(" "),
    bindings: [
      { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 },
    ],
    projection: [
      { sourceAlias: "order_id", resultField: "orderId", type: "string" },
      { sourceAlias: "order_status", resultField: "status", type: "string" },
    ],
    declaredObjects: ["dbo.production_orders"],
    maxResults: 2,
    timeoutMS: 3_000,
    ...overrides,
  };
}

interface FakeRequest {
  input: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

interface FakePool {
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeRequest(result: unknown = { recordset: [] }): FakeRequest {
  const request: FakeRequest = {
    input: vi.fn(),
    query: vi.fn().mockResolvedValue(result),
    cancel: vi.fn(),
  };
  request.input.mockReturnValue(request);
  return request;
}

function fakePool(request = fakeRequest()): FakePool {
  return {
    request: vi.fn().mockReturnValue(request),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeVault(credential: { username: string; password: string } | null = {
  username: "agent_test",
  password: "test-only-password",
}): CredentialVault {
  return {
    put: vi.fn(),
    get: vi.fn().mockResolvedValue(credential),
    remove: vi.fn(),
    listRefs: vi.fn(),
  };
}

function factoryFor(...outcomes: Array<FakePool | Error>): SQLPoolFactory & { open: ReturnType<typeof vi.fn> } {
  const open = vi.fn();
  for (const outcome of outcomes) {
    if (outcome instanceof Error) open.mockRejectedValueOnce(outcome);
    else open.mockResolvedValueOnce(outcome as unknown as mssql.ConnectionPool);
  }
  return { open };
}

function driverError(name: string, code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("Login failed for sql.internal; password=S3cret"), { name, code }, extra);
}

describe("SQLServerAdapter.executeRead", () => {
  it("returns bounded raw rows only through the explicit Workbench method", async () => {
    const request = fakeRequest({
      recordset: [
        { order_id: "ORD-1001", order_status: "queued", internal_cost: 900 },
        { order_id: "ORD-1002", order_status: "queued", internal_cost: 800 },
      ],
    });
    const pool = fakePool(request);
    const adapter = new SQLServerAdapter(fixtureProfile(), fakeVault(), factoryFor(pool));

    const result = await adapter.executeWorkbenchRead(fixtureReadOperation(), { orderId: "ORD-1001" });

    expect(result.raw).toEqual([
      { order_id: "ORD-1001", order_status: "queued", internal_cost: 900 },
      { order_id: "ORD-1002", order_status: "queued", internal_cost: 800 },
    ]);
    expect(result.projected).toEqual([
      { orderId: "ORD-1001", status: "queued" },
      { orderId: "ORD-1002", status: "queued" },
    ]);
    expect(pool.close).toHaveBeenCalledOnce();
  });

  it("strips non-enumerable node-mssql recordset metadata before snapshotting raw rows", async () => {
    const recordset = [{ order_id: "ORD-1001", order_status: "queued", internal_cost: 900 }];
    Object.defineProperty(recordset, "columns", { value: { order_id: {} }, enumerable: false });
    Object.defineProperty(recordset, "toTable", { value: () => undefined, enumerable: false });
    const adapter = new SQLServerAdapter(
      fixtureProfile(),
      fakeVault(),
      factoryFor(fakePool(fakeRequest({ recordset }))),
    );

    await expect(adapter.executeWorkbenchRead(fixtureReadOperation(), { orderId: "ORD-1001" }))
      .resolves.toEqual({
        raw: [{ order_id: "ORD-1001", order_status: "queued", internal_cost: 900 }],
        projected: [{ orderId: "ORD-1001", status: "queued" }],
      });
  });

  it("rejects enumerable recordset metadata instead of exposing it as raw data", async () => {
    const recordset = [{ order_id: "ORD-1001", order_status: "queued" }];
    Object.defineProperty(recordset, "unexpected", { value: "secret", enumerable: true });
    const adapter = new SQLServerAdapter(
      fixtureProfile(),
      fakeVault(),
      factoryFor(fakePool(fakeRequest({ recordset }))),
    );

    await expect(adapter.executeWorkbenchRead(fixtureReadOperation(), { orderId: "ORD-1001" }))
      .rejects.toMatchObject({ code: "failed" });
  });

  it("rejects a Workbench raw response above the byte ceiling and closes the pool", async () => {
    const request = fakeRequest({ recordset: [{
      order_id: "ORD-1001",
      order_status: "queued",
      internal_blob: "x".repeat(1024 * 1024),
    }] });
    const pool = fakePool(request);
    const adapter = new SQLServerAdapter(fixtureProfile(), fakeVault(), factoryFor(pool));

    await expect(adapter.executeWorkbenchRead(fixtureReadOperation(), { orderId: "ORD-1001" }))
      .rejects.toMatchObject({ code: "failed" });
    expect(pool.close).toHaveBeenCalledOnce();
  });

  it("binds typed values, executes validated SQL unchanged, and projects a bounded list", async () => {
    const request = fakeRequest({
      recordset: [
        { order_id: "ORD-1001", order_status: "in_production", secret_cost: 900 },
        { order_id: "ORD-1002", order_status: "queued", secret_cost: 800 },
      ],
    });
    const pool = fakePool(request);
    const pools = factoryFor(pool);
    const operation = fixtureReadOperation();
    const adapter = new SQLServerAdapter(fixtureProfile(), fakeVault(), pools);

    const result = await adapter.executeRead(operation, { orderId: "ORD-1001" });

    expect(result).toEqual([
      { orderId: "ORD-1001", status: "in_production" },
      { orderId: "ORD-1002", status: "queued" },
    ]);
    expect(request.input).toHaveBeenCalledOnce();
    expect(request.input).toHaveBeenCalledWith("orderId", expect.anything(), "ORD-1001");
    expect(request.query).toHaveBeenCalledWith(operation.sql);
    expect(JSON.stringify(result)).not.toContain("secret_cost");
    expect(pools.open).toHaveBeenCalledWith(expect.objectContaining({ requestTimeout: 3_000 }));
    expect(pool.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["zero", [], []],
    ["one", [{ order_id: "ORD-1001", order_status: "in_production" }], [{ orderId: "ORD-1001", status: "in_production" }]],
  ])("accepts %s source rows when maxResults is one", async (_name, recordset, expected) => {
    const request = fakeRequest({ recordset });
    const operation = fixtureReadOperation({
      maxResults: 1,
      sql: fixtureReadOperation().sql.replace("TOP 2", "TOP 1"),
    });

    await expect(new SQLServerAdapter(
      fixtureProfile(),
      fakeVault(),
      factoryFor(fakePool(request)),
    ).executeRead(operation, { orderId: "ORD-1001" })).resolves.toEqual(expected);
  });

  it("rejects source overflow before maxResults truncation", async () => {
    const request = fakeRequest({ recordset: [
      { order_id: "ORD-1001", order_status: "in_production" },
      { order_id: "ORD-1001", order_status: "duplicate" },
    ] });
    const operation = fixtureReadOperation({
      maxResults: 1,
      sql: fixtureReadOperation().sql.replace("TOP 2", "TOP 1"),
    });

    await expect(new SQLServerAdapter(
      fixtureProfile(),
      fakeVault(),
      factoryFor(fakePool(request)),
    ).executeRead(operation, { orderId: "ORD-1001" })).rejects.toMatchObject({ code: "source_rejected" });
  });

  it("rejects Workbench raw overflow before maxResults truncation", async () => {
    const request = fakeRequest({ recordset: [
      { order_id: "ORD-1001", order_status: "in_production", internal_cost: 900 },
      { order_id: "ORD-1001", order_status: "duplicate", internal_cost: 800 },
    ] });
    const operation = fixtureReadOperation({
      maxResults: 1,
      sql: fixtureReadOperation().sql.replace("TOP 2", "TOP 1"),
    });

    await expect(new SQLServerAdapter(
      fixtureProfile(),
      fakeVault(),
      factoryFor(fakePool(request)),
    ).executeWorkbenchRead(operation, { orderId: "ORD-1001" })).rejects.toMatchObject({ code: "source_rejected" });
  });

  it("resolves credentials immediately before each pool open", async () => {
    const events: string[] = [];
    const vault = fakeVault();
    vi.mocked(vault.get).mockImplementation(async () => {
      events.push("credential");
      return { username: "agent_test", password: "test-only-password" };
    });
    const pool = fakePool();
    const pools: SQLPoolFactory = {
      open: vi.fn().mockImplementation(async () => {
        events.push("open");
        return pool as unknown as mssql.ConnectionPool;
      }),
    };

    await new SQLServerAdapter(fixtureProfile(), vault, pools).executeRead(
      fixtureReadOperation(),
      { orderId: "ORD-1001" },
    );

    expect(events).toEqual(["credential", "open"]);
  });

  it("validates the AST immediately before opening a pool", async () => {
    const operation = fixtureReadOperation({
      sql: "SELECT * FROM dbo.production_orders; WAITFOR DELAY '00:00:05'",
    });
    const vault = fakeVault();
    const pools = factoryFor(fakePool());

    await expect(
      new SQLServerAdapter(fixtureProfile(), vault, pools).executeRead(operation, { orderId: "ORD-1001" }),
    ).rejects.toMatchObject({ code: "unsafe_template", message: "unsafe_template" });
    expect(vault.get).not.toHaveBeenCalled();
    expect(pools.open).not.toHaveBeenCalled();
  });

  it.each([
    ["missing argument", {}, "invalid_argument"],
    ["additional argument", { orderId: "ORD-1001", other: "value" }, "invalid_argument"],
    ["wrong string type", { orderId: 1001 }, "invalid_argument"],
    ["oversized string", { orderId: "x".repeat(65) }, "invalid_argument"],
  ])("rejects %s before credential resolution", async (_name, args, code) => {
    const vault = fakeVault();
    const pools = factoryFor(fakePool());

    await expect(
      new SQLServerAdapter(fixtureProfile(), vault, pools).executeRead(fixtureReadOperation(), args),
    ).rejects.toMatchObject({ code, message: code });
    expect(vault.get).not.toHaveBeenCalled();
  });

  it.each([
    ["symbol extra", () => {
      const args: Record<PropertyKey, unknown> = { orderId: "ORD-1001" };
      args[Symbol("hidden")] = "extra";
      return args as Record<string, unknown>;
    }],
    ["non-enumerable extra", () => {
      const args = { orderId: "ORD-1001" };
      Object.defineProperty(args, "hidden", { value: "extra", enumerable: false });
      return args;
    }],
    ["accessor value", () => {
      const args = {} as Record<string, unknown>;
      Object.defineProperty(args, "orderId", { get: () => "ORD-1001", enumerable: true });
      return args;
    }],
    ["inherited value", () => {
      const args = Object.create({ orderId: "ORD-1001" }) as Record<string, unknown>;
      return args;
    }],
    ["non-plain prototype", () => Object.assign(new Date(0), { orderId: "ORD-1001" }) as unknown as Record<string, unknown>],
    ["prototype pollution shape", () => {
      const args = Object.create({ polluted: true }) as Record<string, unknown>;
      args.orderId = "ORD-1001";
      return args;
    }],
  ] as Array<[string, () => Record<string, unknown>]>) (
    "rejects %s in the closed argument snapshot",
    async (_name, makeArgs) => {
      const vault = fakeVault();
      const pools = factoryFor(fakePool());

      await expect(
        new SQLServerAdapter(fixtureProfile(), vault, pools).executeRead(fixtureReadOperation(), makeArgs()),
      ).rejects.toMatchObject({ code: "invalid_argument", message: "invalid_argument" });
      expect(vault.get).not.toHaveBeenCalled();
      expect(pools.open).not.toHaveBeenCalled();
    },
  );

  it("binds integer arguments as Int", async () => {
    const operation = fixtureReadOperation({
      sql: "SELECT TOP 2 o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders AS o WHERE o.version = @version ORDER BY o.order_id ASC",
      bindings: [{ parameter: "version", argument: "version", type: "Int" }],
    });
    const request = fakeRequest();

    await new SQLServerAdapter(fixtureProfile(), fakeVault(), factoryFor(fakePool(request))).executeRead(
      operation,
      { version: 1 },
    );

    expect(request.input).toHaveBeenCalledWith("version", mssql.Int, 1);
  });

  it.each([
    ["missing NVarChar maxLength", { parameter: "orderId", argument: "orderId", type: "NVarChar" }],
    ["zero NVarChar maxLength", { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 0 }],
    ["oversized NVarChar maxLength", { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 4_001 }],
    ["Int maxLength", { parameter: "orderId", argument: "orderId", type: "Int", maxLength: 4 }],
  ])("rejects %s before credential lookup", async (_name, binding) => {
    const operation = fixtureReadOperation({ bindings: [binding as never] });
    const vault = fakeVault();

    await expect(
      new SQLServerAdapter(fixtureProfile(), vault, factoryFor(fakePool())).executeRead(
        operation,
        { orderId: binding.type === "Int" ? 1 : "ORD-1001" },
      ),
    ).rejects.toMatchObject({ code: "invalid_argument", message: "invalid_argument" });
    expect(vault.get).not.toHaveBeenCalled();
  });

  it("rejects malformed projected rows without returning driver values", async () => {
    const request = fakeRequest({ recordset: [{ order_id: "ORD-1001", order_status: 42 }] });

    await expect(
      new SQLServerAdapter(fixtureProfile(), fakeVault(), factoryFor(fakePool(request))).executeRead(
        fixtureReadOperation(),
        { orderId: "ORD-1001" },
      ),
    ).rejects.toMatchObject({ code: "failed", message: "failed" });
  });

  it("uses immutable operation and argument snapshots while a query is in flight", async () => {
    let resolveQuery!: (value: unknown) => void;
    const request = fakeRequest();
    request.query.mockReturnValue(new Promise((resolve) => {
      resolveQuery = resolve;
    }));
    const operation = fixtureReadOperation();
    const args = { orderId: "ORD-1001" };
    const execution = new SQLServerAdapter(
      fixtureProfile(),
      fakeVault(),
      factoryFor(fakePool(request)),
    ).executeRead(operation, args);
    await vi.waitFor(() => expect(request.query).toHaveBeenCalledOnce());

    operation.projection = [
      { sourceAlias: "secret_cost", resultField: "secretCost", type: "integer" },
    ];
    operation.maxResults = 3;
    args.orderId = "ORD-CHANGED";
    resolveQuery({
      recordset: [
        { order_id: "ORD-1001", order_status: "ready", secret_cost: 900 },
        { order_id: "ORD-1002", order_status: "queued", secret_cost: 800 },
      ],
    });

    await expect(execution).resolves.toEqual([
      { orderId: "ORD-1001", status: "ready" },
      { orderId: "ORD-1002", status: "queued" },
    ]);
    expect(request.input).toHaveBeenCalledWith("orderId", expect.anything(), "ORD-1001");
  });

  it("retries exactly once for a transient connection failure and closes both pools", async () => {
    const firstRequest = fakeRequest();
    firstRequest.query.mockRejectedValue(driverError("ConnectionError", "ESOCKET"));
    const firstPool = fakePool(firstRequest);
    const secondPool = fakePool(fakeRequest({ recordset: [{ order_id: "ORD-1001", order_status: "ready" }] }));
    const vault = fakeVault();
    const pools = factoryFor(firstPool, secondPool);

    const result = await new SQLServerAdapter(fixtureProfile(), vault, pools).executeRead(
      fixtureReadOperation(),
      { orderId: "ORD-1001" },
    );

    expect(result).toEqual([{ orderId: "ORD-1001", status: "ready" }]);
    expect(pools.open).toHaveBeenCalledTimes(2);
    expect(vault.get).toHaveBeenCalledTimes(2);
    expect(firstPool.close).toHaveBeenCalledOnce();
    expect(secondPool.close).toHaveBeenCalledOnce();
  });

  it("stops after one retry when transient connection failures continue", async () => {
    const pools = factoryFor(
      driverError("ConnectionError", "ETIMEOUT"),
      driverError("ConnectionError", "ECONNCLOSED"),
    );

    await expect(
      new SQLServerAdapter(fixtureProfile(), fakeVault(), pools).executeRead(
        fixtureReadOperation(),
        { orderId: "ORD-1001" },
      ),
    ).rejects.toMatchObject({ code: "connection_failed", message: "connection_failed" });
    expect(pools.open).toHaveBeenCalledTimes(2);
  });

  it("does not retry request timeouts or authentication failures", async () => {
    for (const failure of [
      driverError("RequestError", "ETIMEOUT"),
      driverError("ConnectionError", "ELOGIN"),
    ]) {
      const pools = factoryFor(failure, fakePool());
      await expect(
        new SQLServerAdapter(fixtureProfile(), fakeVault(), pools).executeRead(
          fixtureReadOperation(),
          { orderId: "ORD-1001" },
        ),
      ).rejects.toMatchObject({
        code: (failure as Error & { code?: string }).code === "ELOGIN" ? "invalid_credentials" : "failed",
      });
      expect(pools.open).toHaveBeenCalledOnce();
    }
  });

  it.each([
    [driverError("ConnectionError", "ELOGIN"), "invalid_credentials"],
    [driverError("ConnectionError", "ESOCKET", { originalError: { code: "CERT_HAS_EXPIRED" } }), "tls_failed"],
    [driverError("RequestError", "EREQUEST", { number: 229 }), "permission_denied"],
    [new Error("Login failed for sql.internal; password=S3cret"), "failed"],
  ])("normalizes driver failures without source details", async (failure, code) => {
    const pools = factoryFor(failure);

    let caught: unknown;
    try {
      await new SQLServerAdapter(fixtureProfile(), fakeVault(), pools).executeRead(
        fixtureReadOperation(),
        { orderId: "ORD-1001" },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code, message: code });
    expect(JSON.stringify(caught)).not.toContain("sql.internal");
    expect(JSON.stringify(caught)).not.toContain("S3cret");
  });

  it("reports a missing credential without opening a pool", async () => {
    const pools = factoryFor(fakePool());

    await expect(
      new SQLServerAdapter(fixtureProfile(), fakeVault(null), pools).executeRead(
        fixtureReadOperation(),
        { orderId: "ORD-1001" },
      ),
    ).rejects.toMatchObject({ code: "missing_credentials", message: "missing_credentials" });
    expect(pools.open).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request on abort, closes the pool, and does not retry", async () => {
    const controller = new AbortController();
    const request = fakeRequest();
    request.query.mockImplementation(() => new Promise(() => undefined));
    const pool = fakePool(request);
    const pools = factoryFor(pool, fakePool());
    const execution = new SQLServerAdapter(fixtureProfile(), fakeVault(), pools).executeRead(
      fixtureReadOperation(),
      { orderId: "ORD-1001" },
      controller.signal,
    );

    await vi.waitFor(() => expect(request.query).toHaveBeenCalledOnce());
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: "failed", message: "failed" });
    expect(request.cancel).toHaveBeenCalledOnce();
    expect(pool.close).toHaveBeenCalledOnce();
    expect(pools.open).toHaveBeenCalledOnce();
  });

  it("does not resolve credentials when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const vault = fakeVault();

    await expect(
      new SQLServerAdapter(fixtureProfile(), vault, factoryFor(fakePool())).executeRead(
        fixtureReadOperation(),
        { orderId: "ORD-1001" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "failed", message: "failed" });
    expect(vault.get).not.toHaveBeenCalled();
  });

  it("returns promptly when aborted during pool open and closes a pool that opens later", async () => {
    const controller = new AbortController();
    const pool = fakePool();
    let resolvePool!: (value: mssql.ConnectionPool) => void;
    const pools: SQLPoolFactory & { open: ReturnType<typeof vi.fn> } = {
      open: vi.fn().mockReturnValue(new Promise<mssql.ConnectionPool>((resolve) => {
        resolvePool = resolve;
      })),
    };
    const execution = new SQLServerAdapter(fixtureProfile(), fakeVault(), pools).executeRead(
      fixtureReadOperation(),
      { orderId: "ORD-1001" },
      controller.signal,
    );
    await vi.waitFor(() => expect(pools.open).toHaveBeenCalledOnce());

    controller.abort();
    const outcome = await Promise.race([
      execution.then(() => "resolved", () => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 25)),
    ]);

    expect(outcome).toBe("aborted");
    resolvePool(pool as unknown as mssql.ConnectionPool);
    await vi.waitFor(() => expect(pool.close).toHaveBeenCalledOnce());
    expect(pool.request).not.toHaveBeenCalled();
  });

  it("returns promptly when aborted during a stalled credential lookup", async () => {
    const controller = new AbortController();
    const vault = fakeVault();
    vi.mocked(vault.get).mockReturnValue(new Promise(() => undefined));
    const pools = factoryFor(fakePool());
    const execution = new SQLServerAdapter(fixtureProfile(), vault, pools).executeRead(
      fixtureReadOperation(),
      { orderId: "ORD-1001" },
      controller.signal,
    );
    await vi.waitFor(() => expect(vault.get).toHaveBeenCalledOnce());

    controller.abort();
    const outcome = await Promise.race([
      execution.then(() => "resolved", () => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 25)),
    ]);

    expect(outcome).toBe("aborted");
    expect(pools.open).not.toHaveBeenCalled();
  });

  it("returns a successful read without waiting indefinitely for pool close", async () => {
    const pool = fakePool(fakeRequest({ recordset: [{ order_id: "ORD-1001", order_status: "ready" }] }));
    pool.close.mockReturnValue(new Promise(() => undefined));
    const execution = new SQLServerAdapter(fixtureProfile(), fakeVault(), factoryFor(pool)).executeRead(
      fixtureReadOperation(),
      { orderId: "ORD-1001" },
    );

    const outcome = await Promise.race([
      execution.then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 250)),
    ]);

    expect(outcome).toBe("resolved");
    expect(pool.close).toHaveBeenCalledOnce();
  });

  it("returns an aborted read without waiting indefinitely for pool close", async () => {
    const controller = new AbortController();
    const request = fakeRequest();
    request.query.mockReturnValue(new Promise(() => undefined));
    const pool = fakePool(request);
    pool.close.mockReturnValue(new Promise(() => undefined));
    const execution = new SQLServerAdapter(fixtureProfile(), fakeVault(), factoryFor(pool)).executeRead(
      fixtureReadOperation(),
      { orderId: "ORD-1001" },
      controller.signal,
    );
    await vi.waitFor(() => expect(request.query).toHaveBeenCalledOnce());

    controller.abort();
    const outcome = await Promise.race([
      execution.then(() => "resolved", () => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 250)),
    ]);

    expect(outcome).toBe("aborted");
    expect(pool.close).toHaveBeenCalledOnce();
  });
});

describe("SQLServerAdapter.testConnection", () => {
  it("opens a verified structured config, probes the server, and closes the pool", async () => {
    const request = fakeRequest({ recordset: [{ connection_ok: 1 }] });
    const pool = fakePool(request);
    const result = await new SQLServerAdapter(
      fixtureProfile({ environment: "preproduction" }),
      fakeVault(),
      factoryFor(pool),
    ).testConnection();

    expect(result.environment).toBe("preproduction");
    expect(result.latencyMS).toBeGreaterThanOrEqual(0);
    expect(request.query).toHaveBeenCalledWith("SELECT 1 AS connection_ok");
    expect(pool.close).toHaveBeenCalledOnce();
  });

  it("returns promptly when aborted during a stalled credential lookup", async () => {
    const controller = new AbortController();
    const vault = fakeVault();
    vi.mocked(vault.get).mockReturnValue(new Promise(() => undefined));
    const pools = factoryFor(fakePool());
    const execution = new SQLServerAdapter(fixtureProfile(), vault, pools).testConnection(controller.signal);
    await vi.waitFor(() => expect(vault.get).toHaveBeenCalledOnce());

    controller.abort();
    const outcome = await Promise.race([
      execution.then(() => "resolved", () => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 25)),
    ]);

    expect(outcome).toBe("aborted");
    expect(pools.open).not.toHaveBeenCalled();
  });

  it("rejects an invalid profile before credential lookup", async () => {
    const vault = fakeVault();
    const pools = factoryFor(fakePool());

    await expect(
      new SQLServerAdapter(fixtureProfile({ server: " " }), vault, pools).testConnection(),
    ).rejects.toMatchObject({ code: "invalid_argument", message: "invalid_argument" });
    expect(vault.get).not.toHaveBeenCalled();
    expect(pools.open).not.toHaveBeenCalled();
  });

  it("rejects an unavailable CA before credential lookup", async () => {
    const vault = fakeVault();
    const pools = factoryFor(fakePool());
    const caPath = `C:\\missing-${Date.now()}\\ca.pem`;

    await expect(
      new SQLServerAdapter(fixtureProfile({ caPath }), vault, pools).testConnection(),
    ).rejects.toMatchObject({ code: "tls_failed", message: "tls_failed" });
    expect(vault.get).not.toHaveBeenCalled();
    expect(pools.open).not.toHaveBeenCalled();
  });

  it("uses an immutable profile snapshot while credential lookup is pending", async () => {
    let resolveCredential!: (value: { username: string; password: string }) => void;
    const vault = fakeVault();
    vi.mocked(vault.get).mockReturnValue(new Promise((resolve) => {
      resolveCredential = resolve;
    }));
    const profile = fixtureProfile();
    const pool = fakePool(fakeRequest({ recordset: [{ connection_ok: 1 }] }));
    const pools = factoryFor(pool);
    const execution = new SQLServerAdapter(profile, vault, pools).testConnection();
    await vi.waitFor(() => expect(vault.get).toHaveBeenCalledOnce());

    profile.server = "mutated.internal";
    profile.environment = "preproduction";
    resolveCredential({ username: "agent_test", password: "test-only-password" });

    await expect(execution).resolves.toMatchObject({ environment: "test" });
    expect(pools.open).toHaveBeenCalledWith(expect.objectContaining({ server: "sql.test.internal" }));
  });
});

const integration = process.env.M7_SQLSERVER_TEST === "1" ? it : it.skip;

integration("reads ORD-1001 from the strict-TLS SQL Server fixture", async () => {
  const caPath = path.resolve(__dirname, "../../../../test/sqlserver/tls/ca.crt");
  expect(fs.existsSync(caPath)).toBe(true);
  const profile = fixtureProfile({
    server: "localhost",
    port: 11433,
    caPath,
    queryTimeoutMS: 10_000,
  });
  const vault = fakeVault({ username: "merchant_agent_test", password: "M7SqlTest!2026" });
  const pools: SQLPoolFactory = {
    async open(config) {
      return new mssql.ConnectionPool(config).connect();
    },
  };
  const operation = fixtureReadOperation({ maxResults: 1, sql: fixtureReadOperation().sql.replace("TOP 2", "TOP 1") });

  const result = await new SQLServerAdapter(profile, vault, pools).executeRead(operation, { orderId: "ORD-1001" });

  expect(result).toEqual([{ orderId: "ORD-1001", status: "in_production" }]);
  expect(JSON.stringify(result)).not.toContain("note");
});
