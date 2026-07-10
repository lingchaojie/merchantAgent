-- skill registry (design §3). Runtime-editable (M6 admin UI builds CRUD on this),
-- so NOT query_only. The AUTHORIZATION projection of these rows (which tools a
-- skill exposes, which roles may use it) is turned into OpenFGA tuples by
-- skill.Tuples — same "single source → tuples" pattern as org sync (§3.4).

-- Platform starter templates (global, read-only conceptually; FSE/we maintain).
CREATE TABLE IF NOT EXISTS templates (
  template_id     TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  playbook_md     TEXT NOT NULL,
  allowed_tools   TEXT NOT NULL,   -- JSON array of tool names
  data_domains    TEXT NOT NULL,   -- JSON array (advisory: "may touch cost")
  suggested_roles TEXT NOT NULL    -- JSON array of role ids
);

-- Tenant skills (cloned from a template, then edited by the tenant admin).
CREATE TABLE IF NOT EXISTS skills (
  tenant_id          TEXT NOT NULL,
  skill_id           TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  playbook_md        TEXT NOT NULL,   -- Markdown body (given to LLM on load_skill)
  allowed_tools      TEXT NOT NULL,   -- JSON array of tool names
  data_domains       TEXT NOT NULL,   -- JSON array (advisory only, NOT a grant)
  roles              TEXT NOT NULL,   -- JSON array of role ids that may use it
  source_template_id TEXT,            -- provenance (nullable)
  PRIMARY KEY (tenant_id, skill_id)
);
