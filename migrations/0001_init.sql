-- One row per site visit. One VisitAgent per visit, named by its id.
CREATE TABLE visits (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  user_email    TEXT NOT NULL,
  client_email  TEXT NOT NULL,
  site_name     TEXT,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | finishing | done | failed
  error         TEXT,
  email_sent_at TEXT
);

-- Every photo uploaded during the visit. Photos are uploaded in batches, each tagged with a room.
CREATE TABLE photos (
  id         TEXT PRIMARY KEY,
  visit_id   TEXT NOT NULL REFERENCES visits(id),
  batch_id   TEXT NOT NULL,
  room       TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX photos_visit ON photos(visit_id);
CREATE INDEX photos_batch ON photos(batch_id);

-- One row per product per room. New photos of a product already listed update that row instead of adding one.
CREATE TABLE products (
  id                 TEXT PRIMARY KEY,
  visit_id           TEXT NOT NULL REFERENCES visits(id),
  room               TEXT NOT NULL,
  manufacturer       TEXT,
  product_name       TEXT NOT NULL,
  product_code       TEXT,                      -- EPA reg no., product code, UPC, etc.
  container_type     TEXT NOT NULL DEFAULT 'other', -- drum | pail | jug | bottle | can | aerosol | box | bag | tote | cylinder | tube | other
  container_material TEXT NOT NULL DEFAULT 'unknown', -- metal | plastic | fiber | wood | glass | unknown (decides the manifest code)
  container_size     TEXT,                      -- capacity as printed, e.g. "55 gal", "NET 2 QT"
  quantity           INTEGER NOT NULL DEFAULT 1, -- number of containers
  count_note         TEXT,                      -- why the count may be off, e.g. "pallet partly hidden"
  count_edited       INTEGER NOT NULL DEFAULT 0, -- 1 = technician corrected count/type; the agent won't overwrite it
  physical_state     TEXT,                      -- solid | liquid | gas | aerosol | unknown
  signal_word        TEXT,                      -- DANGER | WARNING | none
  hazard_statements  TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  ghs_pictograms     TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  ingredients        TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  photo_keys         TEXT NOT NULL DEFAULT '[]', -- JSON array: R2 keys of photos showing this product
  sds_status         TEXT NOT NULL DEFAULT 'pending', -- pending | found | page_only | not_found
  sds_source         TEXT,                      -- library | web
  sds_url            TEXT,
  sds_page_url       TEXT,
  sds_key            TEXT,                      -- R2 key of the PDF
  sds_notes          TEXT
);
CREATE INDEX products_visit ON products(visit_id);

-- Shared memory across all visits: every verified SDS we've found.
-- Next time anyone scans the same product, it comes from here instead of a web search.
CREATE TABLE sds_library (
  id                TEXT PRIMARY KEY,
  manufacturer      TEXT,
  product_name      TEXT NOT NULL,
  product_code      TEXT,
  match_key         TEXT NOT NULL,              -- normalized manufacturer + product name
  code_key          TEXT,                       -- normalized product code
  r2_key            TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  page_url          TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  times_used        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sds_library_match ON sds_library(match_key);
CREATE INDEX sds_library_code ON sds_library(code_key);
