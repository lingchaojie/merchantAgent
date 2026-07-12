import { describe, expect, it } from "vitest";

import type { SQLReadOperation, SQLUpdateOperation } from "./schema";
import { validateOperationBeforeExecution, validateReadOperation, validateUpdateOperation } from "./sql-policy";

function fixtureReadOperation(): SQLReadOperation {
  return {
    kind: "read",
    tool: "query_order_status",
    sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders AS o WHERE o.order_id = @orderId ORDER BY o.order_id ASC",
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

function fixtureUpdateOperation(): SQLUpdateOperation {
  const readSql = "SELECT o.order_id AS order_id, o.status AS order_status, o.row_version AS row_version FROM dbo.production_orders AS o WHERE o.order_id = @orderId";
  return {
    kind: "update",
    tool: "update_order_status",
    beforeSql: readSql,
    updateSql: "UPDATE dbo.production_orders SET status = @status, row_version = @nextVersion WHERE order_id = @orderId AND row_version = @expectedVersion",
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

interface ReadAttack {
  name: string;
  reason: string;
  sql: string;
}

const READ_ATTACKS: ReadAttack[] = [
  { name: "stacked delete", reason: "statement_count", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId; DELETE FROM dbo.production_orders" },
  { name: "stacked update", reason: "statement_count", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId; UPDATE dbo.production_orders SET status=@orderId" },
  { name: "stacked select", reason: "statement_count", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId; SELECT 1" },
  { name: "GO batch separator", reason: "statement_type", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId GO DELETE FROM dbo.production_orders" },
  { name: "line comment", reason: "comment", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o -- parser directive\nWHERE o.order_id=@orderId" },
  { name: "block comment", reason: "comment", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o /* parser: dialect=mysql */ WHERE o.order_id=@orderId" },
  { name: "nested block comment", reason: "comment", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o /* outer /* inner */ WHERE o.order_id=@orderId" },
  { name: "comment hides stacked delete", reason: "comment", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId/**/;DELETE FROM dbo.production_orders" },
  { name: "bracketed table identifier", reason: "identifier", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM [dbo].[production_orders] o WHERE o.order_id=@orderId" },
  { name: "double quoted table identifier", reason: "identifier", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM \"dbo\".\"production_orders\" o WHERE o.order_id=@orderId" },
  { name: "bracketed parameter lookalike", reason: "binding_mismatch", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=[@orderId]" },
  { name: "Unicode no-break whitespace", reason: "parse", sql: "SELECT\u00a0o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "Unicode em whitespace", reason: "parse", sql: "SELECT\u2003o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "Unicode line separator", reason: "parse", sql: "SELECT\u2028o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "where scalar subquery", reason: "predicate_value", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=(SELECT TOP 1 order_id FROM dbo.secret)" },
  { name: "where IN subquery", reason: "predicate_value", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id IN (SELECT order_id FROM dbo.secret)" },
  { name: "where EXISTS subquery", reason: "unknown_property", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE EXISTS (SELECT 1 FROM dbo.secret)" },
  { name: "derived table", reason: "table", sql: "SELECT q.order_id AS order_id, q.status AS order_status FROM (SELECT order_id,status FROM dbo.production_orders) q WHERE q.order_id=@orderId" },
  { name: "projection subquery", reason: "projection", sql: "SELECT (SELECT TOP 1 secret FROM dbo.secret) AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "common table expression", reason: "with", sql: "WITH q AS (SELECT * FROM dbo.production_orders) SELECT q.order_id AS order_id, q.status AS order_status FROM q WHERE q.order_id=@orderId" },
  { name: "recursive common table expression", reason: "with", sql: "WITH q AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM q) SELECT n AS order_id, n AS order_status FROM q WHERE n=@orderId" },
  { name: "UNION", reason: "set_operation", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId UNION SELECT secret AS order_id, secret AS order_status FROM dbo.secret" },
  { name: "UNION ALL", reason: "set_operation", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId UNION ALL SELECT secret AS order_id, secret AS order_status FROM dbo.secret" },
  { name: "INTERSECT", reason: "parse", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId INTERSECT SELECT secret AS order_id, secret AS order_status FROM dbo.secret" },
  { name: "EXCEPT", reason: "parse", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId EXCEPT SELECT secret AS order_id, secret AS order_status FROM dbo.secret" },
  { name: "OPENROWSET", reason: "external_source", sql: "SELECT x.order_id AS order_id, x.status AS order_status FROM OPENROWSET('SQLNCLI','Server=x;Trusted_Connection=yes;','SELECT order_id,status FROM dbo.secret') x WHERE x.order_id=@orderId" },
  { name: "OPENDATASOURCE", reason: "parse", sql: "SELECT x.order_id AS order_id, x.status AS order_status FROM OPENDATASOURCE('SQLNCLI','Data Source=x;Integrated Security=SSPI').db.dbo.secret x WHERE x.order_id=@orderId" },
  { name: "OPENQUERY", reason: "external_source", sql: "SELECT x.order_id AS order_id, x.status AS order_status FROM OPENQUERY(linked, 'SELECT order_id,status FROM secret') x WHERE x.order_id=@orderId" },
  { name: "BULK rowset", reason: "parse", sql: "SELECT x.order_id AS order_id, x.status AS order_status FROM OPENROWSET(BULK 'C:\\secret.txt', SINGLE_CLOB) x WHERE x.order_id=@orderId" },
  { name: "xp_cmdshell procedure", reason: "statement_type", sql: "EXEC master..xp_cmdshell 'whoami'" },
  { name: "sp_executesql procedure", reason: "statement_type", sql: "EXEC sp_executesql N'SELECT * FROM dbo.secret'" },
  { name: "EXECUTE procedure", reason: "statement_type", sql: "EXECUTE dbo.read_order @orderId" },
  { name: "WAITFOR delay", reason: "statement_type", sql: "WAITFOR DELAY '00:00:05'" },
  { name: "USE database", reason: "statement_type", sql: "USE master" },
  { name: "DECLARE scalar", reason: "statement_type", sql: "DECLARE @x INT" },
  { name: "DECLARE table variable", reason: "statement_type", sql: "DECLARE @x TABLE (id INT)" },
  { name: "SET scalar", reason: "statement_type", sql: "SET @orderId = 'other'" },
  { name: "SET identity insert", reason: "statement_type", sql: "SET IDENTITY_INSERT dbo.production_orders ON" },
  { name: "temporary table read", reason: "object_mismatch", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM #production_orders o WHERE o.order_id=@orderId" },
  { name: "table variable read", reason: "object_mismatch", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM @production_orders o WHERE o.order_id=@orderId" },
  { name: "cross database three part", reason: "cross_database", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM otherdb.dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "four part linked server", reason: "cross_database", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM linked.otherdb.dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "master database object", reason: "cross_database", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM master.sys.objects o WHERE o.order_id=@orderId" },
  { name: "SELECT star", reason: "projection", sql: "SELECT * FROM dbo.production_orders WHERE order_id=@orderId" },
  { name: "qualified SELECT star", reason: "projection", sql: "SELECT o.* FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "implicit projection alias mismatch", reason: "projection_mismatch", sql: "SELECT o.order_id, o.status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "duplicate projection alias", reason: "projection", sql: "SELECT o.order_id AS order_id, o.status AS order_id FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "computed projection", reason: "projection", sql: "SELECT o.order_id + @orderId AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "function projection", reason: "parse", sql: "SELECT SYSTEM_USER AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "literal predicate", reason: "predicate_value", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id='fixed'" },
  { name: "numeric literal predicate", reason: "predicate_value", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=1" },
  { name: "tautology predicate", reason: "predicate_value", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE 1=1 OR o.order_id=@orderId" },
  { name: "unbound parameter", reason: "binding_mismatch", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@otherId" },
  { name: "parameter used as table", reason: "object_mismatch", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM @table o WHERE o.order_id=@orderId" },
  { name: "parameter used as projection", reason: "projection", sql: "SELECT @orderId AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "SELECT INTO", reason: "parse", sql: "SELECT o.order_id AS order_id, o.status AS order_status INTO dbo.exfil FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "SELECT INTO temp", reason: "into", sql: "SELECT o.order_id AS order_id, o.status AS order_status INTO #exfil FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "CROSS JOIN", reason: "join", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o CROSS JOIN dbo.customers c WHERE o.order_id=@orderId" },
  { name: "undeclared join", reason: "object_mismatch", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o INNER JOIN dbo.secret s ON s.id=o.order_id WHERE o.order_id=@orderId" },
  { name: "query hint", reason: "parse", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId OPTION (MAXDOP 0)" },
  { name: "table hint", reason: "table_hint", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WITH (NOLOCK) WHERE o.order_id=@orderId" },
  { name: "FOR XML", reason: "for", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId FOR XML AUTO" },
  { name: "GROUP BY", reason: "groupby", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId GROUP BY o.order_id,o.status" },
  { name: "HAVING", reason: "having", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId GROUP BY o.order_id,o.status HAVING COUNT(*) > 0" },
  { name: "OFFSET parameter", reason: "parse", sql: "SELECT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId ORDER BY o.order_id OFFSET @orderId ROWS" },
  { name: "TOP parameter", reason: "parse", sql: "SELECT TOP (@orderId) o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "TOP percent", reason: "top", sql: "SELECT TOP 10 PERCENT o.order_id AS order_id, o.status AS order_status FROM dbo.production_orders o WHERE o.order_id=@orderId" },
  { name: "malformed SELECT", reason: "parse", sql: "SELECT FROM WHERE" },
  { name: "unterminated string", reason: "parse", sql: "SELECT 'unterminated" },
  { name: "unterminated bracket", reason: "identifier", sql: "SELECT [unterminated FROM dbo.production_orders" },
  { name: "empty SQL", reason: "parse", sql: "" },
];

const UPDATE_ATTACKS = [
  { name: "delete instead of update", reason: "statement_type", updateSql: "DELETE FROM dbo.production_orders WHERE order_id=@orderId" },
  { name: "insert instead of update", reason: "statement_type", updateSql: "INSERT INTO dbo.production_orders(status) VALUES (@status)" },
  { name: "merge instead of update", reason: "parse", updateSql: "MERGE dbo.production_orders AS t USING dbo.secret AS s ON t.order_id=s.order_id WHEN MATCHED THEN UPDATE SET status=@status;" },
  { name: "truncate instead of update", reason: "statement_type", updateSql: "TRUNCATE TABLE dbo.production_orders" },
  { name: "drop instead of update", reason: "statement_type", updateSql: "DROP TABLE dbo.production_orders" },
  { name: "create instead of update", reason: "statement_type", updateSql: "CREATE TABLE dbo.exfil(id INT)" },
  { name: "transaction", reason: "parse", updateSql: "BEGIN TRANSACTION" },
  { name: "stacked commit", reason: "parse", updateSql: "UPDATE dbo.production_orders SET status=@status,row_version=@nextVersion WHERE order_id=@orderId AND row_version=@expectedVersion; COMMIT" },
  { name: "assignment literal", reason: "assignment_value", updateSql: "UPDATE dbo.production_orders SET status='approved',row_version=@nextVersion WHERE order_id=@orderId AND row_version=@expectedVersion" },
  { name: "assignment expression", reason: "assignment_value", updateSql: "UPDATE dbo.production_orders SET status=@status,row_version=row_version+1 WHERE order_id=@orderId AND row_version=@expectedVersion" },
  { name: "OUTPUT", reason: "parse", updateSql: "UPDATE dbo.production_orders SET status=@status,row_version=@nextVersion OUTPUT inserted.status WHERE order_id=@orderId AND row_version=@expectedVersion" },
  { name: "UPDATE FROM", reason: "update_from", updateSql: "UPDATE o SET status=@status,row_version=@nextVersion FROM dbo.production_orders o WHERE o.order_id=@orderId AND o.row_version=@expectedVersion" },
  { name: "multiple update tables", reason: "table", updateSql: "UPDATE dbo.production_orders,dbo.customers SET status=@status WHERE order_id=@orderId AND row_version=@expectedVersion" },
  { name: "temporary update table", reason: "object_mismatch", updateSql: "UPDATE #production_orders SET status=@status,row_version=@nextVersion WHERE order_id=@orderId AND row_version=@expectedVersion" },
  { name: "table variable update", reason: "object_mismatch", updateSql: "UPDATE @production_orders SET status=@status,row_version=@nextVersion WHERE order_id=@orderId AND row_version=@expectedVersion" },
  { name: "cross database update", reason: "cross_database", updateSql: "UPDATE otherdb.dbo.production_orders SET status=@status,row_version=@nextVersion WHERE order_id=@orderId AND row_version=@expectedVersion" },
  { name: "missing WHERE", reason: "update_guard", updateSql: "UPDATE dbo.production_orders SET status=@status,row_version=@nextVersion" },
  { name: "OR guard", reason: "update_guard", updateSql: "UPDATE dbo.production_orders SET status=@status,row_version=@nextVersion WHERE order_id=@orderId OR row_version=@expectedVersion" },
  { name: "version inequality", reason: "update_guard", updateSql: "UPDATE dbo.production_orders SET status=@status,row_version=@nextVersion WHERE order_id=@orderId AND row_version<>@expectedVersion" },
  { name: "resource LIKE", reason: "update_guard", updateSql: "UPDATE dbo.production_orders SET status=@status,row_version=@nextVersion WHERE order_id LIKE @orderId AND row_version=@expectedVersion" },
] as const;

describe("restricted T-SQL attack corpus", () => {
  it("contains at least 60 explicit read attacks", () => {
    expect(READ_ATTACKS.length).toBeGreaterThanOrEqual(60);
  });

  it.each(READ_ATTACKS)("denies read attack: $name [$reason]", ({ sql, reason }) => {
    expect(() => validateReadOperation({ ...fixtureReadOperation(), sql })).toThrowError(
      `unsafe_template: ${reason}`,
    );
  });

  it.each(UPDATE_ATTACKS)("denies update attack: $name [$reason]", ({ updateSql, reason }) => {
    expect(() => validateUpdateOperation({ ...fixtureUpdateOperation(), updateSql })).toThrowError(
      `unsafe_template: ${reason}`,
    );
  });

  it("re-parses every accepted fixture at execution time", () => {
    expect(() => validateOperationBeforeExecution(fixtureReadOperation())).not.toThrow();
    expect(() => validateOperationBeforeExecution(fixtureUpdateOperation())).not.toThrow();
  });
});
