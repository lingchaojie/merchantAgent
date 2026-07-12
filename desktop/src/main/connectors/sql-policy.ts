import { Parser, type AST } from "node-sql-parser";

import {
  ConnectorError,
  type SQLBinding,
  type SQLOperation,
  type SQLProjection,
  type SQLReadOperation,
  type SQLUpdateOperation,
} from "./schema";

export interface ValidatedSQL {
  normalizedSQL: string;
  parameterNames: ReadonlySet<string>;
  resultAliases: ReadonlySet<string>;
}

type UnknownRecord = Record<string, unknown>;

interface ParsedTemplate {
  ast: UnknownRecord;
  normalizedSQL: string;
}

interface SelectValidationOptions {
  declaredObjects: readonly string[];
  projection: readonly SQLProjection[];
  maxResults?: number;
}

interface ValidatedSelect extends ValidatedSQL {
  resultColumns: ReadonlyMap<string, string>;
}

interface ValidatedUpdateTemplate extends ValidatedSQL {
  assignments: ReadonlyMap<string, string>;
  guards: ReadonlyArray<{ column: string; parameter: string }>;
}

const parser = new Parser();
const TSQL_OPTIONS = { database: "TransactSQL" } as const;
const FIXED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$#]*$/;
const PARAMETER_IDENTIFIER = /^@[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_READ_OPERATORS = new Set(["=", "!=", "<>", ">", ">=", "<", "<=", "LIKE"]);
const ALLOWED_JOINS = new Set(["INNER JOIN", "LEFT JOIN", "LEFT OUTER JOIN"]);

function unsafe(reason: string, detail?: string): never {
  throw new ConnectorError("unsafe_template", detail === undefined ? reason : `${reason}: ${detail}`);
}

function record(value: unknown, reason: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) unsafe(reason);
  return value as UnknownRecord;
}

function assertKnownKeys(value: UnknownRecord, keys: readonly string[], context: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) unsafe("unknown_property", `${context}.${unknown}`);
}

function fixedIdentifier(value: unknown, reason = "identifier"): string {
  if (typeof value !== "string" || !FIXED_IDENTIFIER.test(value) || value.startsWith("#")) unsafe(reason);
  return value;
}

function nullableFixedIdentifier(value: unknown, reason = "identifier"): string | null {
  if (value === null) return null;
  return fixedIdentifier(value, reason);
}

function parameterName(column: string): string | null {
  if (!column.startsWith("@")) return null;
  if (!PARAMETER_IDENTIFIER.test(column)) unsafe("identifier");
  return column.slice(1);
}

function orderedUnique(values: readonly string[], reason: string): string[] {
  if (new Set(values).size !== values.length) unsafe(reason);
  return [...values];
}

function rejectCaseFoldedDuplicates(values: readonly string[], reason: string): void {
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) unsafe(reason);
}

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameCaseInsensitiveSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const normalized = new Set(expected.map((value) => value.toLowerCase()));
  return actual.every((value) => normalized.has(value.toLowerCase()));
}

function sameExactSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const expectedValues = new Set(expected);
  return actual.every((value) => expectedValues.has(value));
}

function declaredObject(value: string): string {
  const segments = value.split(".");
  if (segments.length < 1 || segments.length > 2 || segments.some((segment) => !FIXED_IDENTIFIER.test(segment))) {
    unsafe("object_mismatch");
  }
  return segments.join(".");
}

// The parser drops comments and quoting style, so reject those discarded forms before AST authorization.
function scanDiscardedSyntax(sql: string): void {
  if (sql.length === 0 || sql.trim().length === 0) unsafe("parse");
  let state: "sql" | "string" = "sql";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char.charCodeAt(0) > 0x7f) unsafe("parse");
    if (state === "string") {
      if (char === "'" && next === "'") {
        index += 1;
      } else if (char === "'") {
        state = "sql";
      }
      continue;
    }
    if (char === "'") {
      state = "string";
      continue;
    }
    if ((char === "-" && next === "-") || (char === "/" && next === "*")) unsafe("comment");
    if (char === "[") unsafe(next === "@" ? "binding_mismatch" : "identifier");
    if (char === '"') unsafe("identifier");
  }
}

