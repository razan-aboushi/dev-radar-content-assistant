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
import { FREE_PROVIDER_PRESETS, RETIRED_MODEL_IDS } from '../src/config';
import { cleanDraft } from '../src/writing/linkedin';
import { renderPublishText } from '../src/writing/publish';
import { loadProfile } from '../src/writing/style';
import type { GeneratedContent, NormalizedItem } from '../src/types';

function contentFixture(): GeneratedContent {
  return {
    topicId: 1, kind: 'medium', angleKind: 'educational', mode: 'llm',
    hook: 'hook', title: 'A title', subtitle: 'A subtitle',
    body: '## Section\n\nProse.', hashtags: ['#One', '#Two'], sources: [],
    styleScore: null, aiTells: [], status: 'draft',
    createdAt: '2026-08-25T00:00:00Z', model: null, language: 'en',
  };
}

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

/* ------------------------------------------ browser-side generation */

/** Loads ai.js against a fake window with a stubbed fetch. */
function loadAiClient(options: { response?: unknown; status?: number; store?: Record<string, string> } = {}) {
  const store = options.store ?? {};
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  const modelCalls: Array<{ url: string; headers: any }> = [];
  const win: Record<string, unknown> = {
    localStorage: {
      getItem: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k]! : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    async fetch(url: string, init: any) {
      // listModels is a GET with no body; only completions carry one.
      const body = init && init.body ? JSON.parse(init.body) : null;
      if (body) calls.push({ url, body, headers: init.headers });
      else modelCalls.push({ url, headers: init.headers });
      const status = options.status ?? 200;
      const payload = options.response ?? { choices: [{ message: { content: 'Generated body.' } }] };
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
    },
  };
  win.window = win;
  const context = vm.createContext(win);
  vm.runInContext(
    fs.readFileSync(path.join(config.root, 'src/server/public/ai.js'), 'utf8'),
    context,
    { filename: 'ai.js' },
  );
  return { ai: win.aiClient as any, calls, modelCalls, store };
}

test('the browser client refuses to call anything without a key', async () => {
  const { ai, calls } = loadAiClient();
  assert.equal(ai.hasKey, false);
  await assert.rejects(
    () => ai.generate({ kind: 'linkedin', system: 's', prompt: 'p', language: 'en' }),
    (error: Error & { reason?: string }) => error.reason === 'noKey',
  );
  assert.equal(calls.length, 0, 'no request may be made without a key');
});

