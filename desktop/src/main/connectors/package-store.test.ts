import { afterEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalJSONStringify } from "./canonical";
import {
  DeviceIdentityStore,
  WindowsACLProtector,
  type ACLProtector,
  type SafeStorageLike,
} from "./device-identity";
import {
  ConnectorPackageReader,
  ConnectorPackageStore,
  submissionSigningInput,
  type InstalledConnector,
} from "./package-store";
import type { ConnectorDraft, ConnectorPrivatePayload, InstalledConnectorEnvelope } from "./schema";

const temporaryDirectories: string[] = [];
const NOW = new Date("2026-07-12T10:00:00Z");

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "connector-package-"));
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
  deviceId = "device-01",
  tenantId = "mock-corp-001",
): string {
  const payload = Buffer.from(
    JSON.stringify({
      credentialId: "implementation-01",
      tenantId,
      deviceId,
      devicePublicKeyPem,
      scopes: ["connector:draft", "connector:test", "connector:submit"],
      issuedAt: Date.parse("2026-07-12T09:00:00Z") / 1000,
      expiresAt: Date.parse("2026-07-12T11:00:00Z") / 1000,
    }),
    "utf8",
  );
  return `${payload.toString("base64url")}.${sign(null, payload, platformPrivateKey).toString("base64url")}`;
}

