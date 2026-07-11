import Database from "better-sqlite3";

const REPORT_PROGRESS_TOOL = "report_production_progress";

export interface OrderStatus {
  orderId: string;
  workOrderId: string;
  status: string;
  promiseDate: string;
  completionRate: number;
  note: string;
  version: number;
}

export interface ProductionProgressInput {
  orderId: string;
  workOrderId: string;
  completionRate: number;
  expectedVersion: number;
  note?: string;
  idempotencyKey: string;
}

export interface ProductionProgressResult {
  data: OrderStatus;
  before: OrderStatus;
  after: OrderStatus;
}

export type ReferenceEnterpriseStoreErrorCode = "invalid_argument" | "source_conflict";

export class ReferenceEnterpriseStoreError extends Error {
  constructor(
    readonly code: ReferenceEnterpriseStoreErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ReferenceEnterpriseStoreError";
  }
}

interface OrderStatusRow {
  order_id: string;
  work_order_id: string;
  status: string;
  promise_date: string;
  completion_rate: number;
  note: string;
  version: number;
}

interface IdempotencyRow {
  tool_name: string;
  result_json: string;
}

function toOrderStatus(row: OrderStatusRow): OrderStatus {
  return {
    orderId: row.order_id,
    workOrderId: row.work_order_id,
    status: row.status,
    promiseDate: row.promise_date,
    completionRate: row.completion_rate,
    note: row.note,
    version: row.version,
  };
}

function requireValidProgress(input: ProductionProgressInput): void {
  if (!Number.isInteger(input.completionRate) || input.completionRate < 0 || input.completionRate > 100) {
    throw new ReferenceEnterpriseStoreError(
      "invalid_argument",
      "completionRate must be an integer from 0 through 100",
    );
  }
}

export class ReferenceEnterpriseStore {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);
    this.database.pragma("foreign_keys = ON");
    this.initialize();
  }

  close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }

  queryOrderStatus(orderId: string): OrderStatus {
    const row = this.selectOrderStatus(orderId);
    if (!row) {
      throw new ReferenceEnterpriseStoreError("source_conflict", "order does not exist");
    }
    return toOrderStatus(row);
  }

  reportProductionProgress(input: ProductionProgressInput): ProductionProgressResult {
    const write = this.database.transaction((): ProductionProgressResult => {
      const idempotent = this.database
        .prepare("SELECT tool_name, result_json FROM tool_idempotency WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as IdempotencyRow | undefined;
      if (idempotent) {
        if (idempotent.tool_name !== REPORT_PROGRESS_TOOL) {
          throw new ReferenceEnterpriseStoreError(
            "source_conflict",
            "idempotency key belongs to a different tool",
          );
        }
        return JSON.parse(idempotent.result_json) as ProductionProgressResult;
      }

      requireValidProgress(input);
      const currentRow = this.selectOrderStatus(input.orderId, input.workOrderId);
      if (!currentRow || currentRow.version !== input.expectedVersion) {
        throw new ReferenceEnterpriseStoreError(
          "source_conflict",
          "order, work order, or expected version does not match the source",
        );
      }
      const before = toOrderStatus(currentRow);

      const update = this.database
        .prepare(
          "UPDATE work_orders SET completion_rate = ?, note = ?, version = version + 1 WHERE work_order_id = ? AND version = ?",
        )
        .run(input.completionRate, input.note ?? currentRow.note, input.workOrderId, input.expectedVersion);
      if (update.changes !== 1) {
        throw new ReferenceEnterpriseStoreError("source_conflict", "work order changed before update");
      }

      const savedRow = this.selectOrderStatus(input.orderId, input.workOrderId);
      if (!savedRow) {
        throw new ReferenceEnterpriseStoreError("source_conflict", "updated work order could not be verified");
      }
      const after = toOrderStatus(savedRow);
      const result = { data: after, before, after };

      this.database
        .prepare(
          "INSERT INTO tool_idempotency (idempotency_key, tool_name, result_json, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(input.idempotencyKey, REPORT_PROGRESS_TOOL, JSON.stringify(result), new Date().toISOString());
      return result;
    });

    return write();
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        promise_date TEXT NOT NULL,
        cost INTEGER NOT NULL,
        price INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_orders (
        work_order_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE,
        completion_rate INTEGER NOT NULL,
        note TEXT NOT NULL,
        version INTEGER NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(order_id)
      );
      CREATE TABLE IF NOT EXISTS tool_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const seed = this.database.transaction(() => {
      const order = this.database.prepare("SELECT order_id FROM orders WHERE order_id = ?").get("SO-1001");
      if (order) return;

      this.database
        .prepare(
          "INSERT INTO orders (order_id, status, promise_date, cost, price) VALUES (?, ?, ?, ?, ?)",
        )
        .run("SO-1001", "生产中", "2026-07-20", 82000, 100000);
      this.database
        .prepare(
          "INSERT INTO work_orders (work_order_id, order_id, completion_rate, note, version) VALUES (?, ?, ?, ?, ?)",
        )
        .run("WO-1001", "SO-1001", 60, "装配中", 1);
    });
    seed();
  }

  private selectOrderStatus(orderId: string, workOrderId?: string): OrderStatusRow | undefined {
    if (workOrderId === undefined) {
      return this.database
        .prepare(
          `SELECT o.order_id, w.work_order_id, o.status, o.promise_date,
                  w.completion_rate, w.note, w.version
             FROM orders AS o
             JOIN work_orders AS w ON w.order_id = o.order_id
            WHERE o.order_id = ?`,
        )
        .get(orderId) as OrderStatusRow | undefined;
    }

    return this.database
      .prepare(
        `SELECT o.order_id, w.work_order_id, o.status, o.promise_date,
                w.completion_rate, w.note, w.version
           FROM orders AS o
           JOIN work_orders AS w ON w.order_id = o.order_id
          WHERE o.order_id = ? AND w.work_order_id = ?`,
      )
      .get(orderId, workOrderId) as OrderStatusRow | undefined;
  }
}
