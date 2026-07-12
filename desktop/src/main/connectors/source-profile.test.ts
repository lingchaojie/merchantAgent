import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { toMSSQLConfig, validateSQLServerProfile } from "./source-profile";
import type { SQLServerProfile } from "./schema";

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

  it("loads an explicit CA file into structured TLS options", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "connector-ca-"));
    const caPath = path.join(directory, "ca.pem");
    fs.writeFileSync(caPath, "TEST CA", "utf8");
    try {
      const config = toMSSQLConfig(
        { ...fixtureProfile(), caPath },
        { username: "agent_test", password: "S3cret!" },
      );

      expect(config.options).toMatchObject({
        cryptoCredentialsDetails: { ca: "TEST CA" },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
