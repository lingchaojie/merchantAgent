import crypto from "node:crypto";
import type { SQLServerAdapter, UpdatePreview } from "../connectors/sql-adapter";
import type { SQLUpdateOperation } from "../connectors/schema";
import {
  LocalToolError,
  type LocalToolErrorCode,
  type VerifiedPackage,
  type VerifiedTool,
} from "./package";
import type {
  OrderStatus,
  ProductionProgressInput,
  ProductionProgressResult,
} from "./store";

export type LocalToolStatus = "succeeded" | "failed" | "cancelled" | "source_conflict" | "unknown";
export type LocalToolResponseError = LocalToolErrorCode | "cancelled" | "local_execution_failed" | "source_rejected" | "unknown";

export interface LocalToolRequest {
  packageId: string;
  packageVersion: string;
  manifestDigest: string;
  tool: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  roleIds: string[];
  skillId: string;
  callId: string;
  idempotencyKey: string;
  risk: "read" | "low_write" | "high_write";
  requiresConfirmation: boolean;
  args: Record<string, unknown>;
}

export interface LocalToolExecutionMeta {
  status: LocalToolStatus;
  executionId: string;
  idempotencyKey: string;
  confirmed: boolean;
  confirmedAt?: string;
  before?: OrderStatus;
  after?: OrderStatus;
}

export interface LocalToolResponse {
  data?: OrderStatus;
  meta: LocalToolExecutionMeta;
  error?: LocalToolResponseError;
}

export interface WritePreview {
  orderId: string;
  workOrderId: string;
  before: OrderStatus;
  proposed: {
    completionRate: number;
    note: string;
  };
}

export type Confirm = (preview: WritePreview) => Promise<boolean>;

export interface LocalDataSource {
  queryOrderStatus(orderId: string): OrderStatus;
  reportProductionProgress(input: ProductionProgressInput): ProductionProgressResult;
}

export interface SQLUpdateRuntime {
  operation: SQLUpdateOperation;
  adapter: Pick<SQLServerAdapter, "resumeUpdate" | "previewUpdate" | "executeConfirmedUpdate">;
}

export type LocalDataSourceErrorCode = "missing_datasource" | "invalid_credentials";

export class LocalDataSourceError extends Error {
  constructor(readonly code: LocalDataSourceErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "LocalDataSourceError";
  }
}

function validateRequestMetadata(req: LocalToolRequest, tool: VerifiedTool): void {
  for (const [field, value] of [
    ["tenantId", req.tenantId],
    ["userId", req.userId],
    ["deviceId", req.deviceId],
    ["skillId", req.skillId],
    ["callId", req.callId],
    ["idempotencyKey", req.idempotencyKey],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new LocalToolError("invalid_credentials", `${field} is required`);
    }
  }
  if (!Array.isArray(req.roleIds) || req.roleIds.some((role) => typeof role !== "string" || role === "")) {
    throw new LocalToolError("invalid_credentials", "roleIds are invalid");
  }
  if (req.risk !== tool.risk || req.requiresConfirmation !== tool.requiresConfirmation) {
    throw new LocalToolError("invalid_argument", "request execution policy does not match the signed manifest");
  }
}

function localErrorCode(error: unknown): LocalToolResponseError {
  if (error instanceof LocalToolError || error instanceof LocalDataSourceError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "invalid_argument" ||
      (error as { code?: unknown }).code === "source_conflict" ||
      (error as { code?: unknown }).code === "source_rejected" ||
      (error as { code?: unknown }).code === "unknown")
  ) {
    return (error as { code: "invalid_argument" | "source_conflict" | "source_rejected" | "unknown" }).code;
  }
  return "local_execution_failed";
}

function resumedErrorMetadata(error: unknown): { confirmedAt: string; before: OrderStatus } | null {
  if (typeof error !== "object" || error === null || (error as { name?: unknown }).name !== "ResumedUpdateError") {
    return null;
  }
  const confirmedAt = (error as { confirmedAt?: unknown }).confirmedAt;
  const before = (error as { before?: unknown }).before;
  if (typeof confirmedAt !== "string" || typeof before !== "object" || before === null || Array.isArray(before)) {
    return null;
  }
  return { confirmedAt, before: before as OrderStatus };
}

