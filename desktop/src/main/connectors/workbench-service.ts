import { createHash, randomUUID } from "node:crypto";

import { canonicalJSONStringify, strictJSONSnapshot } from "./canonical";
import type { CredentialVault, ServiceCredential } from "./credential-vault";
import type { ConnectorSigningIdentity, DeviceEnrollment } from "./device-identity";
import type { InstalledConnector, ConnectorPackageStore } from "./package-store";
import {
  parseConnectorDraft,
  type ConnectorDraft,
  type ConnectorEnvironment,
  type PublicToolContract,
  type SQLOperation,
  type VerifiedImplementationCredential,
} from "./schema";
import { validateOperationBeforeExecution } from "./sql-policy";

export interface WorkbenchSessionView {
  sessionId: string;
  tenantId: string;
  deviceId: string;
  expiresAt: string;
  scopes: string[];
}

export interface ConnectionTestView {
  environment: ConnectorEnvironment;
  latencyMS: number;
}

export interface WorkbenchTestResult {
  resultId: string;
  raw: unknown;
  projected: Record<string, unknown> | Record<string, unknown>[];
  expiresAt: string;
}

export interface ValidationSummary {
  digest: string;
  checkerVersion: string;
  rulesetVersion: "m7.1-sql-v1";
  testsDigest: string;
  publicContract: { tools: PublicToolContract[] };
}

export interface WorkbenchTester {
  testConnection(signal: AbortSignal): Promise<ConnectionTestView>;
  testOperation(
    operation: SQLOperation,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ raw: unknown; projected: Record<string, unknown> | Record<string, unknown>[] }>;
  close(): void | Promise<void>;
}

export interface ConnectorSubmitter {
  submit(
    installed: InstalledConnector,
    identity: ConnectorSigningIdentity,
  ): Promise<{ digest: string; status: "pending_admin_approval" }>;
}

export interface WorkbenchServiceDependencies {
  tenantId?: string;
  enrollment: DeviceEnrollment;
  bindCredential(encodedCredential: string, now: Date): ConnectorSigningIdentity;
  vault: Pick<CredentialVault, "put">;
  createTester(draft: ConnectorDraft): WorkbenchTester;
  createPackageStore(identity: ConnectorSigningIdentity): Pick<ConnectorPackageStore, "install">;
  submitter: ConnectorSubmitter;
  now?: () => Date;
  id?: () => string;
  resultTTLMS?: number;
}

interface Session {
  id: string;
  encodedCredential: string;
  identity: ConnectorSigningIdentity;
  credential: VerifiedImplementationCredential;
  expiresAtMS: number;
  activeDraftId?: string;
  drafts: Map<string, ConnectorDraft>;
  frozen: Set<string>;
  results: Map<string, WorkbenchTestResult>;
  resultTimers: Map<string, ReturnType<typeof setTimeout>>;
  testers: Map<string, WorkbenchTester>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
}

function workbenchError(code: string): Error {
  const error = new Error(code);
  error.name = "WorkbenchError";
  return error;
}

function requireCredential(value: ServiceCredential): ServiceCredential {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 2
    || typeof value.username !== "string"
    || value.username.trim().length === 0
    || typeof value.password !== "string"
    || value.password.length === 0
  ) {
    throw workbenchError("workbench_invalid_request");
  }
  return { username: value.username, password: value.password };
}

function cloneDraft(value: ConnectorDraft): ConnectorDraft {
  return parseConnectorDraft(strictJSONSnapshot(value));
}

export class WorkbenchService {
  private active?: Session;
  private readonly expiredSessionIds = new Set<string>();
  private closed = false;

  constructor(private readonly dependencies: WorkbenchServiceDependencies) {}

  async getEnrollment(): Promise<DeviceEnrollment> {
    return { ...this.dependencies.enrollment };
  }

  async unlock(encodedCredential: string): Promise<WorkbenchSessionView> {
    if (this.closed) throw workbenchError("workbench_closed");
    if (typeof encodedCredential !== "string" || encodedCredential.length === 0 || encodedCredential.length > 16_384) {
      throw workbenchError("workbench_credential_invalid");
    }
    if (this.active !== undefined) this.dispose(this.active);
    const now = this.now();
    let identity: ConnectorSigningIdentity;
    try {
      identity = this.dependencies.bindCredential(encodedCredential, now);
    } catch {
      throw workbenchError("workbench_credential_invalid");
    }
    const credential = identity.verifiedCredential;
    if (
      (this.dependencies.tenantId !== undefined && credential.tenantId !== this.dependencies.tenantId)
      ||
      credential.deviceId !== this.dependencies.enrollment.deviceId
      || credential.devicePublicKeyPem !== this.dependencies.enrollment.devicePublicKeyPem
      || Date.parse(credential.expiresAt) <= now.getTime()
    ) {
      throw workbenchError("workbench_credential_invalid");
    }
    const session: Session = {
      id: (this.dependencies.id ?? randomUUID)(),
      encodedCredential,
      identity,
      credential,
      expiresAtMS: Date.parse(credential.expiresAt),
      drafts: new Map(),
      frozen: new Set(),
      results: new Map(),
      resultTimers: new Map(),
      testers: new Map(),
      controller: new AbortController(),
    };
    const delay = Math.max(0, session.expiresAtMS - now.getTime());
    session.expiryTimer = setTimeout(() => {
      if (this.active === session) this.expire(session);
    }, Math.min(delay, 2_147_483_647));
    session.expiryTimer.unref?.();
    this.active = session;
    return this.view(session);
  }

