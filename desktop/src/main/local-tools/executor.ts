import crypto from "node:crypto";
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

export type LocalToolStatus = "succeeded" | "failed" | "cancelled" | "source_conflict";
export type LocalToolResponseError = LocalToolErrorCode | "cancelled" | "local_execution_failed";

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
      (error as { code?: unknown }).code === "source_conflict")
  ) {
    return (error as { code: "invalid_argument" | "source_conflict" }).code;
  }
  return "local_execution_failed";
}

export class LocalToolExecutor {
  constructor(
    private readonly pkg: VerifiedPackage,
    private readonly store?: LocalDataSource,
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
      tool.validate(req.args);
      if (!this.store) {
        throw new LocalDataSourceError("missing_datasource", "local datasource is unavailable");
      }

      switch (req.tool) {
        case "query_order_status": {
          const data = this.store.queryOrderStatus(String(req.args.orderId));
          return { data, meta: { ...base, status: "succeeded" } };
        }
        case "report_production_progress": {
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
            note: String(req.args.note ?? ""),
          });
          base = { ...base, idempotencyKey: approvedRequest.idempotencyKey };
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
              note: approvedRequest.note,
            },
          });
          if (!approved) {
            return {
              meta: { ...base, status: "cancelled", before },
              error: "cancelled",
            };
          }
          const confirmedAt = new Date().toISOString();
          const written = this.store.reportProductionProgress({
            orderId: approvedRequest.orderId,
            workOrderId: approvedRequest.workOrderId,
            completionRate: approvedRequest.completionRate,
            expectedVersion: approvedRequest.expectedVersion,
            note: approvedRequest.note,
            idempotencyKey: approvedRequest.idempotencyKey,
          });
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
      return {
        meta: { ...base, status: code === "source_conflict" ? "source_conflict" : "failed" },
        error: code,
      };
    }
  }
}
