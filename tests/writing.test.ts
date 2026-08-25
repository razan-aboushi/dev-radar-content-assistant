import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAiTells, scoreStyle } from '../src/writing/evaluate';
import { measureStyle } from '../src/writing/style';
import { fillPattern, selectHookPattern } from '../src/writing/hooks';
import { extractFacts, assertableFacts, renderClaim } from '../src/pipeline/verify';
import { recommendAngle, generateAngles, subjectOf } from '../src/pipeline/angles';
import type { StoredItem, StyleProfile, Topic, TopicScore } from '../src/types';

const profile: StyleProfile = {
  name: 'Test Writer',
  greetings: ['Hello Everyone!'],
  signaturePhrases: ['Think about it.', 'And honestly?'],
  hookPatterns: [
    '{subject} is not what you think...',
    'Many developers do {common_action}. But {complication}.',
    'I used to think {belief}. I was wrong.',
    'This small change can cause a much bigger problem.',
    '{subject} looks simple until you work on a real production system.',
    'Nobody tells you this when you start learning {subject}.',
    "The code works. But that's not the same as {quality}.",
    'One thing I learned from debugging production:',
    "The hardest part wasn't writing the code.",
    '{subject} just changed.',
  ],
  bannedPhrases: ['unlock the power of', 'game-changing', "in today's rapidly evolving digital landscape"],
  emojis: ['\u{1F49B}'],
  preferredHashtags: ['#JavaScript', '#SoftwareEngineering'],
  measured: null,
};

/* ------------------------------------------------------------- AI tells */

test('banned phrases are reported', () => {
  const report = detectAiTells('Unlock the power of this game-changing tool.', profile);
  assert.equal(report.bannedHits.length, 2);
});

test('structural LLM constructions are caught', () => {
  const report = detectAiTells(
    'This is not only fast but also safe. In conclusion, it plays a crucial role.',
    profile,
  );
  assert.ok(report.tells.length >= 2);
});

test('clean human-sounding text produces no tells', () => {
  const text = 'I hit this last week. The build passed. Then production fell over at 3am.\n\nTurns out the cache key was wrong. One line.';
  const report = detectAiTells(text, profile);
  assert.deepEqual(report.bannedHits, []);
});

test('uniform sentence length is flagged', () => {
  const uniform = Array.from({ length: 8 }, () => 'This sentence has exactly seven words here.').join(' ');
  const report = detectAiTells(uniform, profile);
  assert.ok(report.tells.some((t) => t.includes('uniform')));
});

/* ---------------------------------------------------------- style score */

function score(text: string, overrides = {}) {
  return scoreStyle({
    text, profile, kind: 'linkedin',
    hasPersonalTake: true, hasQuestion: true, hasConcreteDetail: true,
    ...overrides,
  });
}

test('style score stays within 0-100 on every dimension', () => {
  const result = score('I broke production with `useLayoutEffect` in v14.2. Check your SSR logs. What would you do?');
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'number') continue;
    assert.ok(value >= 0 && value <= 100, `${key}=${value}`);
  }
});

test('banned phrasing tanks originality and naturalness', () => {
  const clean = score('I shipped a fix for `hydration` in v14.2. What broke for you?');
  const spammy = score("Unlock the power of this game-changing v14.2 fix. What broke for you?");
  assert.ok(spammy.originality < clean.originality - 20);
  assert.ok(spammy.naturalness < clean.naturalness);
});

test('a weak generic opener is penalised on hook strength', () => {
  const strong = score('Nobody tells you this when you start learning SSR.\n\nI learned it at 3am.');
  const weak = score('In the world of modern web development there are many considerations to weigh carefully.');
  assert.ok(weak.hookStrength < strong.hookStrength);
});

test('missing first person is called out in the notes', () => {
  const result = score('The `cache` option changed in v14.2. Teams should check their config.', {
    hasPersonalTake: false,
  });
  assert.ok(result.notes.some((n) => n.includes('first-person')));
});

