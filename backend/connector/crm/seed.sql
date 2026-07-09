-- Seed data. customer_name matches connector/erp customers.name so 客户360 can
-- stitch ERP orders/receivables with CRM contacts/follow-ups/opportunities.

INSERT INTO contacts (contact_id, customer_name, person, title, phone) VALUES
  ('CT-1', 'A公司', '张伟', '采购经理', '138-0000-0001'),
  ('CT-2', 'A公司', '李娜', '总经理',   '138-0000-0002'),
  ('CT-3', 'B公司', '王强', '采购',     '138-0000-0003'),
  ('CT-4', 'C贸易', '陈静', '老板',     '138-0000-0004');

INSERT INTO follow_ups (followup_id, customer_name, at_date, summary, owner_user_id) VALUES
  ('FU-1', 'A公司', '2026-07-01', '确认 SO-1001 交期，客户催货', 'u_sales1'),
  ('FU-2', 'A公司', '2026-07-05', '洽谈追加订单，意向 20 万',    'u_sales1'),
  ('FU-3', 'B公司', '2026-06-28', '回款提醒，客户承诺月底付',    'u_sales1'),
  ('FU-4', 'C贸易', '2026-07-06', '报价谈判中',                 'u_smgr');

INSERT INTO opportunities (opp_id, customer_name, stage, est_amount, owner_user_id) VALUES
  ('OP-1', 'A公司', '谈判', 200000, 'u_sales1'),
  ('OP-2', 'C贸易', '报价', 155000, 'u_smgr'),
  ('OP-3', 'D工厂', '意向', 90000,  'u_smgr');
