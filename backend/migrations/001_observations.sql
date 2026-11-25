-- SkyFlip community observations schema_version=1
-- Unverified community observations — not discoveries.

PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observation_submissions (
  submission_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  delete_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  app_version TEXT,
  git_commit TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  target_id TEXT,
  target_name TEXT,
  ra REAL NOT NULL,
  dec REAL NOT NULL,
  ra_dec_source TEXT,
  fov_deg REAL,
  data_source TEXT,
  data_release TEXT,
  processing_version TEXT,
  description TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  answers_json TEXT NOT NULL,
  display_json TEXT NOT NULL,
  frames_json TEXT NOT NULL,
  highlights_json TEXT NOT NULL,
  share_url TEXT,
  healpix_nside32 INTEGER,
  client_key_hash TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_created ON observation_submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_obs_status ON observation_submissions(status);
CREATE INDEX IF NOT EXISTS idx_obs_target ON observation_submissions(target_id);
CREATE INDEX IF NOT EXISTS idx_obs_sky ON observation_submissions(ra, dec);
CREATE INDEX IF NOT EXISTS idx_obs_healpix ON observation_submissions(healpix_nside32);

-- Optional contact — separate table; retention/deletion independent
CREATE TABLE IF NOT EXISTS observation_contacts (
  submission_id TEXT PRIMARY KEY REFERENCES observation_submissions(submission_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  consent INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observation_rate_limits (
  client_key_hash TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