function locallyValidatedDraft(): ConnectorDraft {
  return {
    draftId: "draft-01",
    tenantId: "mock-corp-001",
    deviceId: "device-01",
    state: "locally_validated",
    payload: {
      schemaVersion: 1,
      connectorId: "sql-orders",
      version: "1.0.0",
      adapter: "sqlserver",
      profile: {
        profileId: "sql.internal",
        server: "sql.internal",
        database: "erp",
        encrypt: true,
        trustServerCertificate: false,
        connectTimeoutMS: 5_000,
        queryTimeoutMS: 10_000,
        credentialRef: "erp-credential",
        environment: "test",
      },
      operations: [
        {
          kind: "read",
          tool: "query_order_status",
          sql: "SELECT TOP 10 order_id FROM dbo.production_orders WHERE order_id = @orderId",
          bindings: [{ parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 }],
          projection: [{ sourceAlias: "order_id", resultField: "orderId", type: "string" }],
          declaredObjects: ["dbo.production_orders"],
          maxResults: 10,
          timeoutMS: 10_000,
        },
        {
          kind: "update",
          tool: "report_production_progress",
          beforeSql: "SELECT order_id, work_order_id, status, promise_date, completion_rate, note, version FROM dbo.production_orders WHERE order_id = @orderId AND work_order_id = @workOrderId",
          updateSql: "UPDATE dbo.production_orders SET completion_rate = @completionRate, note = @note, version = @nextVersion WHERE order_id = @orderId AND work_order_id = @workOrderId AND version = @expectedVersion",
          readBackSql: "SELECT order_id, work_order_id, status, promise_date, completion_rate, note, version FROM dbo.production_orders WHERE order_id = @orderId AND work_order_id = @workOrderId",
          bindings: [
            { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 },
            { parameter: "workOrderId", argument: "workOrderId", type: "NVarChar", maxLength: 64 },
            { parameter: "completionRate", argument: "completionRate", type: "Int" },
            { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" },
            { parameter: "note", argument: "note", type: "NVarChar", maxLength: 256 },
            { parameter: "nextVersion", argument: "nextVersion", type: "Int" },
          ],
          projection: [
            { sourceAlias: "order_id", resultField: "orderId", type: "string" },
            { sourceAlias: "work_order_id", resultField: "workOrderId", type: "string" },
            { sourceAlias: "status", resultField: "status", type: "string" },
            { sourceAlias: "promise_date", resultField: "promiseDate", type: "string" },
            { sourceAlias: "completion_rate", resultField: "completionRate", type: "integer" },
            { sourceAlias: "note", resultField: "note", type: "string" },
            { sourceAlias: "version", resultField: "version", type: "integer" },
          ],
          proposed: [
            { resultField: "completionRate", argument: "completionRate" },
            { resultField: "note", argument: "note", preserveIfMissing: true },
            { resultField: "version", argument: "nextVersion" },
          ],
          declaredObject: "dbo.production_orders",
          resourceParameter: "orderId",
          concurrencyParameter: "expectedVersion",
          updateColumns: ["completion_rate", "note", "version"],
          versionField: "version",
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
              properties: { orderId: { type: "string" } },
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
          {
            name: "report_production_progress",
            description: "Report production progress",
            parameters: {
              type: "object",
              properties: {
                orderId: { type: "string" },
                workOrderId: { type: "string" },
                completionRate: { type: "integer" },
                expectedVersion: { type: "integer" },
                note: { type: "string" },
              },
              required: ["orderId", "workOrderId", "completionRate", "expectedVersion"],
              additionalProperties: false,
            },
            resultFields: [
              "orderId", "workOrderId", "status", "promiseDate", "completionRate", "note", "version",
            ],
            resourceType: "business_record",
            resourceKind: "order",
            resourceArg: "orderId",
            resourceRelation: "operator",
            dataDomain: "manufacturing",
            risk: "low_write",
            requiresConfirmation: true,
            timeoutMS: 10_000,
            maxResults: 1,
          },
        ],
      },
      checker: {
        version: "1.0.0",
        rulesetVersion: "m7.1-sql-v1",
        testsDigest: `sha256:${"a".repeat(64)}`,
      },
    },
  };
}

function fixtureStore(): {
  store: ConnectorPackageStore;
  safeStorage: SafeStorageLike;
  platform: ReturnType<typeof generateKeyPairSync>;
  identityStore: DeviceIdentityStore;
  identity: ReturnType<DeviceIdentityStore["bindImplementationCredential"]>;
  userData: string;
  protectedPaths: string[];
} {
  const userData = temporaryDirectory();
  const safeStorage = fakeSafeStorage();
  const protectedPaths: string[] = [];
  const acl: ACLProtector = { protect: (filePath) => protectedPaths.push(filePath) };
  const platform = generateKeyPairSync("ed25519");
  const identityStore = new DeviceIdentityStore(
    userData,
    safeStorage,
    acl,
    () => "device-01",
    () => NOW,
  );
  const enrollment = identityStore.loadOrCreate();
  const credential = signedCredential(platform.privateKey, enrollment.devicePublicKeyPem);
  const identity = identityStore.bindImplementationCredential(
    credential,
    platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
    NOW,
  );
  return {
    store: new ConnectorPackageStore(userData, safeStorage, identity, acl),
    safeStorage,
    platform,
    identityStore,
    identity,
    userData,
    protectedPaths,
  };
}

function readEnvelope(installed: InstalledConnector): InstalledConnectorEnvelope {
  return JSON.parse(fs.readFileSync(installed.path, "utf8")) as InstalledConnectorEnvelope;
}

function writeEnvelope(installed: InstalledConnector, envelope: InstalledConnectorEnvelope): void {
  fs.writeFileSync(installed.path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

function resignEnvelope(
  installed: InstalledConnector,
  safeStorage: SafeStorageLike,
  mutatePayload: (payload: Record<string, unknown>) => void,
  signInput: (input: string) => string,
): void {
  const envelope = readEnvelope(installed);
  const plaintext = safeStorage.decryptString(Buffer.from(envelope.encryptedPayload, "base64"));
  const payload = JSON.parse(plaintext) as Record<string, unknown>;
  mutatePayload(payload);
  const canonical = canonicalJSONStringify(payload);
  envelope.manifest.digest = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  envelope.encryptedPayload = safeStorage.encryptString(canonical).toString("base64");
  envelope.implementationSignature = signInput(
    submissionSigningInput(
      "mock-corp-001",
      envelope.manifest.deviceId,
      envelope.manifest.connectorId,
      envelope.manifest.version,
      envelope.manifest.digest,
      envelope.manifest.signedAt,
    ),
  );
  writeEnvelope(installed, envelope);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ConnectorPackageStore", () => {
  it("rejects an out-of-scope tool contract before package installation", () => {
    const fixture = fixtureStore();
    const draft = locallyValidatedDraft();
    draft.payload.operations[1].tool = "update_order_status";
    draft.payload.publicContract.tools[1].name = "update_order_status";

    expect(() => fixture.store.install(draft, NOW)).toThrowError("package_integrity");
  });

  it("classifies an absent approved package as connector_not_installed", () => {
    const fixture = fixtureStore();

    expect(() => fixture.store.loadApproved(
      { connectorId: "missing", version: "1.0.0" },
      `sha256:${"a".repeat(64)}`,
    )).toThrowError("connector_not_installed");
  });

  it("stores only a public manifest plus DPAPI ciphertext and restores an approved payload", () => {
    const fixture = fixtureStore();
    const installed = fixture.store.install(locallyValidatedDraft(), NOW);
    const disk = fs.readFileSync(installed.path, "utf8");

    expect(disk).not.toContain("SELECT");
    expect(disk).not.toContain("dbo.production_orders");
    expect(disk).not.toContain("erp-credential");
    expect(disk).toContain('"encryptedPayload"');
    const packageACLPaths = fixture.protectedPaths.filter((protectedPath) =>
      protectedPath.includes(".ma-connector."),
    );
    expect(packageACLPaths).toHaveLength(1);
    expect(path.dirname(packageACLPaths[0])).toBe(path.dirname(installed.path));
    expect(packageACLPaths[0]).toMatch(/\.ma-connector\.\d+\.[a-f0-9-]+\.tmp$/);

    const loaded = fixture.store.loadApproved(installed.ref, installed.manifest.digest);
    expect(loaded.payload).toEqual(locallyValidatedDraft().payload);
    expect(loaded.manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("uses Go RFC3339Nano timestamp spelling for Task 2 submission signatures", () => {
    const fixture = fixtureStore();

    expect(fixture.store.install(locallyValidatedDraft(), NOW).manifest.signedAt).toBe(
      "2026-07-12T10:00:00Z",
    );
    const fractionalFixture = fixtureStore();
    expect(
      fractionalFixture.store.install(locallyValidatedDraft(), new Date("2026-07-12T10:00:00.120Z")).manifest.signedAt,
    ).toBe("2026-07-12T10:00:00.12Z");
  });

  it("rejects a re-signed timestamp that Go would canonicalize differently", () => {
    const fixture = fixtureStore();
    const installed = fixture.store.install(locallyValidatedDraft(), NOW);
    const envelope = readEnvelope(installed);
    envelope.manifest.signedAt = "2026-07-12T10:00:00.000Z";
    envelope.implementationSignature = fixture.identity.sign(
      submissionSigningInput(
        "mock-corp-001",
        envelope.manifest.deviceId,
        envelope.manifest.connectorId,
        envelope.manifest.version,
        envelope.manifest.digest,
        envelope.manifest.signedAt,
      ),
    );
    writeEnvelope(installed, envelope);

    expect(() => fixture.store.loadApproved(installed.ref, installed.manifest.digest)).toThrowError(
      "package_integrity",
    );
  });

  it("detects encrypted payload and device signature tampering", () => {
    const fixture = fixtureStore();
    const installed = fixture.store.install(locallyValidatedDraft(), NOW);
    const envelope = readEnvelope(installed);
    envelope.encryptedPayload = `${envelope.encryptedPayload.slice(0, -2)}AA`;
    writeEnvelope(installed, envelope);
    expect(() => fixture.store.loadApproved(installed.ref, installed.manifest.digest)).toThrowError(
      "package_integrity",
    );

    const signatureFixture = fixtureStore();
    const signatureInstalled = signatureFixture.store.install(locallyValidatedDraft(), NOW);
    const signatureTampered = readEnvelope(signatureInstalled);
    const replacement = signatureTampered.implementationSignature.endsWith("A") ? "B" : "A";
    signatureTampered.implementationSignature = `${signatureTampered.implementationSignature.slice(0, -1)}${replacement}`;
    writeEnvelope(signatureInstalled, signatureTampered);
    expect(() => signatureFixture.store.loadApproved(signatureInstalled.ref, signatureInstalled.manifest.digest)).toThrowError(
      "package_integrity",
    );
  });

  it("rejects approval digest mismatch and a credential for another device", () => {
    const fixture = fixtureStore();
    const installed = fixture.store.install(locallyValidatedDraft(), NOW);
    expect(() => fixture.store.loadApproved(installed.ref, `sha256:${"b".repeat(64)}`)).toThrowError(
      "package_version",
    );

    const envelope = readEnvelope(installed);
    const otherDevice = generateKeyPairSync("ed25519");
    const otherPem = otherDevice.publicKey.export({ type: "spki", format: "pem" }).toString();
    envelope.implementationCredential = signedCredential(fixture.platform.privateKey, otherPem, "device-02");
    writeEnvelope(installed, envelope);
    expect(() => fixture.store.loadApproved(installed.ref, installed.manifest.digest)).toThrowError(
      "package_integrity",
    );
  });

  it("rejects malformed payload schemas and unsafe environments even when re-signed", () => {
    const fixture = fixtureStore();
    const installed = fixture.store.install(locallyValidatedDraft(), NOW);
    const identity = fixture.identityStore.bindImplementationCredential(
      readEnvelope(installed).implementationCredential,
      fixture.platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
      NOW,
    );
    const signInput = (input: string): string => identity.sign(input);

    resignEnvelope(installed, fixture.safeStorage, (payload) => {
      payload.schemaVersion = 2;
    }, signInput);
    const malformed = readEnvelope(installed);
    expect(() => fixture.store.loadApproved(installed.ref, malformed.manifest.digest)).toThrowError(
      "package_integrity",
    );

    const unsafeFixture = fixtureStore();
    const unsafeInstalled = unsafeFixture.store.install(locallyValidatedDraft(), NOW);
    const unsafeIdentity = unsafeFixture.identityStore.bindImplementationCredential(
      readEnvelope(unsafeInstalled).implementationCredential,
      unsafeFixture.platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
      NOW,
    );
    resignEnvelope(unsafeInstalled, unsafeFixture.safeStorage, (payload) => {
      (payload.profile as Record<string, unknown>).environment = "production";
    }, (input) => unsafeIdentity.sign(input));
    const unsafe = readEnvelope(unsafeInstalled);
    expect(() => unsafeFixture.store.loadApproved(unsafeInstalled.ref, unsafe.manifest.digest)).toThrowError(
      "package_integrity",
    );
  });

  it("accepts an approved package after the credential's current-time expiry", () => {
    const fixture = fixtureStore();
    const installed = fixture.store.install(locallyValidatedDraft(), NOW);

    expect(fixture.store.loadApproved(installed.ref, installed.manifest.digest).payload.connectorId).toBe(
      "sql-orders",
    );
  });

  it("reopens an approved package after expiry without restoring signing authority", () => {
    const fixture = fixtureStore();
    const installed = fixture.store.install(locallyValidatedDraft(), NOW);
    const platformPublicKeyPem = fixture.platform.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const restartedIdentityStore = new DeviceIdentityStore(
      fixture.userData,
      fixture.safeStorage,
      { protect: () => undefined },
      () => "must-not-create-another-device",
    );
    const afterExpiry = new Date("2026-07-12T11:00:00Z");

    expect(() =>
      restartedIdentityStore.bindImplementationCredential(
        fixture.identity.implementationCredential,
        platformPublicKeyPem,
        afterExpiry,
      ),
    ).toThrowError("implementation_credential_expired");

    const archivalIdentity = restartedIdentityStore.loadPackageReaderIdentity(
      "mock-corp-001",
      platformPublicKeyPem,
    );
    const reader = new ConnectorPackageReader(
      fixture.userData,
      fixture.safeStorage,
      archivalIdentity,
      { protect: () => undefined },
    );

    expect("sign" in archivalIdentity).toBe(false);
    expect("install" in reader).toBe(false);
    expect(Object.getOwnPropertyNames(reader)).not.toContain("core");
    expect((reader as unknown as { core?: unknown }).core).toBeUndefined();
    expect(reader.loadApproved(installed.ref, installed.manifest.digest).payload).toEqual(
      locallyValidatedDraft().payload,
    );
  });

  it("rejects direct signing after a retained identity reaches exclusive expiry", () => {
    const userData = temporaryDirectory();
    const safeStorage = fakeSafeStorage();
    const platform = generateKeyPairSync("ed25519");
    let currentTime = NOW;
    const identityStore = new DeviceIdentityStore(
      userData,
      safeStorage,
      { protect: () => undefined },
      () => "device-01",
      () => currentTime,
    );
    const enrollment = identityStore.loadOrCreate();
    const identity = identityStore.bindImplementationCredential(
      signedCredential(platform.privateKey, enrollment.devicePublicKeyPem),
      platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
      currentTime,
    );

    currentTime = new Date("2026-07-12T11:00:00Z");

    expect(() => identity.sign("retained signing attempt")).toThrowError(
      "implementation_credential_expired",
    );
  });

  it("cannot backdate installation with a retained expired signing identity", () => {
    const userData = temporaryDirectory();
    const safeStorage = fakeSafeStorage();
    const acl = { protect: () => undefined };
    const platform = generateKeyPairSync("ed25519");
    let currentTime = NOW;
    const identityStore = new DeviceIdentityStore(
      userData,
      safeStorage,
      acl,
      () => "device-01",
      () => currentTime,
    );
    const enrollment = identityStore.loadOrCreate();
    const identity = identityStore.bindImplementationCredential(
      signedCredential(platform.privateKey, enrollment.devicePublicKeyPem),
      platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
      currentTime,
    );
    const store = new ConnectorPackageStore(userData, safeStorage, identity, acl);
    currentTime = new Date("2026-07-12T11:00:00Z");

    expect(() => store.install(locallyValidatedDraft(), NOW)).toThrowError("package_integrity");
    expect(fs.existsSync(path.join(userData, "connectors", "sql-orders", "1.0.0.ma-connector"))).toBe(false);
  });

  it("cannot retry an existing package install with a retained expired signing identity", () => {
    const userData = temporaryDirectory();
    const safeStorage = fakeSafeStorage();
    const acl = { protect: () => undefined };
    const platform = generateKeyPairSync("ed25519");
    let currentTime = NOW;
    const identityStore = new DeviceIdentityStore(
      userData,
      safeStorage,
      acl,
      () => "device-01",
      () => currentTime,
    );
    const enrollment = identityStore.loadOrCreate();
    const identity = identityStore.bindImplementationCredential(
      signedCredential(platform.privateKey, enrollment.devicePublicKeyPem),
      platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
      currentTime,
    );
    const store = new ConnectorPackageStore(userData, safeStorage, identity, acl);
    const installed = store.install(locallyValidatedDraft(), NOW);
    currentTime = new Date("2026-07-12T11:00:00Z");

    expect(() => store.install(locallyValidatedDraft(), NOW)).toThrowError("package_integrity");
    expect(store.loadApproved(installed.ref, installed.manifest.digest).payload.connectorId).toBe(
      "sql-orders",
    );
  });

  it("requires a locally validated draft bound to the credential tenant and device", () => {
    const fixture = fixtureStore();
    const draft = locallyValidatedDraft();
    draft.state = "draft";
    expect(() => fixture.store.install(draft, NOW)).toThrowError("package_integrity");
    draft.state = "locally_validated";
    draft.deviceId = "device-02";
    expect(() => fixture.store.install(draft, NOW)).toThrowError("package_integrity");
  });

  it("removes a new package when ACL protection fails", () => {
    const fixture = fixtureStore();
    const identity = fixture.identityStore.bindImplementationCredential(
      signedCredential(
        fixture.platform.privateKey,
        fixture.identityStore.loadOrCreate().devicePublicKeyPem,
      ),
      fixture.platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
      NOW,
    );
    const store = new ConnectorPackageStore(
      path.dirname(fixture.identityStore.identityPath),
      fixture.safeStorage,
      identity,
      { protect: () => { throw new Error("acl failed"); } },
    );

    expect(() => store.install(locallyValidatedDraft(), NOW)).toThrowError("acl failed");
    expect(fs.existsSync(path.join(path.dirname(fixture.identityStore.identityPath), "connectors", "sql-orders", "1.0.0.ma-connector"))).toBe(false);
  });

  it("preserves an immutable installed version before a replacement ACL can fail", () => {
    const fixture = fixtureStore();
    const installed = fixture.store.install(locallyValidatedDraft(), NOW);
    const original = fs.readFileSync(installed.path, "utf8");
    let aclCalls = 0;
    const replacementStore = new ConnectorPackageStore(
      fixture.userData,
      fixture.safeStorage,
      fixture.identity,
      { protect: () => { aclCalls += 1; throw new Error("acl failed"); } },
    );
    const changed = locallyValidatedDraft();
    changed.payload.operations[0] = {
      ...changed.payload.operations[0],
      timeoutMS: 9_000,
    };

    expect(() => replacementStore.install(changed, NOW)).toThrowError("package_version");
    expect(aclCalls).toBe(0);
    expect(fs.readFileSync(installed.path, "utf8")).toBe(original);
    expect(fixture.store.loadApproved(installed.ref, installed.manifest.digest).payload).toEqual(
      locallyValidatedDraft().payload,
    );
  });

  it("does not use a persistent lock path that can survive a process crash", () => {
    const fixture = fixtureStore();
    const packageDirectory = path.join(fixture.userData, "connectors", "sql-orders");
    fs.mkdirSync(packageDirectory, { recursive: true });
    const lockPath = path.join(packageDirectory, "1.0.0.ma-connector.lock");
    fs.writeFileSync(lockPath, "held", { encoding: "utf8", flag: "wx" });

    const installed = fixture.store.install(locallyValidatedDraft(), NOW);
    expect(fs.existsSync(installed.path)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("held");
  });

  it("does not load or reuse a package issued under another tenant identity", () => {
    const fixture = fixtureStore();
    const installed = fixture.store.install(locallyValidatedDraft(), NOW);
    const enrollment = fixture.identityStore.loadOrCreate();
    const otherCredential = signedCredential(
      fixture.platform.privateKey,
      enrollment.devicePublicKeyPem,
      enrollment.deviceId,
      "other-corp-002",
    );
    const otherIdentity = fixture.identityStore.bindImplementationCredential(
      otherCredential,
      fixture.platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
      NOW,
    );
    const otherStore = new ConnectorPackageStore(
      fixture.userData,
      fixture.safeStorage,
      otherIdentity,
      { protect: () => undefined },
    );
    const otherDraft = locallyValidatedDraft();
    otherDraft.tenantId = "other-corp-002";

    expect(() => otherStore.loadApproved(installed.ref, installed.manifest.digest)).toThrowError(
      "package_integrity",
    );
    expect(() => otherStore.install(otherDraft, NOW)).toThrowError("package_integrity");
  });
});

describe("WindowsACLProtector", () => {
  it("uses fixed executable arguments and never invokes a shell", () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const execute = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      return file === "whoami.exe" ? '"DESKTOP\\alice","S-1-5-21-123-456-789-1001"\r\n' : "";
    }) as never;
    const protector = new WindowsACLProtector(execute);

    protector.protect("C:\\Users\\alice\\connector.ma-connector");

    expect(calls).toEqual([
      {
        file: "whoami.exe",
        args: ["/user", "/fo", "csv", "/nh"],
        options: { encoding: "utf8", windowsHide: true, shell: false },
      },
      {
        file: "icacls.exe",
        args: [
          "C:\\Users\\alice\\connector.ma-connector",
          "/inheritance:r",
          "/grant:r",
          "S-1-5-21-123-456-789-1001:(F)",
        ],
        options: { encoding: "utf8", windowsHide: true, shell: false },
      },
    ]);
  });
});
