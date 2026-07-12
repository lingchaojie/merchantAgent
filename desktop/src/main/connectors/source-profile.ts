import type { config as MSSQLConfig } from "mssql";
import fs from "node:fs";

import type { ServiceCredential } from "./credential-vault";
import { ConnectorError, isCredentialRef, type SQLServerProfile } from "./schema";

function fixedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
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
  if (!fixedString(profile.profileId) || !fixedString(profile.server) || !fixedString(profile.database)) {
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
  if (profile.caPath !== undefined && !fixedString(profile.caPath)) {
    throw new ConnectorError("invalid_argument", "SQL Server CA path is invalid");
  }
}

export function toMSSQLConfig(
  profile: SQLServerProfile,
  credential: ServiceCredential,
): MSSQLConfig {
  validateSQLServerProfile(profile);
  if (
    typeof credential !== "object" ||
    credential === null ||
    !fixedString(credential.username) ||
    typeof credential.password !== "string" ||
    credential.password.length === 0
  ) {
    throw new ConnectorError("invalid_credentials", "SQL Server service credential is invalid");
  }
  let ca: string | undefined;
  if (profile.caPath !== undefined) {
    try {
      ca = fs.readFileSync(profile.caPath, "utf8");
      if (ca.length === 0) throw new Error("empty CA file");
    } catch {
      throw new ConnectorError("tls_failed", "SQL Server CA certificate is unavailable");
    }
  }
  return {
    user: credential.username,
    password: credential.password,
    server: profile.server,
    ...(profile.port === undefined ? {} : { port: profile.port }),
    database: profile.database,
    connectionTimeout: profile.connectTimeoutMS,
    requestTimeout: profile.queryTimeoutMS,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      ...(profile.instance === undefined ? {} : { instanceName: profile.instance }),
      ...(ca === undefined ? {} : { cryptoCredentialsDetails: { ca } }),
    },
  };
}