  async saveCredential(sessionId: string, ref: string, value: ServiceCredential): Promise<void> {
    const session = this.requireSession(sessionId, "connector:draft");
    const credential = requireCredential(value);
    await this.dependencies.vault.put(ref, credential);
    this.requireSameSession(session);
  }

  async saveDraft(sessionId: string, input: ConnectorDraft): Promise<{ draftId: string }> {
    const session = this.requireSession(sessionId, "connector:draft");
    let draft: ConnectorDraft;
    try {
      draft = cloneDraft(input);
    } catch {
      throw workbenchError("workbench_invalid_request");
    }
    if (draft.tenantId !== session.credential.tenantId || draft.deviceId !== session.credential.deviceId) {
      throw workbenchError("workbench_draft_owner");
    }
    if (session.activeDraftId !== undefined) {
      session.controller.abort();
      session.controller = new AbortController();
      this.clearResults(session);
      this.closeTesters(session);
    }
    session.activeDraftId = draft.draftId;
    session.drafts.set(draft.draftId, draft);
    session.frozen.delete(draft.draftId);
    return { draftId: draft.draftId };
  }

  async testConnection(sessionId: string, draftId: string): Promise<ConnectionTestView> {
    const session = this.requireSession(sessionId, "connector:test");
    const draft = this.requireDraft(session, draftId);
    const result = await this.tester(session, draft).testConnection(session.controller.signal);
    this.requireSameSession(session);
    if (
      typeof result.latencyMS !== "number"
      || result.latencyMS < 0
      || result.environment !== draft.payload.profile.environment
    ) {
      throw workbenchError("workbench_test_failed");
    }
    return { ...result };
  }