function parseExactlyOne(sql: string): ParsedTemplate {
  scanDiscardedSyntax(sql);
  let parsed: AST | AST[];
  try {
    parsed = parser.astify(sql, TSQL_OPTIONS);
  } catch {
    const firstToken = sql.trimStart().match(/^[A-Za-z]+/)?.[0].toUpperCase();
    if (firstToken !== undefined && new Set([
      "EXEC", "EXECUTE", "WAITFOR", "USE", "DECLARE", "SET", "BEGIN", "COMMIT", "ROLLBACK",
    ]).has(firstToken)) {
      unsafe("statement_type");
    }
    unsafe("parse");
  }
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) unsafe("statement_count");
    parsed = parsed[0];
  }
  if (parsed === undefined || parsed === null) unsafe("parse");
  const ast = record(parsed, "parse");
  let normalizedSQL: string;
  try {
    normalizedSQL = parser.sqlify(parsed, TSQL_OPTIONS);
  } catch {
    unsafe("parse");
  }
  return { ast, normalizedSQL };
}

function columnReference(
  value: unknown,
  qualifiers: ReadonlySet<string>,
  allowParameter: boolean,
  reason = "expression",
): {
  column: string;
  parameter: string | null;
  table: string | null;
} {
  const node = record(value, reason);
  if (node.type !== "column_ref") unsafe(reason);
  assertKnownKeys(node, ["type", "table", "db", "schema", "column", "collate"], "column_ref");
  if (node.db !== null || node.schema !== null || node.collate !== null) {
    unsafe(reason);
  }
  const table = nullableFixedIdentifier(node.table);
  const column = typeof node.column === "string" ? node.column : unsafe("identifier");
  const parameter = parameterName(column);
  if (parameter !== null) {
    if (!allowParameter || table !== null) unsafe(reason);
    return { column, parameter, table };
  }
  if (!FIXED_IDENTIFIER.test(column) || column === "*") unsafe("identifier");
  if (table !== null && !qualifiers.has(table.toLowerCase())) unsafe("identifier");
  return { column, parameter: null, table };
}

function predicateLeaf(
  value: unknown,
  qualifiers: ReadonlySet<string>,
  parameters: Set<string>,
  allowedOperators: ReadonlySet<string>,
): { column: string; parameter: string; operator: string } {
  const node = record(value, "expression");
  assertKnownKeys(node, ["type", "operator", "left", "right"], "binary_expr");
  if (node.type !== "binary_expr" || typeof node.operator !== "string" || !allowedOperators.has(node.operator.toUpperCase())) {
    unsafe("predicate_value");
  }
  const left = columnReference(node.left, qualifiers, true, "predicate_value");
  const right = columnReference(node.right, qualifiers, true, "predicate_value");
  if ((left.parameter === null) === (right.parameter === null)) unsafe("predicate_value");
  const parameter = left.parameter ?? right.parameter;
  if (parameter === null) unsafe("predicate_value");
  parameters.add(parameter);
  return {
    column: left.parameter === null ? left.column : right.column,
    parameter,
    operator: node.operator.toUpperCase(),
  };
}

function validateReadPredicate(value: unknown, qualifiers: ReadonlySet<string>, parameters: Set<string>): void {
  const node = record(value, "expression");
  if (node.type === "binary_expr" && (node.operator === "AND" || node.operator === "OR")) {
    assertKnownKeys(node, ["type", "operator", "left", "right"], "binary_expr");
    validateReadPredicate(node.left, qualifiers, parameters);
    validateReadPredicate(node.right, qualifiers, parameters);
    return;
  }
  predicateLeaf(node, qualifiers, parameters, ALLOWED_READ_OPERATORS);
}

