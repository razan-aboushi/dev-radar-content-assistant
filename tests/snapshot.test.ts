import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { config } from '../src/config';
import { createTestDb } from '../src/db';
import { insertContent, insertItems } from '../src/db/repositories';
import { buildTopics } from '../src/pipeline/run';
import { buildSnapshot } from '../src/snapshot';
import { FREE_PROVIDER_PRESETS } from '../src/config';
import type { NormalizedItem } from '../src/types';

/**
 * The published build.
 *
 * A scheduled job freezes the database into JSON and GitHub Pages serves it.
 * Two things have to hold for that to be safe: the snapshot must contain
 * everything the dashboard reads, and it must contain nothing it should not
 * publish. Both are asserted here.
 */

function seededDb() {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight, reach)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run('react-blog', 'React Blog', 'https://react.dev/rss.xml', 'rss', 'primary', 'react', 1.4, 5);

  const items: NormalizedItem[] = [
    {
      sourceKey: 'react-blog', guid: 'a',
      title: 'React Server Components and the hydration boundary, explained',
      url: 'https://react.dev/a',
      summary: 'How the payload streams and where hydration begins. Fixed in v19.2.0.',
      publishedAt: new Date().toISOString(), author: null, extra: { points: 240, comments: 90 },
    },
  ];
  insertItems(db, items);
  buildTopics(db);
  return db;
}

function snapshotInto(db: ReturnType<typeof seededDb>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devradar-snapshot-'));
  const manifest = buildSnapshot(db, { outDir: dir });
  return { dir, manifest };
}

function readJson<T>(dir: string, name: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as T;
}

/* ------------------------------------------------------------ contents */

