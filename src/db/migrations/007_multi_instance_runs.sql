ALTER TABLE runs
  ADD COLUMN status text NOT NULL DEFAULT 'completed' CHECK (status IN ('running','completed','failed')),
  ADD COLUMN lease_until timestamptz;

-- Finish streams interrupted before run leases were introduced.
INSERT INTO run_events(run_id, seq, data)
SELECT r.id, coalesce(max(e.seq), 0) + 1, '{"type":"error","text":"服务已重启，请发起新一轮调查。"}'::jsonb
FROM runs r LEFT JOIN run_events e ON e.run_id = r.id
GROUP BY r.id HAVING NOT coalesce(bool_or(e.data->>'type' IN ('final','error')), false);

UPDATE runs SET status = 'failed'
WHERE EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = runs.id AND e.data->>'type' = 'error');

CREATE UNIQUE INDEX runs_one_running_per_ticket ON runs(ticket_id) WHERE status = 'running';
