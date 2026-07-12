import { createHash, randomUUID, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalJSONStringify } from "./canonical";
import {
  defaultACLProtector,
  type ACLProtector,
  type ConnectorPackageReadIdentity,
  type ConnectorSigningIdentity,
  type SafeStorageLike,
} from "./device-identity";
import {
  parseEd25519PublicKeyPem,
  verifyImplementationCredential,
} from "./implementation-credential";
import {
  ConnectorSchemaError,
  parseConnectorDraft,
  parseConnectorPrivatePayload,
  parseInstalledConnectorEnvelope,
  type ConnectorDraft,
  type ConnectorPrivatePayload,
  type InstalledConnectorEnvelope,
} from "./schema";

export interface InstalledConnectorRef {
  connectorId: string;
  version: string;
}

export interface InstalledConnector {
  ref: InstalledConnectorRef;
  path: string;
  manifest: InstalledConnectorEnvelope["manifest"];
}

export interface LoadedApprovedConnector extends InstalledConnector {
  payload: ConnectorPrivatePayload;
}

export type ConnectorPackageErrorCode = "package_integrity" | "package_version";

export class ConnectorPackageError extends Error {
  constructor(readonly code: ConnectorPackageErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ConnectorPackageError";
  }
}

function packageError(code: ConnectorPackageErrorCode, detail: string): never {
  throw new ConnectorPackageError(code, detail);
}

function packageIntegrity(detail: string): never {
  return packageError("package_integrity", detail);
}

function parseSignedAt(value: string): Date {
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    formatRFC3339Nano(parsed) !== value
  ) {
    return packageIntegrity("signedAt is not an RFC3339 UTC timestamp");
  }
  return parsed;
}

function formatRFC3339Nano(value: Date): string {
  return value.toISOString().replace(/\.(\d{3})Z$/, (_match, milliseconds: string) => {
    const fraction = milliseconds.replace(/0+$/, "");
    return fraction.length === 0 ? "Z" : `.${fraction}Z`;
  });
}

function safeReference(ref: InstalledConnectorRef): InstalledConnectorRef {
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (
    typeof ref !== "object" ||
    ref === null ||
    !segment.test(ref.connectorId) ||
    !segment.test(ref.version) ||
    Object.keys(ref).some((key) => key !== "connectorId" && key !== "version")
  ) {
    return packageIntegrity("connector reference is invalid");
  }
  return ref;
}

function decodeCanonicalBase64URL(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return packageIntegrity("signature is malformed");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 64 || decoded.toString("base64url") !== value) {
    return packageIntegrity("signature is malformed");
  }
  return decoded;
}

function sameJSON(left: unknown, right: unknown): boolean {
  return canonicalJSONStringify(left) === canonicalJSONStringify(right);
}

export function submissionSigningInput(
  tenantId: string,
  deviceId: string,
  connectorId: string,
  version: string,
  digest: string,
  signedAt: string,
): string {
  return [
    "merchantagent.connector.submit.v1",
    tenantId,
    deviceId,
    connectorId,
    version,
    digest,
    signedAt,
  ].join("\n");
}

class ConnectorPackageCore {
  private readonly connectorsDirectory: string;

  constructor(
    userDataPath: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly identity: ConnectorPackageReadIdentity,
    private readonly aclProtector: ACLProtector = defaultACLProtector(),
  ) {
    this.connectorsDirectory = path.join(userDataPath, "connectors");
  }

