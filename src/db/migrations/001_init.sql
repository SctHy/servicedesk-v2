CREATE TABLE tickets(id uuid PRIMARY KEY, tenant_id text NOT NULL, actor_id text NOT NULL, scenario text NOT NULL CHECK(scenario IN ('A','B')));
CREATE TABLE runs(id uuid PRIMARY KEY,tenant_id text NOT NULL,actor_id text NOT NULL,ticket_id uuid NOT NULL REFERENCES tickets,created_at timestamptz NOT NULL,client_request_id text NOT NULL,request_fingerprint text NOT NULL,UNIQUE(tenant_id,actor_id,ticket_id,client_request_id));
CREATE TABLE run_events(run_id uuid REFERENCES runs,seq integer NOT NULL,data jsonb NOT NULL,PRIMARY KEY(run_id,seq));
CREATE TABLE evidence(id uuid PRIMARY KEY,ticket_id uuid REFERENCES tickets,source text NOT NULL,observed_at timestamptz NOT NULL,data jsonb NOT NULL);
CREATE TABLE kb_chunks(id text PRIMARY KEY,tenant_id text NOT NULL,department_id text NOT NULL,visibility text NOT NULL,app text NOT NULL,code text NOT NULL,body text NOT NULL);
CREATE TABLE mask_bindings(tenant_id text NOT NULL,ticket_id uuid REFERENCES tickets,ref text NOT NULL,cipher text NOT NULL,PRIMARY KEY(tenant_id,ticket_id,ref));
CREATE TABLE changes(id uuid PRIMARY KEY,ticket_id uuid REFERENCES tickets,payload jsonb NOT NULL);
CREATE TABLE jobs(id uuid PRIMARY KEY,change_id uuid REFERENCES changes,status text NOT NULL);
