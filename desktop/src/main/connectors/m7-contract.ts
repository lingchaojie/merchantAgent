import type { PublicToolContract, SQLBinding, SQLOperation, SQLUpdateOperation } from "./schema";
import {
  readOperationUsesResourceParameter,
  updateOperationUsesProjectedParameter,
  validateOperationBeforeExecution,
} from "./sql-policy";

type ParameterType = "string" | "integer";

interface FixedTool {
  kind: "read" | "update";
  risk: "read" | "low_write";
  requiresConfirmation: boolean;
  resourceRelation: "viewer" | "operator";
  properties: Readonly<Record<string, ParameterType>>;
  required: readonly string[];
}

const FIXED_TOOLS: Readonly<Record<string, FixedTool>> = Object.freeze({
  query_order_status: Object.freeze({
    kind: "read",
    risk: "read",
    requiresConfirmation: false,
    resourceRelation: "viewer",
    properties: Object.freeze({ orderId: "string" }),
    required: Object.freeze(["orderId"]),
  }),
  report_production_progress: Object.freeze({
    kind: "update",
    risk: "low_write",
    requiresConfirmation: true,
    resourceRelation: "operator",
    properties: Object.freeze({
      orderId: "string",
      workOrderId: "string",
      completionRate: "integer",
      expectedVersion: "integer",
      note: "string",
    }),
    required: Object.freeze(["orderId", "workOrderId", "completionRate", "expectedVersion"]),
  }),
});

function contractError(): never {
  throw new Error("m7_contract");
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function assertTool(tool: PublicToolContract, expected: FixedTool): void {
  const names = Object.keys(tool.parameters.properties);
  const expectedNames = Object.keys(expected.properties);
  if (
    tool.parameters.type !== "object"
    || tool.parameters.additionalProperties !== false
    || !sameSet(names, expectedNames)
    || !sameSet(tool.parameters.required, expected.required)
    || names.some((name) => {
      const property = tool.parameters.properties[name];
      return property === undefined
        || property.type !== expected.properties[name]
        || Object.keys(property).some((key) => key !== "type");
    })
    || tool.risk !== expected.risk
    || tool.requiresConfirmation !== expected.requiresConfirmation
    || tool.resourceType !== "business_record"
    || tool.resourceKind !== "order"
    || tool.resourceArg !== "orderId"
    || tool.resourceRelation !== expected.resourceRelation
  ) {
    contractError();
  }
}

function assertBindingType(binding: SQLBinding, type: ParameterType): void {
  if (type === "integer") {
    if (binding.type !== "Int" || binding.maxLength !== undefined) contractError();
    return;
  }
  if (
    binding.type !== "NVarChar"
    || !Number.isSafeInteger(binding.maxLength)
    || binding.maxLength < 1
    || binding.maxLength > 4_000
  ) contractError();
}

function exactBindings(
  operation: SQLOperation,
  expected: FixedTool,
): ReadonlyMap<string, SQLBinding> {
  const expectedTypes: Record<string, ParameterType> = {
    ...expected.properties,
    ...(expected.kind === "update" ? { nextVersion: "integer" as const } : {}),
  };
  const names = Object.keys(expectedTypes);
  if (operation.bindings.length !== names.length) contractError();
  const bindings = new Map<string, SQLBinding>();
  for (const name of names) {
    const matches = operation.bindings.filter((binding) => binding.argument === name);
    if (matches.length !== 1) contractError();
    const binding = matches[0];
    const type = expectedTypes[name];
    if (binding === undefined || type === undefined) contractError();
    assertBindingType(binding, type);
    bindings.set(name, binding);
  }
  return bindings;
}

function exactProposedField(
  operation: SQLUpdateOperation,
  argument: string,
  resultField: string,
  preserveIfMissing: boolean | undefined,
): number {
  const indexes = operation.proposed.flatMap((field, index) => field.argument === argument ? [index] : []);
  if (indexes.length !== 1) contractError();
  const index = indexes[0];
  const field = operation.proposed[index];
  if (
    index === undefined
    || field === undefined
    || field.resultField !== resultField
    || field.preserveIfMissing !== preserveIfMissing
  ) contractError();
  return index;
}

function assertUpdateRoles(
  operation: SQLUpdateOperation,
  bindings: ReadonlyMap<string, SQLBinding>,
): void {
  if (
    operation.resourceParameter !== bindings.get("orderId")?.parameter
    || operation.concurrencyParameter !== bindings.get("expectedVersion")?.parameter
    || operation.versionField !== "version"
    || operation.proposed.length !== 3
  ) contractError();
  exactProposedField(operation, "completionRate", "completionRate", undefined);
  exactProposedField(operation, "note", "note", true);
  const versionIndex = exactProposedField(operation, "nextVersion", operation.versionField, undefined);
  if (operation.updateColumns[versionIndex]?.toLowerCase() !== operation.versionField.toLowerCase()) contractError();
}

export function assertM71Contract(
  publicContract: { tools: PublicToolContract[] },
  operations: SQLOperation[],
): void {
  const names = Object.keys(FIXED_TOOLS);
  if (publicContract.tools.length !== names.length || operations.length !== names.length) contractError();
  for (const name of names) {
    const tool = publicContract.tools.find((candidate) => candidate.name === name);
    const operation = operations.find((candidate) => candidate.tool === name);
    const expected = FIXED_TOOLS[name];
    if (tool === undefined || operation === undefined || expected === undefined || operation.kind !== expected.kind) {
      contractError();
    }
    assertTool(tool, expected);
    const bindings = exactBindings(operation, expected);
    try {
      if (operation.kind === "update") {
        assertUpdateRoles(operation, bindings);
        const workOrderParameter = bindings.get("workOrderId")?.parameter;
        if (
          workOrderParameter === undefined
          || !updateOperationUsesProjectedParameter(operation, workOrderParameter, "workOrderId")
        ) contractError();
      } else {
        const orderParameter = bindings.get("orderId")?.parameter;
        if (
          orderParameter === undefined
          || !readOperationUsesResourceParameter(operation, orderParameter, "orderId")
        ) contractError();
      }
      validateOperationBeforeExecution(operation);
    } catch {
      contractError();
    }
  }
}

function snapshotArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) contractError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) contractError();
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") contractError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) contractError();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

export function prepareM71Arguments(toolName: string, input: unknown): Record<string, unknown> {
  const expected = FIXED_TOOLS[toolName];
  if (expected === undefined) contractError();
  const args = snapshotArgs(input);
  const names = Object.keys(args);
  const expectedNames = Object.keys(expected.properties);
  if (
    names.some((name) => !expectedNames.includes(name))
    || expected.required.some((name) => !Object.hasOwn(args, name))
  ) contractError();
  for (const name of names) {
    const type = expected.properties[name];
    const value = args[name];
    if ((type === "string" && typeof value !== "string") || (type === "integer" && !Number.isSafeInteger(value))) {
      contractError();
    }
  }
  if (toolName === "report_production_progress") {
    const expectedVersion = args.expectedVersion as number;
    if (expectedVersion >= 2_147_483_647) contractError();
    args.nextVersion = expectedVersion + 1;
  }
  return args;
}
