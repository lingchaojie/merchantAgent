import { describe, expect, it } from "vitest";

import type { PublicToolContract, SQLOperation } from "./schema";
import { assertM71Contract } from "./m7-contract";

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
      bindings: [{ argument: "orderId" }],
    },
    {
      kind: "update",
      tool: "report_production_progress",
      bindings: [
        { argument: "orderId" },
        { argument: "workOrderId" },
        { argument: "completionRate" },
        { argument: "expectedVersion" },
        { argument: "note" },
        { argument: "nextVersion" },
      ],
    },
  ] as SQLOperation[];
}

describe("fixed M7.1 connector contract", () => {
  it("accepts exactly query_order_status and report_production_progress schemas", () => {
    expect(() => assertM71Contract({ tools: tools() }, operations())).not.toThrow();
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

  it("rejects private operation bindings outside the fixed public schema and nextVersion", () => {
    const value = operations();
    value[1].bindings.push({ argument: "targetOrderId" } as never);
    expect(() => assertM71Contract({ tools: tools() }, value)).toThrowError("m7_contract");
  });
});