test('the key is sent as a bearer token to the chosen provider only', async () => {
  const { ai, calls } = loadAiClient();
  ai.setKey('gsk_test_key');
  ai.setProvider('groq');
  await ai.generate({ kind: 'linkedin', system: 'sys', prompt: 'prompt', language: 'en', hashtags: [] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(calls[0]!.headers.authorization, 'Bearer gsk_test_key');
  assert.equal(calls[0]!.body.messages[0].content, 'sys');
  assert.equal(calls[0]!.body.messages[1].content, 'prompt');
});

test('switching provider changes the endpoint and nothing else', async () => {
  const { ai, calls } = loadAiClient();
  ai.setKey('k');
  ai.setProvider('cerebras');
  await ai.generate({ kind: 'linkedin', system: 's', prompt: 'p', language: 'en', hashtags: [] });
  assert.match(calls[0]!.url, /^https:\/\/api\.cerebras\.ai\//);
  assert.equal(ai.setProvider('not-a-provider'), false);
});

test('provider failures are reported as causes you can act on', async () => {
  for (const [status, reason] of [[401, 'invalidKey'], [429, 'rateLimited'], [404, 'badModel'], [503, 'providerDown']] as const) {
    const { ai } = loadAiClient({ status, response: { error: { message: 'nope' } } });
    ai.setKey('k');
    await assert.rejects(
      () => ai.generate({ kind: 'linkedin', system: 's', prompt: 'p', language: 'en' }),
      (error: Error & { reason?: string }) => {
        assert.equal(error.reason, reason, `status ${status} should mean ${reason}`);
        return true;
      },
    );
  }
});

test('an empty model response is an error, not an empty draft', async () => {
  const { ai } = loadAiClient({ response: { choices: [{ message: { content: '   ' } }] } });
  ai.setKey('k');
  await assert.rejects(
    () => ai.generate({ kind: 'linkedin', system: 's', prompt: 'p', language: 'en' }),
    (error: Error & { reason?: string }) => error.reason === 'empty',
  );
});

test('a browser-made draft has the same shape the server returns', async () => {
  const { ai } = loadAiClient();
  ai.setKey('k');
  const draft = await ai.generate({
    topicId: 7, kind: 'medium', angle: 'educational', language: 'ar',
    system: 's', prompt: 'p', hashtags: ['#a', '#b'], sources: ['https://x/a'],
    title: 'عنوان', subtitle: 'وصف',
  });
  for (const key of ['topicId', 'kind', 'angleKind', 'mode', 'title', 'subtitle', 'body', 'hashtags', 'sources', 'status', 'createdAt', 'language']) {
    assert.ok(key in draft, `missing ${key}`);
  }
  assert.equal(draft.language, 'ar');
  assert.equal(draft.mode, 'llm');
  assert.equal(draft.kind, 'medium');
});

test('the browser and server draft cleaners agree', () => {
  // Two copies exist because a browser-made draft never passes through the
  // server. They must behave identically or the published site quietly
  // produces different text from the CLI.
  const { ai } = loadAiClient();
  const fixtures = [
    '```\nA fenced draft.\n```',
    "Here's the post you asked for:\n\nReal text.",
    '«نص عربي هنا.\n\nوسطر آخر.»\n\n#برمجة #ReactJS',
    'Body text.\n\n#JavaScript #WebDev',
    'Some **bold** and *italic* text.',
    'Line one.\n\n\n\n\nLine two.',
  ];
  for (const fixture of fixtures) {
    assert.equal(
      ai.cleanDraft(fixture),
      cleanDraft(fixture),
      `cleaners disagree on: ${JSON.stringify(fixture.slice(0, 40))}`,
    );
  }
});

test('the browser and server publish renderers agree', () => {
  // Same reasoning: app.js has its own renderPublishText for browser drafts.
  const app = fs.readFileSync(path.join(config.root, 'src/server/public/app.js'), 'utf8');
  const source = app.slice(app.indexOf('function renderPublishText'));
  const body = source.slice(0, source.indexOf('\nfunction countWords'));
  const browserRender = new Function(`${body}; return renderPublishText;`)() as (c: unknown) => string;

  const cases: GeneratedContent[] = [
    { ...contentFixture(), kind: 'medium' },
    { ...contentFixture(), kind: 'medium', subtitle: '' },
    { ...contentFixture(), kind: 'linkedin', body: 'Post body.' },
    { ...contentFixture(), kind: 'linkedin', body: 'Post body.', hashtags: [] },
    { ...contentFixture(), kind: 'medium', body: 'نص عربي 💛', title: 'عنوان', subtitle: 'وصف' },
  ];
  for (const content of cases) {
    assert.equal(
      browserRender(content),
      renderPublishText(content),
      `renderers disagree for ${content.kind}`,
    );
  }
});

test('a long headline never becomes a title with an ellipsis in the middle', async () => {
  // subjectOf() caps at 70 characters and adds an ellipsis; gluing a template
  // onto that produced "…as cheaper tools…: explained properly".
  const { titleSubject, articleTitleFor: titleFor } = await import('../src/writing/titles');
  const long = 'Anthropic’s best AI model struggles to attract users as cheaper tools…';

  assert.ok(!titleSubject(long).includes('…'));
  assert.ok(titleSubject(long).length <= 52, titleSubject(long));
  // Cut on a word boundary, not mid-word.
  assert.ok(!/\s$/.test(titleSubject(long)));

  for (const language of ['en', 'ar'] as const) {
    for (const angle of ['educational', 'opinion', 'engineering-lesson'] as const) {
      const title = titleFor(long, angle, language);
      assert.ok(!title.includes('…'), `${language}/${angle}: ${title}`);
      assert.ok(title.length < 120, `${language}/${angle} is too long: ${title}`);
    }
  }

  // A short subject is left exactly as it is.
  assert.equal(titleSubject('React Server Components'), 'React Server Components');
  assert.equal(titleFor('INP', 'educational', 'en'), 'INP, explained properly');
});

test('the article titles the browser uses match the ones medium.ts writes', async () => {
  // prompts.ts mirrors medium.ts so the snapshot can carry titles. If they
  // drift, a browser-made article gets a different headline from a local one.
  const db = seededDb();
  const topicId = (db.prepare('SELECT id FROM topics LIMIT 1').get() as { id: number }).id;
  const topic = (await import('../src/db/repositories')).getTopic(db, topicId)!;
  const { buildTopicPrompts } = await import('../src/writing/prompts');
  const { subjectOf } = await import('../src/pipeline/angles');
  const { articleTitleFor } = await import('../src/writing/prompts');

  const prompts = buildTopicPrompts(db, topic, loadProfile());
  const subject = subjectOf(topic);
  for (const angle of ['educational', 'opinion', 'engineering-lesson'] as const) {
    for (const language of ['en', 'ar'] as const) {
      assert.equal(
        prompts.titles[angle]![language]!.title,
        articleTitleFor(subject, angle, language),
      );
      assert.ok(prompts.linkedin[angle]![language]!.length > 100, 'prompt looks empty');
      assert.ok(prompts.medium[angle]![language]!.length > 100, 'prompt looks empty');
    }
  }
  db.close();
});

test('every topic in the snapshot carries prompts for both languages', () => {
  const db = seededDb();
  const { dir } = snapshotInto(db);
  try {
    const system = readJson<Record<string, string>>(dir, 'system-prompts.json');
    assert.ok(system.en!.includes('Write in English.'));
    assert.ok(system.ar!.includes('Write in Arabic.'));

    const topics = readJson<Array<{ topic: { id: number } }>>(dir, 'topics.json');
    for (const row of topics) {
      const detail = readJson<{ prompts: { linkedin: any; medium: any } }>(dir, `topic/${row.topic.id}.json`);
      for (const angle of ['educational', 'opinion', 'engineering-lesson']) {
        for (const language of ['en', 'ar']) {
          assert.ok(detail.prompts.linkedin[angle][language], `no linkedin prompt ${angle}/${language}`);
          assert.ok(detail.prompts.medium[angle][language], `no medium prompt ${angle}/${language}`);
        }
      }
      // Arabic prompts must actually instruct Arabic output.
      assert.ok(detail.prompts.linkedin.educational.ar.includes('اكتب النص كاملاً بالعربية'));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

/* ------------------------------------------------------- AI presets */

test('the browser provider list matches the server preset list exactly', () => {
  // Two lists, one truth. A provider added to one and not the other either
  // cannot be selected or is selected and then fails.
  const ai = fs.readFileSync(path.join(config.root, 'src/server/public/ai.js'), 'utf8');
  const browserNames = [...ai.matchAll(/^\s{4}(\w+): \{$/gm)].map((m) => m[1]!);
  assert.deepEqual(browserNames.sort(), Object.keys(FREE_PROVIDER_PRESETS).sort());

  for (const [name, preset] of Object.entries(FREE_PROVIDER_PRESETS)) {
    assert.ok(ai.includes(`baseUrl: '${preset.baseUrl}'`), `${name} baseUrl differs`);
    assert.ok(ai.includes(`model: '${preset.model}'`), `${name} model differs`);
    assert.ok(
      ai.includes(`trainsOnInput: ${preset.trainsOnInput}`),
      `${name} data policy differs between client and server`,
    );
  }
});

test('no preset ships a model ID that has been retired', () => {
  // Both defaults originally shipped here were already dead: Groq retired
  // llama-3.3-70b-versatile on 16 Aug 2026 and Google retired
  // gemini-2.0-flash on 1 Jun 2026. Every call 404s, which reads as a broken
  // button. This is the guard against doing it again.
  const ai = fs.readFileSync(path.join(config.root, 'src/server/public/ai.js'), 'utf8');
  for (const [name, preset] of Object.entries(FREE_PROVIDER_PRESETS)) {
    assert.ok(
      !RETIRED_MODEL_IDS.includes(preset.model),
      `${name} defaults to the retired model "${preset.model}"`,
    );
  }
  for (const retired of RETIRED_MODEL_IDS) {
    assert.ok(!ai.includes(`model: '${retired}'`), `ai.js defaults to the retired model "${retired}"`);
  }
});

test('the browser can ask a provider which models it actually runs', async () => {
  // The fix for retired IDs is to ask rather than guess.
  const { ai, calls, modelCalls } = loadAiClient({
    response: { data: [{ id: 'zeta-model' }, { id: 'alpha-model' }] },
  });
  ai.setKey('k');
  ai.setProvider('groq');
  // Copied out of the vm realm: an array built in there has a different
  // Array.prototype, which deepStrictEqual rejects on identity alone.
  const models = [...(await ai.listModels())];

  assert.deepEqual(models, ['alpha-model', 'zeta-model'], 'models should come back sorted');
  assert.equal(calls.length, 0, 'listModels must not post a completion');
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0]!.url, 'https://api.groq.com/openai/v1/models');
  assert.equal(modelCalls[0]!.headers.authorization, 'Bearer k');

  await assert.rejects(
    () => loadAiClient().ai.listModels(),
    (error: Error & { reason?: string }) => error.reason === 'noKey',
  );
});

test('a chosen model is remembered per provider and used for generation', async () => {
  const store: Record<string, string> = {};
  const first = loadAiClient({ store });
  first.ai.setProvider('groq');
  first.ai.setModel('groq-choice');
  first.ai.setProvider('cerebras');
  assert.notEqual(first.ai.model, 'groq-choice', 'a model must not leak across providers');
  first.ai.setProvider('groq');
  assert.equal(first.ai.model, 'groq-choice');

  const second = loadAiClient({ store });
  second.ai.setKey('k');
  await second.ai.generate({ kind: 'linkedin', system: 's', prompt: 'p', language: 'en', hashtags: [] });
  assert.equal(second.calls[0]!.body.model, 'groq-choice', 'generation must use the chosen model');
});

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
