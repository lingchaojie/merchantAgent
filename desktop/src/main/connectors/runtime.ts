import { randomUUID } from "node:crypto";

import type { LocalToolRequest, LocalToolResponse } from "../../shared/contract";
import type { CredentialVault } from "./credential-vault";
import {
  ConnectorPackageError,
  type ConnectorPackageReader,
  type LoadedApprovedConnector,
} from "./package-store";
import {
  ConnectorError,
  type ConnectorErrorCode,
  type ParameterProperty,
  type PublicToolContract,
  type SQLReadOperation,
  type SQLUpdateOperation,
} from "./schema";
import type { ResumedUpdate, UpdatePreview } from "./sql-adapter";
import {
  validateOperationBeforeExecution,
  readOperationUsesResourceParameter,
} from "./sql-policy";
import { assertM71Contract, prepareM71Arguments } from "./m7-contract";

export interface ApprovalResolver {
  getApproval(
    tenantId: string,
    userId: string,
    connectorId: string,
    version: string,
  ): Promise<{
    digest: string;
    status: "pending_admin_approval" | "published" | "suspended" | "revoked";
  } | null>;
}

export interface ConnectorSource {
  executeRead(operation: SQLReadOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
  resumeUpdate(
    operation: SQLUpdateOperation,
    args: Record<string, unknown>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ResumedUpdate | null>;
  previewUpdate(operation: SQLUpdateOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<UpdatePreview>;
  executeConfirmedUpdate(
    operation: SQLUpdateOperation,
    args: Record<string, unknown>,
    idempotencyKey: string,
    preview: UpdatePreview,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export type Confirm = (preview: UpdatePreview) => boolean | Promise<boolean>;

export interface ConnectorRuntimeDependencies {
  tenantId?: string;
  approvals: ApprovalResolver;
  packages: Pick<ConnectorPackageReader, "loadApproved"> & {
    loadApproved(ref: { connectorId: string; version: string }, digest: string, tenantId?: string): LoadedApprovedConnector;
  };
  vault: Pick<CredentialVault, "get">;
  createSource(connector: LoadedApprovedConnector): ConnectorSource;
  executionId?: () => string;
}

const PUBLIC_ERRORS = new Set<ConnectorErrorCode>([
  "connector_not_installed",
  "package_integrity",
  "package_version",
  "approval_revoked",
  "missing_credentials",
  "invalid_credentials",
  "connection_failed",
  "tls_failed",
  "invalid_argument",
  "unsafe_template",
  "permission_denied",
  "record_not_found",
  "source_conflict",
  "source_rejected",
  "failed",
  "unknown",
]);

function ownEnumerableRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function matchesProperty(value: unknown, property: ParameterProperty): boolean {
  if (property.type === "string") {
    if (typeof value !== "string") return false;
    if (property.minLength !== undefined && value.length < property.minLength) return false;
    if (property.maxLength !== undefined && value.length > property.maxLength) return false;
  } else if (property.type === "integer") {
    if (!Number.isSafeInteger(value)) return false;
    if (property.minimum !== undefined && (value as number) < property.minimum) return false;
    if (property.maximum !== undefined && (value as number) > property.maximum) return false;
  } else if (property.type === "boolean") {
    if (typeof value !== "boolean") return false;
  } else {
    return false;
  }
  return property.enum === undefined || property.enum.includes(value as never);
}

function validateArguments(tool: PublicToolContract, args: unknown): asserts args is Record<string, unknown> {
  if (!ownEnumerableRecord(args)) throw new ConnectorError("invalid_argument", "invalid_argument");
  const keys = Object.keys(args);
  const declared = Object.keys(tool.parameters.properties);
  if (
    keys.some((key) => !Object.hasOwn(tool.parameters.properties, key))
    || tool.parameters.required.some((key) => !Object.hasOwn(args, key))
    || declared.some((key) => Object.hasOwn(args, key) && !matchesProperty(args[key], tool.parameters.properties[key]))
  ) {
    throw new ConnectorError("invalid_argument", "invalid_argument");
  }
}

function checkedTool(connector: LoadedApprovedConnector, request: LocalToolRequest) {
  if (
    connector.ref.connectorId !== request.packageId
    || connector.ref.version !== request.packageVersion
    || connector.manifest.digest !== request.manifestDigest
    || connector.manifest.deviceId !== request.deviceId
    || connector.payload.connectorId !== request.packageId
    || connector.payload.version !== request.packageVersion
  ) {
    throw new ConnectorError("package_version", "package_version");
  }
  try {
    assertM71Contract(connector.manifest.publicContract, connector.payload.operations);
  } catch {
    throw new ConnectorError("permission_denied", "permission_denied");
  }
  const contract = connector.manifest.publicContract.tools.find((candidate) => candidate.name === request.tool);
  const operation = connector.payload.operations.find((candidate) => candidate.tool === request.tool);
  if (
    contract === undefined
    || operation === undefined
    || contract.risk !== request.risk
    || contract.requiresConfirmation !== request.requiresConfirmation
    || (operation.kind === "read") !== (contract.risk === "read")
    || operation.timeoutMS !== contract.timeoutMS
    || (operation.kind === "read" && operation.maxResults !== contract.maxResults)
    || operation.projection.length !== contract.resultFields.length
    || operation.projection.some((projection) => !contract.resultFields.includes(projection.resultField))
  ) {
    throw new ConnectorError("permission_denied", "permission_denied");
  }
  validateArguments(contract, request.args);
  validateOperationBeforeExecution(operation);
  const resourceBinding = operation.bindings.find((binding) => binding.argument === contract.resourceArg);
  if (resourceBinding === undefined) throw new ConnectorError("permission_denied", "permission_denied");
  if (operation.kind === "update") {
    if (resourceBinding.parameter !== operation.resourceParameter) {
      throw new ConnectorError("permission_denied", "permission_denied");
    }
  } else {
    if (!readOperationUsesResourceParameter(operation, resourceBinding.parameter, contract.resourceArg)) {
      throw new ConnectorError("permission_denied", "permission_denied");
    }
  }
  let preparedArgs: Record<string, unknown>;
  try {
    preparedArgs = prepareM71Arguments(request.tool, request.args);
  } catch {
    throw new ConnectorError("invalid_argument", "invalid_argument");
  }
  return { operation, preparedArgs };
}

function normalizedError(error: unknown): ConnectorErrorCode {
  if (error instanceof ConnectorPackageError) return error.code;
  if (error instanceof ConnectorError && PUBLIC_ERRORS.has(error.code)) return error.code;
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  ) {
    return "connector_not_installed";
  }
  return "failed";
}

export class ConnectorRuntime {
  private readonly active = new Set<AbortController>();
  private closed = false;

  constructor(private readonly dependencies: ConnectorRuntimeDependencies) {}

  async execute(request: LocalToolRequest, confirm: Confirm): Promise<LocalToolResponse> {
    const executionId = (this.dependencies.executionId ?? randomUUID)();
    const baseMeta = {
      executionId,
      idempotencyKey: typeof request?.idempotencyKey === "string" ? request.idempotencyKey : "invalid",
      confirmed: false,
    };
    if (this.closed) return { meta: { ...baseMeta, status: "failed" }, error: "failed" };
    const controller = new AbortController();
    this.active.add(controller);
    try {
      if (this.dependencies.tenantId !== undefined && request.tenantId !== this.dependencies.tenantId) {
        throw new ConnectorError("permission_denied", "permission_denied");
      }
      const approval = await this.dependencies.approvals.getApproval(
        request.tenantId,
        request.userId,
        request.packageId,
        request.packageVersion,
      );
      if (approval === null || approval.status !== "published") {
        throw new ConnectorError("approval_revoked", "approval_revoked");
      }
      if (approval.digest !== request.manifestDigest) {
        throw new ConnectorError("package_version", "package_version");
      }
      const connector = this.dependencies.packages.loadApproved(
        { connectorId: request.packageId, version: request.packageVersion },
        approval.digest,
        request.tenantId,
      );
      const { operation, preparedArgs } = checkedTool(connector, request);
      const credential = await this.dependencies.vault.get(connector.payload.profile.credentialRef);
      if (credential === null) throw new ConnectorError("missing_credentials", "missing_credentials");
      const source = this.dependencies.createSource(connector);
      if (operation.kind === "read") {
        const rows = await source.executeRead(operation, preparedArgs, controller.signal);
        return { data: { rows }, meta: { ...baseMeta, status: "succeeded" } };
      }
      const resumed = await source.resumeUpdate(operation, preparedArgs, request.idempotencyKey, controller.signal);
      if (resumed !== null) {
        return {
          data: { ...resumed.result },
          meta: {
            ...baseMeta,
            status: "succeeded",
            confirmed: true,
            confirmedAt: resumed.confirmedAt,
            before: { ...resumed.before },
            after: { ...resumed.result },
          },
        };
      }
      const preview = await source.previewUpdate(operation, preparedArgs, controller.signal);
      if (!await confirm(preview)) {
        return {
          meta: { ...baseMeta, status: "cancelled", before: { ...preview.before } },
          error: "cancelled",
        };
      }
      const confirmedAt = new Date().toISOString();
      const result = await source.executeConfirmedUpdate(
        operation,
        preparedArgs,
        request.idempotencyKey,
        preview,
        controller.signal,
      );
      return {
        data: { ...result },
        meta: {
          ...baseMeta,
          status: "succeeded",
          confirmed: true,
          confirmedAt,
          before: { ...preview.before },
          after: { ...result },
        },
      };
    } catch (error) {
      const code = normalizedError(error);
      const status = code === "source_conflict" ? "source_conflict" : code === "unknown" ? "unknown" : "failed";
      return { meta: { ...baseMeta, status }, error: code };
    } finally {
      this.active.delete(controller);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}

interface RoutedExecutor {
  execute(
    request: LocalToolRequest,
    confirm: (preview: never) => Promise<boolean> | boolean,
  ): Promise<LocalToolResponse>;
}

export class LocalToolRouter {
  constructor(
    private readonly reference: RoutedExecutor,
    private readonly published: RoutedExecutor,
    private readonly referencePackageIds: ReadonlySet<string>,
  ) {}

  execute(request: LocalToolRequest, confirm: (preview: never) => Promise<boolean>): Promise<LocalToolResponse> {
    const executor = this.referencePackageIds.has(request.packageId) ? this.reference : this.published;
    return executor.execute(request, confirm);
  }
}
