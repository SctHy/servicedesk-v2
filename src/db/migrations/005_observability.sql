ALTER TABLE tickets ADD COLUMN session text NOT NULL DEFAULT 'normal' CHECK(session IN ('normal','wrong_account')),
  ADD COLUMN session_updated_at timestamptz;
ALTER TABLE jobs ADD COLUMN traceparent text;
