import {
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { VerifiedImplementationCredential } from "./schema";

const REQUIRED_SCOPES = ["connector:draft", "connector:test", "connector:submit"] as const;
const CLAIM_KEYS = new Set([
  "credentialId",
  "tenantId",
  "deviceId",
  "devicePublicKeyPem",
  "scopes",
  "issuedAt",
  "expiresAt",
]);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PUBLIC KEY-----\r?\n?$/;

export type ImplementationCredentialErrorCode =
  | "implementation_credential_invalid"
  | "implementation_credential_expired"
  | "implementation_credential_scope"
  | "implementation_credential_device_mismatch";

export class ImplementationCredentialError extends Error {
  constructor(readonly code: ImplementationCredentialErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ImplementationCredentialError";
  }
}

function credentialError(code: ImplementationCredentialErrorCode, detail: string): never {
  throw new ImplementationCredentialError(code, detail);
}

function decodeBase64URL(value: string, field: string): Buffer {
  if (!BASE64URL.test(value)) return credentialError("implementation_credential_invalid", `${field} is malformed`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    return credentialError("implementation_credential_invalid", `${field} is not canonical base64url`);
  }
  return decoded;
}

export function parseEd25519PublicKeyPem(pem: string | Buffer): KeyObject {
  const text = Buffer.isBuffer(pem) ? pem.toString("utf8") : pem;
  const match = typeof text === "string" ? PUBLIC_KEY_PEM.exec(text) : null;
  if (!match) {
    return credentialError("implementation_credential_invalid", "public verification material is missing or malformed");
  }
  const body = match[1].replace(/\r?\n/g, "");
  if (body.length === 0 || Buffer.from(body, "base64").toString("base64") !== body) {
    return credentialError("implementation_credential_invalid", "public verification material is not canonical PEM");
  }
  try {
    const key = createPublicKey(text);
    if (key.asymmetricKeyType !== "ed25519") {
      return credentialError("implementation_credential_invalid", "public verification key must be Ed25519");
    }
    return key;
  } catch (error) {
    if (error instanceof ImplementationCredentialError) throw error;
    return credentialError("implementation_credential_invalid", "public verification key cannot be parsed");
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return credentialError("implementation_credential_invalid", `${field} is required`);
  }
  return value;
}

function exactScopes(value: unknown): VerifiedImplementationCredential["scopes"] {
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string")) {
    return credentialError("implementation_credential_scope", "submission scopes are invalid");
  }
  const scopes = value as string[];
  if (
    scopes.length !== REQUIRED_SCOPES.length ||
    new Set(scopes).size !== scopes.length ||
    REQUIRED_SCOPES.some((scope) => !scopes.includes(scope))
  ) {
    return credentialError("implementation_credential_scope", "exact submission scopes are required");
  }
  return scopes as VerifiedImplementationCredential["scopes"];
}

export function verifyImplementationCredential(
  encoded: string,
  platformPublicKey: string | Buffer,
  now: Date = new Date(),
): VerifiedImplementationCredential {
  if (typeof encoded !== "string") return credentialError("implementation_credential_invalid", "credential must be encoded text");
  const parts = encoded.split(".");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    return credentialError("implementation_credential_invalid", "credential envelope is malformed");
  }
  const payload = decodeBase64URL(parts[0], "payload");
  const signature = decodeBase64URL(parts[1], "signature");
  if (signature.length !== 64) return credentialError("implementation_credential_invalid", "signature length is invalid");
  const platformKey = parseEd25519PublicKeyPem(platformPublicKey);
  if (!verify(null, payload, platformKey, signature)) {
    return credentialError("implementation_credential_invalid", "platform signature verification failed");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8"));
  } catch {
    return credentialError("implementation_credential_invalid", "claims are not valid JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return credentialError("implementation_credential_invalid", "claims must be an object");
  }
  const claims = decoded as Record<string, unknown>;
  if (Object.keys(claims).length !== CLAIM_KEYS.size || Object.keys(claims).some((key) => !CLAIM_KEYS.has(key))) {
    return credentialError("implementation_credential_invalid", "claims contain missing or unknown fields");
  }
  const issuedAt = claims.issuedAt;
  const expiresAt = claims.expiresAt;
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    (issuedAt as number) <= 0 ||
    (expiresAt as number) <= (issuedAt as number)
  ) {
    return credentialError("implementation_credential_invalid", "credential interval is invalid");
  }
  if (!Number.isFinite(now.getTime())) return credentialError("implementation_credential_invalid", "verification time is invalid");
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (nowSeconds < (issuedAt as number) || nowSeconds >= (expiresAt as number)) {
    return credentialError("implementation_credential_expired", "credential is expired or not yet valid");
  }
  const devicePublicKeyPem = nonEmptyString(claims.devicePublicKeyPem, "devicePublicKeyPem");
  parseEd25519PublicKeyPem(devicePublicKeyPem);
  return {
    credentialId: nonEmptyString(claims.credentialId, "credentialId"),
    tenantId: nonEmptyString(claims.tenantId, "tenantId"),
    deviceId: nonEmptyString(claims.deviceId, "deviceId"),
    devicePublicKeyPem,
    scopes: exactScopes(claims.scopes),
    issuedAt: new Date((issuedAt as number) * 1000).toISOString(),
    expiresAt: new Date((expiresAt as number) * 1000).toISOString(),
  };
}

export function loadBundledPlatformPublicKey(resourcesPath: string = process.resourcesPath): string {
  const keyPath = path.join(resourcesPath, "implementation", "platform-public.pem");
  let pem: string;
  try {
    pem = fs.readFileSync(keyPath, "utf8");
  } catch {
    return credentialError("implementation_credential_invalid", "platform public verification material is unavailable");
  }
  parseEd25519PublicKeyPem(pem);
  return pem;
}
