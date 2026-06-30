-- Reference schema. The function creates these automatically via ensureSchema();
-- this file is here for documentation and manual inspection.

CREATE TABLE IF NOT EXISTS processed_sites (
  site_id       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  custom_domain TEXT,
  action        TEXT NOT NULL,  -- 'seeded' | 'assigned' | 'skipped_existing_domain'
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
