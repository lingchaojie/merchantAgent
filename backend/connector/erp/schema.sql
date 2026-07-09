-- ERP schema (Phase 1 mock). A real Kingdee/用友 connector replaces this behind
-- the same connector.Connector interface; here it's an in-memory SQLite the tools
-- query with PARAMETERIZED READ-ONLY statements (never LLM-authored SQL).

CREATE TABLE customers (
  customer_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,          -- join key across ERP<->CRM (by name)
  owner_user_id TEXT NOT NULL,          -- sales rep who owns the account
  owner_dept_id TEXT NOT NULL,
  region        TEXT
);

CREATE TABLE orders (
  order_id      TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(customer_id),
  owner_user_id TEXT NOT NULL,
  owner_dept_id TEXT NOT NULL,
  status        TEXT NOT NULL,          -- 待排产/生产中/已发货/已完成
  promise_date  TEXT NOT NULL,          -- ISO date
  cost          INTEGER NOT NULL,       -- sensitive: data_domain cost
  price         INTEGER NOT NULL        -- sensitive: data_domain pricing
);

-- Bill of materials + on-hand, per order, for the 齐套/欠料 (kitting) scenario.
CREATE TABLE boms (
  order_id  TEXT NOT NULL REFERENCES orders(order_id),
  material  TEXT NOT NULL,
  required  INTEGER NOT NULL,
  on_hand   INTEGER NOT NULL,
  PRIMARY KEY (order_id, material)
);

-- Accounts receivable, for the 逾期应收预警 scenario. Amounts are sensitive
-- (data_domain finance); due_date < today AND settled=0 ⇒ overdue.
CREATE TABLE receivables (
  invoice_id  TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  amount      INTEGER NOT NULL,
  due_date    TEXT NOT NULL,
  settled     INTEGER NOT NULL DEFAULT 0
);
