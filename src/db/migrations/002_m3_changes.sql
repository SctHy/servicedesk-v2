-- Preserve opaque M1 placeholders without granting execution authority to legacy payloads.
ALTER TABLE jobs RENAME TO jobs_legacy;
ALTER TABLE changes RENAME TO changes_legacy;
CREATE TABLE changes (
 id uuid PRIMARY KEY, tenant_id text NOT NULL, ticket_id uuid REFERENCES tickets,
 requester_id text NOT NULL, beneficiary_principal text NOT NULL, app text NOT NULL,
 role text NOT NULL, reason text NOT NULL, evidence_ids jsonb NOT NULL,
 payload_hash text NOT NULL, status text NOT NULL CHECK(status IN
 ('pending_approval','approved','rejected','executing','succeeded','failed','manual_review')),
 approver_id text, decision_note text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE jobs (
 id uuid PRIMARY KEY, tenant_id text NOT NULL, change_id uuid UNIQUE NOT NULL REFERENCES changes,
 resource_key text NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','manual_review')),
 version int NOT NULL, lease_owner text, lease_until timestamptz, attempt_count int NOT NULL,
 last_error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX jobs_running_resource ON jobs(resource_key) WHERE status='running';
CREATE TABLE change_audit(id uuid PRIMARY KEY, change_id uuid NOT NULL REFERENCES changes,
 actor_id text NOT NULL, action text NOT NULL, note text NOT NULL, created_at timestamptz NOT NULL);
-- This table belongs to the demo external adapter and commits independently of jobs.
CREATE TABLE demo_grants(resource_key text PRIMARY KEY, role text NOT NULL);