  install(draftInput: ConnectorDraft, signedAtInput: Date = new Date()): InstalledConnector {
    const signingIdentity = this.requireSigningIdentity();
    try {
      signingIdentity.assertCurrentAuthorization();
    } catch {
      return packageIntegrity("implementation credential is not currently authorized to install");
    }
    this.requireEncryption();
    let draft: ConnectorDraft;
    try {
      draft = parseConnectorDraft(draftInput);
    } catch (error) {
      if (error instanceof ConnectorSchemaError) return packageIntegrity(error.message);
      throw error;
    }
    if (draft.state !== "locally_validated") return packageIntegrity("draft is not locally validated");
    if (!Number.isFinite(signedAtInput.getTime())) return packageIntegrity("signedAt is invalid");
    const signedAt = formatRFC3339Nano(signedAtInput);
    let credential;
    try {
      credential = verifyImplementationCredential(
        signingIdentity.implementationCredential,
        signingIdentity.platformPublicKeyPem,
        signedAtInput,
      );
    } catch {
      return packageIntegrity("implementation credential is invalid at signing time");
    }
    if (
      credential.credentialId !== signingIdentity.verifiedCredential.credentialId ||
      credential.tenantId !== draft.tenantId ||
      credential.deviceId !== draft.deviceId ||
      credential.deviceId !== signingIdentity.deviceId ||
      !parseEd25519PublicKeyPem(credential.devicePublicKeyPem)
        .export({ type: "spki", format: "der" })
        .equals(parseEd25519PublicKeyPem(signingIdentity.devicePublicKeyPem).export({ type: "spki", format: "der" }))
    ) {
      return packageIntegrity("draft, credential, and device identity are not bound");
    }

    const canonicalPayload = canonicalJSONStringify(draft.payload);
    const digest = `sha256:${createHash("sha256").update(canonicalPayload, "utf8").digest("hex")}`;
    const manifest: InstalledConnectorEnvelope["manifest"] = {
      connectorId: draft.payload.connectorId,
      version: draft.payload.version,
      adapter: "sqlserver",
      environment: draft.payload.profile.environment,
      digest,
      publicContract: draft.payload.publicContract,
      checks: {
        checkerVersion: draft.payload.checker.version,
        rulesetVersion: "m7.1-sql-v1",
        testsDigest: draft.payload.checker.testsDigest,
      },
      credentialId: credential.credentialId,
      deviceId: credential.deviceId,
      signedAt,
    };
    const ref = { connectorId: manifest.connectorId, version: manifest.version };
    const packagePath = this.packagePath(ref);
    if (fs.existsSync(packagePath)) {
      const existing = this.loadApproved(ref, digest);
      return { ref, path: packagePath, manifest: existing.manifest };
    }
    let implementationSignature: string;
    try {
      implementationSignature = signingIdentity.sign(
        submissionSigningInput(
          credential.tenantId,
          credential.deviceId,
          manifest.connectorId,
          manifest.version,
          manifest.digest,
          manifest.signedAt,
        ),
      );
    } catch {
      return packageIntegrity("implementation credential is not currently authorized to sign");
    }
    const envelope: InstalledConnectorEnvelope = {
      manifest,
      encryptedPayload: this.safeStorage.encryptString(canonicalPayload).toString("base64"),
      implementationCredential: signingIdentity.implementationCredential,
      implementationSignature,
    };
    const created = this.atomicWrite(packagePath, `${JSON.stringify(envelope, null, 2)}\n`);
    if (!created) {
      const winner = this.loadApproved(ref, digest);
      this.aclProtector.protect(packagePath);
      return { ref, path: packagePath, manifest: winner.manifest };
    }
    return { ref, path: packagePath, manifest };
  }