function validateJoinPredicate(
  value: unknown,
  qualifiers: ReadonlySet<string>,
  introducedQualifiers: ReadonlySet<string>,
): void {
  const node = record(value, "join");
  assertKnownKeys(node, ["type", "operator", "left", "right"], "join.binary_expr");
  if (node.type !== "binary_expr" || node.operator !== "=") unsafe("join");
  const left = columnReference(node.left, qualifiers, false, "join");
  const right = columnReference(node.right, qualifiers, false, "join");
  if (
    left.parameter !== null
    || right.parameter !== null
    || left.table === null
    || right.table === null
    || left.table.toLowerCase() === right.table.toLowerCase()
    || (
      !introducedQualifiers.has(left.table.toLowerCase())
      && !introducedQualifiers.has(right.table.toLowerCase())
    )
  ) {
    unsafe("join");
  }
}

function tableObject(node: UnknownRecord): { objectName: string; qualifiers: string[] } {
  if (node.schema !== undefined && node.schema !== null) unsafe("cross_database");
  const databaseOrSchema = nullableFixedIdentifier(node.db, "object_mismatch");
  const table = fixedIdentifier(node.table, "object_mismatch");
  const alias = nullableFixedIdentifier(node.as);
  const objectName = databaseOrSchema === null ? table : `${databaseOrSchema}.${table}`;
  return {
    objectName,
    qualifiers: [table, ...(alias === null ? [] : [alias])].map((value) => value.toLowerCase()),
  };
}

function validateFrom(value: unknown, expectedObjects: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) unsafe("table");
  const actualObjects: string[] = [];
  const qualifiers = new Set<string>();
  const nodes = value.map((item, index) => {
    const node = record(item, "table");
    if (node.server !== undefined || (node.schema !== undefined && node.schema !== null)) unsafe("cross_database");
    if (node.type === "expr") unsafe("external_source");
    if (node.expr !== undefined) unsafe("table");
    assertKnownKeys(node, [
      "db", "table", "as", "table_hint", "temporal_table", "operator", "join", "on", "schema",
    ], `from[${index}]`);
    if (node.table_hint !== null) unsafe("table_hint");
    if (node.temporal_table !== null || (node.operator !== undefined && node.operator !== null)) unsafe("table");
    const parsed = tableObject(node);
    actualObjects.push(parsed.objectName);
    for (const qualifier of parsed.qualifiers) {
      if (qualifiers.has(qualifier)) unsafe("table");
      qualifiers.add(qualifier);
    }
    return { node, introducedQualifiers: new Set(parsed.qualifiers) };
  });
  nodes.forEach(({ node, introducedQualifiers }, index) => {
    if (index === 0) {
      if (node.join !== undefined || node.on !== undefined) unsafe("join");
      return;
    }
    if (typeof node.join !== "string" || !ALLOWED_JOINS.has(node.join.toUpperCase()) || node.on === undefined) {
      unsafe("join");
    }
    validateJoinPredicate(node.on, qualifiers, introducedQualifiers);
  });
  if (new Set(actualObjects.map((objectName) => objectName.toLowerCase())).size !== actualObjects.length) unsafe("table");
  if (!sameCaseInsensitiveSet(actualObjects, expectedObjects)) unsafe("object_mismatch");
  return qualifiers;
}

function validateProjection(
  value: unknown,
  qualifiers: ReadonlySet<string>,
  expected: readonly SQLProjection[],
): { aliases: string[]; resultColumns: ReadonlyMap<string, string> } {
  if (!Array.isArray(value) || value.length === 0) unsafe("projection");
  const resultColumns = new Map<string, string>();
  const aliases = value.map((item, index) => {
    const column = record(item, "projection");
    assertKnownKeys(column, ["expr", "as"], `columns[${index}]`);
    const expression = columnReference(column.expr, qualifiers, false, "projection");
    if (expression.parameter !== null) unsafe("projection");
    const alias = column.as === null
      ? expression.column
      : typeof column.as === "string" && FIXED_IDENTIFIER.test(column.as)
        ? column.as
        : unsafe("projection");
    resultColumns.set(alias, expression.column);
    return alias;
  });
  orderedUnique(aliases, "projection");
  const expectedAliases = orderedUnique(expected.map((projection) => projection.sourceAlias), "projection_mismatch");
  orderedUnique(expected.map((projection) => projection.resultField), "projection_mismatch");
  if (!sameOrderedValues(aliases, expectedAliases)) unsafe("projection_mismatch");
  return { aliases, resultColumns };
}

