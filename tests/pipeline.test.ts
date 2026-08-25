import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, getNumberSetting, setSetting } from '../src/db';
import {
  contentHashOf, insertItems, insertPriorContent, insertTopic, listAngles,
  listContent, listFacts, listScoredTopics, getScore, getTopicBySlug,
} from '../src/db/repositories';
import { buildTopics } from '../src/pipeline/run';
import { buildContext } from '../src/writing/context';
import { generateLinkedIn, scaffold, renderForPublishing } from '../src/writing/linkedin';
import { generateMedium } from '../src/writing/medium';
import { NullProvider } from '../src/ai/provider';
import { loadProfile } from '../src/writing/style';
import { buildDaily, buildWeekly } from '../src/reports';
import type { NormalizedItem } from '../src/types';

function seedSources(db: ReturnType<typeof createTestDb>) {
  db.prepare(
    `INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run('nodejs-blog', 'Node Blog', 'https://x/f', 'rss', 'primary', 'nodejs', 1.4);
  db.prepare(
    `INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run('hn', 'HN', 'https://x/hn', 'hackernews', 'community', 'frontend', 0.85);
}

function item(over: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    sourceKey: 'nodejs-blog',
    guid: 'g1',
    title: 'Node.js v22.5.0 makes the permission model stable',
    url: 'https://nodejs.org/a',
    summary:
      'The permission model graduated to stable in v22.5.0. The team measured a 12% startup improvement. ' +
      'This changes how you sandbox a production worker process.',
    publishedAt: new Date().toISOString(),
    author: null,
    extra: {},
    ...over,
  };
}

test('the same item inserted twice creates one row', () => {
  const db = createTestDb();
  seedSources(db);
  assert.equal(insertItems(db, [item()]).inserted.length, 1);
  assert.equal(insertItems(db, [item()]).inserted.length, 0);
  db.close();
});

test('content hash ignores case and whitespace differences', () => {
  assert.equal(
    contentHashOf(item({ title: ' Node.js V22.5.0 Makes The Permission Model Stable ' })),
    contentHashOf(item()),
  );
});

test('buildTopics promotes items to scored topics with facts and angles', () => {
  const db = createTestDb();
  seedSources(db);
  insertItems(db, [item()]);

  const result = buildTopics(db);
  assert.equal(result.topicsNew, 1);

  const topic = getTopicBySlug(db, 'node.js-v22.5.0-makes-the-permission-model-stable');
  assert.ok(topic, 'topic was not created with the expected slug');

  const score = getScore(db, topic!.id);
  assert.ok(score, 'topic was not scored');
  assert.ok(score!.total > 0 && score!.total <= 100);
  assert.ok(score!.reasons.length >= 7, 'every component should carry a reason');

  assert.equal(listAngles(db, topic!.id).length, 3);
  assert.ok(listFacts(db, topic!.id).length > 0);
  db.close();
});

test('buildTopics is idempotent', () => {
  const db = createTestDb();
  seedSources(db);
  insertItems(db, [item()]);
  buildTopics(db);
  const second = buildTopics(db);
  assert.equal(second.topicsNew, 0);
  assert.equal(listScoredTopics(db, { status: 'any' }).length, 1);
  db.close();
});

test('a topic matching prior published work is rejected, not shortlisted', () => {
  const db = createTestDb();
  seedSources(db);
  insertPriorContent(db, {
    platform: 'linkedin',
    title: 'Node.js v22.5.0 makes the permission model stable',
    url: null,
    text: 'A post about the Node.js permission model going stable in v22.5.0 and what it means for workers.',
    publishedAt: '2024-01-01T00:00:00Z',
  });

  const result = buildTopics(db) as { topicsNew: number; topicsRejected: number };
  insertItems(db, [item()]);
  const second = buildTopics(db);
  assert.equal(second.topicsNew, 0);
  assert.equal(second.topicsRejected, 1);
  void result;

  const rejected = listScoredTopics(db, { status: 'rejected' });
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.topic.rejectionReason?.includes('overlap'));
  db.close();
});

test('topics above minTopicScore are shortlisted automatically', () => {
  const db = createTestDb();
  seedSources(db);
  setSetting(db, 'minTopicScore', '1');
  insertItems(db, [item()]);
  buildTopics(db);
  assert.equal(listScoredTopics(db, { status: 'shortlisted' }).length, 1);
  db.close();
});

