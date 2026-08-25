import fs from 'node:fs';
import path from 'node:path';
import type { SourceConfig, StyleProfile } from './types';

/**
 * Configuration loader. Reads .env manually so the project needs no dotenv
 * dependency, then layers process.env on top (real env always wins).
 */

function loadDotEnv(root: string): void {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Walk up from this file until package.json is found. Resolving `__dirname/..`
 * is wrong once the project is compiled, because the file then sits in
 * dist/src/ rather than src/ and every relative path (config, style profile,
 * database) would resolve inside dist.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '..');
}

export const ROOT = findProjectRoot(__dirname);
loadDotEnv(ROOT);

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export type AiProviderName = 'none' | 'ollama' | 'openai-compatible';

function providerName(): AiProviderName {
  const v = str('AI_PROVIDER', 'none').toLowerCase();
  if (v === 'ollama' || v === 'openai-compatible' || v === 'none') return v;
  return 'none';
}

export const config = {
  root: ROOT,
  databasePath: path.resolve(ROOT, str('DATABASE_PATH', './data/radar.db')),
  exportDir: path.resolve(ROOT, str('EXPORT_DIR', './out')),
  sourcesFile: path.resolve(ROOT, 'config/sources.json'),
  styleProfileFile: path.resolve(ROOT, 'style/style-profile.json'),
  corpusDir: path.resolve(ROOT, 'style/corpus'),
  http: {
    timeoutMs: int('HTTP_TIMEOUT_MS', 15000),
    retries: int('HTTP_RETRIES', 2),
    concurrency: int('HTTP_CONCURRENCY', 4),
    hostDelayMs: int('HTTP_HOST_DELAY_MS', 1000),
    userAgent: str('USER_AGENT', 'dev-radar/1.0 (personal research tool)'),
  },
  github: { token: str('GITHUB_TOKEN', '') },
  ai: {
    provider: providerName(),
    ollamaBaseUrl: str('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
    ollamaModel: str('OLLAMA_MODEL', 'llama3.1:8b'),
    openaiBaseUrl: str('OPENAI_BASE_URL', 'http://127.0.0.1:8080/v1'),
    openaiModel: str('OPENAI_MODEL', 'local-model'),
    openaiApiKey: str('OPENAI_API_KEY', ''),
  },
  server: {
    port: int('PORT', 4311),
    host: str('HOST', '127.0.0.1'),
  },
} as const;

export function loadSources(): SourceConfig[] {
  const raw = fs.readFileSync(config.sourcesFile, 'utf8');
  const parsed = JSON.parse(raw) as { sources: SourceConfig[] };
  if (!Array.isArray(parsed.sources)) {
    throw new Error(`config/sources.json must contain a "sources" array`);
  }
  return parsed.sources;
}

export function loadStyleProfile(): StyleProfile {
  const raw = fs.readFileSync(config.styleProfileFile, 'utf8');
  return JSON.parse(raw) as StyleProfile;
}

export function saveStyleProfile(profile: StyleProfile): void {
  fs.writeFileSync(config.styleProfileFile, JSON.stringify(profile, null, 2) + '\n', 'utf8');
}