function validateTop(value: unknown, maxResults: number | undefined): void {
  if (value === null) return;
  const top = record(value, "top");
  assertKnownKeys(top, ["value", "percent", "parentheses"], "top");
  if (!Number.isSafeInteger(top.value) || (top.value as number) < 1 || top.percent !== null) unsafe("top");
  if (top.parentheses !== undefined && top.parentheses !== false) unsafe("top");
  if (maxResults === undefined || top.value !== maxResults) unsafe("top");
}

function validateOrderBy(value: unknown, qualifiers: ReadonlySet<string>): void {
  if (value === null) return;
  if (!Array.isArray(value) || value.length === 0) unsafe("orderby");
  for (const [index, item] of value.entries()) {
    const order = record(item, "orderby");
    assertKnownKeys(order, ["expr", "type"], `orderby[${index}]`);
    if (order.type !== "ASC" && order.type !== "DESC") unsafe("orderby");
    const expression = columnReference(order.expr, qualifiers, false, "orderby");
    if (expression.parameter !== null) unsafe("orderby");
  }
}

function validateSelectTemplate(sql: string, options: SelectValidationOptions): ValidatedSelect {
  const declaredObjects = orderedUnique(
    options.declaredObjects.map(declaredObject),
    "object_mismatch",
  );
  const parsed = parseExactlyOne(sql);
  const statement = parsed.ast;
  if (statement.type !== "select") unsafe("statement_type");
  if (statement._next !== undefined || statement.set_op !== undefined) unsafe("set_operation");
  assertKnownKeys(statement, [
    "with", "type", "options", "distinct", "columns", "into", "from", "for", "where", "groupby",
    "having", "top", "orderby", "limit",
  ], "select");
  if (statement.with !== null) unsafe("with");
  if (statement.options !== null) unsafe("option");
  if (statement.distinct !== null) unsafe("distinct");
  const into = record(statement.into, "into");
  if (into.position !== null || Object.keys(into).some((key) => key !== "position")) unsafe("into");
  assertKnownKeys(into, ["position"], "into");
  if (statement.for !== null) unsafe("for");
  if (statement.having !== null) unsafe("having");
  if (statement.groupby !== null) unsafe("groupby");
  if (statement.limit !== null) unsafe("limit");
  validateTop(statement.top, options.maxResults);
  const qualifiers = validateFrom(statement.from, declaredObjects);
  const projection = validateProjection(statement.columns, qualifiers, options.projection);
  const parameters = new Set<string>();
  if (statement.where !== null) validateReadPredicate(statement.where, qualifiers, parameters);
  validateOrderBy(statement.orderby, qualifiers);
  return {
    normalizedSQL: parsed.normalizedSQL,
    parameterNames: parameters,
    resultAliases: new Set(projection.aliases),
    resultColumns: projection.resultColumns,
  };
}

function bindingNames(bindings: readonly SQLBinding[]): string[] {
  const parameters = orderedUnique(bindings.map((binding) => binding.parameter), "binding_mismatch");
  rejectCaseFoldedDuplicates(parameters, "binding_mismatch");
  return parameters;
}

function compareBindings(actual: ReadonlySet<string>, bindings: readonly SQLBinding[]): void {
  const expected = bindingNames(bindings);
  const actualParameters = [...actual];
  rejectCaseFoldedDuplicates(actualParameters, "binding_mismatch");
  if (!sameExactSet(actualParameters, expected)) unsafe("binding_mismatch");
}

