import { describe, expect, it } from "vitest";

import type {
  ConnectorPrivatePayload,
  SQLReadOperation,
  SQLUpdateOperation,
} from "./schema";
import { parseConnectorPrivatePayload } from "./schema";
import {
  validateOperationBeforeExecution,
  validateReadOperation,
  validateUpdateOperation,
} from "./sql-policy";

export function fixtureReadOperation(): SQLReadOperation {
  return {
    kind: "read",
    tool: "query_order_status",
    sql: [
      "SELECT TOP 10 o.order_id AS order_id, o.status AS order_status",
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
    maxResults: 10,
    timeoutMS: 10_000,
  };
}

export function fixtureUpdateOperation(): SQLUpdateOperation {
  const readSql = [
    "SELECT o.order_id AS order_id, o.status AS order_status, o.row_version AS row_version",
    "FROM dbo.production_orders AS o",
    "WHERE o.order_id = @orderId",
  ].join(" ");
  return {
    kind: "update",
    tool: "update_order_status",
    beforeSql: readSql,
    updateSql: [
      "UPDATE dbo.production_orders",
      "SET status = @status, row_version = @nextVersion",
      "WHERE order_id = @orderId AND row_version = @expectedVersion",
    ].join(" "),
    readBackSql: readSql,
    bindings: [
      { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 },
      { parameter: "status", argument: "status", type: "NVarChar", maxLength: 32 },
      { parameter: "nextVersion", argument: "nextVersion", type: "Int" },
      { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" },
    ],
    projection: [
      { sourceAlias: "order_id", resultField: "orderId", type: "string" },
      { sourceAlias: "order_status", resultField: "status", type: "string" },
      { sourceAlias: "row_version", resultField: "rowVersion", type: "integer" },
    ],
    proposed: [
      { resultField: "status", argument: "status" },
      { resultField: "rowVersion", argument: "nextVersion" },
    ],
    declaredObject: "dbo.production_orders",
    resourceParameter: "orderId",
    concurrencyParameter: "expectedVersion",
    updateColumns: ["status", "row_version"],
    versionField: "row_version",
    timeoutMS: 10_000,
  };
}

function fixturePayload(operation: SQLReadOperation): ConnectorPrivatePayload {
  return {
    schemaVersion: 1,
    connectorId: "sql-orders",
    version: "1.0.0",
    adapter: "sqlserver",
    profile: {
      profileId: "erp-test",
      server: "sql.test.internal",
      database: "merchant_test",
      encrypt: true,
      trustServerCertificate: false,
      connectTimeoutMS: 5_000,
      queryTimeoutMS: 10_000,
      credentialRef: "erp-test",
      environment: "test",
    },
    operations: [operation],
    publicContract: {
      tools: [{
        name: operation.tool,
        description: "Query an order status",
        parameters: {
          type: "object",
          properties: { orderId: { type: "string", minLength: 1, maxLength: 64 } },
          required: ["orderId"],
          additionalProperties: false,
        },
        resultFields: ["orderId", "status"],
        resourceType: "business_record",
        resourceKind: "order",
        resourceArg: "orderId",
        resourceRelation: "viewer",
        dataDomain: "manufacturing",
        risk: "read",
        requiresConfirmation: false,
        timeoutMS: 10_000,
        maxResults: 10,
      }],
    },
    checker: {
      version: "1.0.0",
      rulesetVersion: "m7.1-sql-v1",
      testsDigest: `sha256:${"a".repeat(64)}`,
    },
  };
}

describe("restricted T-SQL read policy", () => {
  it("accepts one fully declared, parameterized SELECT", () => {
    const validated = validateReadOperation(fixtureReadOperation());

    expect(validated.normalizedSQL).toContain("SELECT");
    expect([...validated.parameterNames]).toEqual(["orderId"]);
    expect([...validated.resultAliases]).toEqual(["order_id", "order_status"]);
  });

  it("accepts a declared inner join with fixed identifiers", () => {
    const operation = fixtureReadOperation();
    operation.sql = [
      "SELECT TOP 10 o.order_id AS order_id, c.customer_name AS order_status",
      "FROM dbo.production_orders AS o",
      "INNER JOIN dbo.customers AS c ON c.customer_id = o.customer_id",
      "WHERE o.order_id = @orderId",
    ].join(" ");
    operation.declaredObjects = ["dbo.production_orders", "dbo.customers"];

    expect(() => validateReadOperation(operation)).not.toThrow();
  });

  it("requires a join predicate to bind two different declared table qualifiers", () => {
    const operation = fixtureReadOperation();
    operation.sql = [
      "SELECT TOP 10 o.order_id AS order_id, c.customer_name AS order_status",
      "FROM dbo.production_orders AS o",
      "INNER JOIN dbo.customers AS c ON o.customer_id = o.customer_id",
      "WHERE o.order_id = @orderId",
    ].join(" ");
    operation.declaredObjects = ["dbo.production_orders", "dbo.customers"];

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: join");
  });

  it("requires every later join predicate to bind the table introduced by that join", () => {
    const operation = fixtureReadOperation();
    operation.sql = [
      "SELECT TOP 10 o.order_id AS order_id, c.customer_name AS order_status",
      "FROM dbo.production_orders AS o",
      "INNER JOIN dbo.customers AS c ON c.customer_id = o.customer_id",
      "INNER JOIN dbo.secret AS s ON c.customer_id = o.customer_id",
      "WHERE o.order_id = @orderId",
    ].join(" ");
    operation.declaredObjects = ["dbo.production_orders", "dbo.customers", "dbo.secret"];

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: join");
  });

  it("accepts a direct column's deterministic implicit alias when metadata matches", () => {
    const operation = fixtureReadOperation();
    operation.sql = "SELECT TOP 10 o.order_id FROM dbo.production_orders AS o WHERE o.order_id = @orderId";
    operation.projection = [operation.projection[0]];

    expect(() => validateReadOperation(operation)).not.toThrow();
  });

  it("rejects a direct column's implicit alias when projection metadata differs", () => {
    const operation = fixtureReadOperation();
    operation.sql = "SELECT TOP 10 o.status FROM dbo.production_orders AS o WHERE o.order_id = @orderId";
    operation.projection = [operation.projection[0]];

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: projection_mismatch");
  });

  it.each([
    "SELECT * FROM dbo.production_orders WHERE order_id = @orderId",
    "SELECT order_id AS order_id FROM otherdb.dbo.production_orders WHERE order_id = @orderId",
    "SELECT order_id AS order_id FROM dbo.production_orders WHERE order_id = @orderId; DELETE FROM dbo.production_orders",
    "SELECT order_id AS order_id FROM dbo.production_orders WHERE order_id IN (SELECT order_id FROM dbo.secret)",
    "EXEC dbo.read_order @orderId",
    "SELECT order_id AS order_id FROM OPENROWSET('SQLNCLI','x','SELECT 1')",
  ])("rejects unsafe read SQL: %s", (sql) => {
    expect(() => validateReadOperation({ ...fixtureReadOperation(), sql })).toThrowError("unsafe_template");
  });

  it("requires SQL result aliases to match projection metadata exactly", () => {
    const operation = fixtureReadOperation();
    operation.projection[1] = { ...operation.projection[1], sourceAlias: "different_alias" };

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: projection_mismatch");
  });

  it("rejects discovered result aliases that collide under SQL Server case folding", () => {
    const operation = fixtureReadOperation();
    operation.sql = operation.sql.replace("o.status AS order_status", "o.status AS ORDER_ID");
    operation.projection[1] = { ...operation.projection[1], sourceAlias: "ORDER_ID" };

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: projection");
  });

  it("rejects declared projection aliases that collide under SQL Server case folding", () => {
    const operation = fixtureReadOperation();
    operation.projection[1] = { ...operation.projection[1], sourceAlias: "ORDER_ID" };

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: projection_mismatch");
  });

  it("requires discovered parameters to match bindings exactly", () => {
    const operation = fixtureReadOperation();
    operation.bindings.push({ parameter: "unused", argument: "unused", type: "Int" });

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: binding_mismatch");
  });

  it("requires exact parameter spelling", () => {
    const operation = fixtureReadOperation();
    operation.bindings[0] = { ...operation.bindings[0], parameter: "OrderId" };

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: binding_mismatch");
  });

  it("rejects parameter names that collide under SQL Server case folding", () => {
    const operation = fixtureReadOperation();
    operation.sql = operation.sql.replace(
      "WHERE o.order_id = @orderId",
      "WHERE o.order_id = @orderId AND o.status = @OrderId",
    );
    operation.bindings.push({ parameter: "OrderId", argument: "otherOrderId", type: "NVarChar", maxLength: 64 });

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: binding_mismatch");
  });

  it.each([
    ["missing NVarChar maxLength", { parameter: "orderId", argument: "orderId", type: "NVarChar" }],
    ["zero NVarChar maxLength", { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 0 }],
    ["oversized NVarChar maxLength", { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 4_001 }],
    ["Int maxLength", { parameter: "orderId", argument: "orderId", type: "Int", maxLength: 4 }],
  ])("rejects %s during direct policy validation", (_name, binding) => {
    const operation = fixtureReadOperation();
    operation.bindings[0] = binding as never;

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: binding_mismatch");
  });

  it("accepts the bounded NVarChar upper limit", () => {
    const operation = fixtureReadOperation();
    const binding = operation.bindings[0];
    if (binding.type !== "NVarChar") throw new Error("invalid fixture");
    operation.bindings[0] = { ...binding, maxLength: 4_000 };

    expect(() => validateReadOperation(operation)).not.toThrow();
  });

  it.each([
    ["missing NVarChar maxLength", { parameter: "orderId", argument: "orderId", type: "NVarChar" }],
    ["zero NVarChar maxLength", { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 0 }],
    ["oversized NVarChar maxLength", { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 4_001 }],
    ["Int maxLength", { parameter: "orderId", argument: "orderId", type: "Int", maxLength: 4 }],
  ])("rejects %s during strict payload parsing", (_name, binding) => {
    const operation = fixtureReadOperation();
    operation.bindings[0] = binding as never;

    expect(() => parseConnectorPrivatePayload(fixturePayload(operation))).toThrowError(/maxLength/);
  });

  it("allows only a fixed TOP equal to maxResults", () => {
    const operation = fixtureReadOperation();
    expect(() => validateReadOperation(operation)).not.toThrow();

    operation.sql = operation.sql.replace("TOP 10", "TOP 11");
    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: top");
  });

  it("rejects a read SELECT without TOP", () => {
    const operation = fixtureReadOperation();
    operation.sql = operation.sql.replace("TOP 10 ", "");

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: top");
  });

  it.each([
    [0, "TOP 0"],
    [101, "TOP 101"],
    [1.5, "TOP 10"],
  ] as const)("rejects policy maxResults outside the integer 1..100 bound: %s", (maxResults, top) => {
    const operation = fixtureReadOperation();
    operation.maxResults = maxResults;
    operation.sql = operation.sql.replace("TOP 10", top);

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: top");
  });

  it("enforces the operation maxResults bound in strict payload parsing", () => {
    const operation = fixtureReadOperation();
    operation.maxResults = 101;
    const payload = fixturePayload(operation);
    payload.publicContract.tools[0].maxResults = 101;

    expect(() => parseConnectorPrivatePayload(payload)).toThrowError("maxResults must be an integer from 1 through 100");
  });

  it("enforces the public tool maxResults bound in strict payload parsing", () => {
    const payload = fixturePayload(fixtureReadOperation());
    payload.publicContract.tools[0].maxResults = 101;

    expect(() => parseConnectorPrivatePayload(payload)).toThrowError("maxResults must be an integer from 1 through 100");
  });

  it("rejects undeclared and unused objects", () => {
    const operation = fixtureReadOperation();
    operation.declaredObjects.push("dbo.customers");

    expect(() => validateReadOperation(operation)).toThrowError("unsafe_template: object_mismatch");
  });
});

describe("restricted T-SQL update policy", () => {
  it("accepts a guarded, allowlisted single-table update", () => {
    const validated = validateUpdateOperation(fixtureUpdateOperation());

    expect([...validated.update.parameterNames]).toEqual([
      "status", "nextVersion", "orderId", "expectedVersion",
    ]);
    expect([...validated.before.resultAliases]).toEqual(["order_id", "order_status", "row_version"]);
  });

  it.each([
    ["missing resource predicate", "WHERE row_version = @expectedVersion"],
    ["missing concurrency predicate", "WHERE order_id = @orderId"],
    ["disjunctive guard", "WHERE order_id = @orderId OR row_version = @expectedVersion"],
  ])("rejects an update with %s", (_name, where) => {
    const operation = fixtureUpdateOperation();
    operation.updateSql = `UPDATE dbo.production_orders SET status = @status, row_version = @nextVersion ${where}`;

    expect(() => validateUpdateOperation(operation)).toThrowError("unsafe_template: update_guard");
  });

  it("requires the concurrency predicate to guard the declared version field", () => {
    const operation = fixtureUpdateOperation();
    operation.updateSql = operation.updateSql.replace(
      "row_version = @expectedVersion",
      "other_column = @expectedVersion",
    );

    expect(() => validateUpdateOperation(operation)).toThrowError("unsafe_template: update_guard");
  });

  it("requires the resource predicate to guard the selected resource column", () => {
    const operation = fixtureUpdateOperation();
    operation.updateSql = operation.updateSql.replace(
      "order_id = @orderId",
      "status = @orderId",
    );

    expect(() => validateUpdateOperation(operation)).toThrowError("unsafe_template: update_guard");
  });

  it.each([
    { target: "beforeSql", where: "WHERE o.status = @orderId", attack: "resource parameter on unrelated column" },
    { target: "beforeSql", where: "WHERE o.order_id <> @orderId", attack: "non-equality resource predicate" },
    { target: "beforeSql", where: "WHERE o.order_id = @orderId OR o.status = @orderId", attack: "disjunctive resource predicate" },
    { target: "readBackSql", where: "WHERE o.status = @orderId", attack: "resource parameter on unrelated column" },
    { target: "readBackSql", where: "WHERE o.order_id <> @orderId", attack: "non-equality resource predicate" },
    { target: "readBackSql", where: "WHERE o.order_id = @orderId OR o.status = @orderId", attack: "disjunctive resource predicate" },
  ] as const)("rejects $target leak: $attack", ({ target, where }) => {
    const operation = fixtureUpdateOperation();
    operation[target] = operation[target].replace("WHERE o.order_id = @orderId", where);

    expect(() => validateUpdateOperation(operation)).toThrowError("unsafe_template: update_guard");
  });

  it("requires before and read-back templates to project the resource field", () => {
    const operation = fixtureUpdateOperation();
    operation.projection = operation.projection.slice(1);
    operation.beforeSql = operation.beforeSql.replace("o.order_id AS order_id, ", "");
    operation.readBackSql = operation.readBackSql.replace("o.order_id AS order_id, ", "");

    expect(() => validateUpdateOperation(operation)).toThrowError("unsafe_template: update_guard");
  });

  it("requires each allowlisted assignment to use its proposed parameter", () => {
    const operation = fixtureUpdateOperation();
    operation.updateSql = operation.updateSql.replace(
      "status = @status, row_version = @nextVersion",
      "status = @nextVersion, row_version = @status",
    );

    expect(() => validateUpdateOperation(operation)).toThrowError("unsafe_template: assignment_mismatch");
  });

  it.each([
    ["extra assignment", "SET status = @status, row_version = @nextVersion, notes = @status"],
    ["missing assignment", "SET status = @status"],
  ])("rejects an update with an %s", (_name, setClause) => {
    const operation = fixtureUpdateOperation();
    operation.updateSql = operation.updateSql.replace(
      "SET status = @status, row_version = @nextVersion",
      setClause,
    );

    expect(() => validateUpdateOperation(operation)).toThrowError("unsafe_template: assignment_mismatch");
  });

  it.each([
    "UPDATE dbo.production_orders SET status = @status OUTPUT inserted.status WHERE order_id = @orderId AND row_version = @expectedVersion",
    "UPDATE o SET status = @status FROM dbo.production_orders o JOIN dbo.customers c ON c.customer_id=o.customer_id WHERE o.order_id=@orderId AND o.row_version=@expectedVersion",
    "UPDATE otherdb.dbo.production_orders SET status = @status WHERE order_id = @orderId AND row_version = @expectedVersion",
  ])("rejects unsafe update SQL: %s", (updateSql) => {
    expect(() => validateUpdateOperation({ ...fixtureUpdateOperation(), updateSql })).toThrowError("unsafe_template");
  });
});

describe("policy enforcement lifecycle", () => {
  it("validates operation SQL while parsing a draft payload", () => {
    const operation = fixtureReadOperation();
    operation.sql = "SELECT * FROM dbo.production_orders";

    expect(() => parseConnectorPrivatePayload(fixturePayload(operation))).toThrowError("unsafe_template");
  });

  it("re-parses a read operation before every execution", () => {
    const operation = fixtureReadOperation();
    validateOperationBeforeExecution(operation);
    operation.sql = `${operation.sql}; WAITFOR DELAY '00:00:05'`;

    expect(() => validateOperationBeforeExecution(operation)).toThrowError("unsafe_template");
  });

  it("re-parses all update templates before every execution", () => {
    const operation = fixtureUpdateOperation();
    validateOperationBeforeExecution(operation);
    operation.readBackSql = "SELECT * FROM dbo.production_orders";

    expect(() => validateOperationBeforeExecution(operation)).toThrowError("unsafe_template");
  });
});