function sqlResumeArguments(
  args: Record<string, unknown>,
  operation: SQLUpdateOperation,
): Readonly<Record<string, unknown>> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new LocalToolError("invalid_argument", "arguments must be an object");
  }
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LocalToolError("invalid_argument", "arguments must be plain data");
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(args)) {
    if (typeof key !== "string") throw new LocalToolError("invalid_argument", "argument names are invalid");
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new LocalToolError("invalid_argument", "arguments must be plain data");
    }
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value,
    });
  }
  const needsNextVersion = operation.bindings.some((binding) => binding.argument === "nextVersion");
  if (needsNextVersion && !Object.prototype.hasOwnProperty.call(snapshot, "nextVersion")) {
    const expectedVersion = snapshot.expectedVersion;
    Object.defineProperty(snapshot, "nextVersion", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: Number.isSafeInteger(expectedVersion) ? (expectedVersion as number) + 1 : expectedVersion,
    });
  }
  return Object.freeze(snapshot);
}

export class LocalToolExecutor {
  constructor(
    private readonly pkg: VerifiedPackage,
    private readonly store?: LocalDataSource,
    private readonly sqlUpdateRuntime?: SQLUpdateRuntime,
  ) {}

  async execute(req: LocalToolRequest, confirm: Confirm): Promise<LocalToolResponse> {
    const executionId = crypto.randomUUID();
    let base = {
      executionId,
      idempotencyKey: typeof req.idempotencyKey === "string" ? req.idempotencyKey : "",
      confirmed: false,
    };

    try {
      const tool = this.pkg.requireTool(
        req.packageId,
        req.packageVersion,
        req.manifestDigest,
        req.tool,
      );
      validateRequestMetadata(req, tool);
      let resumedSQLArgs: Readonly<Record<string, unknown>> | undefined;
      if (req.tool === "report_production_progress" && this.sqlUpdateRuntime !== undefined) {
        resumedSQLArgs = sqlResumeArguments(req.args, this.sqlUpdateRuntime.operation);
        const resumed = await this.sqlUpdateRuntime.adapter.resumeUpdate(
          this.sqlUpdateRuntime.operation,
          resumedSQLArgs,
          req.idempotencyKey,
        );
        if (resumed !== null) {
          return {
            data: resumed.result as unknown as OrderStatus,
            meta: {
              ...base,
              status: "succeeded",
              confirmed: true,
              confirmedAt: resumed.confirmedAt,
              before: resumed.before as unknown as OrderStatus,
              after: resumed.result as unknown as OrderStatus,
            },
          };
        }
      }
      tool.validate(req.args);
      switch (req.tool) {
        case "query_order_status": {
          if (!this.store) {
            throw new LocalDataSourceError("missing_datasource", "local datasource is unavailable");
          }
          const data = this.store.queryOrderStatus(String(req.args.orderId));
          return { data, meta: { ...base, status: "succeeded" } };
        }
        case "report_production_progress": {
          const notePresent = Object.prototype.hasOwnProperty.call(req.args, "note");
          const approvedRequest = Object.freeze({
            tenantId: req.tenantId,
            userId: req.userId,
            deviceId: req.deviceId,
            roleIds: Object.freeze([...req.roleIds]),
            skillId: req.skillId,
            callId: req.callId,
            idempotencyKey: req.idempotencyKey,
            orderId: String(req.args.orderId),
            workOrderId: String(req.args.workOrderId),
            completionRate: Number(req.args.completionRate),
            expectedVersion: Number(req.args.expectedVersion),
            notePresent,
            note: notePresent ? String(req.args.note) : undefined,
          });
          base = { ...base, idempotencyKey: approvedRequest.idempotencyKey };
          if (this.sqlUpdateRuntime !== undefined) {
            if (resumedSQLArgs === undefined) throw new LocalDataSourceError("missing_datasource", "SQL arguments are unavailable");
            return await this.executeSQLProgress(approvedRequest, resumedSQLArgs, base, confirm);
          }
          if (!this.store) {
            throw new LocalDataSourceError("missing_datasource", "local datasource is unavailable");
          }
          const before = this.store.queryOrderStatus(approvedRequest.orderId);
          if (before.workOrderId !== approvedRequest.workOrderId) {
            throw new LocalToolError("source_conflict", "work order does not belong to the order");
          }
          const approved = await confirm({
            orderId: approvedRequest.orderId,
            workOrderId: approvedRequest.workOrderId,
            before,
            proposed: {
              completionRate: approvedRequest.completionRate,
              note: approvedRequest.notePresent ? approvedRequest.note! : before.note,
            },
          });
          if (!approved) {
            return {
              meta: { ...base, status: "cancelled", before },
              error: "cancelled",
            };
          }
          const confirmedAt = new Date().toISOString();
          const writeInput: ProductionProgressInput = {
            orderId: approvedRequest.orderId,
            workOrderId: approvedRequest.workOrderId,
            completionRate: approvedRequest.completionRate,
            expectedVersion: approvedRequest.expectedVersion,
            idempotencyKey: approvedRequest.idempotencyKey,
            ...(approvedRequest.notePresent ? { note: approvedRequest.note! } : {}),
          };
          const written = this.store.reportProductionProgress(writeInput);
          return {
            data: written.data,
            meta: {
              ...base,
              status: "succeeded",
              confirmed: true,
              confirmedAt,
              before: written.before,
              after: written.after,
            },
          };
        }
        default:
          return {
            meta: { ...base, status: "failed" },
            error: "tool_not_installed",
          };
      }
    } catch (error) {
      const code = localErrorCode(error);
      const resumed = resumedErrorMetadata(error);
      if (resumed !== null) {
        return {
          meta: {
            ...base,
            status: code === "source_conflict" ? "source_conflict" : code === "unknown" ? "unknown" : "failed",
            confirmed: true,
            confirmedAt: resumed.confirmedAt,
            before: resumed.before,
          },
          error: code,
        };
      }
      return {
        meta: {
          ...base,
          status: code === "source_conflict" ? "source_conflict" : code === "unknown" ? "unknown" : "failed",
        },
        error: code,
      };
    }
  }

