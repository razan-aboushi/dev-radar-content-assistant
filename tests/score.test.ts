import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTopic, WEIGHTS } from '../src/pipeline/score';
import type { ScoreInput } from '../src/pipeline/score';

function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    topic: {
      title: 'Node.js 22 adds a stable permission model',
      summary: 'The release notes describe how the flag graduated to stable in v22.0.0.',
      category: 'nodejs',
      publishedAt: new Date().toISOString(),
      sourceTier: 'primary',
    },
    sourceWeight: 1.2,
    clusterSize: 1,
    priorSimilarity: 0,
    ...overrides,
  };
}

test('component weights sum to 1', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
});

test('every component and total stays within 0-100', () => {
  const score = scoreTopic(1, input());
  for (const [key, value] of Object.entries(score)) {
    if (typeof value !== 'number' || key === 'topicId') continue;
    assert.ok(value >= 0 && value <= 100, `${key} out of range: ${value}`);
  }
});

test('freshness decays with age', () => {
  const fresh = scoreTopic(1, input()).freshness;
  const old = scoreTopic(1, input({
    topic: { ...input().topic, publishedAt: new Date(Date.now() - 21 * 86400000).toISOString() },
  })).freshness;
  assert.ok(fresh > old, `${fresh} should exceed ${old}`);
});

test('undated items get a neutral freshness rather than zero', () => {
  const score = scoreTopic(1, input({ topic: { ...input().topic, publishedAt: null } }));
  assert.equal(score.freshness, 50);
});

test('overlap with prior work drives originality down', () => {
  const clean = scoreTopic(1, input({ priorSimilarity: 0 })).originality;
  const repeat = scoreTopic(1, input({ priorSimilarity: 0.9 })).originality;
  assert.ok(repeat < clean - 30, `${repeat} should be well below ${clean}`);
});

test('a story carried by many sources scores less original', () => {
  const exclusive = scoreTopic(1, input({ clusterSize: 1 })).originality;
  const everywhere = scoreTopic(1, input({ clusterSize: 5 })).originality;
  assert.ok(everywhere < exclusive);
});

test('debate wording raises discussion potential', () => {
  const plain = scoreTopic(1, input()).discussionPotential;
  const spicy = scoreTopic(1, input({
    topic: { ...input().topic, title: 'Do you really need Redux? Stop using it, it is considered harmful' },
  })).discussionPotential;
  assert.ok(spicy > plain);
});

test('marketing noise is penalised in relevance', () => {
  const normal = scoreTopic(1, input()).relevance;
  const spam = scoreTopic(1, input({
    topic: { ...input().topic, title: 'Sponsored webinar: sign up now for a discount', summary: '' },
  })).relevance;
  assert.ok(spam < normal);
});

test('community sources score lower confidence than primary', () => {
  const primary = scoreTopic(1, input()).confidence;
  const community = scoreTopic(1, input({
    topic: { ...input().topic, sourceTier: 'community' },
  })).confidence;
  assert.ok(community < primary);
});

test('scoring is deterministic', () => {
  // One fixture, scored twice: calling input() twice would produce two
  // different publishedAt timestamps and a spurious freshness difference.
  //
  // `now` is pinned as well. Freshness used to read the clock on every call,
  // so two calls either side of a millisecond boundary disagreed and this
  // assertion failed about 2% of the time.
  const fixed = input({
    topic: { ...input().topic, publishedAt: '2026-08-01T00:00:00Z' },
    now: Date.parse('2026-08-10T00:00:00Z'),
  });
  assert.deepEqual(scoreTopic(1, fixed), scoreTopic(1, fixed));
});

test('scoring does not drift as the clock advances within a call', () => {
  const at = (now: number) =>
    scoreTopic(1, input({
      topic: { ...input().topic, publishedAt: '2026-08-01T00:00:00Z' },
      now,
    }));
  // Same pinned instant must always give a byte-identical result.
  const base = Date.parse('2026-08-10T00:00:00Z');
  for (let i = 0; i < 500; i += 1) assert.deepEqual(at(base), at(base));
  // A later instant must give a strictly staler score.
  assert.ok(at(base + 7 * 86_400_000).freshness < at(base).freshness);
});
