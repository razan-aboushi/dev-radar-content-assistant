import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIENCE_FOCUS,
  RELEASE_SIGNALS,
  countSignals,
  detectCategory,
  detectStability,
  haystack,
  matchedSignals,
} from '../src/pipeline/signals';
import { scoreTopic } from '../src/pipeline/score';
import { clusterItems } from '../src/pipeline/dedupe';
import { decodeEntities, stripHtml } from '../src/util/text';
import { githubReleasesAdapter, rssAdapter } from '../src/sources/adapters';
import { scoreStyle } from '../src/writing/evaluate';
import { createTestDb, setSetting } from '../src/db';
import { insertItems, listScoredTopics } from '../src/db/repositories';
import { buildTopics } from '../src/pipeline/run';
import { loadProfile } from '../src/writing/style';
import type { NormalizedItem, SourceConfig, StoredItem } from '../src/types';

/**
 * Regression tests. Each one pins down a defect that was found by reading the
 * code or by running the tool against the live web, so the behaviour cannot
 * quietly come back.
 */

/* ------------------------------------------------- keyword edge matching */

const OFF_TOPIC_TITLE = 'Rust maintainers detail a new search architecture available in the container';
const OFF_TOPIC_SUMMARY = 'The team explains the rapid rewrite of their build chain and how it is maintained.';

test('short keywords do not match inside unrelated words', () => {
  const hay = haystack(`${OFF_TOPIC_TITLE} ${OFF_TOPIC_SUMMARY}`);
  // "ai" in maintainers/available/chain, "api" in rapid, "rc" in search/architecture.
  assert.deepEqual(matchedSignals(hay, AUDIENCE_FOCUS), []);
  assert.equal(countSignals(hay, RELEASE_SIGNALS), 0);
});

test('an off-topic item stays below the default shortlist threshold', () => {
  const score = scoreTopic(1, {
    topic: {
      title: OFF_TOPIC_TITLE,
      summary: OFF_TOPIC_SUMMARY,
      category: 'career',
      publishedAt: new Date().toISOString(),
      sourceTier: 'community',
    },
    sourceWeight: 1,
    clusterSize: 1,
    priorSimilarity: 0,
  });
  // Substring matching scored this at 56, over the default minTopicScore of 55.
  assert.ok(score.total < 55, `off-topic item scored ${score.total}`);
});

test('genuine focus keywords are still matched, including attached forms', () => {
  const on = haystack('React Server Components and the hydration boundary, explained');
  assert.deepEqual(matchedSignals(on, AUDIENCE_FOCUS), ['react', 'hydration', 'server components']);

  assert.ok(matchedSignals(haystack('Node.js 22 ships today'), AUDIENCE_FOCUS).includes('node.js'));
  assert.ok(matchedSignals(haystack('An ai-assisted workflow'), AUDIENCE_FOCUS).includes('ai'));
  assert.ok(matchedSignals(haystack('Core Web Vitals update'), AUDIENCE_FOCUS).includes('core web vitals'));
});

test('category detection is not driven by fragments of other words', () => {
  // "ui" inside "building" used to make this frontend.
  assert.notEqual(detectCategory(OFF_TOPIC_TITLE, 'career'), 'frontend');
  assert.equal(detectCategory('A guide to React hooks and useState', 'career'), 'react');
});

test('stability words still match at word edges', () => {
  assert.equal(detectStability('The flag graduated to stable in v22'), 'stable');
  assert.equal(detectStability('This is a stage 3 proposal'), 'proposal');
  assert.equal(detectStability('Nothing notable in this sentence'), null);
});

/* ------------------------------------------------------- entity decoding */

test('out-of-range numeric entities are left alone rather than thrown on', () => {
  // String.fromCodePoint raises above U+10FFFF; one bad entity used to take
  // down the whole source it arrived in.
  assert.equal(decodeEntities('hello &#99999999; world'), 'hello &#99999999; world');
  assert.equal(decodeEntities('hi &#xFFFFFFF; there'), 'hi &#xFFFFFFF; there');
  assert.equal(stripHtml('<p>x &#1114112; y</p>'), 'x &#1114112; y');
});

test('valid entities still decode', () => {
  assert.equal(decodeEntities('a &amp; b &#8217;c&#x2014;d'), 'a & b ’c—d');
});

/* ---------------------------------------------------------- feed parsing */

