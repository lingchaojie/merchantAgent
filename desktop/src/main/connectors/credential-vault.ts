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

function nativeFailure(): ConnectorError {
  return new ConnectorError("invalid_credentials", "credential vault operation failed");
}

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
      const result = await this.#api.setPassword(this.#service, account, JSON.stringify(credential));
      if (result !== undefined) throw new Error("invalid native result");
    } catch {
      throw nativeFailure();
    }
  }

  async get(ref: string): Promise<ServiceCredential | null> {
    const account = accountFor(ref);
    let stored: string | null;
    try {
      stored = await this.#api.getPassword(this.#service, account);
    } catch {
      throw nativeFailure();
    }
    return stored === null ? null : decodeCredential(stored);
  }

  async remove(ref: string): Promise<boolean> {
    const account = accountFor(ref);
    try {
      const removed = await this.#api.deletePassword(this.#service, account);
      if (typeof removed !== "boolean") throw new Error("invalid native result");
      return removed;
    } catch {
      throw nativeFailure();
    }
  }

  async listRefs(): Promise<string[]> {
    try {
      const stored = await this.#api.findCredentials(this.#service);
      if (!Array.isArray(stored)) throw new Error("invalid native result");
      const refs = new Set<string>();
      for (const entry of stored) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          throw new Error("invalid native result");
        }
        if (Object.getPrototypeOf(entry) !== Object.prototype) {
          throw new Error("invalid native result");
        }
        const keys = Object.keys(entry);
        const account = Object.getOwnPropertyDescriptor(entry, "account");
        const password = Object.getOwnPropertyDescriptor(entry, "password");
        if (
          keys.length !== 2 ||
          !keys.includes("account") ||
          !keys.includes("password") ||
          account === undefined ||
          password === undefined ||
          !("value" in account) ||
          !("value" in password) ||
          typeof account.value !== "string" ||
          typeof password.value !== "string"
        ) {
          throw new Error("invalid native result");
        }
        if (!account.value.startsWith(ACCOUNT_PREFIX)) continue;
        const ref = account.value.slice(ACCOUNT_PREFIX.length);
        if (isCredentialRef(ref)) refs.add(ref);
      }
      return [...refs].sort();
    } catch {
      throw nativeFailure();
    }
  }
}
