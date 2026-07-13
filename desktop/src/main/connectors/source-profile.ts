import type { config as MSSQLConfig } from "mssql";
import fs from "node:fs";
import path from "node:path";

import type { ServiceCredential } from "./credential-vault";
import { ConnectorError, isCredentialRef, isSourceProfileId, type SQLServerProfile } from "./schema";

const MAX_CA_BYTES = 256 * 1024;
const CERTIFICATE_EXTENSIONS = new Set([".pem", ".crt", ".cer"]);

export type PreparedMSSQLConfig = Readonly<Omit<MSSQLConfig, "user" | "password">>;

function fixedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function tlsFailure(): ConnectorError {
  return new ConnectorError("tls_failed", "SQL Server CA certificate is unavailable");
}

function requireLocalCertificatePath(caPath: string): void {
  if (
    process.platform !== "win32" ||
    !/^[A-Za-z]:[\\/]/.test(caPath) ||
    !path.win32.isAbsolute(caPath) ||
    !CERTIFICATE_EXTENSIONS.has(path.win32.extname(caPath).toLowerCase())
  ) {
    throw tlsFailure();
  }
}

function requireRegularCertificateFile(stat: fs.BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("invalid CA file");
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  if (left.dev !== right.dev || left.ino !== right.ino) return false;
  return left.ino !== 0n || left.birthtimeNs === right.birthtimeNs;
}

function readLocalCertificate(caPath: string): Buffer {
  let descriptor: number | undefined;
  let scratch: Buffer | undefined;
  let certificate: Buffer | undefined;
  let failed = false;
  try {
    const before = fs.lstatSync(caPath, { bigint: true });
    requireRegularCertificateFile(before);
    descriptor = fs.openSync(caPath, fs.constants.O_RDONLY);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    requireRegularCertificateFile(opened);
    if (
      opened.size < 1n ||
      opened.size > BigInt(MAX_CA_BYTES) ||
      !sameFileIdentity(before, opened)
    ) {
      throw new Error("invalid CA file");
    }

    scratch = Buffer.alloc(MAX_CA_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, scratch, 0, scratch.length, 0);
    if (
      bytesRead < 1 ||
      bytesRead > MAX_CA_BYTES ||
      BigInt(bytesRead) !== opened.size
    ) {
      throw new Error("invalid CA file");
    }

    const handleAfterRead = fs.fstatSync(descriptor, { bigint: true });
    requireRegularCertificateFile(handleAfterRead);
    const pathAfterRead = fs.lstatSync(caPath, { bigint: true });
    requireRegularCertificateFile(pathAfterRead);
    if (
      handleAfterRead.size !== opened.size ||
      pathAfterRead.size !== opened.size ||
      !sameFileIdentity(opened, handleAfterRead) ||
      !sameFileIdentity(opened, pathAfterRead)
    ) {
      throw new Error("invalid CA file");
    }
    certificate = Buffer.from(scratch.subarray(0, bytesRead));
  } catch {
    failed = true;
  } finally {
    scratch?.fill(0);
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        failed = true;
      }
    }
  }
  if (failed || certificate === undefined) throw tlsFailure();
  return certificate;
}

export function validateSQLServerProfile(profile: SQLServerProfile): void {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new ConnectorError("invalid_argument", "SQL Server profile is invalid");
  }
  if (profile.encrypt !== true || profile.trustServerCertificate !== false) {
    throw new ConnectorError("tls_failed", "SQL Server profile must require verified TLS");
  }
  if (profile.environment !== "test" && profile.environment !== "preproduction") {
    throw new ConnectorError("invalid_argument", "SQL Server environment is not supported");
  }
  if (!isSourceProfileId(profile.profileId) || !fixedString(profile.server) || !fixedString(profile.database)) {
    throw new ConnectorError("invalid_argument", "SQL Server profile contains an invalid fixed value");
  }
  if (profile.instance !== undefined && !fixedString(profile.instance)) {
    throw new ConnectorError("invalid_argument", "SQL Server instance is invalid");
  }
  if (profile.port !== undefined && !integerInRange(profile.port, 1, 65_535)) {
    throw new ConnectorError("invalid_argument", "SQL Server port is invalid");
  }
  if (profile.instance !== undefined && profile.port !== undefined) {
    throw new ConnectorError("invalid_argument", "SQL Server instance and port are mutually exclusive");
  }
  if (!integerInRange(profile.connectTimeoutMS, 1_000, 30_000)) {
    throw new ConnectorError("invalid_argument", "SQL Server connection timeout is invalid");
  }
  if (!integerInRange(profile.queryTimeoutMS, 1_000, 10_000)) {
    throw new ConnectorError("invalid_argument", "SQL Server query timeout is invalid");
  }
  if (!isCredentialRef(profile.credentialRef)) {
    throw new ConnectorError("invalid_argument", "SQL Server credential ref is invalid");
  }
  if (profile.profileId === profile.credentialRef) {
    throw new ConnectorError("invalid_argument", "SQL Server credential ref must differ from the profile ID");
  }
  if (profile.caPath !== undefined) {
    if (!fixedString(profile.caPath)) throw tlsFailure();
    requireLocalCertificatePath(profile.caPath);
  }
}

export function prepareMSSQLConfig(profile: SQLServerProfile): PreparedMSSQLConfig {
  validateSQLServerProfile(profile);
  const ca = profile.caPath === undefined ? undefined : readLocalCertificate(profile.caPath);
  const options = Object.freeze({
    encrypt: true,
    trustServerCertificate: false,
    ...(profile.instance === undefined ? {} : { instanceName: profile.instance }),
    ...(ca === undefined ? {} : { cryptoCredentialsDetails: { ca } }),
  });
  return Object.freeze({
    server: profile.server,
    ...(profile.port === undefined ? {} : { port: profile.port }),
    database: profile.database,
    connectionTimeout: profile.connectTimeoutMS,
    requestTimeout: profile.queryTimeoutMS,
    options,
  });
}

export function withMSSQLCredential(
  prepared: PreparedMSSQLConfig,
  credential: ServiceCredential,
): MSSQLConfig {
  if (
    typeof credential !== "object" ||
    credential === null ||
    !fixedString(credential.username) ||
    typeof credential.password !== "string" ||
    credential.password.length === 0
  ) {
    throw new ConnectorError("invalid_credentials", "SQL Server service credential is invalid");
  }
  return {
    ...prepared,
    user: credential.username,
    password: credential.password,
    ...(prepared.options === undefined ? {} : { options: { ...prepared.options } }),
  };
}

export function toMSSQLConfig(
  profile: SQLServerProfile,
  credential: ServiceCredential,
): MSSQLConfig {
  return withMSSQLCredential(prepareMSSQLConfig(profile), credential);
}
