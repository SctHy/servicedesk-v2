-- Keep tenant ownership consistent even for writes outside the HTTP service.
ALTER TABLE tickets ADD UNIQUE (tenant_id,id);
ALTER TABLE changes ADD UNIQUE (tenant_id,id),
  ADD FOREIGN KEY (tenant_id,ticket_id) REFERENCES tickets(tenant_id,id);
ALTER TABLE runs ADD FOREIGN KEY (tenant_id,ticket_id) REFERENCES tickets(tenant_id,id);
ALTER TABLE jobs ADD FOREIGN KEY (tenant_id,change_id) REFERENCES changes(tenant_id,id);
