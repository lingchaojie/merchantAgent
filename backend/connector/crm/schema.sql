-- CRM schema (Phase 1 mock). Separate system from ERP → separate connector +
-- separate DB. Cross-system 客户360 joins ERP<->CRM BY CUSTOMER NAME (the two
-- systems have no shared surrogate key, which mirrors real SME data silos).

CREATE TABLE contacts (
  contact_id    TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,   -- join key to ERP customers.name
  person        TEXT NOT NULL,
  title         TEXT,
  phone         TEXT             -- PII-ish; a real system would gate this
);

CREATE TABLE follow_ups (
  followup_id   TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  at_date       TEXT NOT NULL,   -- ISO date
  summary       TEXT NOT NULL,
  owner_user_id TEXT NOT NULL
);

CREATE TABLE opportunities (
  opp_id        TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  stage         TEXT NOT NULL,   -- 意向/报价/谈判/赢单/丢单
  est_amount    INTEGER NOT NULL,
  owner_user_id TEXT NOT NULL
);