  async testOperation(
    sessionId: string,
    draftId: string,
    args: Record<string, unknown>,
  ): Promise<WorkbenchTestResult> {
    const session = this.requireSession(sessionId, "connector:test");
    const draft = this.requireDraft(session, draftId);
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw workbenchError("workbench_invalid_request");
    }
    const operation = draft.payload.operations[0];
    if (operation === undefined) throw workbenchError("workbench_invalid_request");
    validateOperationBeforeExecution(operation);
    const tested = await this.tester(session, draft).testOperation(
      operation,
      strictJSONSnapshot(args),
      session.controller.signal,
    );
    this.requireSameSession(session);
    this.requireDraft(session, draftId);
    const resultId = (this.dependencies.id ?? randomUUID)();
    const expiresAtMS = Math.min(
      session.expiresAtMS,
      this.now().getTime() + (this.dependencies.resultTTLMS ?? 60_000),
    );
    const result: WorkbenchTestResult = {
      resultId,
      raw: strictJSONSnapshot(tested.raw),
      projected: strictJSONSnapshot(tested.projected),
      expiresAt: new Date(expiresAtMS).toISOString(),
    };
    session.results.set(resultId, result);
    const resultTimer = setTimeout(() => {
      session.results.delete(resultId);
      session.resultTimers.delete(resultId);
    }, Math.max(0, expiresAtMS - this.now().getTime()));
    resultTimer.unref?.();
    session.resultTimers.set(resultId, resultTimer);
    return strictJSONSnapshot(result);
  }

  readResult(sessionId: string, resultId: string): WorkbenchTestResult {
    const session = this.requireSession(sessionId, "connector:test");
    const result = session.results.get(resultId);
    if (result === undefined || Date.parse(result.expiresAt) <= this.now().getTime()) {
      if (result !== undefined) session.results.delete(resultId);
      const timer = session.resultTimers.get(resultId);
      if (timer !== undefined) clearTimeout(timer);
      session.resultTimers.delete(resultId);
      throw workbenchError("workbench_result_expired");
    }
    return strictJSONSnapshot(result);
  }

  closeResult(sessionId: string, resultId: string): void {
    const session = this.requireSession(sessionId, "connector:test");
    session.results.delete(resultId);
    const timer = session.resultTimers.get(resultId);
    if (timer !== undefined) clearTimeout(timer);
    session.resultTimers.delete(resultId);
  }

  async validateAndFreeze(sessionId: string, draftId: string): Promise<ValidationSummary> {
    const session = this.requireSession(sessionId, "connector:draft");
    const draft = this.requireDraft(session, draftId);
    const validated = cloneDraft(draft);
    for (const operation of validated.payload.operations) validateOperationBeforeExecution(operation);
    const canonical = canonicalJSONStringify(validated.payload);
    const digest = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    session.drafts.set(draftId, { ...validated, state: "locally_validated" });
    session.frozen.add(draftId);
    return {
      digest,
      checkerVersion: validated.payload.checker.version,
      rulesetVersion: "m7.1-sql-v1",
      testsDigest: validated.payload.checker.testsDigest,
      publicContract: strictJSONSnapshot(validated.payload.publicContract),
    };
  }

  async submit(sessionId: string, draftId: string): Promise<{ digest: string; status: "pending_admin_approval" }> {
    const session = this.requireSession(sessionId, "connector:submit");
    const draft = this.requireDraft(session, draftId);
    if (!session.frozen.has(draftId) || draft.state !== "locally_validated") {
      throw workbenchError("workbench_draft_not_frozen");
    }
    const installed = this.dependencies.createPackageStore(session.identity).install(cloneDraft(draft));
    const submitted = await this.dependencies.submitter.submit(installed, session.identity);
    this.requireSameSession(session);
    if (submitted.digest !== installed.manifest.digest || submitted.status !== "pending_admin_approval") {
      throw workbenchError("workbench_submit_failed");
    }
    return { ...submitted };
  }

  lock(sessionId?: string): void {
    if (this.active === undefined || (sessionId !== undefined && this.active.id !== sessionId)) return;
    this.dispose(this.active);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.active !== undefined) this.dispose(this.active);
  }

  diagnosticState(): { active: boolean; draftCount: number; resultCount: number } {
    return {
      active: this.active !== undefined,
      draftCount: this.active?.drafts.size ?? 0,
      resultCount: this.active?.results.size ?? 0,
    };
  }

  private now(): Date {
    return (this.dependencies.now ?? (() => new Date()))();
  }

  private view(session: Session): WorkbenchSessionView {
    return {
      sessionId: session.id,
      tenantId: session.credential.tenantId,
      deviceId: session.credential.deviceId,
      expiresAt: session.credential.expiresAt,
      scopes: [...session.credential.scopes],
    };
  }

  private requireSession(sessionId: string, scope: VerifiedImplementationCredential["scopes"][number]): Session {
    const session = this.active;
    if (session === undefined || session.id !== sessionId) {
      if (this.expiredSessionIds.has(sessionId)) throw workbenchError("workbench_session_expired");
      throw workbenchError("workbench_session_locked");
    }
    if (this.now().getTime() >= session.expiresAtMS) {
      this.expire(session);
      throw workbenchError("workbench_session_expired");
    }
    if (!session.credential.scopes.includes(scope)) throw workbenchError("workbench_scope_denied");
    return session;
  }

  private requireSameSession(session: Session): void {
    if (this.active !== session) throw workbenchError("workbench_session_locked");
    this.requireSession(session.id, "connector:draft");
  }

  private requireDraft(session: Session, draftId: string): ConnectorDraft {
    const draft = session.drafts.get(draftId);
    if (draft === undefined || session.activeDraftId !== draftId) throw workbenchError("workbench_draft_owner");
    if (draft.tenantId !== session.credential.tenantId || draft.deviceId !== session.credential.deviceId) {
      throw workbenchError("workbench_draft_owner");
    }
    return draft;
  }

  private tester(session: Session, draft: ConnectorDraft): WorkbenchTester {
    let tester = session.testers.get(draft.draftId);
    if (tester === undefined) {
      tester = this.dependencies.createTester(cloneDraft(draft));
      session.testers.set(draft.draftId, tester);
    }
    return tester;
  }

  private clearResults(session: Session): void {
    for (const timer of session.resultTimers.values()) clearTimeout(timer);
    session.resultTimers.clear();
    session.results.clear();
  }

  private closeTesters(session: Session): void {
    for (const tester of session.testers.values()) {
      void Promise.resolve(tester.close()).catch(() => undefined);
    }
    session.testers.clear();
  }

  private dispose(session: Session): void {
    if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
    session.controller.abort();
    this.clearResults(session);
    this.closeTesters(session);
    session.drafts.clear();
    session.frozen.clear();
    session.encodedCredential = "";
    if (this.active === session) this.active = undefined;
  }

  private expire(session: Session): void {
    this.expiredSessionIds.add(session.id);
    while (this.expiredSessionIds.size > 32) {
      const oldest = this.expiredSessionIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.expiredSessionIds.delete(oldest);
    }
    this.dispose(session);
  }
}
