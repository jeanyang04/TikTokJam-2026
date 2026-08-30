-- 001_init.sql
-- LOCK 2: Postgres row-level security for crm_records.
-- Runs once, automatically, the first time the postgres container boots
-- against an empty data volume (see docker-compose.yml's
-- /docker-entrypoint-initdb.d mount). Executed as the POSTGRES_USER
-- superuser, so RLS below does not block the seed inserts at the bottom.

-- Two roles:
--   app_admin  — full access, used for anything that legitimately needs to
--                 see across owners (migrations, admin tooling, tests).
--   app_agent  — the role the running app connects as on behalf of an
--                 agent. NOBYPASSRLS is explicit: this role must never be
--                 able to skip the row-level security policy below, even
--                 though it isn't a superuser and wouldn't bypass by
--                 default. Being explicit here means a future
--                 "ALTER ROLE app_agent ..." can't quietly re-enable
--                 bypass without someone noticing the diff.
CREATE ROLE app_admin WITH LOGIN PASSWORD 'launchpad' BYPASSRLS;
CREATE ROLE app_agent WITH LOGIN PASSWORD 'launchpad' NOBYPASSRLS;

CREATE TABLE IF NOT EXISTS crm_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    text NOT NULL,
  customer    text NOT NULL,
  note        text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- gateway.ts's crm_write does INSERT ... ON CONFLICT (owner_id, customer)
  -- DO UPDATE — that needs a real unique constraint to target, not just an
  -- application-level assumption that (owner, customer) is one row.
  UNIQUE (owner_id, customer)
);

ALTER TABLE crm_records OWNER TO app_admin;

-- FORCE (not just ENABLE) so the policy applies even to the table owner,
-- app_admin — the only role meant to see across owners is a superuser
-- connection or an explicit query that unsets app.owner_id.
ALTER TABLE crm_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_records FORCE ROW LEVEL SECURITY;

-- Owner-only (D4 in docs/PLAN.md): a row is visible/writable only when its
-- owner_id matches the app.owner_id set on the current transaction by
-- db.ts's withOwner(). Grants (PolicyGrant, cross-agent access) are NOT
-- enforced here — that's the gateway's job (LOCK 1). This policy is the
-- second, independent lock: even a bug in the gateway can't make Postgres
-- hand back another owner's rows.
CREATE POLICY crm_records_owner_only ON crm_records
  USING (owner_id = current_setting('app.owner_id', true))
  WITH CHECK (owner_id = current_setting('app.owner_id', true));

-- app_agent gets exactly what the running app needs and nothing else: no
-- DELETE, no DDL, no visibility into any other table that might land here
-- later.
GRANT SELECT, INSERT, UPDATE ON crm_records TO app_agent;

-- Demo fixture data (see docs/TEAM.md's seed section): 2 rows for Jean, 1
-- for Alex. Inserted as the superuser running this init script, so RLS
-- above does not block it regardless of app.owner_id being unset.
INSERT INTO crm_records (owner_id, customer, note) VALUES
  ('user-jean', 'Acme Corp',     'Renewal call scheduled for next week.'),
  ('user-jean', 'Globex Inc',    'Waiting on their legal sign-off.'),
  ('user-alex', 'Initech',       'Escalated pricing question to sales.');
