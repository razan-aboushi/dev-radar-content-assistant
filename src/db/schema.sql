PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  key             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  kind            TEXT NOT NULL,
  tier            TEXT NOT NULL,
  category        TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  weight          REAL NOT NULL DEFAULT 1.0,
  query           TEXT,
  last_fetched_at TEXT,
  last_status     TEXT,
  last_error      TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key   TEXT NOT NULL REFERENCES sources(key) ON DELETE CASCADE,
  guid         TEXT NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  author       TEXT,
  extra        TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  UNIQUE (source_key, guid)
);

CREATE INDEX IF NOT EXISTS idx_items_hash ON items(content_hash);
CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at DESC);

CREATE TABLE IF NOT EXISTS topics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id           INTEGER REFERENCES items(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  summary           TEXT NOT NULL DEFAULT '',
  category          TEXT NOT NULL,
  source_key        TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  source_tier       TEXT NOT NULL DEFAULT 'community',
  published_at      TEXT,
  created_at        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'new',
  corroboration     TEXT NOT NULL DEFAULT '[]',
  rejection_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status);
CREATE INDEX IF NOT EXISTS idx_topics_created ON topics(created_at DESC);

CREATE TABLE IF NOT EXISTS topic_scores (
  topic_id             INTEGER PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
  freshness            REAL NOT NULL,
  relevance            REAL NOT NULL,
  practical_value      REAL NOT NULL,
  discussion_potential REAL NOT NULL,
  educational_value    REAL NOT NULL,
  originality          REAL NOT NULL,
  audience_fit         REAL NOT NULL,
  total                REAL NOT NULL,
  confidence           REAL NOT NULL,
  linkedin_score       REAL NOT NULL,
  medium_score         REAL NOT NULL,
  controversy          REAL NOT NULL,
  reasons              TEXT NOT NULL DEFAULT '[]',
  scored_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_total ON topic_scores(total DESC);

CREATE TABLE IF NOT EXISTS angles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  recommended INTEGER NOT NULL DEFAULT 0,
  UNIQUE (topic_id, kind)
);

CREATE TABLE IF NOT EXISTS facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  claim       TEXT NOT NULL,
  source_url  TEXT NOT NULL,
  source_tier TEXT NOT NULL,
  status      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_facts_topic ON facts(topic_id);

CREATE TABLE IF NOT EXISTS content (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  angle_kind  TEXT NOT NULL,
  mode        TEXT NOT NULL,
  hook        TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  subtitle    TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  hashtags    TEXT NOT NULL DEFAULT '[]',
  sources     TEXT NOT NULL DEFAULT '[]',
  style_score TEXT,
  ai_tells    TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'draft',
  model       TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_topic ON content(topic_id);
CREATE INDEX IF NOT EXISTS idx_content_created ON content(created_at DESC);

CREATE TABLE IF NOT EXISTS prior_content (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform     TEXT NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT,
  text         TEXT NOT NULL,
  published_at TEXT,
  fingerprint  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS research_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  sources_ok     INTEGER NOT NULL DEFAULT 0,
  sources_failed INTEGER NOT NULL DEFAULT 0,
  items_seen     INTEGER NOT NULL DEFAULT 0,
  items_new      INTEGER NOT NULL DEFAULT 0,
  topics_new     INTEGER NOT NULL DEFAULT 0,
  log            TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
