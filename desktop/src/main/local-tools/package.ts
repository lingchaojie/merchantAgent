import { createHash, verify } from "node:crypto";
import fs from "node:fs";

const REFERENCE_PACKAGE_ID = "reference-manufacturing";
const REFERENCE_PACKAGE_VERSION = "1.0.0";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type LocalToolErrorCode =
  | "package_integrity"
  | "package_version"
  | "tool_not_installed"
  | "invalid_argument"
  | "missing_datasource"
  | "invalid_credentials"
  | "source_conflict";

export class LocalToolError extends Error {
  constructor(readonly code: LocalToolErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "LocalToolError";
  }
}

type JsonType = "string" | "integer" | "boolean";

export interface ParameterSchema {
  type: "object";
  properties: Record<string, { type: JsonType }>;
  required: string[];
  additionalProperties: false;
}

export interface CapabilityToolManifest {
  name: string;
  parameters: ParameterSchema;
  resultFields: string[];
  execution: "desktop";
  risk: "read" | "low_write";
  requiresConfirmation: boolean;
}

export interface CapabilityManifest {
  packageId: string;
  version: string;
  tools: CapabilityToolManifest[];
}

export interface VerifiedTool extends CapabilityToolManifest {
  validate(args: Record<string, unknown>): void;
}

export interface VerifiedPackage {
  manifest: CapabilityManifest;
  manifestDigest: string;
  requireTool(
    packageId: string,
    packageVersion: string,
    manifestDigest: string,
    toolName: string,
  ): VerifiedTool;
}

interface CapabilityEnvelope {
  payload: string;
  signature: string;
  manifestDigest: string;
}

function integrity(detail: string): never {
  throw new LocalToolError("package_integrity", detail);
}

function decodeBase64(value: unknown, field: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || !BASE64.test(value)) {
    return integrity(`${field} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    return integrity(`${field} is not canonical base64`);
  }
  return decoded;
}

function parseEnvelope(packagePath: string): CapabilityEnvelope {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return integrity("package envelope must be an object");
    }
    const envelope = parsed as Record<string, unknown>;
    if (
      typeof envelope.payload !== "string" ||
      typeof envelope.signature !== "string" ||
      typeof envelope.manifestDigest !== "string"
    ) {
      return integrity("package envelope fields are invalid");
    }
    return envelope as unknown as CapabilityEnvelope;
  } catch (error) {
    if (error instanceof LocalToolError) throw error;
    return integrity("package envelope cannot be read");
  }
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return integrity(`${field} must be an array of strings`);
  }
  return value;
}

function parseParameterSchema(value: unknown, toolName: string): ParameterSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return integrity(`${toolName} parameters are invalid`);
  }
  const schema = value as Record<string, unknown>;
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    typeof schema.properties !== "object" ||
    schema.properties === null ||
    Array.isArray(schema.properties)
  ) {
    return integrity(`${toolName} parameter schema is not closed`);
  }
  const properties: Record<string, { type: JsonType }> = {};
  for (const [name, rawProperty] of Object.entries(schema.properties)) {
    if (
      typeof rawProperty !== "object" ||
      rawProperty === null ||
      Array.isArray(rawProperty) ||
      !["string", "integer", "boolean"].includes(String((rawProperty as Record<string, unknown>).type))
    ) {
      return integrity(`${toolName}.${name} has an unsupported parameter type`);
    }
    properties[name] = { type: (rawProperty as { type: JsonType }).type };
  }
  const required = requireStringArray(schema.required, `${toolName}.required`);
  if (required.some((name) => !(name in properties))) {
    return integrity(`${toolName} requires an undeclared parameter`);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function parseManifest(payload: Buffer): CapabilityManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return integrity("signed payload is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return integrity("manifest must be an object");
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.packageId !== "string" || typeof raw.version !== "string" || !Array.isArray(raw.tools)) {
    return integrity("manifest fields are invalid");
  }
  const tools = raw.tools.map((value): CapabilityToolManifest => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return integrity("tool manifest is invalid");
    }
    const tool = value as Record<string, unknown>;
    if (
      typeof tool.name !== "string" ||
      tool.execution !== "desktop" ||
      (tool.risk !== "read" && tool.risk !== "low_write") ||
      typeof tool.requiresConfirmation !== "boolean"
    ) {
      return integrity("tool execution policy is invalid");
    }
    if (
      (tool.risk === "read" && tool.requiresConfirmation) ||
      (tool.risk === "low_write" && !tool.requiresConfirmation)
    ) {
      return integrity(`${tool.name} confirmation policy does not match its risk`);
    }
    return {
      name: tool.name,
      parameters: parseParameterSchema(tool.parameters, tool.name),
      resultFields: requireStringArray(tool.resultFields, `${tool.name}.resultFields`),
      execution: "desktop",
      risk: tool.risk,
      requiresConfirmation: tool.requiresConfirmation,
    };
  });
  return { packageId: raw.packageId, version: raw.version, tools };
}

function validateArguments(schema: ParameterSchema, args: Record<string, unknown>): void {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new LocalToolError("invalid_argument", "args must be an object");
  }
  for (const name of Object.keys(args)) {
    if (!(name in schema.properties)) {
      throw new LocalToolError("invalid_argument", `unknown argument ${name}`);
    }
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = args[name];
    if (value === undefined || value === null || (property.type === "string" && value === "")) {
      if (schema.required.includes(name)) {
        throw new LocalToolError("invalid_argument", `missing required argument ${name}`);
      }
      continue;
    }
    if (property.type === "string" && typeof value !== "string") {
      throw new LocalToolError("invalid_argument", `${name} must be string`);
    }
    if (property.type === "boolean" && typeof value !== "boolean") {
      throw new LocalToolError("invalid_argument", `${name} must be boolean`);
    }
    if (property.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
      throw new LocalToolError("invalid_argument", `${name} must be integer`);
    }
  }
}

export function verifyCapabilityPackage(packagePath: string, publicKeyPath: string): VerifiedPackage {
  const envelope = parseEnvelope(packagePath);
  const payload = decodeBase64(envelope.payload, "payload");
  const signature = decodeBase64(envelope.signature, "signature");
  let signatureValid = false;
  try {
    signatureValid = verify(null, payload, fs.readFileSync(publicKeyPath), signature);
  } catch {
    return integrity("signature could not be verified");
  }
  if (!signatureValid) return integrity("signature is invalid");

  const computedDigest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
  if (envelope.manifestDigest !== computedDigest) return integrity("manifest digest does not match payload");

  const manifest = parseManifest(payload);
  if (manifest.packageId !== REFERENCE_PACKAGE_ID || manifest.version !== REFERENCE_PACKAGE_VERSION) {
    throw new LocalToolError("package_version", "unsupported package identity or version");
  }
  const tools = new Map<string, VerifiedTool>();
  for (const tool of manifest.tools) {
    if (tools.has(tool.name)) return integrity(`duplicate tool ${tool.name}`);
    tools.set(tool.name, { ...tool, validate: (args) => validateArguments(tool.parameters, args) });
  }

  return {
    manifest,
    manifestDigest: computedDigest,
    requireTool(packageId, packageVersion, manifestDigest, toolName) {
      if (
        packageId !== manifest.packageId ||
        packageVersion !== manifest.version ||
        manifestDigest !== computedDigest
      ) {
        throw new LocalToolError("package_version", "request does not target the installed package");
      }
      const tool = tools.get(toolName);
      if (!tool) throw new LocalToolError("tool_not_installed", `tool ${toolName} is not installed`);
      return tool;
    },
  };
}
