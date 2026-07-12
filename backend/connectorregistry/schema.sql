CREATE TABLE IF NOT EXISTS connector_versions (
  tenant_id                       TEXT NOT NULL,
  connector_id                    TEXT NOT NULL,
  version                         TEXT NOT NULL,
  digest                          TEXT NOT NULL,
  adapter                         TEXT NOT NULL,
  environment                     TEXT NOT NULL,
  public_contract_json            TEXT NOT NULL,
  check_summary_json              TEXT NOT NULL,
  implementation_credential_id    TEXT NOT NULL,
  device_id                       TEXT NOT NULL,
  submitted_by                    TEXT NOT NULL,
  approved_by                     TEXT NOT NULL DEFAULT '',
  status                          TEXT NOT NULL,
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connector_id, version),
  UNIQUE (tenant_id, connector_id, digest)
);

CREATE INDEX IF NOT EXISTS connector_versions_published
  ON connector_versions (tenant_id, status, connector_id, version);

CREATE TABLE IF NOT EXISTS connector_lifecycle_events (
  event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,
  connector_id   TEXT NOT NULL,
  version        TEXT NOT NULL,
  digest         TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  from_status    TEXT NOT NULL,
  to_status      TEXT NOT NULL,
  occurred_at    TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS connector_lifecycle_events_no_update
BEFORE UPDATE ON connector_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'connector lifecycle events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS connector_lifecycle_events_no_delete
BEFORE DELETE ON connector_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'connector lifecycle events are append-only');
END;
