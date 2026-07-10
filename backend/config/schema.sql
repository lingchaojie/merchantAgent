-- backend/config/schema.sql
-- M6 config registry (source of truth for admin-editable authz config).
-- Runtime-editable, persisted to a file DB; the AUTHORIZATION projection of
-- these rows is turned into OpenFGA tuples by config.Tuples (same pattern as
-- org sync + skill.Tuples). Seeded once on a fresh DB; edits are never
-- clobbered (see config.go bootstrap).
CREATE TABLE IF NOT EXISTS roles (
  tenant_id   TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  label       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, role_id)
);
CREATE TABLE IF NOT EXISTS role_rules (
  tenant_id   TEXT NOT NULL,
  ord         INTEGER NOT NULL,
  match_terms TEXT NOT NULL,   -- JSON array of substrings
  role_id     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, ord)
);
CREATE TABLE IF NOT EXISTS data_domains (
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  label     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, domain_id)
);
CREATE TABLE IF NOT EXISTS domain_grants (
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  subject   TEXT NOT NULL,     -- full OpenFGA subject string
  PRIMARY KEY (tenant_id, domain_id, subject)
);
