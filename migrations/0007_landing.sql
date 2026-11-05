-- Landing page at / : beta applications and source tagged visits (?src=card from the printed card QR, ?src=email from emails).
-- The form asks only for work email and company; name, state, role and field workers are optional.
CREATE TABLE IF NOT EXISTS beta_applications (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,            -- unix ms
  name TEXT,
  company TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,             -- lowercased
  phone TEXT,
  state TEXT,
  role TEXT,
  field_workers TEXT,
  containers_per_month TEXT,
  struggles TEXT,
  tools_wanted TEXT,
  source TEXT,                            -- card | email | direct | web | utm tag
  ip_country TEXT,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS landing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                    -- unix ms
  kind TEXT NOT NULL,                     -- visit | app_click | apply | apply_duplicate
  source TEXT,
  email TEXT,
  ip_country TEXT
);
CREATE INDEX IF NOT EXISTS idx_landing_events_source ON landing_events(source, kind);
