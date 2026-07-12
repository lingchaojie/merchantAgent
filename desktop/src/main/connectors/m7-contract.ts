import type { PublicToolContract, SQLOperation } from "./schema";

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
    const bindingArguments = operation.bindings.map((binding) => binding.argument);
    const expectedArguments = expected.kind === "update"
      ? [...Object.keys(expected.properties), "nextVersion"]
      : Object.keys(expected.properties);
    if (!sameSet(bindingArguments, expectedArguments)) contractError();
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
