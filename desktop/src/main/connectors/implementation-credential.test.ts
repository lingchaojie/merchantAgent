import { afterEach, describe, expect, it } from "vitest";
import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadBundledPlatformPublicKey,
  verifyImplementationCredential,
} from "./implementation-credential";
import {
  DeviceIdentityStore,
  type ACLProtector,
  type SafeStorageLike,
} from "./device-identity";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "connector-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`protected:${plaintext}`, "utf8"),
    decryptString: (ciphertext) => {
      const encoded = ciphertext.toString("utf8");
      if (!encoded.startsWith("protected:")) throw new Error("ciphertext rejected");
      return encoded.slice("protected:".length);
    },
  };
}

function signedCredential(
  platformPrivateKey: KeyObject,
  devicePublicKeyPem: string,
  overrides: Partial<{
    credentialId: string;
    tenantId: string;
    deviceId: string;
    devicePublicKeyPem: string;
    scopes: string[];
    issuedAt: number;
    expiresAt: number;
    unexpected: string;
  }> = {},
): string {
  const claims = {
    credentialId: "implementation-01",
    tenantId: "mock-corp-001",
    deviceId: "device-01",
    devicePublicKeyPem,
    scopes: ["connector:draft", "connector:test", "connector:submit"],
    issuedAt: Date.parse("2026-07-12T09:00:00Z") / 1000,
    expiresAt: Date.parse("2026-07-12T11:00:00Z") / 1000,
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8");
  const signature = sign(null, payload, platformPrivateKey);
  return `${payload.toString("base64url")}.${signature.toString("base64url")}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("verifyImplementationCredential", () => {
  it("binds an implementation credential to tenant, device, scope, key, and expiry", () => {
    const platform = generateKeyPairSync("ed25519");
    const device = generateKeyPairSync("ed25519");
    const devicePublicKeyPem = device.publicKey.export({ type: "spki", format: "pem" }).toString();
    const credential = signedCredential(platform.privateKey, devicePublicKeyPem);

    const verified = verifyImplementationCredential(
      credential,
      platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
      new Date("2026-07-12T10:00:00Z"),
    );

    expect(verified.credentialId).toBe("implementation-01");
    expect(verified.tenantId).toBe("mock-corp-001");
    expect(verified.deviceId).toBe("device-01");
    expect(verified.devicePublicKeyPem).toBe(devicePublicKeyPem);
    expect(verified.scopes).toEqual(["connector:draft", "connector:test", "connector:submit"]);
    expect(verified.issuedAt).toBe("2026-07-12T09:00:00.000Z");
    expect(verified.expiresAt).toBe("2026-07-12T11:00:00.000Z");
  });

  it("treats credential expiry as exclusive", () => {
    const platform = generateKeyPairSync("ed25519");
    const device = generateKeyPairSync("ed25519");
    const publicPem = device.publicKey.export({ type: "spki", format: "pem" }).toString();
    const credential = signedCredential(platform.privateKey, publicPem);
    const platformPem = platform.publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(() =>
      verifyImplementationCredential(credential, platformPem, new Date("2026-07-12T11:00:00Z")),
    ).toThrowError("implementation_credential_expired");
  });

  it("fails closed for tampering, unknown claims, invalid scopes, and invalid platform material", () => {
    const platform = generateKeyPairSync("ed25519");
    const otherPlatform = generateKeyPairSync("ed25519");
    const device = generateKeyPairSync("ed25519");
    const publicPem = device.publicKey.export({ type: "spki", format: "pem" }).toString();
    const platformPem = platform.publicKey.export({ type: "spki", format: "pem" }).toString();
    const now = new Date("2026-07-12T10:00:00Z");

    const tampered = signedCredential(otherPlatform.privateKey, publicPem);
    expect(() => verifyImplementationCredential(tampered, platformPem, now)).toThrowError(
      "implementation_credential_invalid",
    );
    expect(() =>
      verifyImplementationCredential(
        signedCredential(platform.privateKey, publicPem, { unexpected: "rejected" }),
        platformPem,
        now,
      ),
    ).toThrowError("implementation_credential_invalid");
    expect(() =>
      verifyImplementationCredential(
        signedCredential(platform.privateKey, publicPem, { scopes: ["connector:draft", "connector:test"] }),
        platformPem,
        now,
      ),
    ).toThrowError("implementation_credential_scope");
    expect(() => verifyImplementationCredential(tampered, "not a public key", now)).toThrowError(
      "implementation_credential_invalid",
    );
  });

  it("fails closed when bundled verification material is missing and loads a valid resource", () => {
    const resources = temporaryDirectory();
    expect(() => loadBundledPlatformPublicKey(resources)).toThrowError("implementation_credential_invalid");

    const platform = generateKeyPairSync("ed25519");
    const implementationDirectory = path.join(resources, "implementation");
    fs.mkdirSync(implementationDirectory);
    const publicPem = platform.publicKey.export({ type: "spki", format: "pem" }).toString();
    fs.writeFileSync(path.join(implementationDirectory, "platform-public.pem"), publicPem, "utf8");

    expect(loadBundledPlatformPublicKey(resources)).toBe(publicPem);
  });
});

describe("DeviceIdentityStore", () => {
  it("stores only the public key and DPAPI ciphertext and exposes a fingerprinted enrollment view", () => {
    const aclPaths: string[] = [];
    const acl: ACLProtector = { protect: (filePath) => aclPaths.push(filePath) };
    const store = new DeviceIdentityStore(temporaryDirectory(), fakeSafeStorage(), acl, () => "device-01");

    const enrollment = store.loadOrCreate();
    const disk = fs.readFileSync(store.identityPath, "utf8");

    expect(enrollment.deviceId).toBe("device-01");
    expect(enrollment.devicePublicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(enrollment.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(disk).toContain('"encryptedPrivateKey"');
    expect(disk).not.toContain("BEGIN PRIVATE KEY");
    expect(aclPaths).toHaveLength(1);
    expect(path.dirname(aclPaths[0])).toBe(path.dirname(store.identityPath));
    expect(aclPaths[0]).toMatch(/device-identity\.json\.\d+\.[a-f0-9-]+\.tmp$/);
    expect(fs.existsSync(aclPaths[0])).toBe(false);
    expect(store.loadOrCreate()).toEqual(enrollment);
  });

  it("rejects a credential bound to a different device public key", () => {
    const directory = temporaryDirectory();
    const store = new DeviceIdentityStore(directory, fakeSafeStorage(), { protect: () => undefined }, () => "device-01");
    store.loadOrCreate();
    const platform = generateKeyPairSync("ed25519");
    const otherDevice = generateKeyPairSync("ed25519");
    const otherPublicPem = otherDevice.publicKey.export({ type: "spki", format: "pem" }).toString();
    const credential = signedCredential(platform.privateKey, otherPublicPem);

    expect(() =>
      store.bindImplementationCredential(
        credential,
        platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
        new Date("2026-07-12T10:00:00Z"),
      ),
    ).toThrowError("implementation_credential_device_mismatch");
  });

  it("removes a new identity when ACL protection fails", () => {
    const store = new DeviceIdentityStore(
      temporaryDirectory(),
      fakeSafeStorage(),
      { protect: () => { throw new Error("acl failed"); } },
      () => "device-01",
    );

    expect(() => store.loadOrCreate()).toThrowError("acl failed");
    expect(fs.existsSync(store.identityPath)).toBe(false);
  });

  it("publishes without replacement and loads the identity that wins a creation race", () => {
    const directory = temporaryDirectory();
    const safeStorage = fakeSafeStorage();
    const winnerStore = new DeviceIdentityStore(
      directory,
      safeStorage,
      { protect: () => undefined },
      () => "winning-device",
    );
    let winner: ReturnType<DeviceIdentityStore["loadOrCreate"]> | undefined;
    let loserStore: DeviceIdentityStore;
    const aclPaths: string[] = [];
    loserStore = new DeviceIdentityStore(
      directory,
      safeStorage,
      {
        protect: (filePath) => {
          aclPaths.push(filePath);
          if (winner === undefined) {
            if (fs.existsSync(loserStore.identityPath)) fs.rmSync(loserStore.identityPath);
            winner = winnerStore.loadOrCreate();
          }
        },
      },
      () => "losing-device",
    );

    const loaded = loserStore.loadOrCreate();

    expect(loaded).toEqual(winner);
    expect(loaded.deviceId).toBe("winning-device");
    expect(aclPaths).toHaveLength(1);
    expect(aclPaths[0]).not.toBe(loserStore.identityPath);
    expect(new DeviceIdentityStore(directory, safeStorage, { protect: () => undefined }).loadOrCreate()).toEqual(
      winner,
    );
  });

  it("preserves a concurrent winning identity when loser ACL protection fails", () => {
    const directory = temporaryDirectory();
    const safeStorage = fakeSafeStorage();
    const winnerStore = new DeviceIdentityStore(
      directory,
      safeStorage,
      { protect: () => undefined },
      () => "winning-device",
    );
    let winner: ReturnType<DeviceIdentityStore["loadOrCreate"]> | undefined;
    let loserStore: DeviceIdentityStore;
    loserStore = new DeviceIdentityStore(
      directory,
      safeStorage,
      {
        protect: () => {
          if (winner === undefined) {
            if (fs.existsSync(loserStore.identityPath)) fs.rmSync(loserStore.identityPath);
            winner = winnerStore.loadOrCreate();
          }
          throw new Error("acl failed");
        },
      },
      () => "losing-device",
    );

    expect(() => loserStore.loadOrCreate()).toThrowError("acl failed");
    expect(fs.existsSync(loserStore.identityPath)).toBe(true);
    expect(new DeviceIdentityStore(directory, safeStorage, { protect: () => undefined }).loadOrCreate()).toEqual(
      winner,
    );
  });
});