test('a short LinkedIn draft gets a word-count note', () => {
  const result = score('I broke it. What about you?');
  assert.ok(result.notes.some((n) => n.includes('words')));
});

/* -------------------------------------------------------- style measure */

test('measureStyle returns null with no corpus', () => {
  assert.equal(measureStyle([]), null);
});

test('measureStyle derives sentence and question statistics', () => {
  const measured = measureStyle([
    { file: 'a.md', text: 'I broke production last night. What would you have done?\n\nThe fix was one line. Really.' },
    { file: 'b.md', text: 'Hydration is confusing. I used to ignore it. Then it bit me. Twice.' },
  ]);
  assert.ok(measured);
  assert.equal(measured!.sampleCount, 2);
  assert.ok(measured!.avgSentenceWords > 0);
  assert.ok(measured!.questionRatio > 0 && measured!.questionRatio < 1);
  assert.ok(measured!.topOpeners.length >= 2);
});

/* ----------------------------------------------------------------- hooks */

test('placeholders are always filled or removed, never left visible', () => {
  for (const pattern of profile.hookPatterns) {
    const filled = fillPattern(pattern, {
      subject: 'SSR', commonAction: 'guess', complication: 'it breaks',
      belief: 'it was simple', quality: 'being correct',
    });
    assert.ok(!/\{[a-z_]+\}/.test(filled), `unfilled placeholder in: ${filled}`);
  }
});

test('hook selection is stable for a slug but varies across slugs', () => {
  const a1 = selectHookPattern(profile, 'opinion', 'topic-one');
  const a2 = selectHookPattern(profile, 'opinion', 'topic-one');
  assert.equal(a1, a2);
  const slugs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const chosen = new Set(slugs.map((s) => selectHookPattern(profile, 'engineering-lesson', s)));
  assert.ok(chosen.size > 1, 'every slug produced the same hook');
});

/* ------------------------------------------------------------ verification */

function storedItem(overrides: Partial<StoredItem> = {}): StoredItem {
  return {
    id: 1, sourceKey: 'nodejs-blog', guid: 'g', title: 'Node.js v22.0.0 is out',
    url: 'https://nodejs.org/a',
    summary: 'The permission model reached stable in v22.0.0. Startup improved by 12% in the team benchmark. It is described as experimental in earlier notes.',
    publishedAt: '2024-10-02T00:00:00Z', author: null, extra: {},
    contentHash: 'h', fetchedAt: '2024-10-02T00:00:00Z', ...overrides,
  };
}

test('facts are only extracted from sentences with checkable specifics', () => {
  const facts = extractFacts({
    topicId: 1, lead: storedItem(), leadTier: 'primary', corroborators: [],
  });
  assert.ok(facts.length > 0);
  for (const fact of facts) {
    assert.equal(fact.sourceUrl, 'https://nodejs.org/a');
  }
});

test('a community source alone never yields a verified fact', () => {
  const facts = extractFacts({
    topicId: 1,
    lead: storedItem({ sourceKey: 'hn' }),
    leadTier: 'community',
    corroborators: [],
  });
  assert.ok(facts.every((f) => f.status !== 'verified'));
});

test('corroboration upgrades a community claim to verified', () => {
  const other = storedItem({ id: 2, sourceKey: 'other', summary: 'Also reports v22.0.0 shipping.' });
  const facts = extractFacts({
    topicId: 1,
    lead: storedItem({ sourceKey: 'hn' }),
    leadTier: 'community',
    corroborators: [{ item: other, tier: 'reputable' }],
  });
  assert.ok(facts.some((f) => f.status === 'verified'));
});

