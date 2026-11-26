CREATE TABLE resource_watermarks (
  tenant_id text NOT NULL,
  ticket_id uuid NOT NULL,
  topic text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, ticket_id, topic),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets(tenant_id, id) ON DELETE CASCADE
);

INSERT INTO resource_watermarks
SELECT tenant_id, ticket_id, 'access_state', max(stamp)
FROM (
  SELECT tenant_id, ticket_id, updated_at AS stamp FROM changes
  WHERE status IN ('succeeded','revoked')
  UNION ALL
  SELECT c.tenant_id, c.ticket_id, a.created_at FROM changes c
  JOIN change_audit a ON a.change_id=c.id WHERE a.action IN ('succeeded','revoked')
) transitions
WHERE ticket_id IS NOT NULL GROUP BY tenant_id, ticket_id;

INSERT INTO resource_watermarks
SELECT tenant_id, id, 'session_state', session_updated_at FROM tickets
WHERE session_updated_at IS NOT NULL;
