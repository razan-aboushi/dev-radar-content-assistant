import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAudienceInterest, INTEREST_BANDS } from '../src/pipeline/interest';
import { opportunityScore, scoreTopic } from '../src/pipeline/score';
import { createTestDb, setSetting } from '../src/db';
import { insertItems, listScoredTopics } from '../src/db/repositories';
import { buildTopics } from '../src/pipeline/run';
import { buildDaily } from '../src/reports';
import { loadSources } from '../src/config';
import type { NormalizedItem, StoredItem, TopicScore } from '../src/types';

/**
 * Audience interest: the "how many people care" number.
 *
 * The property that matters most is that it is never invented — every point
 * traces to a measured input or a weight written down in config.
 */

function item(over: Partial<StoredItem> = {}): StoredItem {
  return {
    id: 1,
    sourceKey: 'react-blog',
    guid: 'g',
    title: 'React 19 ships the compiler',
    url: 'https://react.dev/a',
    summary: 'x',
    publishedAt: new Date().toISOString(),
    author: null,
    extra: {},
    contentHash: 'h',
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

const reachOf = (key: string) => (key === 'react-blog' ? 5 : key === 'tiny-blog' ? 1 : 3);

function interest(over: Parameters<typeof scoreAudienceInterest>[0] extends infer T ? Partial<T> : never = {}) {
  return scoreAudienceInterest({
    category: 'react',
    publishedAt: new Date().toISOString(),
    sourceTier: 'primary',
    members: [item()],
    reachOf,
    ...over,
  });
}

/* -------------------------------------------------------------- ranges */

test('the score stays inside 0-100 across wildly different inputs', () => {
  const cases = [
    interest(),
    interest({ members: [item({ extra: { points: 5000, comments: 4000 } })] }),
    interest({ members: [item({ sourceKey: 'tiny-blog', extra: {} })], category: 'career' }),
    interest({ publishedAt: null }),
    interest({ publishedAt: '2001-01-01T00:00:00Z' }),
    interest({ members: [] }),
  ];
  for (const result of cases) {
    assert.ok(result.score >= 0 && result.score <= 100, `out of range: ${result.score}`);
    assert.ok(INTEREST_BANDS.includes(result.band), `unknown band: ${result.band}`);
    assert.ok(result.reachMin > 0 && result.reachMax > result.reachMin);
  }
});

test('scoring the same input twice gives the same answer', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');
  const a = interest({ now, members: [item({ extra: { points: 120, comments: 40 } })] });
  const b = interest({ now, members: [item({ extra: { points: 120, comments: 40 } })] });
  assert.deepEqual(a, b);
});

/* ------------------------------------------------------------- signals */

test('more engagement scores higher, but with diminishing returns', () => {
  const now = Date.now();
  const quiet = interest({ now, members: [item({ extra: { points: 10 } })] });
  const busy = interest({ now, members: [item({ extra: { points: 100 } })] });
  const huge = interest({ now, members: [item({ extra: { points: 1000 } })] });

  assert.ok(busy.score > quiet.score, 'more upvotes must score higher');
  assert.ok(huge.score > busy.score);
  // Log-scaled: 10x the upvotes must not mean 10x the score.
  assert.ok(huge.score - busy.score < busy.score - quiet.score + 6, 'engagement is not saturating');
});

test('comments count for more than upvotes, because writing one costs more', () => {
  const now = Date.now();
  const upvotes = interest({ now, members: [item({ extra: { points: 100, comments: 0 } })] });
  const comments = interest({ now, members: [item({ extra: { points: 0, comments: 100 } })] });
  assert.ok(comments.score > upvotes.score);
});

test('a story carried by several outlets outscores an exclusive with the same engagement', () => {
  const now = Date.now();
  const one = interest({ now, members: [item()] });
  const many = interest({
    now,
    members: [item(), item({ id: 2, sourceKey: 'javascript-weekly' }), item({ id: 3, sourceKey: 'node-weekly' })],
  });
  assert.ok(many.score > one.score);
});

test('a large outlet lifts the score above a tiny one', () => {
  const now = Date.now();
  const big = interest({ now, members: [item({ sourceKey: 'react-blog' })] });
  const small = interest({ now, members: [item({ sourceKey: 'tiny-blog' })] });
  assert.ok(big.score > small.score);
});

test('a widely followed subject outscores a specialised one, all else equal', () => {
  const now = Date.now();
  const wide = interest({ now, category: 'react' });
  const narrow = interest({ now, category: 'career' });
  assert.ok(wide.score > narrow.score);
});

test('interest decays with age', () => {
  const now = Date.parse('2026-08-25T00:00:00Z');
  const today = interest({ now, publishedAt: '2026-08-25T00:00:00Z' });
  const old = interest({ now, publishedAt: '2026-06-25T00:00:00Z' });
  assert.ok(today.score > old.score);
});

/* ------------------------------------------------------------ evidence */

test('evidence only ever states numbers that were actually measured', () => {
  const withNumbers = interest({
    members: [item({ extra: { points: 480, comments: 320, stars: 1200 } })],
  });
  const codes = withNumbers.evidence.map((e) => e.code);
  assert.ok(codes.includes('hackerNews'));
  assert.ok(codes.includes('stars'));
  assert.ok(!codes.includes('noEngagement'));

  const hn = withNumbers.evidence.find((e) => e.code === 'hackerNews')!;
  assert.equal(hn.params?.points, 480);
  assert.equal(hn.params?.comments, 320);

  // Nothing measured means the absence is stated, not papered over.
  const silent = interest({ members: [item({ extra: {} })] });
  const silentCodes = silent.evidence.map((e) => e.code);
  assert.ok(silentCodes.includes('noEngagement'));
  assert.ok(!silentCodes.includes('hackerNews'));
  assert.ok(!silentCodes.includes('stars'));
});

test('evidence is structured, so the dashboard can say it in either language', () => {
  // Prose baked in at scoring time is exactly why the score reasons cannot be
  // translated. Evidence must never regress to strings.
  for (const entry of interest({ members: [item({ extra: { points: 9 } })] }).evidence) {
    assert.equal(typeof entry, 'object');
    assert.equal(typeof entry.code, 'string');
  }
});

test('the band matches the score, and reach follows the band', () => {
  const seen = new Map<string, [number, number]>();
  for (const points of [0, 30, 300, 5000]) {
    for (const category of ['career', 'react'] as const) {
      const result = interest({ category, members: [item({ extra: { points } })] });
      const existing = seen.get(result.band);
      if (existing) {
        assert.deepEqual([result.reachMin, result.reachMax], existing, 'one band, one reach range');
      } else {
        seen.set(result.band, [result.reachMin, result.reachMax]);
      }
    }
  }
  assert.ok(seen.size >= 2, 'expected the inputs to span more than one band');
});

/* --------------------------------------------------------- opportunity */

function score(over: Partial<TopicScore> = {}): TopicScore {
  return {
    topicId: 1, freshness: 50, relevance: 50, practicalValue: 50, discussionPotential: 50,
    educationalValue: 50, originality: 50, audienceFit: 50, total: 50, confidence: 50,
    linkedinScore: 50, mediumScore: 50, controversy: 50, audience: null, reasons: [],
    ...over,
  };
}

test('opportunity blends fit and interest, weighted towards fit', () => {
  const audience = { score: 100, band: 'major' as const, reachMin: 1, reachMax: 2, evidence: [] };
  assert.equal(opportunityScore(score({ total: 100, audience })), 100);
  assert.equal(opportunityScore(score({ total: 0, audience })), 40);
  assert.equal(opportunityScore(score({ total: 100, audience: null })), 60);
  // Fit must outweigh interest at equal distance from the extremes.
  const fitHeavy = opportunityScore(score({ total: 80, audience: { ...audience, score: 20 } }));
  const interestHeavy = opportunityScore(score({ total: 20, audience: { ...audience, score: 80 } }));
  assert.ok(fitHeavy > interestHeavy);
});

test('a topic with no audience score still ranks on fit alone', () => {
  assert.equal(opportunityScore(score({ total: 70, audience: null })), 42);
});

/* ------------------------------------------------------ sorting in SQL */

function seeded() {
  const db = createTestDb();
  const insert = db.prepare(
    `INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight, reach)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  insert.run('react-blog', 'React', 'https://x/a', 'rss', 'primary', 'react', 1.4, 5);
  insert.run('hn-frontend', 'HN', 'https://x/b', 'hackernews', 'community', 'frontend', 0.85, 5);

  const items: NormalizedItem[] = [
    {
      sourceKey: 'react-blog', guid: 'a',
      title: 'React Server Components and the hydration boundary, explained',
      url: 'https://react.dev/a',
      summary: 'A deep dive into how the server component payload is streamed and where hydration begins.',
      publishedAt: new Date().toISOString(), author: null, extra: {},
    },
    {
      sourceKey: 'hn-frontend', guid: 'b',
      title: 'Do you really need a state management library in 2026?',
      url: 'https://news.ycombinator.com/item?id=1',
      summary: '',
      publishedAt: new Date().toISOString(), author: null,
      extra: { points: 900, comments: 700 },
    },
  ];
  insertItems(db, items);
  buildTopics(db);
  return db;
}

test('every topic gets an audience score once the radar has run', () => {
  const db = seeded();
  const rows = listScoredTopics(db, { status: 'any' });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.score, 'expected a score');
    assert.ok(row.score!.audience, 'expected an audience score');
    assert.ok(row.score!.audience!.evidence.length > 0);
  }
  db.close();
});

test('the three sort orders genuinely differ', () => {
  const db = seeded();
  const byFit = listScoredTopics(db, { status: 'any', sort: 'fit' });
  const byInterest = listScoredTopics(db, { status: 'any', sort: 'interest' });

  // The React deep dive fits better; the Hacker News thread has 900 upvotes.
  assert.match(byFit[0]!.topic.title, /React Server Components/);
  assert.match(byInterest[0]!.topic.title, /state management library/);
  assert.ok(
    byInterest[0]!.score!.audience!.score > byFit[0]!.score!.audience!.score,
    'interest sort must lead with the most-discussed topic',
  );
  db.close();
});

test('the interest filter excludes quiet topics', () => {
  const db = seeded();
  const loud = listScoredTopics(db, { status: 'any', minInterest: 70 });
  assert.ok(loud.length >= 1);
  for (const row of loud) assert.ok(row.score!.audience!.score >= 70);

  const impossible = listScoredTopics(db, { status: 'any', minInterest: 101 });
  assert.equal(impossible.length, 0);
  db.close();
});

test('an unknown sort falls back to opportunity rather than breaking the query', () => {
  const db = seeded();
  const rows = listScoredTopics(db, { status: 'any', sort: 'nonsense' as never });
  assert.equal(rows.length, 2);
  db.close();
});

/* --------------------------------------------------- the daily shortlist */

test('the daily radar qualifies on opportunity, not on fit alone', () => {
  // The regression: a story with fit 51 and interest 87 was dropped by a
  // fit-only threshold while a duller topic with fit 60 stayed.
  const db = seeded();
  setSetting(db, 'minTopicScore', '50');
  const report = buildDaily(db);
  const titles = report.entries.map((entry) => entry.topic.title);
  assert.ok(
    titles.some((title) => /state management library/.test(title)),
    `the high-interest topic was filtered out: ${titles.join(' | ')}`,
  );
  for (const entry of report.entries) assert.ok(entry.opportunity >= 50);
  db.close();
});

test('the daily radar is ordered by opportunity, highest first', () => {
  const db = seeded();
  setSetting(db, 'minTopicScore', '0');
  const entries = buildDaily(db).entries;
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok(
      entries[i - 1]!.opportunity >= entries[i]!.opportunity,
      'entries are out of order',
    );
  }
  db.close();
});

/* ------------------------------------------------------------- config */

test('every configured source declares a sane reach', () => {
  for (const source of loadSources()) {
    const reach = source.reach ?? 3;
    assert.ok(
      Number.isInteger(reach) && reach >= 1 && reach <= 5,
      `${source.key} has reach ${reach}, expected an integer 1-5`,
    );
  }
});

test('the source list covers backend, frontend and AI, not just JavaScript', () => {
  // The radar was frontend-heavy: AI and backend had almost no primary sources.
  const categories = new Set(loadSources().filter((s) => s.enabled).map((s) => s.category));
  for (const required of ['ai-for-developers', 'backend', 'frontend', 'databases', 'security']) {
    assert.ok(categories.has(required as never), `no enabled source for ${required}`);
  }
  assert.ok(loadSources().length >= 40, `expected a broad source list, got ${loadSources().length}`);
});

test('source keys are unique and every source has a usable url', () => {
  const sources = loadSources();
  const keys = sources.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate source key');
  for (const source of sources) {
    assert.ok(source.url.length > 0, `${source.key} has no url`);
    if (source.kind === 'rss' || source.kind === 'atom') {
      assert.match(source.url, /^https:\/\//, `${source.key} must fetch over https`);
    }
    assert.ok(source.weight >= 0.5 && source.weight <= 1.5, `${source.key} weight out of range`);
  }
});

test('scoreTopic leaves audience for the pipeline to fill in', () => {
  // scoreTopic is a pure function of one topic and deliberately does not see
  // the cluster payloads that engagement is read from.
  const result = scoreTopic(1, {
    topic: {
      title: 'React 19', summary: 'x', category: 'react',
      publishedAt: new Date().toISOString(), sourceTier: 'primary',
    },
    sourceWeight: 1,
    clusterSize: 1,
    priorSimilarity: 0,
  });
  assert.equal(result.audience, null);
});
