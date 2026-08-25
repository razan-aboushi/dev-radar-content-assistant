import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHtml, decodeEntities, tokens, jaccard, dice, slugify,
  truncate, sentences, wordCount, countEmoji, toIsoDate, daysSince, clamp,
} from '../src/util/text';

test('stripHtml removes scripts entirely, not just tags', () => {
  const dirty = '<p>Hello</p><script>alert("x")</script><b>world</b>';
  const clean = stripHtml(dirty);
  assert.equal(clean, 'Hello world');
  assert.ok(!clean.includes('alert'));
});

test('stripHtml decodes the entities feeds actually use', () => {
  assert.equal(stripHtml('<p>a &amp; b &lt;c&gt; &#39;d&#39;</p>'), "a & b <c> 'd'");
});

test('decodeEntities handles hex and decimal numeric references', () => {
  assert.equal(decodeEntities('&#x2014;'), '\u2014');
  assert.equal(decodeEntities('&#8212;'), '\u2014');
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

test('tokens drops stop words and short tokens', () => {
  const result = tokens('The new Node.js release is a big one');
  assert.ok(!result.includes('the'));
  assert.ok(!result.includes('is'));
  assert.ok(result.includes('node.js'));
});

test('jaccard is 1 for identical sets and 0 for disjoint', () => {
  const a = new Set(['x', 'y']);
  assert.equal(jaccard(a, new Set(['x', 'y'])), 1);
  assert.equal(jaccard(a, new Set(['p', 'q'])), 0);
  assert.equal(jaccard(a, new Set()), 0);
});

test('dice is more forgiving than jaccard on unequal sizes', () => {
  const small = new Set(['react', 'hooks']);
  const large = new Set(['react', 'hooks', 'a', 'b', 'c', 'd', 'e', 'f']);
  assert.ok(dice(small, large) > jaccard(small, large));
});

test('slugify produces a stable url-safe stem', () => {
  assert.equal(slugify('Next.js 15: What Changed?!'), 'next.js-15-what-changed');
  assert.equal(slugify('!!!'), 'topic');
});

test('truncate never exceeds the limit and appends an ellipsis', () => {
  const result = truncate('a'.repeat(50), 20);
  assert.ok(result.length <= 21);
  assert.ok(result.endsWith('\u2026'));
  assert.equal(truncate('short', 20), 'short');
});

test('sentences splits on terminal punctuation only', () => {
  assert.deepEqual(sentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
});

test('wordCount handles empty and padded strings', () => {
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount(' a  b '), 2);
});

test('countEmoji counts pictographs', () => {
  assert.equal(countEmoji('no emoji here'), 0);
  assert.ok(countEmoji('nice \u{1F49B} work \u{1F680}') >= 2);
});

test('toIsoDate parses RFC822, ISO and epoch seconds', () => {
  assert.ok(toIsoDate('Wed, 02 Oct 2024 13:00:00 GMT')?.startsWith('2024-10-02'));
  assert.ok(toIsoDate('2024-10-02T13:00:00Z')?.startsWith('2024-10-02'));
  assert.ok(toIsoDate('1727874000')?.startsWith('2024-10-02'));
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate(undefined), null);
});

test('daysSince returns null for unparseable input', () => {
  assert.equal(daysSince(null), null);
  const now = Date.parse('2024-10-10T00:00:00Z');
  assert.equal(daysSince('2024-10-08T00:00:00Z', now), 2);
});

test('clamp bounds and handles NaN', () => {
  assert.equal(clamp(150), 100);
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(Number.NaN), 0);
});
