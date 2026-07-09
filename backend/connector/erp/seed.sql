-- Seed data. Preserves the Phase 0 e2e contract (SO-1001: A公司/生产中/cost 82000/
-- price 100000/螺栓 short 200) and adds breadth for aggregation scenarios.
-- Customer names are the ERP<->CRM join key (see connector/crm seed).

INSERT INTO customers (customer_id, name, owner_user_id, owner_dept_id, region) VALUES
  ('C-A', 'A公司',  'u_sales1', 'd_sales', '华东'),
  ('C-B', 'B公司',  'u_sales1', 'd_sales', '华南'),
  ('C-C', 'C贸易',  'u_smgr',   'd_sales', '华北'),
  ('C-D', 'D工厂',  'u_smgr',   'd_sales', '华东');

INSERT INTO orders (order_id, customer_id, owner_user_id, owner_dept_id, status, promise_date, cost, price) VALUES
  ('SO-1001', 'C-A', 'u_sales1', 'd_sales', '生产中',  '2026-07-20', 82000,  100000),
  ('SO-1002', 'C-A', 'u_sales1', 'd_sales', '待排产',  '2026-07-25', 45000,  60000),
  ('SO-1003', 'C-B', 'u_sales1', 'd_sales', '已发货',  '2026-07-10', 30000,  38000),
  ('SO-1004', 'C-C', 'u_smgr',   'd_sales', '生产中',  '2026-07-18', 120000, 155000),
  ('SO-1005', 'C-D', 'u_smgr',   'd_sales', '待排产',  '2026-08-01', 66000,  90000);

INSERT INTO boms (order_id, material, required, on_hand) VALUES
  ('SO-1001', 'M-钢板', 100, 120),
  ('SO-1001', 'M-螺栓', 500, 300),   -- short 200
  ('SO-1002', 'M-铝材', 80,  80),
  ('SO-1004', 'M-钢板', 200, 150),   -- short 50
  ('SO-1004', 'M-轴承', 40,  40);

INSERT INTO receivables (invoice_id, customer_id, amount, due_date, settled) VALUES
  ('INV-9001', 'C-A', 100000, '2026-06-30', 0),   -- overdue (before 2026-07-09)
  ('INV-9002', 'C-B', 38000,  '2026-06-15', 1),   -- settled
  ('INV-9003', 'C-C', 155000, '2026-07-05', 0),   -- overdue
  ('INV-9004', 'C-D', 90000,  '2026-08-15', 0);   -- not yet due
