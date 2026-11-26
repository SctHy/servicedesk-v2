ALTER TABLE runs ADD UNIQUE (tenant_id, id);
CREATE TABLE run_checkpoints (
  run_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  turn int NOT NULL CHECK (turn BETWEEN 1 AND 10),
  messages jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE CASCADE
);
