CREATE INDEX jobs_status_run_at ON jobs(status, run_at);
-- run_events already has a btree primary key on (run_id, seq).