test('the daily report surfaces a top recommendation with reasoning', () => {
  const db = createTestDb();
  seedSources(db);
  setSetting(db, 'minTopicScore', '1');
  insertItems(db, [item()]);
  buildTopics(db);

  const daily = buildDaily(db);
  assert.ok(daily.top);
  assert.ok(daily.top!.whyItMatters.length > 10);
  assert.ok(daily.top!.suggestedAngle.length > 5);
  assert.ok(daily.top!.linkedinScore >= 0);

  const weekly = buildWeekly(db);
  assert.ok(weekly.sections.length > 0);
  db.close();
});

test('generation with no model produces a labelled scaffold, not fake prose', async () => {
  const db = createTestDb();
  seedSources(db);
  insertItems(db, [item()]);
  buildTopics(db);
  const topic = listScoredTopics(db, { status: 'any' })[0]!.topic;

  const context = buildContext(db, topic, getScore(db, topic.id), loadProfile());
  const result = await generateLinkedIn(db, context, new NullProvider());

  assert.equal(result.content.mode, 'scaffold');
  assert.ok(result.content.body.includes('[YOUR TAKE]'), 'scaffold should be visibly an outline');
  assert.ok(result.content.hook.length > 0);
  assert.ok(result.content.hashtags.length >= 1 && result.content.hashtags.length <= 8);
  assert.ok(result.content.sources.includes(topic.sourceUrl));
  assert.equal(listContent(db, topic.id).length, 1);
  db.close();
});

test('a medium scaffold contains the required sections and its sources', async () => {
  const db = createTestDb();
  seedSources(db);
  insertItems(db, [item()]);
  buildTopics(db);
  const topic = listScoredTopics(db, { status: 'any' })[0]!.topic;

  const context = buildContext(db, topic, getScore(db, topic.id), loadProfile());
  const result = await generateMedium(db, context, new NullProvider());

  assert.equal(result.content.mode, 'scaffold');
  for (const heading of ['## Why this matters', '## Common mistakes', '## My takeaway']) {
    assert.ok(result.content.body.includes(heading), `missing ${heading}`);
  }
  assert.ok(result.content.body.includes(topic.sourceUrl));
  assert.ok(result.content.title.length > 0);
  db.close();
});

test('the scaffold only ever contains claims that passed verification', () => {
  const db = createTestDb();
  seedSources(db);
  insertItems(db, [
    item({
      sourceKey: 'hn',
      guid: 'hn1',
      title: 'Someone claims the new runtime is 400% faster than everything',
      url: 'https://news.ycombinator.com/item?id=1',
      summary: 'An unsourced claim that it is 400% faster in v9.9.9.',
    }),
  ]);
  buildTopics(db);
  const topic = listScoredTopics(db, { status: 'any' })[0]!.topic;
  const context = buildContext(db, topic, getScore(db, topic.id), loadProfile());

  const text = scaffold(context, 'hook');
  const unverified = listFacts(db, topic.id).filter((f) => f.status === 'unverified');
  for (const fact of unverified) {
    assert.ok(!text.includes(fact.claim), 'an unverified claim leaked into the draft');
  }
  db.close();
});

test('publishing text appends hashtags exactly once', async () => {
  const db = createTestDb();
  seedSources(db);
  insertItems(db, [item()]);
  buildTopics(db);
  const topic = listScoredTopics(db, { status: 'any' })[0]!.topic;
  const context = buildContext(db, topic, getScore(db, topic.id), loadProfile());
  const result = await generateLinkedIn(db, context, new NullProvider());

  const text = renderForPublishing(result.content);
  const firstTag = result.content.hashtags[0]!;
  assert.equal(text.split(firstTag).length - 1, 1);
  db.close();
});

test('settings fall back to defaults when unset', () => {
  const db = createTestDb();
  assert.equal(getNumberSetting(db, 'minTopicScore'), 55);
  setSetting(db, 'minTopicScore', '70');
  assert.equal(getNumberSetting(db, 'minTopicScore'), 70);
  db.close();
});

test('inserting a topic with a duplicate slug returns null instead of throwing', () => {
  const db = createTestDb();
  seedSources(db);
  const base = {
    itemId: null, title: 'A duplicate title here', summary: '', category: 'nodejs' as const,
    sourceKey: 'nodejs-blog', sourceUrl: 'https://x/1', sourceTier: 'primary' as const,
    publishedAt: null, status: 'new' as const, corroborationUrls: [], rejectionReason: null,
  };
  assert.ok(insertTopic(db, base));
  assert.equal(insertTopic(db, base), null);
  db.close();
});