test('a feed with more than 1000 entity expansions still parses', () => {
  // fast-xml-parser defaults to a budget of 1000, which three shipped feeds
  // exceeded on ordinary content and failed to parse entirely.
  const items = Array.from(
    { length: 400 },
    (_, i) =>
      `<item><title>Release notes for widgets &amp; gadgets, part ${i}</title>` +
      `<link>https://example.com/${i}</link><guid>g${i}</guid>` +
      `<description>Ampersands &amp; entities &amp; more &amp; more</description></item>`,
  ).join('');
  const raw = `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;

  const source: SourceConfig = {
    key: 'test', name: 'Test', url: 'https://example.com/feed', kind: 'rss',
    tier: 'primary', category: 'javascript', enabled: true, weight: 1,
  };
  const parsed = rssAdapter.validate(rssAdapter.normalize(raw, source));
  assert.equal(parsed.length, 400);
  assert.ok(parsed[0]!.summary.includes('&'), 'entities should be decoded, not escaped');
});

/* ------------------------------------------------- github release filter */

test('automated canary builds are dropped but real prereleases are kept', () => {
  const source: SourceConfig = {
    key: 'next', name: 'Next', url: 'vercel/next.js', kind: 'github-releases',
    tier: 'primary', category: 'nextjs', enabled: true, weight: 1.4,
  };
  const releases = [
    { id: 1, html_url: 'https://x/1', tag_name: 'v16.4.0-canary.6', name: 'v16.4.0-canary.6', body: 'auto', draft: false, prerelease: true, published_at: '2026-08-01T00:00:00Z', author: null },
    { id: 2, html_url: 'https://x/2', tag_name: 'v16.3.2', name: 'v16.3.2', body: 'real notes', draft: false, prerelease: false, published_at: '2026-08-01T00:00:00Z', author: null },
    { id: 3, html_url: 'https://x/3', tag_name: 'v6.0-rc', name: 'v6.0 RC', body: 'release candidate', draft: false, prerelease: true, published_at: '2026-08-01T00:00:00Z', author: null },
    { id: 4, html_url: 'https://x/4', tag_name: 'v1.0.0', name: 'v1.0.0', body: 'draft', draft: true, prerelease: false, published_at: null, author: null },
  ];
  const items = githubReleasesAdapter.normalize(
    JSON.stringify({ repo: 'vercel/next.js', releases }),
    source,
  );
  const tags = items.map((i) => String(i.extra.tag));
  assert.deepEqual(tags, ['v16.3.2', 'v6.0-rc']);
});

/* ----------------------------------------------------------- clustering */

function stored(over: Partial<StoredItem>): StoredItem {
  return {
    id: 1, sourceKey: 'community', guid: 'g', title: 'A story about something',
    url: 'https://example.com/a', summary: '', publishedAt: '2026-08-01T00:00:00Z',
    author: null, extra: {}, contentHash: 'h', fetchedAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

test('a url-matched duplicate from a better source takes the cluster lead', () => {
  const items = [
    stored({ id: 1, sourceKey: 'community', url: 'https://example.com/a?utm_source=x' }),
    stored({ id: 2, sourceKey: 'primary-src', url: 'https://example.com/a' }),
  ];
  const clusters = clusterItems(items, {
    threshold: 0.62,
    tierRank: (key) => (key === 'primary-src' ? 3 : 1),
  });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.members.length, 2);
  assert.equal(clusters[0]!.lead.sourceKey, 'primary-src');
});

/* ---------------------------------------------------- word-count setting */

test('the style gate judges length against the configured word range', () => {
  const profile = loadProfile();
  const text = Array.from({ length: 200 }, () => 'word').join(' ');
  const lengthNote = (min: number, max: number) =>
    scoreStyle({
      text, profile, kind: 'linkedin', minWords: min, maxWords: max,
      hasPersonalTake: true, hasQuestion: true, hasConcreteDetail: true,
    }).notes.find((n) => n.includes('words; target'));

  // 200 words is inside a 150-300 target and outside a 600-900 one. The bounds
  // used to be hardcoded, so changing the setting changed nothing here.
  assert.equal(lengthNote(150, 300), undefined);
  assert.ok(lengthNote(600, 900)?.includes('target 600–900'));
});

/* --------------------------------------------- rescoring existing topics */

function item(over: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    sourceKey: 'nodejs-blog', guid: 'g1',
    title: 'Node.js v22.5.0 makes the permission model stable',
    url: 'https://nodejs.org/a',
    summary: 'The permission model graduated to stable in v22.5.0 after a 12% startup improvement.',
    publishedAt: new Date().toISOString(), author: null, extra: {},
    ...over,
  };
}

test('a second pass re-scores existing topics instead of skipping them', () => {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run('nodejs-blog', 'Node Blog', 'https://x/f', 'rss', 'primary', 'nodejs', 1.4);

  insertItems(db, [item()]);
  const first = buildTopics(db);
  assert.equal(first.topicsNew, 1);
  assert.equal(first.topicsRescored, 0);

  const second = buildTopics(db);
  assert.equal(second.topicsNew, 0, 'must not duplicate the topic');
  assert.equal(second.topicsRescored, 1, 'must re-score what is already stored');
});

test('changing minTopicScore and re-running moves topics in and out of the shortlist', () => {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run('nodejs-blog', 'Node Blog', 'https://x/f', 'rss', 'primary', 'nodejs', 1.4);

  insertItems(db, [item()]);
  setSetting(db, 'minTopicScore', '10');
  buildTopics(db);
  assert.equal(listScoredTopics(db, { status: 'shortlisted' }).length, 1);

  setSetting(db, 'minTopicScore', '99');
  buildTopics(db);
  assert.equal(listScoredTopics(db, { status: 'shortlisted' }).length, 0);

  setSetting(db, 'minTopicScore', '10');
  buildTopics(db);
  assert.equal(listScoredTopics(db, { status: 'shortlisted' }).length, 1);
  db.close();
});

test('a status set by hand survives a re-score', () => {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run('nodejs-blog', 'Node Blog', 'https://x/f', 'rss', 'primary', 'nodejs', 1.4);

  insertItems(db, [item()]);
  setSetting(db, 'minTopicScore', '10');
  buildTopics(db);
  db.prepare('UPDATE topics SET status = ?').run('published');
  buildTopics(db);
  assert.equal(listScoredTopics(db, { status: 'published' }).length, 1);
  db.close();
});

/* ------------------------------------------------------- score.topicId */

test('listScoredTopics returns scores carrying their own topic id', () => {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run('nodejs-blog', 'Node Blog', 'https://x/f', 'rss', 'primary', 'nodejs', 1.4);

  insertItems(db, [item()]);
  buildTopics(db);
  const [row] = listScoredTopics(db, { status: 'any' });
  assert.ok(row?.score, 'expected a scored topic');
  // The join aliases topic_id, so this used to come back undefined.
  assert.equal(row.score.topicId, row.topic.id);
  db.close();
});
