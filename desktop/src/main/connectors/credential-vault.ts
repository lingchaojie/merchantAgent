import type * as keytar from "keytar";

import { ConnectorError, isCredentialRef } from "./schema";

export interface ServiceCredential {
  username: string;
  password: string;
}

export interface CredentialVault {
  put(ref: string, value: ServiceCredential): Promise<void>;
  get(ref: string): Promise<ServiceCredential | null>;
  remove(ref: string): Promise<boolean>;
  listRefs(): Promise<string[]>;
}

export type KeytarAPI = Pick<
  typeof keytar,
  "setPassword" | "getPassword" | "deletePassword" | "findCredentials"
>;

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACCOUNT_PREFIX = "credential/";

function requireScopeId(value: string): string {
  if (!SCOPE_ID.test(value)) {
    throw new ConnectorError("invalid_argument", "credential vault scope is invalid");
  }
  return value;
}

function accountFor(ref: string): string {
  if (!isCredentialRef(ref)) {
    throw new ConnectorError("invalid_argument", "credential ref is invalid");
  }
  return `${ACCOUNT_PREFIX}${ref}`;
}

function requireCredential(value: ServiceCredential): ServiceCredential {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.username !== "string" ||
    value.username.length === 0 ||
    typeof value.password !== "string" ||
    value.password.length === 0
  ) {
    throw new ConnectorError("invalid_credentials", "service credential is invalid");
  }
  return { username: value.username, password: value.password };
}

function decodeCredential(stored: unknown): ServiceCredential {
  let bytes: Buffer | undefined;
  try {
    if (typeof stored !== "string") throw new Error("invalid envelope");
    bytes = Buffer.from(stored, "utf8");
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid envelope");
    }
    const raw = parsed as Record<string, unknown>;
    if (
      Object.keys(raw).length !== 2 ||
      !Object.hasOwn(raw, "username") ||
      !Object.hasOwn(raw, "password")
    ) {
      throw new Error("invalid envelope");
    }
    return requireCredential(raw as unknown as ServiceCredential);
  } catch {
    throw new ConnectorError("invalid_credentials", "stored service credential is invalid");
  } finally {
    bytes?.fill(0);
  }
}

export class KeytarCredentialVault implements CredentialVault {
  readonly #api: KeytarAPI;
  readonly #service: string;

  constructor(
    api: KeytarAPI,
    tenantId: string,
    deviceId: string,
  ) {
    this.#api = api;
    this.#service = `com.merchantagent.connector/${requireScopeId(tenantId)}/${requireScopeId(deviceId)}`;
  }

  async put(ref: string, value: ServiceCredential): Promise<void> {
    const account = accountFor(ref);
    const credential = requireCredential(value);
    try {
      await this.#api.setPassword(this.#service, account, JSON.stringify(credential));
    } catch {
      throw new ConnectorError("invalid_credentials", "service credential could not be stored");
    }
  }

  async get(ref: string): Promise<ServiceCredential | null> {
    const account = accountFor(ref);
    let stored: string | null;
    try {
      stored = await this.#api.getPassword(this.#service, account);
    } catch {
      throw new ConnectorError("missing_credentials", "service credential is unavailable");
    }
    return stored === null ? null : decodeCredential(stored);
  }

  async remove(ref: string): Promise<boolean> {
    const account = accountFor(ref);
    try {
      return await this.#api.deletePassword(this.#service, account);
    } catch {
      throw new ConnectorError("invalid_credentials", "service credential could not be removed");
    }
  }

  async listRefs(): Promise<string[]> {
    let stored: Awaited<ReturnType<KeytarAPI["findCredentials"]>>;
    try {
      stored = await this.#api.findCredentials(this.#service);
    } catch {
      throw new ConnectorError("missing_credentials", "credential refs are unavailable");
    }
    if (!Array.isArray(stored)) {
      throw new ConnectorError("invalid_credentials", "stored credential index is invalid");
    }
    const refs = new Set<string>();
    for (const entry of stored) {
      if (typeof entry !== "object" || entry === null || typeof entry.account !== "string") {
        throw new ConnectorError("invalid_credentials", "stored credential index is invalid");
      }
      if (!entry.account.startsWith(ACCOUNT_PREFIX)) continue;
      const ref = entry.account.slice(ACCOUNT_PREFIX.length);
      if (isCredentialRef(ref)) refs.add(ref);
    }
    return [...refs].sort();
  }
}
