-- backend/config/seed.sql — mock-corp-001 starter config.
INSERT INTO roles (tenant_id, role_id, label, description) VALUES
 ('mock-corp-001','manager_tier','管理层','经理/主管/总监等'),
 ('mock-corp-001','sales','销售','销售/业务/外贸'),
 ('mock-corp-001','purchasing','采购',''),
 ('mock-corp-001','planner','计划员','PMC/排产'),
 ('mock-corp-001','qc','质检','QC/品控'),
 ('mock-corp-001','finance','财务','财务/会计/出纳'),
 ('mock-corp-001','staff','员工','默认兜底角色');

INSERT INTO role_rules (tenant_id, ord, match_terms, role_id) VALUES
 ('mock-corp-001',0,'["经理","主管","总监","厂长","负责人","总经理"]','manager_tier'),
 ('mock-corp-001',1,'["销售","业务","外贸","BD"]','sales'),
 ('mock-corp-001',2,'["采购"]','purchasing'),
 ('mock-corp-001',3,'["计划","PMC","排产"]','planner'),
 ('mock-corp-001',4,'["质检","QC","IQC","IPQC","OQC","品控"]','qc'),
 ('mock-corp-001',5,'["财务","会计","出纳"]','finance');

INSERT INTO data_domains (tenant_id, domain_id, label) VALUES
 ('mock-corp-001','cost','成本'),
 ('mock-corp-001','pricing','定价'),
 ('mock-corp-001','orders','订单');

INSERT INTO domain_grants (tenant_id, domain_id, subject) VALUES
 ('mock-corp-001','cost','user:u_fin'),
 ('mock-corp-001','cost','department:mock-corp-001/d_sales#manager'),
 ('mock-corp-001','cost','department:mock-corp-001/d_root#manager'),
 ('mock-corp-001','orders','role:mock-corp-001/sales#assignee'),
 ('mock-corp-001','orders','role:mock-corp-001/planner#assignee'),
 ('mock-corp-001','orders','role:mock-corp-001/manager_tier#assignee');
