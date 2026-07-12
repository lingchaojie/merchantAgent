import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { toMSSQLConfig, validateSQLServerProfile } from "./source-profile";
import type { SQLServerProfile } from "./schema";

const MAX_CA_BYTES = 256 * 1024;

function fakeBigIntStats(options: {
  ino?: bigint;
  size?: bigint;
  symlink?: boolean;
  file?: boolean;
} = {}): fs.BigIntStats {
  const ino = options.ino ?? 101n;
  return {
    dev: 7n,
    ino,
    size: options.size ?? 7n,
    birthtimeNs: 1_000n + ino,
    ctimeNs: 2_000n,
    isFile: () => options.file ?? true,
    isSymbolicLink: () => options.symlink ?? false,
  } as fs.BigIntStats;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function fixtureProfile(): SQLServerProfile {
  return {
    profileId: "erp-test",
    server: "sql.test.internal",
    port: 1433,
    database: "merchant_test",
    encrypt: true,
    trustServerCertificate: false,
    connectTimeoutMS: 5_000,
    queryTimeoutMS: 10_000,
    credentialRef: "erp-test",
    environment: "test",
  };
}

describe("validateSQLServerProfile", () => {
  it("accepts test and preproduction profiles at supported boundaries", () => {
    expect(() => validateSQLServerProfile(fixtureProfile())).not.toThrow();
    expect(() =>
      validateSQLServerProfile({
        ...fixtureProfile(),
        environment: "preproduction",
        port: 65_535,
        connectTimeoutMS: 30_000,
        queryTimeoutMS: 1_000,
      }),
    ).not.toThrow();
  });

  it("rejects production-like and weakened TLS profiles", () => {
    expect(() =>
      validateSQLServerProfile({ ...fixtureProfile(), environment: "production" as never }),
    ).toThrowError("invalid_argument");
    expect(() => validateSQLServerProfile({ ...fixtureProfile(), encrypt: false as never })).toThrowError(
      "tls_failed",
    );
    expect(() =>
      validateSQLServerProfile({ ...fixtureProfile(), trustServerCertificate: true as never }),
    ).toThrowError("tls_failed");
  });

  it.each([
    ["blank server", { server: "   " }],
    ["blank database", { database: "" }],
    ["port below range", { port: 0 }],
    ["port above range", { port: 65_536 }],
    ["short connect timeout", { connectTimeoutMS: 999 }],
    ["long connect timeout", { connectTimeoutMS: 30_001 }],
    ["short query timeout", { queryTimeoutMS: 999 }],
    ["long query timeout", { queryTimeoutMS: 10_001 }],
    ["unsafe credential ref", { credentialRef: "credential://erp-test" }],
  ])("rejects %s", (_name, override) => {
    expect(() => validateSQLServerProfile({ ...fixtureProfile(), ...override } as SQLServerProfile)).toThrowError(
      "invalid_argument",
    );
  });

  it("rejects simultaneous instance and port selection", () => {
    expect(() => validateSQLServerProfile({ ...fixtureProfile(), instance: "TESTSQL" })).toThrowError(
      "invalid_argument",
    );
  });

  it("normalizes a malformed profile to invalid_argument", () => {
    expect(() => validateSQLServerProfile(null as never)).toThrowError("invalid_argument");
  });

  it.each([
    ["UNC", "\\\\server\\share\\ca.pem"],
    ["extended namespace", "\\\\?\\C:\\certs\\ca.pem"],
    ["device namespace", "\\\\.\\C:\\certs\\ca.pem"],
    ["relative", "certs\\ca.pem"],
    ["unsupported extension", "C:\\certs\\ca.txt"],
  ])("rejects a %s CA path as tls_failed", (_name, caPath) => {
    let error: unknown;
    try {
      validateSQLServerProfile({ ...fixtureProfile(), caPath });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("tls_failed");
    expect((error as Error).message).not.toContain(caPath);
  });
});

describe("toMSSQLConfig", () => {
  it("returns a structured verified-TLS config with credentials and fixed timeouts", () => {
    const config = toMSSQLConfig(fixtureProfile(), {
      username: "agent_test",
      password: "S3cret!",
    });

    expect(config).toEqual({
      user: "agent_test",
      password: "S3cret!",
      server: "sql.test.internal",
      port: 1433,
      database: "merchant_test",
      connectionTimeout: 5_000,
      requestTimeout: 10_000,
      options: {
        encrypt: true,
        trustServerCertificate: false,
      },
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  it("maps a named instance without inventing a port", () => {
    const profile = { ...fixtureProfile(), port: undefined, instance: "TESTSQL" };

    const config = toMSSQLConfig(profile, { username: "agent_test", password: "S3cret!" });

    expect(config.port).toBeUndefined();
    expect(config.options).toMatchObject({ instanceName: "TESTSQL" });
  });

  it.each([".pem", ".crt", ".cer"])("loads a bounded local %s CA file into structured TLS options", (extension) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "connector-ca-"));
    const caPath = path.join(directory, `ca${extension}`);
    const contents = Buffer.from("TEST CA", "utf8");
    fs.writeFileSync(caPath, contents);
    try {
      const config = toMSSQLConfig(
        { ...fixtureProfile(), caPath },
        { username: "agent_test", password: "S3cret!" },
      );

      expect(config.options).toMatchObject({
        cryptoCredentialsDetails: { ca: contents },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized CA file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oversized-connector-ca-"));
    const caPath = path.join(directory, "ca.pem");
    fs.writeFileSync(caPath, Buffer.alloc(256 * 1024 + 1, 65));
    try {
      expect(() =>
        toMSSQLConfig(
          { ...fixtureProfile(), caPath },
          { username: "agent_test", password: "S3cret!" },
        ),
      ).toThrowError("tls_failed");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an empty or non-regular CA path", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "invalid-connector-ca-"));
    const emptyPath = path.join(directory, "empty.pem");
    const directoryPath = path.join(directory, "directory.pem");
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    fs.mkdirSync(directoryPath);
    try {
      for (const caPath of [emptyPath, directoryPath]) {
        expect(() =>
          toMSSQLConfig(
            { ...fixtureProfile(), caPath },
            { username: "agent_test", password: "S3cret!" },
          ),
        ).toThrowError("tls_failed");
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a CA symlink when Windows permits creating one", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-connector-ca-"));
    const targetPath = path.join(directory, "target.pem");
    const symlinkPath = path.join(directory, "link.pem");
    fs.writeFileSync(targetPath, "TEST CA", "utf8");
    try {
      try {
        fs.symlinkSync(targetPath, symlinkPath, "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      expect(() =>
        toMSSQLConfig(
          { ...fixtureProfile(), caPath: symlinkPath },
          { username: "agent_test", password: "S3cret!" },
        ),
      ).toThrowError("tls_failed");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds a file that grows after fstat to MAX_CA_BYTES plus one", () => {
    const before = fakeBigIntStats({ size: 7n });
    vi.spyOn(fs, "lstatSync").mockReturnValue(before as never);
    vi.spyOn(fs, "openSync").mockReturnValue(41);
    vi.spyOn(fs, "fstatSync").mockReturnValue(before as never);
    let requestedLength = 0;
    vi.spyOn(fs, "readSync").mockImplementation(((_fd: number, _buffer: Buffer, _offset: number, length: number) => {
      requestedLength = length;
      return MAX_CA_BYTES + 1;
    }) as never);
    const close = vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);

    expect(() =>
      toMSSQLConfig(
        { ...fixtureProfile(), caPath: "C:\\certs\\ca.pem" },
        { username: "agent_test", password: "S3cret!" },
      ),
    ).toThrowError("tls_failed");
    expect(requestedLength).toBe(MAX_CA_BYTES + 1);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ["symlink", fakeBigIntStats({ symlink: true, file: false })],
    ["different inode", fakeBigIntStats({ ino: 202n })],
  ])("rejects a path swap to a %s after the handle read", (_name, after) => {
    const contents = Buffer.from("TEST CA", "utf8");
    const original = fakeBigIntStats({ size: BigInt(contents.length) });
    vi.spyOn(fs, "lstatSync")
      .mockReturnValueOnce(original as never)
      .mockReturnValueOnce(after as never);
    vi.spyOn(fs, "openSync").mockReturnValue(42);
    vi.spyOn(fs, "fstatSync").mockReturnValue(original as never);
    vi.spyOn(fs, "readSync").mockImplementation(((_fd: number, buffer: Buffer) => {
      contents.copy(buffer);
      return contents.length;
    }) as never);
    const close = vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);

    expect(() =>
      toMSSQLConfig(
        { ...fixtureProfile(), caPath: "C:\\certs\\ca.pem" },
        { username: "agent_test", password: "S3cret!" },
      ),
    ).toThrowError("tls_failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("reads a normal bounded CA through one verified handle", () => {
    const contents = Buffer.from("TEST CA", "utf8");
    const stable = fakeBigIntStats({ size: BigInt(contents.length) });
    vi.spyOn(fs, "lstatSync").mockReturnValue(stable as never);
    const open = vi.spyOn(fs, "openSync").mockReturnValue(43);
    vi.spyOn(fs, "fstatSync").mockReturnValue(stable as never);
    const read = vi.spyOn(fs, "readSync").mockImplementation(((_fd: number, buffer: Buffer) => {
      contents.copy(buffer);
      return contents.length;
    }) as never);
    const close = vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);

    const config = toMSSQLConfig(
      { ...fixtureProfile(), caPath: "C:\\certs\\ca.pem" },
      { username: "agent_test", password: "S3cret!" },
    );

    expect(config.options).toMatchObject({ cryptoCredentialsDetails: { ca: contents } });
    expect(open).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("normalizes an unreadable CA file without exposing its path", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "missing-connector-ca-"));
    const caPath = path.join(directory, "ca.pem");
    try {
      let error: unknown;
      try {
        toMSSQLConfig(
          { ...fixtureProfile(), caPath },
          { username: "agent_test", password: "S3cret!" },
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("tls_failed");
      expect((error as Error).message).not.toContain(caPath);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid credentials without including their values", () => {
    let error: unknown;
    try {
      toMSSQLConfig(fixtureProfile(), { username: "agent_test", password: "" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid_credentials");
    expect((error as Error).message).not.toContain("agent_test");
  });
});