  loadApproved(refInput: InstalledConnectorRef, approvedDigest: string): LoadedApprovedConnector {
    this.requireEncryption();
    const ref = safeReference(refInput);
    const packagePath = this.packagePath(ref);
    let envelope: InstalledConnectorEnvelope;
    try {
      envelope = parseInstalledConnectorEnvelope(JSON.parse(fs.readFileSync(packagePath, "utf8")));
    } catch (error) {
      if (error instanceof ConnectorPackageError) throw error;
      return packageIntegrity("package envelope cannot be read or validated");
    }
    if (envelope.manifest.connectorId !== ref.connectorId || envelope.manifest.version !== ref.version) {
      return packageError("package_version", "package reference does not match manifest");
    }
    if (approvedDigest !== envelope.manifest.digest) {
      return packageError("package_version", "approved digest does not match installed package");
    }

    const signedAt = parseSignedAt(envelope.manifest.signedAt);
    let credential;
    try {
      credential = verifyImplementationCredential(
        envelope.implementationCredential,
        this.identity.platformPublicKeyPem,
        signedAt,
      );
    } catch {
      return packageIntegrity("implementation credential verification failed");
    }
    if (
      credential.credentialId !== envelope.manifest.credentialId ||
      credential.deviceId !== envelope.manifest.deviceId ||
      credential.deviceId !== this.identity.deviceId ||
      credential.tenantId !== this.identity.tenantId
    ) {
      return packageIntegrity("manifest is not bound to the implementation credential and local device");
    }
    const credentialKey = parseEd25519PublicKeyPem(credential.devicePublicKeyPem);
    const localKey = parseEd25519PublicKeyPem(this.identity.devicePublicKeyPem);
    if (
      !credentialKey.export({ type: "spki", format: "der" }).equals(localKey.export({ type: "spki", format: "der" }))
    ) {
      return packageIntegrity("implementation credential is bound to another device key");
    }
    const signingInput = submissionSigningInput(
      credential.tenantId,
      credential.deviceId,
      envelope.manifest.connectorId,
      envelope.manifest.version,
      envelope.manifest.digest,
      envelope.manifest.signedAt,
    );
    if (
      !verify(
        null,
        Buffer.from(signingInput, "utf8"),
        credentialKey,
        decodeCanonicalBase64URL(envelope.implementationSignature),
      )
    ) {
      return packageIntegrity("implementation signature verification failed");
    }

    let canonicalPayload: string;
    try {
      canonicalPayload = this.safeStorage.decryptString(Buffer.from(envelope.encryptedPayload, "base64"));
    } catch {
      return packageIntegrity("encrypted payload cannot be decrypted");
    }
    let payload: ConnectorPrivatePayload;
    try {
      const decoded: unknown = JSON.parse(canonicalPayload);
      payload = parseConnectorPrivatePayload(decoded);
      if (canonicalJSONStringify(decoded) !== canonicalPayload) return packageIntegrity("payload is not canonical JSON");
    } catch (error) {
      if (error instanceof ConnectorPackageError) throw error;
      return packageIntegrity("decrypted payload schema is invalid");
    }
    const digest = `sha256:${createHash("sha256").update(canonicalPayload, "utf8").digest("hex")}`;
    if (digest !== envelope.manifest.digest) return packageIntegrity("payload digest does not match manifest");
    if (
      payload.connectorId !== envelope.manifest.connectorId ||
      payload.version !== envelope.manifest.version ||
      payload.adapter !== envelope.manifest.adapter ||
      payload.profile.environment !== envelope.manifest.environment ||
      !sameJSON(payload.publicContract, envelope.manifest.publicContract) ||
      payload.checker.version !== envelope.manifest.checks.checkerVersion ||
      payload.checker.rulesetVersion !== envelope.manifest.checks.rulesetVersion ||
      payload.checker.testsDigest !== envelope.manifest.checks.testsDigest
    ) {
      return packageIntegrity("public manifest does not match private payload");
    }
    return { ref, path: packagePath, manifest: envelope.manifest, payload };
  }

  private requireSigningIdentity(): ConnectorSigningIdentity {
    const candidate = this.identity as Partial<ConnectorSigningIdentity>;
    if (
      typeof candidate.sign !== "function" ||
      typeof candidate.assertCurrentAuthorization !== "function" ||
      typeof candidate.implementationCredential !== "string" ||
      candidate.verifiedCredential === undefined
    ) {
      return packageIntegrity("a current signing identity is required to install packages");
    }
    return candidate as ConnectorSigningIdentity;
  }

  private requireEncryption(): void {
    if (!this.safeStorage.isEncryptionAvailable()) return packageIntegrity("safeStorage encryption is unavailable");
  }

  private packagePath(refInput: InstalledConnectorRef): string {
    const ref = safeReference(refInput);
    return path.join(this.connectorsDirectory, ref.connectorId, `${ref.version}.ma-connector`);
  }

  private atomicWrite(packagePath: string, contents: string): boolean {
    fs.mkdirSync(path.dirname(packagePath), { recursive: true });
    const temporaryPath = `${packagePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      this.aclProtector.protect(temporaryPath);
      try {
        fs.linkSync(temporaryPath, packagePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      return true;
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}

export class ConnectorPackageReader {
  readonly #core: ConnectorPackageCore;

  constructor(
    userDataPath: string,
    safeStorage: SafeStorageLike,
    identity: ConnectorPackageReadIdentity,
    aclProtector: ACLProtector = defaultACLProtector(),
  ) {
    this.#core = new ConnectorPackageCore(userDataPath, safeStorage, identity, aclProtector);
  }

  loadApproved(ref: InstalledConnectorRef, approvedDigest: string): LoadedApprovedConnector {
    return this.#core.loadApproved(ref, approvedDigest);
  }
}

export class ConnectorPackageStore extends ConnectorPackageCore {
  constructor(
    userDataPath: string,
    safeStorage: SafeStorageLike,
    identity: ConnectorSigningIdentity,
    aclProtector: ACLProtector = defaultACLProtector(),
  ) {
    super(userDataPath, safeStorage, identity, aclProtector);
  }
}
