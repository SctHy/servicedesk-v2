ALTER TABLE runs ADD COLUMN resume_from uuid,
  ADD FOREIGN KEY (tenant_id, resume_from) REFERENCES runs(tenant_id, id);
