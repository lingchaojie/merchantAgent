import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  ImplementationCredentialError,
  parseEd25519PublicKeyPem,
  verifyImplementationCredential,
} from "./implementation-credential";
import type { VerifiedImplementationCredential } from "./schema";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export interface ACLProtector {
  protect(filePath: string): void;
}

export interface DeviceEnrollment {
  deviceId: string;
  devicePublicKeyPem: string;
  fingerprint: string;
}

export interface ConnectorPackageReadIdentity extends DeviceEnrollment {
  tenantId: string;
  platformPublicKeyPem: string;
}

export interface ConnectorSigningIdentity extends ConnectorPackageReadIdentity {
  implementationCredential: string;
  verifiedCredential: VerifiedImplementationCredential;
  assertCurrentAuthorization(): VerifiedImplementationCredential;
  sign(input: string): string;
}

type ExecuteText = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; windowsHide: true; shell: false },
) => string;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class WindowsACLProtector implements ACLProtector {
  private readonly execute: ExecuteText;

  constructor(execute?: ExecuteText) {
    this.execute = execute ?? ((file, args, options) => execFileSync(file, [...args], options));
  }

  protect(filePath: string): void {
    const output = this.execute("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    const match = /^"(?:[^"]|"")*","(S-\d+(?:-\d+)+)"\r?\n?$/.exec(output);
    if (!match) throw new Error("device_acl: current Windows SID could not be determined");
    this.execute(
      "icacls.exe",
      // icacls requires '*' to treat a numeric SID as a SID instead of an account name.
      [filePath, "/inheritance:r", "/grant:r", `*${match[1]}:(F)`],
      { encoding: "utf8", windowsHide: true, shell: false },
    );
  }
}

class OwnerOnlyACLProtector implements ACLProtector {
  protect(filePath: string): void {
    fs.chmodSync(filePath, 0o600);
  }
}

export function defaultACLProtector(): ACLProtector {
  return process.platform === "win32" ? new WindowsACLProtector() : new OwnerOnlyACLProtector();
}

interface StoredDeviceIdentity {
  schemaVersion: 1;
  deviceId: string;
  devicePublicKeyPem: string;
  encryptedPrivateKey: string;
}

interface LoadedDeviceIdentity {
  enrollment: DeviceEnrollment;
  privateKey: KeyObject;
}

export class DeviceIdentityStore {
  readonly identityPath: string;

  constructor(
    userDataPath: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly aclProtector: ACLProtector = defaultACLProtector(),
    private readonly createDeviceId: () => string = randomUUID,
    private readonly currentTime: () => Date = () => new Date(),
  ) {
    this.identityPath = path.join(userDataPath, "connectors", "device-identity.json");
  }

  loadOrCreate(): DeviceEnrollment {
    if (fs.existsSync(this.identityPath)) return this.load().enrollment;
    this.requireEncryption();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const devicePublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const stored: StoredDeviceIdentity = {
      schemaVersion: 1,
      deviceId: this.createDeviceId(),
      devicePublicKeyPem,
      encryptedPrivateKey: this.safeStorage.encryptString(privateKeyPem).toString("base64"),
    };
    const created = this.atomicWrite(`${JSON.stringify(stored, null, 2)}\n`);
    if (!created) return this.load().enrollment;
    return this.enrollment(stored.deviceId, publicKey, devicePublicKeyPem);
  }

  bindImplementationCredential(
    implementationCredential: string,
    platformPublicKeyPem: string,
    now: Date = new Date(),
  ): ConnectorSigningIdentity {
    const identity = this.load();
    const verifiedCredential = verifyImplementationCredential(implementationCredential, platformPublicKeyPem, now);
    const credentialKey = parseEd25519PublicKeyPem(verifiedCredential.devicePublicKeyPem);
    const localKey = parseEd25519PublicKeyPem(identity.enrollment.devicePublicKeyPem);
    if (
      verifiedCredential.deviceId !== identity.enrollment.deviceId ||
      !credentialKey.export({ type: "spki", format: "der" }).equals(localKey.export({ type: "spki", format: "der" }))
    ) {
      throw new ImplementationCredentialError(
        "implementation_credential_device_mismatch",
        "credential is not bound to this device identity",
      );
    }
    const assertCurrentAuthorization = (): VerifiedImplementationCredential =>
      verifyImplementationCredential(
        implementationCredential,
        platformPublicKeyPem,
        this.currentTime(),
      );
    return {
      ...identity.enrollment,
      tenantId: verifiedCredential.tenantId,
      implementationCredential,
      verifiedCredential,
      platformPublicKeyPem,
      assertCurrentAuthorization,
      sign: (input: string) => {
        assertCurrentAuthorization();
        return sign(null, Buffer.from(input, "utf8"), identity.privateKey).toString("base64url");
      },
    };
  }

  loadPackageReaderIdentity(
    tenantId: string,
    platformPublicKeyPem: string,
  ): ConnectorPackageReadIdentity {
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new Error("device_identity_integrity: tenant is required");
    }
    parseEd25519PublicKeyPem(platformPublicKeyPem);
    return {
      ...this.load().enrollment,
      tenantId,
      platformPublicKeyPem,
    };
  }

  private requireEncryption(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("device_identity_encryption_unavailable");
    }
  }

  private enrollment(deviceId: string, publicKey: KeyObject, devicePublicKeyPem: string): DeviceEnrollment {
    const der = publicKey.export({ type: "spki", format: "der" });
    return {
      deviceId,
      devicePublicKeyPem,
      fingerprint: `sha256:${createHash("sha256").update(der).digest("hex")}`,
    };
  }

  private load(): LoadedDeviceIdentity {
    this.requireEncryption();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.identityPath, "utf8"));
    } catch {
      throw new Error("device_identity_integrity: identity file cannot be read");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("device_identity_integrity: identity envelope is invalid");
    }
    const raw = parsed as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (
      keys.length !== 4 ||
      keys.some((key) => !["schemaVersion", "deviceId", "devicePublicKeyPem", "encryptedPrivateKey"].includes(key)) ||
      raw.schemaVersion !== 1 ||
      typeof raw.deviceId !== "string" ||
      raw.deviceId.length === 0 ||
      typeof raw.devicePublicKeyPem !== "string" ||
      typeof raw.encryptedPrivateKey !== "string" ||
      !BASE64.test(raw.encryptedPrivateKey) ||
      Buffer.from(raw.encryptedPrivateKey, "base64").toString("base64") !== raw.encryptedPrivateKey
    ) {
      throw new Error("device_identity_integrity: identity envelope is invalid");
    }
    let privateKey: KeyObject;
    let publicKey: KeyObject;
    try {
      publicKey = parseEd25519PublicKeyPem(raw.devicePublicKeyPem);
      const privatePem = this.safeStorage.decryptString(Buffer.from(raw.encryptedPrivateKey, "base64"));
      privateKey = createPrivateKey(privatePem);
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("private key is not Ed25519");
      const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
      if (!derived.equals(publicKey.export({ type: "spki", format: "der" }))) throw new Error("public key mismatch");
    } catch {
      throw new Error("device_identity_integrity: key material is invalid");
    }
    return {
      enrollment: this.enrollment(raw.deviceId, publicKey, raw.devicePublicKeyPem),
      privateKey,
    };
  }

  private atomicWrite(contents: string): boolean {
    fs.mkdirSync(path.dirname(this.identityPath), { recursive: true });
    const temporaryPath = `${this.identityPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, contents, { encoding: "utf8" });
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      this.aclProtector.protect(temporaryPath);
      try {
        fs.linkSync(temporaryPath, this.identityPath);
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
