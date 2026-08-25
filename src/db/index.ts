import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, loadSources } from '../config';
import { createLogger } from '../logger';

const log = createLogger('db');

export type DB = Database.Database;

let instance: DB | null = null;

/** Defaults written on first run. Editable from the dashboard Settings tab. */
export const DEFAULT_SETTINGS: Record<string, string> = {
  minTopicScore: '55',
  dailyTopicCount: '10',
  linkedinMinWords: '150',
  linkedinMaxWords: '300',
  mediumMinWords: '1000',
  mediumMaxWords: '1800',
  minStyleScore: '85',
  maxStyleRewrites: '2',
  repeatSimilarityThreshold: '0.55',
  clusterSimilarityThreshold: '0.62',
  lookbackDays: '21',
  enabledCategories: '*',
};

function schemaPath(): string {
  // Resolves under src/ when run via tsx, and under dist/ after a build.
  const local = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(local)) return local;
  return path.join(config.root, 'src/db/schema.sql');
}

export function getDb(): DB {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(schemaPath(), 'utf8'));
  seedSettings(db);
  syncSources(db);
  instance = db;
  return db;
}

/** Test helper: open an isolated in-memory database. */
export function createTestDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    fs
      .readFileSync(schemaPath(), 'utf8')
      .replace(/PRAGMA journal_mode = WAL;/, ''),
  );
  seedSettings(db);
  return db;
}

function seedSettings(db: DB): void {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value);
  });
  tx();
}

/**
 * config/sources.json is the source of truth for which sources exist. Runtime
 * columns (last_fetched_at, last_status) are preserved across syncs so editing
 * the file never loses fetch history.
 */
export function syncSources(db: DB): void {
  let sources;
  try {
    sources = loadSources();
  } catch (error) {
    log.error('could not read config/sources.json', error);
    return;
  }

  const upsert = db.prepare(`
    INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight, query)
    VALUES (@key, @name, @url, @kind, @tier, @category, @enabled, @weight, @query)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name, url = excluded.url, kind = excluded.kind,
      tier = excluded.tier, category = excluded.category,
      enabled = excluded.enabled, weight = excluded.weight, query = excluded.query
  `);

  const tx = db.transaction(() => {
    for (const source of sources) {
      upsert.run({
        key: source.key,
        name: source.name,
        url: source.url,
        kind: source.kind,
        tier: source.tier,
        category: source.category,
        enabled: source.enabled ? 1 : 0,
        weight: source.weight,
        query: source.query ?? null,
      });
    }
  });
  tx();
}

export function getSetting(db: DB, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? DEFAULT_SETTINGS[key] ?? '';
}

export function getNumberSetting(db: DB, key: string): number {
  const value = Number(getSetting(db, key));
  if (Number.isFinite(value)) return value;
  return Number(DEFAULT_SETTINGS[key] ?? 0);
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function allSettings(db: DB): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