test('the snapshot contains every file the dashboard reads', () => {
  const db = seededDb();
  const { dir, manifest } = snapshotInto(db);
  try {
    for (const file of [
      'manifest.json', 'topics.json', 'sources.json', 'history.json', 'settings.json',
      'overview.en.json', 'overview.ar.json', 'weekly.en.json', 'weekly.ar.json',
    ]) {
      assert.ok(fs.existsSync(path.join(dir, file)), `missing ${file}`);
    }
    assert.ok(manifest.topicCount > 0);
    assert.deepEqual(manifest.languages, ['en', 'ar']);

    // One file per topic, so opening one fetches kilobytes not megabytes.
    const topics = readJson<Array<{ topic: { id: number } }>>(dir, 'topics.json');
    for (const row of topics) {
      assert.ok(fs.existsSync(path.join(dir, `topic/${row.topic.id}.json`)), `missing topic ${row.topic.id}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('the snapshot carries interest scores and their evidence', () => {
  const db = seededDb();
  const { dir } = snapshotInto(db);
  try {
    const topics = readJson<Array<{ score: { audience: { score: number; evidence: unknown[] } } | null; opportunity: number }>>(
      dir, 'topics.json',
    );
    assert.ok(topics.length > 0);
    for (const row of topics) {
      assert.ok(row.score?.audience, 'audience interest missing from the snapshot');
      assert.ok(row.score.audience.evidence.length > 0);
      assert.ok(typeof row.opportunity === 'number');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('report prose is emitted in both languages, because a static host cannot re-render it', () => {
  const db = seededDb();
  const { dir } = snapshotInto(db);
  try {
    const en = readJson<{ daily: { entries: Array<{ whyItMatters: string }> } }>(dir, 'overview.en.json');
    const ar = readJson<{ daily: { entries: Array<{ whyItMatters: string }> } }>(dir, 'overview.ar.json');
    assert.ok(en.daily.entries.length > 0);
    assert.equal(ar.daily.entries.length, en.daily.entries.length);
    assert.ok(/[A-Za-z]/.test(en.daily.entries[0]!.whyItMatters));
    assert.ok(/[\u0600-\u06FF]/.test(ar.daily.entries[0]!.whyItMatters));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('a pre-written draft ships with the exact text the copy button will produce', () => {
  const db = seededDb();
  const topicId = (db.prepare('SELECT id FROM topics LIMIT 1').get() as { id: number }).id;
  insertContent(db, {
    topicId, kind: 'medium', angleKind: 'educational', mode: 'llm',
    hook: 'hook', title: 'A title', subtitle: 'A subtitle',
    body: '## Section one\n\nSome prose.',
    hashtags: ['#React'], sources: ['https://react.dev/a'],
    styleScore: null, aiTells: [], status: 'draft',
    createdAt: new Date().toISOString(), model: null, language: 'en',
  });

  const { dir, manifest } = snapshotInto(db);
  try {
    assert.equal(manifest.draftCount, 1);
    const detail = readJson<{ drafts: Array<{ publishText: string; wordCount: number; dir: string }> }>(
      dir, `topic/${topicId}.json`,
    );
    const [draft] = detail.drafts;
    assert.ok(draft);
    assert.ok(draft.publishText.startsWith('# A title'), draft.publishText.slice(0, 40));
    assert.ok(draft.publishText.includes('## A subtitle'));
    assert.ok(draft.publishText.includes('## Section one'));
    assert.equal(draft.dir, 'ltr');
    assert.ok(draft.wordCount > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

/* -------------------------------------------------------------- safety */

test('the snapshot publishes no secrets', () => {
  // It is committed to a public repository and served on the open web.
  const db = seededDb();
  const { dir } = snapshotInto(db);
  try {
    const everything = fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath ?? dir, entry.name), 'utf8'))
      .join('\n');

    for (const forbidden of [
      'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GROQ_API_KEY', 'apiKey', 'api_key',
      'Bearer ', 'sk-', 'gsk_', 'ghp_',
    ]) {
      assert.ok(!everything.includes(forbidden), `snapshot contains "${forbidden}"`);
    }
    // Nor the absolute paths of the machine that built it.
    assert.ok(!everything.includes(os.homedir()), 'snapshot leaks a home directory path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('the snapshot reports no AI provider, because the published copy has none', () => {
  const db = seededDb();
  const { dir } = snapshotInto(db);
  try {
    const overview = readJson<{ provider: { available: boolean } }>(dir, 'overview.en.json');
    assert.equal(overview.provider.available, false);
    const settings = readJson<{ provider: string }>(dir, 'settings.json');
    assert.equal(settings.provider, 'snapshot');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

/* --------------------------------------------------------- data layer */

/** Loads data.js against a fake window whose fetch serves a snapshot folder. */
function loadDataSource(options: { staticMode: boolean; files?: Record<string, unknown> }) {
  const requested: string[] = [];
  const files = options.files ?? {};

  const win: Record<string, unknown> = {
    location: { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1' },
    async fetch(url: string) {
      requested.push(url);
      const key = String(url).replace(/^data\//, '');
      if (options.staticMode && key === 'mode.json') {
        return { ok: true, status: 200, json: async () => ({ mode: 'static' }) };
      }
      if (!options.staticMode && String(url).startsWith('data/')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (Object.prototype.hasOwnProperty.call(files, key)) {
        return { ok: true, status: 200, json: async () => files[key] };
      }
      if (String(url).startsWith('/api/')) {
        return { ok: true, status: 200, json: async () => ({ live: true, url }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    },
  };
  win.window = win;
  const context = vm.createContext(win);
  vm.runInContext(
    fs.readFileSync(path.join(config.root, 'src/server/public/data.js'), 'utf8'),
    context,
    { filename: 'data.js' },
  );
  return { data: win.dataSource as any, requested };
}

const SAMPLE_TOPICS = [
  { topic: { id: 1, status: 'new', publishedAt: '2026-08-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z' },
    score: { total: 80, audience: { score: 20 } }, opportunity: 56 },
  { topic: { id: 2, status: 'shortlisted', publishedAt: '2026-08-20T00:00:00Z', createdAt: '2026-08-20T00:00:00Z' },
    score: { total: 40, audience: { score: 90 } }, opportunity: 60 },
  { topic: { id: 3, status: 'new', publishedAt: '2026-08-10T00:00:00Z', createdAt: '2026-08-10T00:00:00Z' },
    score: { total: 60, audience: { score: 60 } }, opportunity: 60 },
];

test('a local server is detected as live, and reads go to the API', async () => {
  const { data, requested } = loadDataSource({ staticMode: false });
  assert.equal(await data.init(), 'live');
  assert.equal(data.canWrite, true);
  assert.equal(data.isStatic, false);
  await data.overview('ar');
  assert.ok(requested.some((url) => url.includes('/api/overview') && url.includes('lang=ar')));
});

test('a published build is detected as static and refuses writes clearly', async () => {
  const { data } = loadDataSource({
    staticMode: true,
    files: { 'manifest.json': { generatedAt: '2026-08-25T00:00:00Z', topicCount: 3 } },
  });
  assert.equal(await data.init(), 'static');
  assert.equal(data.canWrite, false);
  assert.equal(data.manifest.topicCount, 3);

  for (const write of [
    () => data.runRadar(),
    () => data.saveSettings({}),
    () => data.generate({}),
    () => data.toggleSource('x', true),
    () => data.setTopicStatus(1, 'rejected', 'x'),
    () => data.publishContent(1),
  ]) {
    await assert.rejects(write, (error: Error & { readOnly?: boolean }) => {
      assert.equal(error.readOnly, true, 'a refused write must be marked read-only, not generic');
      return true;
    });
  }
});

test('static filtering and sorting match what the SQL does', async () => {
  const { data } = loadDataSource({ staticMode: true, files: { 'topics.json': SAMPLE_TOPICS } });
  await data.init();

  const byFit = await data.topics({ min: 0, minInterest: 0, status: 'any', sort: 'fit' }, 'en');
  assert.deepEqual(byFit.map((r: any) => r.topic.id), [1, 3, 2]);

  const byInterest = await data.topics({ min: 0, minInterest: 0, status: 'any', sort: 'interest' }, 'en');
  assert.deepEqual(byInterest.map((r: any) => r.topic.id), [2, 3, 1]);

  const byNewest = await data.topics({ min: 0, minInterest: 0, status: 'any', sort: 'newest' }, 'en');
  assert.deepEqual(byNewest.map((r: any) => r.topic.id), [2, 3, 1]);

  const byFitFilter = await data.topics({ min: 55, minInterest: 0, status: 'any', sort: 'fit' }, 'en');
  assert.deepEqual(byFitFilter.map((r: any) => r.topic.id), [1, 3]);

  const byInterestFilter = await data.topics({ min: 0, minInterest: 55, status: 'any', sort: 'fit' }, 'en');
  assert.deepEqual(byInterestFilter.map((r: any) => r.topic.id), [3, 2]);

  const byStatus = await data.topics({ min: 0, minInterest: 0, status: 'shortlisted', sort: 'fit' }, 'en');
  assert.deepEqual(byStatus.map((r: any) => r.topic.id), [2]);
});

test('an unknown static sort falls back rather than returning nothing', async () => {
  const { data } = loadDataSource({ staticMode: true, files: { 'topics.json': SAMPLE_TOPICS } });
  await data.init();
  const rows = await data.topics({ min: 0, minInterest: 0, status: 'any', sort: 'nonsense' }, 'en');
  assert.equal(rows.length, 3);
});

test('the static build reads per-language report files', async () => {
  const { data, requested } = loadDataSource({
    staticMode: true,
    files: { 'overview.ar.json': { ok: true }, 'weekly.en.json': { ok: true } },
  });
  await data.init();
  await data.overview('ar');
  await data.weekly('en');
  assert.ok(requested.includes('data/overview.ar.json'));
  assert.ok(requested.includes('data/weekly.en.json'));
});

/* ------------------------------------------------------- AI presets */

test('every free AI preset is an https OpenAI-compatible endpoint', () => {
  const names = Object.keys(FREE_PROVIDER_PRESETS);
  assert.ok(names.includes('groq'), 'Groq is the documented default');
  for (const [name, preset] of Object.entries(FREE_PROVIDER_PRESETS)) {
    assert.match(preset.baseUrl, /^https:\/\//, `${name} must use https`);
    assert.ok(preset.model.length > 0, `${name} needs a default model`);
    assert.match(preset.keyUrl, /^https:\/\//, `${name} needs a link to get a key`);
    assert.equal(typeof preset.trainsOnInput, 'boolean', `${name} must state its data policy`);
  }
  // The default must not train on the user's drafts.
  assert.equal(FREE_PROVIDER_PRESETS.groq!.trainsOnInput, false);
});
