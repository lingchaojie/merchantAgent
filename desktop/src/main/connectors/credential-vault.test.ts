import { describe, expect, it } from "vitest";

import { KeytarCredentialVault } from "./credential-vault";

interface StoredCredential {
  account: string;
  password: string;
}

function fakeKeytar() {
  const entries = new Map<string, string>();
  const calls: Array<{ method: string; service: string; account?: string }> = [];
  const key = (service: string, account: string): string => `${service}\u0000${account}`;
  return {
    entries,
    calls,
    api: {
      async setPassword(service: string, account: string, password: string): Promise<void> {
        calls.push({ method: "set", service, account });
        entries.set(key(service, account), password);
      },
      async getPassword(service: string, account: string): Promise<string | null> {
        calls.push({ method: "get", service, account });
        return entries.get(key(service, account)) ?? null;
      },
      async deletePassword(service: string, account: string): Promise<boolean> {
        calls.push({ method: "delete", service, account });
        return entries.delete(key(service, account));
      },
      async findCredentials(service: string): Promise<StoredCredential[]> {
        calls.push({ method: "find", service });
        const prefix = `${service}\u0000`;
        return [...entries.entries()]
          .filter(([entry]) => entry.startsWith(prefix))
          .map(([entry, password]) => ({ account: entry.slice(prefix.length), password }));
      },
    },
    seed(service: string, account: string, password: string): void {
      entries.set(key(service, account), password);
    },
  };
}

const SERVICE = "com.merchantagent.connector/mock-corp-001/device-01";

describe("KeytarCredentialVault", () => {
  it("stores a service credential by opaque ref and never returns it from list", async () => {
    const keytar = fakeKeytar();
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");

    await vault.put("erp-test", { username: "agent_test", password: "S3cret!" });

    expect(await vault.get("erp-test")).toEqual({ username: "agent_test", password: "S3cret!" });
    expect(await vault.listRefs()).toEqual(["erp-test"]);
    expect(JSON.stringify(await vault.listRefs())).not.toContain("S3cret!");
    expect(keytar.calls).toEqual([
      { method: "set", service: SERVICE, account: "credential/erp-test" },
      { method: "get", service: SERVICE, account: "credential/erp-test" },
      { method: "find", service: SERVICE },
      { method: "find", service: SERVICE },
    ]);
    expect(Object.getOwnPropertyNames(vault)).not.toContain("api");
    expect(JSON.stringify(vault)).not.toContain("findCredentials");
  });

  it("returns null for a missing ref and supports removal", async () => {
    const keytar = fakeKeytar();
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");

    expect(await vault.get("missing")).toBeNull();
    expect(await vault.remove("missing")).toBe(false);
    await vault.put("erp-test", { username: "agent_test", password: "S3cret!" });
    expect(await vault.remove("erp-test")).toBe(true);
    expect(await vault.get("erp-test")).toBeNull();
  });

  it("rejects unsafe refs and scope identifiers before calling keytar", async () => {
    const keytar = fakeKeytar();
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");

    for (const ref of ["", "UPPER", "../escape", "credential/ref", `a${"b".repeat(64)}`]) {
      await expect(vault.get(ref)).rejects.toThrowError("invalid_argument");
    }
    expect(keytar.calls).toEqual([]);
    expect(() => new KeytarCredentialVault(keytar.api, "tenant/escape", "device-01")).toThrowError(
      "invalid_argument",
    );
  });

  it("rejects malformed stored JSON without exposing it or driver details", async () => {
    const keytar = fakeKeytar();
    keytar.seed(SERVICE, "credential/erp-test", '{"username":"agent_test","password":42,"driver":"detail"}');
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");

    let error: unknown;
    try {
      await vault.get("erp-test");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid_credentials");
    expect((error as Error).message).not.toMatch(/agent_test|driver|detail|42/);
  });

  it("lists only valid credential refs and never exposes keytar records", async () => {
    const keytar = fakeKeytar();
    keytar.seed(SERVICE, "credential/z-last", "secret-z");
    keytar.seed(SERVICE, "credential/a-first", "secret-a");
    keytar.seed(SERVICE, "credential/../escape", "secret-invalid");
    keytar.seed(SERVICE, "unrelated", "secret-unrelated");
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");

    const refs = await vault.listRefs();

    expect(refs).toEqual(["a-first", "z-last"]);
    expect(JSON.stringify(refs)).not.toMatch(/secret|password|account/);
  });

  it("normalizes keytar failures without leaking native error details", async () => {
    const keytar = fakeKeytar();
    keytar.api.getPassword = async () => {
      throw new Error("keytar native error: S3cret!");
    };
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");

    let error: unknown;
    try {
      await vault.get("erp-test");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid_credentials");
    expect((error as Error).message).not.toMatch(/keytar|native|S3cret/);
  });

  it("normalizes malformed keytar return shapes", async () => {
    const keytar = fakeKeytar();
    keytar.api.getPassword = async () => undefined as never;
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");

    await expect(vault.get("erp-test")).rejects.toThrowError("invalid_credentials");

    keytar.api.findCredentials = async () => [null, { account: 42 }] as never;
    await expect(vault.listRefs()).rejects.toThrowError("invalid_credentials");
  });

  it("normalizes malformed delete results and delete rejections", async () => {
    const keytar = fakeKeytar();
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");

    keytar.api.deletePassword = async () => "yes" as never;
    await expect(vault.remove("erp-test")).rejects.toThrowError("invalid_credentials");

    keytar.api.deletePassword = async () => {
      throw new Error("delete native detail: S3cret!");
    };
    let error: unknown;
    try {
      await vault.remove("erp-test");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid_credentials");
    expect((error as Error).message).not.toMatch(/delete|native|S3cret/);
  });

  it("normalizes malformed set results and set rejections", async () => {
    const keytar = fakeKeytar();
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");
    const credential = { username: "agent_test", password: "S3cret!" };

    keytar.api.setPassword = async () => true as never;
    await expect(vault.put("erp-test", credential)).rejects.toThrowError("invalid_credentials");

    keytar.api.setPassword = async () => {
      throw new Error("set native detail: S3cret!");
    };
    let error: unknown;
    try {
      await vault.put("erp-test", credential);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid_credentials");
    expect((error as Error).message).not.toMatch(/set|native|S3cret/);
  });

  it("requires complete plain findCredentials records and normalizes list rejections", async () => {
    const malformedRecords: unknown[] = [
      { account: "credential/erp-test" },
      { account: "credential/erp-test", password: 42 },
      { account: "credential/erp-test", password: "secret", extra: true },
      Object.assign(Object.create({ inherited: true }) as object, {
        account: "credential/erp-test",
        password: "secret",
      }),
    ];

    for (const record of malformedRecords) {
      const keytar = fakeKeytar();
      keytar.api.findCredentials = async () => [record] as never;
      const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");
      await expect(vault.listRefs()).rejects.toThrowError("invalid_credentials");
    }

    const keytar = fakeKeytar();
    keytar.api.findCredentials = async () => {
      throw new Error("list native detail: S3cret!");
    };
    const vault = new KeytarCredentialVault(keytar.api, "mock-corp-001", "device-01");
    let error: unknown;
    try {
      await vault.listRefs();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid_credentials");
    expect((error as Error).message).not.toMatch(/list|native|S3cret/);
  });
});
