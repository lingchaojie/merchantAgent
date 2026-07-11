-- Seed: one platform template + two tenant skills for mock-corp-001.
-- roles use platform role ids (see sync.DefaultRoleRules): sales / manager_tier /
-- planner / … . order360 is usable by sales + manager_tier so the e2e users
-- u_sales1(sales), u_smgr(manager_tier), and u_boss(manager_tier) can invoke
-- the original order360 tools. Later migrations add narrower role-scoped skills.

INSERT INTO templates (template_id, name, description, playbook_md, allowed_tools, data_domains, suggested_roles) VALUES
 ('order-360', '订单360',
  '查订单全景：进度/交期/齐套/财务（财务按权限展示）',
  '当用户问某订单情况时：\n1. query_order_status 取状态/交期/客户\n2. check_material_kitting 看齐套欠料\n3. 若用户有财务权限，query_order_financials 补成本/利润\n4. 汇总成话；欠料且临近交期→标红预警',
  '["query_order_status","query_order_financials","check_material_kitting"]',
  '["cost","pricing"]',
  '["sales","manager_tier"]');

INSERT INTO skills (tenant_id, skill_id, name, description, playbook_md, allowed_tools, data_domains, roles, source_template_id) VALUES
 ('mock-corp-001', 'order360', '订单360',
  '查订单全景：进度/交期/齐套/财务（财务按权限展示）',
  '当用户问某订单情况时：\n1. query_order_status 取状态/交期/客户\n2. check_material_kitting 看齐套欠料\n3. 若用户有财务权限，query_order_financials 补成本/利润\n4. 汇总成话；欠料且临近交期→标红预警',
  '["query_order_status","query_order_financials","check_material_kitting"]',
  '["cost","pricing"]',
  '["sales","manager_tier"]',
  'order-360'),
 ('mock-corp-001', 'customer360', '客户360',
  '跨 ERP+CRM 拼客户全景：订单+联系人+跟进+商机',
  '当用户问某客户整体情况时：\n1. query_customer_orders 取该客户订单\n2. query_customer_contacts 取联系人\n3. query_customer_followups 取最近跟进\n4. query_customer_opportunities 取商机\n5. 汇总成客户档案卡',
  '["query_customer_orders","query_customer_contacts","query_customer_followups","query_customer_opportunities"]',
  '[]',
  '["sales","manager_tier"]',
  NULL);