  private async executeSQLProgress(
    approvedRequest: Readonly<{
      idempotencyKey: string;
      orderId: string;
      workOrderId: string;
      completionRate: number;
      expectedVersion: number;
      notePresent: boolean;
      note?: string;
    }>,
    sqlArgs: Readonly<Record<string, unknown>>,
    base: { executionId: string; idempotencyKey: string; confirmed: boolean },
    confirm: Confirm,
  ): Promise<LocalToolResponse> {
    const runtime = this.sqlUpdateRuntime;
    if (runtime === undefined) throw new LocalDataSourceError("missing_datasource", "SQL runtime is unavailable");
    const preview: UpdatePreview = await runtime.adapter.previewUpdate(runtime.operation, sqlArgs);
    if (preview.before.workOrderId !== approvedRequest.workOrderId) {
      throw new LocalToolError("source_conflict", "work order does not belong to the order");
    }
    const approved = await confirm(Object.freeze({
      orderId: approvedRequest.orderId,
      workOrderId: approvedRequest.workOrderId,
      before: preview.before as unknown as OrderStatus,
      proposed: Object.freeze({
        completionRate: approvedRequest.completionRate,
        note: String(preview.proposed.note),
      }),
    }));
    if (!approved) {
      return {
        meta: { ...base, status: "cancelled", before: preview.before as unknown as OrderStatus },
        error: "cancelled",
      };
    }
    const confirmedAt = new Date().toISOString();
    let after: Record<string, unknown>;
    try {
      after = await runtime.adapter.executeConfirmedUpdate(
        runtime.operation,
        sqlArgs,
        approvedRequest.idempotencyKey,
        preview,
      );
    } catch (error) {
      const code = localErrorCode(error);
      return {
        meta: {
          ...base,
          status: code === "source_conflict" ? "source_conflict" : code === "unknown" ? "unknown" : "failed",
          confirmed: true,
          confirmedAt,
          before: preview.before as unknown as OrderStatus,
        },
        error: code,
      };
    }
    return {
      data: after as unknown as OrderStatus,
      meta: {
        ...base,
        status: "succeeded",
        confirmed: true,
        confirmedAt,
        before: preview.before as unknown as OrderStatus,
        after: after as unknown as OrderStatus,
      },
    };
  }
}
