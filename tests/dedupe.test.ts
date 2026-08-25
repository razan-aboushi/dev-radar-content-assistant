import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterItems, checkRepeat } from '../src/pipeline/dedupe';
import type { PriorContent, StoredItem } from '../src/types';

function item(id: number, sourceKey: string, title: string, url: string): StoredItem {
  return {
    id, sourceKey, guid: url, title, url, summary: '', publishedAt: '2024-10-02T00:00:00Z',
    author: null, extra: {}, contentHash: String(id), fetchedAt: '2024-10-02T00:00:00Z',
  };
}

const tierRank = (key: string) => (key === 'primary-src' ? 3 : 1);

test('the same story across sources lands in one cluster', () => {
  const clusters = clusterItems(
    [
      item(1, 'blog-a', 'React 19 introduces the React Compiler', 'https://a.com/1'),
      item(2, 'blog-b', 'React 19 introduces the React Compiler', 'https://b.com/1'),
      item(3, 'blog-c', 'Postgres 17 improves vacuum performance', 'https://c.com/1'),
    ],
    { threshold: 0.6, tierRank },
  );
  assert.equal(clusters.length, 2);
  const big = clusters.find((c) => c.members.length === 2);
  assert.ok(big);
  assert.equal(big!.urls.length, 2);
});

test('the highest-tier source leads the cluster', () => {
  const clusters = clusterItems(
    [
      item(1, 'blog-a', 'React 19 introduces the React Compiler', 'https://a.com/1'),
      item(2, 'primary-src', 'React 19 introduces the React Compiler', 'https://react.dev/1'),
    ],
    { threshold: 0.6, tierRank },
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.lead.sourceKey, 'primary-src');
});

test('tracking params do not create a second cluster', () => {
  const clusters = clusterItems(
    [
      item(1, 'a', 'Some article about bundling and tree shaking', 'https://x.com/p'),
      item(2, 'b', 'Some article about bundling and tree shaking', 'https://x.com/p?utm_source=rss'),
    ],
    { threshold: 0.6, tierRank },
  );
  assert.equal(clusters.length, 1);
});

test('unrelated titles stay apart', () => {
  const clusters = clusterItems(
    [
      item(1, 'a', 'CSS anchor positioning ships in Chrome', 'https://a.com/1'),
      item(2, 'b', 'Rust adds async closures to the language', 'https://b.com/1'),
    ],
    { threshold: 0.6, tierRank },
  );
  assert.equal(clusters.length, 2);
});

const prior: PriorContent[] = [
  {
    platform: 'linkedin',
    title: 'Why hydration mismatches happen in Next.js',
    text: 'A post about hydration mismatches, server rendering and why the client and server disagree.',
    url: null,
    publishedAt: '2024-01-01T00:00:00Z',
  },
];

test('a near-identical topic is flagged as a repeat', () => {
  const result = checkRepeat('Why hydration mismatches happen in Next.js', 'Some body text.', prior, 0.5);
  assert.equal(result.isRepeat, true);
  assert.ok(result.match);
});

test('a genuinely different topic is not a repeat', () => {
  const result = checkRepeat('Postgres 17 vacuum performance improvements', 'Autovacuum tuning notes.', prior, 0.5);
  assert.equal(result.isRepeat, false);
  assert.equal(result.match, null);
});

test('an empty history never reports a repeat', () => {
  assert.equal(checkRepeat('anything at all', 'body', [], 0.5).isRepeat, false);
});
