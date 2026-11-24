ALTER TABLE changes ADD COLUMN expires_at timestamptz, ADD COLUMN revoked_at timestamptz,
  DROP CONSTRAINT changes_status_check,
  ADD CHECK (status IN ('pending_approval','approved','rejected','executing','succeeded','failed','manual_review','revoked'));
ALTER TABLE jobs ADD COLUMN kind text NOT NULL DEFAULT 'grant' CHECK (kind IN ('grant','revoke')),
  ADD COLUMN run_at timestamptz NOT NULL DEFAULT now(),
  DROP CONSTRAINT jobs_change_id_key, ADD UNIQUE (change_id, kind);
ALTER TABLE demo_grants DROP CONSTRAINT demo_grants_pkey, ADD PRIMARY KEY(resource_key, role);