export function validateReadOperation(operation: SQLReadOperation): ValidatedSQL {
  const validated = validateSelectTemplate(operation.sql, {
    declaredObjects: operation.declaredObjects,
    projection: operation.projection,
    maxResults: operation.maxResults,
  });
  compareBindings(validated.parameterNames, operation.bindings);
  return validated;
}

function validateUpdateTable(value: unknown, declared: string): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length !== 1) unsafe("table");
  const node = record(value[0], "table");
  assertKnownKeys(node, ["db", "table", "as", "table_hint", "temporal_table", "schema"], "update.table[0]");
  if (node.table_hint !== null || node.temporal_table !== null) unsafe("table_hint");
  const parsed = tableObject(node);
  if (parsed.objectName.toLowerCase() !== declared.toLowerCase()) unsafe("object_mismatch");
  return new Set(parsed.qualifiers);
}

function validateAssignments(
  value: unknown,
  qualifiers: ReadonlySet<string>,
  expectedColumns: readonly string[],
  parameters: Set<string>,
): ReadonlyMap<string, string> {
  if (!Array.isArray(value) || value.length === 0) unsafe("assignment_mismatch");
  const columns: string[] = [];
  const assignments = new Map<string, string>();
  for (const [index, item] of value.entries()) {
    const assignment = record(item, "assignment_mismatch");
    assertKnownKeys(assignment, ["column", "value", "table"], `set[${index}]`);
    if (assignment.table !== null) unsafe("assignment_mismatch");
    columns.push(fixedIdentifier(assignment.column, "assignment_mismatch"));
    const assigned = columnReference(assignment.value, qualifiers, true, "assignment_value");
    if (assigned.parameter === null) unsafe("assignment_value");
    parameters.add(assigned.parameter);
    assignments.set(columns[columns.length - 1].toLowerCase(), assigned.parameter);
  }
  orderedUnique(columns, "assignment_mismatch");
  if (!sameCaseInsensitiveSet(columns, expectedColumns)) unsafe("assignment_mismatch");
  return assignments;
}

function collectUpdateGuards(
  value: unknown,
  qualifiers: ReadonlySet<string>,
  parameters: Set<string>,
): Array<{ column: string; parameter: string }> {
  const node = record(value, "update_guard");
  if (node.type === "binary_expr" && node.operator === "AND") {
    assertKnownKeys(node, ["type", "operator", "left", "right"], "update.where");
    return [
      ...collectUpdateGuards(node.left, qualifiers, parameters),
      ...collectUpdateGuards(node.right, qualifiers, parameters),
    ];
  }
  try {
    const guard = predicateLeaf(node, qualifiers, parameters, new Set(["="]));
    return [{ column: guard.column, parameter: guard.parameter }];
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "unsafe_template") unsafe("update_guard");
    throw error;
  }
}

function validateUpdateTemplate(operation: SQLUpdateOperation): ValidatedUpdateTemplate {
  const declared = declaredObject(operation.declaredObject);
  const parsed = parseExactlyOne(operation.updateSql);
  const statement = parsed.ast;
  if (statement.type !== "update") unsafe("statement_type");
  assertKnownKeys(statement, ["with", "type", "table", "set", "from", "where"], "update");
  if (statement.with !== null) unsafe("with");
  if (statement.from !== null) unsafe("update_from");
  const qualifiers = validateUpdateTable(statement.table, declared);
  const expectedColumns = orderedUnique(
    operation.updateColumns.map((column) => fixedIdentifier(column, "assignment_mismatch")),
    "assignment_mismatch",
  );
  const parameters = new Set<string>();
  const assignments = validateAssignments(statement.set, qualifiers, expectedColumns, parameters);
  if (statement.where === null) unsafe("update_guard");
  const guards = collectUpdateGuards(statement.where, qualifiers, parameters);
  const resource = guards.some((guard) => guard.parameter === operation.resourceParameter);
  const concurrency = guards.some((guard) => (
    guard.parameter === operation.concurrencyParameter
      && guard.column.toLowerCase() === operation.versionField.toLowerCase()
  ));
  if (!resource || !concurrency || operation.resourceParameter === operation.concurrencyParameter) unsafe("update_guard");
  return {
    normalizedSQL: parsed.normalizedSQL,
    parameterNames: parameters,
    resultAliases: new Set(),
    assignments,
    guards,
  };
}

