import { describe, expect, it } from "vitest";

import type { PublicToolContract, SQLOperation } from "./schema";
import { assertM71Contract } from "./m7-contract";
import { validateOperationBeforeExecution } from "./sql-policy";

function tools(): PublicToolContract[] {
  const resultFields = [
    "orderId", "workOrderId", "status", "promiseDate", "completionRate", "note", "version",
  ];
  return [{
    name: "query_order_status",
    description: "Query order status",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false,
    },
    resultFields,
    resourceType: "business_record",
    resourceKind: "order",
    resourceArg: "orderId",
    resourceRelation: "viewer",
    dataDomain: "manufacturing",
    risk: "read",
    requiresConfirmation: false,
    timeoutMS: 10_000,
    maxResults: 10,
  }, {
    name: "report_production_progress",
    description: "Report production progress",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        workOrderId: { type: "string" },
        completionRate: { type: "integer" },
        expectedVersion: { type: "integer" },
        note: { type: "string" },
      },
      required: ["orderId", "workOrderId", "completionRate", "expectedVersion"],
      additionalProperties: false,
    },
    resultFields,
    resourceType: "business_record",
    resourceKind: "order",
    resourceArg: "orderId",
    resourceRelation: "operator",
    dataDomain: "manufacturing",
    risk: "low_write",
    requiresConfirmation: true,
    timeoutMS: 10_000,
    maxResults: 1,
  }];
}

function operations(): SQLOperation[] {
  return [
    {
      kind: "read",
      tool: "query_order_status",
      sql: "SELECT TOP 10 order_id AS order_id FROM dbo.orders WHERE order_id = @order_id",
      bindings: [{ parameter: "order_id", argument: "orderId", type: "NVarChar", maxLength: 32 }],
      projection: [{ sourceAlias: "order_id", resultField: "orderId", type: "string" }],
      declaredObjects: ["dbo.orders"],
      maxResults: 10,
      timeoutMS: 5_000,
    },
    {
      kind: "update",
      tool: "report_production_progress",
      beforeSql: "SELECT order_id, work_order_id, completion_rate, note, version FROM dbo.orders WHERE order_id = @orderId AND work_order_id = @workOrderId",
      updateSql: "UPDATE dbo.orders SET completion_rate = @completionRate, note = @note, version = @nextVersion WHERE order_id = @orderId AND work_order_id = @workOrderId AND version = @expectedVersion",
      readBackSql: "SELECT order_id, work_order_id, completion_rate, note, version FROM dbo.orders WHERE order_id = @orderId AND work_order_id = @workOrderId",
      bindings: [
        { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 32 },
        { parameter: "workOrderId", argument: "workOrderId", type: "NVarChar", maxLength: 32 },
        { parameter: "completionRate", argument: "completionRate", type: "Int" },
        { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" },
        { parameter: "note", argument: "note", type: "NVarChar", maxLength: 100 },
        { parameter: "nextVersion", argument: "nextVersion", type: "Int" },
      ],
      projection: [
        { sourceAlias: "order_id", resultField: "orderId", type: "string" },
        { sourceAlias: "work_order_id", resultField: "workOrderId", type: "string" },
        { sourceAlias: "completion_rate", resultField: "completionRate", type: "integer" },
        { sourceAlias: "note", resultField: "note", type: "string" },
        { sourceAlias: "version", resultField: "version", type: "integer" },
      ],
      proposed: [
        { resultField: "completionRate", argument: "completionRate" },
        { resultField: "note", argument: "note", preserveIfMissing: true },
        { resultField: "version", argument: "nextVersion" },
      ],
      declaredObject: "dbo.orders",
      resourceParameter: "orderId",
      concurrencyParameter: "expectedVersion",
      updateColumns: ["completion_rate", "note", "version"],
      versionField: "version",
      timeoutMS: 5_000,
    },
  ];
}

describe("fixed M7.1 connector contract", () => {
  it("accepts exactly query_order_status and report_production_progress schemas", () => {
    const value = operations();
    for (const operation of value) expect(() => validateOperationBeforeExecution(operation)).not.toThrow();
    expect(() => assertM71Contract({ tools: tools() }, value)).not.toThrow();
  });

  it("accepts exact fixed bindings when their non-semantic array order changes", () => {
    const value = operations();
    value[0].bindings.reverse();
    value[1].bindings.reverse();

    expect(() => assertM71Contract({ tools: tools().reverse() }, value.reverse())).not.toThrow();
  });

  it.each([
    ["arbitrary tool", (value: PublicToolContract[]) => { value[1].name = "update_order_status"; }],
    ["extra parameter", (value: PublicToolContract[]) => {
      value[0].parameters.properties.other = { type: "string" };
    }],
    ["wrong required set", (value: PublicToolContract[]) => { value[1].parameters.required.push("note"); }],
    ["wrong parameter type", (value: PublicToolContract[]) => {
      value[1].parameters.properties.completionRate = { type: "string" };
    }],
    ["missing tool", (value: PublicToolContract[]) => { value.pop(); }],
  ])("rejects %s", (_name, mutate) => {
    const value = tools();
    mutate(value);
    expect(() => assertM71Contract({ tools: value }, operations())).toThrowError("m7_contract");
  });

  it("rejects an operation kind that does not match the fixed tool", () => {
    const value = operations();
    value[1] = { ...value[1], kind: "read" } as SQLOperation;
    expect(() => assertM71Contract({ tools: tools() }, value)).toThrowError("m7_contract");
  });

  it.each([
    ["a public argument with the wrong SQL type", (operation: Extract<SQLOperation, { kind: "update" }>) => {
      operation.bindings[2] = {
        parameter: "completionRate",
        argument: "completionRate",
        type: "NVarChar",
        maxLength: 16,
      };
    }],
    ["a resource argument bound outside the resource role", (operation: Extract<SQLOperation, { kind: "update" }>) => {
      operation.bindings[0] = { ...operation.bindings[0], argument: "workOrderId" };
      operation.bindings[1] = { ...operation.bindings[1], argument: "orderId" };
    }],
    ["expectedVersion outside the concurrency role", (operation: Extract<SQLOperation, { kind: "update" }>) => {
      operation.bindings[3] = { ...operation.bindings[3], argument: "nextVersion" };
      operation.bindings[5] = { ...operation.bindings[5], argument: "expectedVersion" };
    }],
    ["nextVersion outside the version-update role", (operation: Extract<SQLOperation, { kind: "update" }>) => {
      operation.bindings[2] = { ...operation.bindings[2], argument: "nextVersion" };
      operation.bindings[5] = { ...operation.bindings[5], argument: "completionRate" };
    }],
    ["optional note without preserve-if-missing semantics", (operation: Extract<SQLOperation, { kind: "update" }>) => {
      operation.proposed[1] = { resultField: "note", argument: "note" };
    }],
  ])("rejects %s", (_name, mutate) => {
    const value = operations();
    const operation = value[1];
    if (operation.kind !== "update") throw new Error("test fixture");
    mutate(operation);

    expect(() => assertM71Contract({ tools: tools() }, value)).toThrowError("m7_contract");
  });

  it("rejects private operation bindings outside the fixed public schema and nextVersion", () => {
    const value = operations();
    value[1].bindings.push({ parameter: "targetOrderId", argument: "targetOrderId", type: "NVarChar", maxLength: 32 });
    expect(() => assertM71Contract({ tools: tools() }, value)).toThrowError("m7_contract");
  });
});
