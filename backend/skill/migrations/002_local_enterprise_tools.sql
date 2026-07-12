INSERT OR IGNORE INTO templates
  (template_id, name, description, playbook_md, allowed_tools, data_domains, suggested_roles)
VALUES
  ('order-status', 'Order Status',
   'Query the current status and local production progress for an order.',
   'Call query_order_status for the requested order and summarize the returned status, promise date, production completion, and version. Do not infer missing values.',
   '["query_order_status"]', '[]', '["sales","planner","manager_tier"]'),
  ('production-progress', 'Production Progress',
   'Review and report local production progress with optimistic concurrency.',
   '1. Call query_order_status for the requested order first.\n2. Pass the returned version to report_production_progress as expectedVersion.\n3. Summarize the proposed completion rate, work order, and note for the client.\n4. Call report_production_progress to request execution. The privileged desktop client asks for confirmation inside tool execution; if the user declines, report the cancellation. Do not claim success until the tool returns a verified result.',
   '["query_order_status","report_production_progress"]', '[]', '["planner","manager_tier"]');

INSERT OR IGNORE INTO skills
  (tenant_id, skill_id, name, description, playbook_md, allowed_tools, data_domains, roles, source_template_id)
VALUES
  ('mock-corp-001', 'order-status', 'Order Status',
   'Query the current status and local production progress for an order.',
   'Call query_order_status for the requested order and summarize the returned status, promise date, production completion, and version. Do not infer missing values.',
   '["query_order_status"]', '[]', '["sales","planner","manager_tier"]', 'order-status'),
  ('mock-corp-001', 'production-progress', 'Production Progress',
   'Review and report local production progress with optimistic concurrency.',
   '1. Call query_order_status for the requested order first.\n2. Pass the returned version to report_production_progress as expectedVersion.\n3. Summarize the proposed completion rate, work order, and note for the client.\n4. Call report_production_progress to request execution. The privileged desktop client asks for confirmation inside tool execution; if the user declines, report the cancellation. Do not claim success until the tool returns a verified result.',
   '["query_order_status","report_production_progress"]', '[]', '["planner","manager_tier"]', 'production-progress');