function validateUpdateMetadata(operation: SQLUpdateOperation): void {
  fixedIdentifier(operation.resourceParameter, "binding_mismatch");
  fixedIdentifier(operation.concurrencyParameter, "binding_mismatch");
  const updateColumns = orderedUnique(
    operation.updateColumns.map((column) => fixedIdentifier(column, "assignment_mismatch")),
    "assignment_mismatch",
  );
  const versionField = fixedIdentifier(operation.versionField, "update_guard");
  if (!updateColumns.some((column) => column.toLowerCase() === versionField.toLowerCase())) unsafe("assignment_mismatch");
  const proposedFields = orderedUnique(operation.proposed.map((field) => field.resultField), "assignment_mismatch");
  const projectionFields = orderedUnique(operation.projection.map((field) => field.resultField), "projection_mismatch");
  if (!proposedFields.every((field) => projectionFields.includes(field))) unsafe("projection_mismatch");
  const bindings = bindingNames(operation.bindings);
  orderedUnique(operation.bindings.map((binding) => binding.argument), "binding_mismatch");
  for (const field of operation.proposed) {
    if (field.argument !== undefined && !bindings.includes(field.argument)) unsafe("binding_mismatch");
  }
}

export function validateUpdateOperation(operation: SQLUpdateOperation): {
  before: ValidatedSQL;
  update: ValidatedSQL;
  readBack: ValidatedSQL;
} {
  validateUpdateMetadata(operation);
  const selectOptions = {
    declaredObjects: [operation.declaredObject],
    projection: operation.projection,
  };
  const before = validateSelectTemplate(operation.beforeSql, selectOptions);
  const update = validateUpdateTemplate(operation);
  const readBack = validateSelectTemplate(operation.readBackSql, selectOptions);
  if (!before.parameterNames.has(operation.resourceParameter) || !readBack.parameterNames.has(operation.resourceParameter)) {
    unsafe("update_guard");
  }
  const allParameters = new Set([
    ...before.parameterNames,
    ...update.parameterNames,
    ...readBack.parameterNames,
  ]);
  compareBindings(allParameters, operation.bindings);
  const resourceBinding = operation.bindings.find((binding) => binding.parameter === operation.resourceParameter);
  const resourceProjection = resourceBinding === undefined
    ? undefined
    : operation.projection.find((projection) => projection.resultField === resourceBinding.argument);
  const beforeResourceColumn = resourceProjection === undefined
    ? undefined
    : before.resultColumns.get(resourceProjection.sourceAlias);
  const readBackResourceColumn = resourceProjection === undefined
    ? undefined
    : readBack.resultColumns.get(resourceProjection.sourceAlias);
  if (
    beforeResourceColumn === undefined
    || readBackResourceColumn === undefined
    || beforeResourceColumn.toLowerCase() !== readBackResourceColumn.toLowerCase()
    || !update.guards.some((guard) => (
      guard.parameter === operation.resourceParameter
        && guard.column.toLowerCase() === beforeResourceColumn.toLowerCase()
    ))
  ) {
    unsafe("update_guard");
  }
  if (operation.proposed.length !== operation.updateColumns.length) unsafe("assignment_mismatch");
  operation.updateColumns.forEach((column, index) => {
    const proposedArgument = operation.proposed[index]?.argument;
    const binding = proposedArgument === undefined
      ? undefined
      : operation.bindings.find((candidate) => candidate.argument === proposedArgument);
    if (binding === undefined || update.assignments.get(column.toLowerCase()) !== binding.parameter) {
      unsafe("assignment_mismatch");
    }
  });
  return { before, update, readBack };
}

export function validateOperationBeforeExecution(operation: SQLOperation): void {
  if (operation.kind === "read") {
    validateReadOperation(operation);
    return;
  }
  validateUpdateOperation(operation);
}