test('unverified claims never reach the writer', () => {
  const facts = [
    { topicId: 1, claim: 'a', sourceUrl: 'u', sourceTier: 'community' as const, status: 'unverified' as const, note: '' },
    { topicId: 1, claim: 'b', sourceUrl: 'u', sourceTier: 'primary' as const, status: 'verified' as const, note: '' },
  ];
  const usable = assertableFacts(facts);
  assert.equal(usable.length, 1);
  assert.equal(usable[0]!.claim, 'b');
});

test('single-source claims are rendered with a hedge', () => {
  const rendered = renderClaim({
    topicId: 1, claim: 'It is 40% faster.', sourceUrl: 'u',
    sourceTier: 'reputable', status: 'single-source', note: '',
  });
  assert.ok(rendered.toLowerCase().includes('one source'));
});

test('stability is surfaced as an explicit fact', () => {
  const facts = extractFacts({
    topicId: 1,
    lead: storedItem({ summary: 'This is a stage 2 proposal, not shipped in v1.0.0 yet.' }),
    leadTier: 'primary',
    corroborators: [],
  });
  assert.ok(facts.some((f) => f.claim.toLowerCase().includes('stability')));
});

/* ---------------------------------------------------------------- angles */

const topic: Topic = {
  id: 1, itemId: 1, title: 'Announcing: React 19 ships the compiler',
  slug: 'react-19-compiler', summary: 'x', category: 'react',
  sourceKey: 'react-blog', sourceUrl: 'https://react.dev/a', sourceTier: 'primary',
  publishedAt: '2024-10-02T00:00:00Z', createdAt: '2024-10-02T00:00:00Z',
  status: 'new', corroborationUrls: [], rejectionReason: null,
};

function makeScore(over: Partial<TopicScore> = {}): TopicScore {
  return {
    topicId: 1, freshness: 50, relevance: 50, practicalValue: 50,
    discussionPotential: 50, educationalValue: 50, originality: 50, audienceFit: 50,
    total: 50, confidence: 50, linkedinScore: 50, mediumScore: 50, controversy: 50,
    audience: null, reasons: [], ...over,
  };
}

test('subjectOf reduces a headline sentence to a usable noun phrase', () => {
  // Each of these has to read correctly inside "Do we actually need ___?"
  assert.equal(subjectOf({ title: 'Announcing: React 19 ships the compiler' }), 'React 19');
  assert.equal(
    subjectOf({ title: 'Node.js v22.5.0 makes the permission model stable' }),
    'Node.js v22.5.0',
  );
  assert.equal(
    subjectOf({ title: 'INP replaced FID: what actually changed for Core Web Vitals' }),
    'INP',
  );
  assert.equal(
    subjectOf({ title: 'Do you really need a state management library in 2026?' }),
    'state management library in 2026',
  );
  assert.equal(
    subjectOf({ title: 'React Server Components and the hydration boundary, explained' }),
    'React Server Components and the hydration boundary',
  );
});

test('subjectOf falls back to the cleaned headline when nothing matches', () => {
  assert.equal(subjectOf({ title: 'Container queries everywhere' }), 'Container queries everywhere');
});

test('subjectOf never returns an empty string', () => {
  for (const title of ['Why', 'The', 'Announcing:', 'a', 'How to']) {
    assert.ok(subjectOf({ title }).length > 0, `empty subject for "${title}"`);
  }
});

test('exactly three angles are produced, one recommended', () => {
  const angles = generateAngles(topic, makeScore());
  assert.equal(angles.length, 3);
  assert.equal(angles.filter((a) => a.recommended).length, 1);
});

test('high debate scores push towards the opinion angle', () => {
  assert.equal(recommendAngle(makeScore({ discussionPotential: 98, controversy: 95 })), 'opinion');
});

test('high educational value pushes towards the educational angle', () => {
  assert.equal(
    recommendAngle(makeScore({ educationalValue: 98, freshness: 95, practicalValue: 10, audienceFit: 10, originality: 10 })),
    'educational',
  );
});

test('an unscored topic defaults to the engineering lesson', () => {
  assert.equal(recommendAngle(null), 'engineering-lesson');
});
