import { describe, expect, it } from "vitest";

import { parseConnectorPrivatePayload, type ConnectorPrivatePayload } from "./schema";

function fixturePayload(): ConnectorPrivatePayload {
  return {
    schemaVersion: 1,
    connectorId: "sql-orders",
    version: "1.0.0",
    adapter: "sqlserver",
    profile: {
      profileId: "erp-test",
      server: "sql.test.internal",
      port: 1433,
      database: "merchant_test",
      encrypt: true,
      trustServerCertificate: false,
      connectTimeoutMS: 5_000,
      queryTimeoutMS: 10_000,
      credentialRef: "erp-test",
      environment: "test",
    },
    operations: [
      {
        kind: "read",
        tool: "query_order_status",
        sql: "SELECT order_id FROM dbo.production_orders WHERE order_id = @orderId",
        bindings: [
          { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 },
        ],
        projection: [{ sourceAlias: "order_id", resultField: "orderId", type: "string" }],
        declaredObjects: ["dbo.production_orders"],
        maxResults: 10,
        timeoutMS: 10_000,
      },
    ],
    publicContract: {
      tools: [
        {
          name: "query_order_status",
          description: "Query an order status",
          parameters: {
            type: "object",
            properties: { orderId: { type: "string", minLength: 1, maxLength: 64 } },
            required: ["orderId"],
            additionalProperties: false,
          },
          resultFields: ["orderId"],
          resourceType: "business_record",
          resourceKind: "order",
          resourceArg: "orderId",
          resourceRelation: "viewer",
          dataDomain: "manufacturing",
          risk: "read",
          requiresConfirmation: false,
          timeoutMS: 10_000,
          maxResults: 10,
        },
      ],
    },
    checker: {
      version: "1.0.0",
      rulesetVersion: "m7.1-sql-v1",
      testsDigest: `sha256:${"a".repeat(64)}`,
    },
  };
}

describe("SQL Server profile schema", () => {
  it("accepts an opaque credential ref", () => {
    expect(parseConnectorPrivatePayload(fixturePayload()).profile.credentialRef).toBe("erp-test");
  });

  it.each([
    ["uppercase", "ERP-test"],
    ["URI-like", "credential://erp-test"],
    ["traversal", "../erp-test"],
    ["separator", "erp/test"],
    ["over 64 characters", `a${"b".repeat(64)}`],
  ])("rejects a %s credential ref", (_name, credentialRef) => {
    const payload = fixturePayload();
    payload.profile.credentialRef = credentialRef;

    expect(() => parseConnectorPrivatePayload(payload)).toThrowError("credentialRef");
  });
});
