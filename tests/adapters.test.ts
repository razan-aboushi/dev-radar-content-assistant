import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rssAdapter, githubReleasesAdapter, hackerNewsAdapter, getAdapter } from '../src/sources/adapters';
import type { SourceConfig } from '../src/types';

const source: SourceConfig = {
  key: 'test', name: 'Test', url: 'https://example.com/feed', kind: 'rss',
  tier: 'primary', category: 'javascript', enabled: true, weight: 1,
};

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example</title>
  <item>
    <title>Node.js v22.0.0 released</title>
    <link>https://example.com/a</link>
    <guid>https://example.com/a</guid>
    <pubDate>Wed, 02 Oct 2024 13:00:00 GMT</pubDate>
    <description><![CDATA[<p>The <b>permission model</b> is now stable.</p>]]></description>
  </item>
  <item>
    <title>Too short</title>
    <link>https://example.com/b</link>
  </item>
  <item>
    <title>Missing a usable link entirely here</title>
    <link>not-a-url</link>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:example,2024:1</id>
    <title>V8 release v12.4 brings faster parsing</title>
    <link rel="edit" href="https://example.com/edit"/>
    <link rel="alternate" href="https://example.com/post"/>
    <updated>2024-10-02T13:00:00Z</updated>
    <summary>Some summary text about parsing performance.</summary>
    <author><name>The V8 team</name></author>
  </entry>
</feed>`;

test('rss adapter parses items and strips html from the summary', () => {
  const items = rssAdapter.validate(rssAdapter.normalize(RSS, source));
  const first = items[0]!;
  assert.equal(first.title, 'Node.js v22.0.0 released');
  assert.equal(first.url, 'https://example.com/a');
  assert.equal(first.summary, 'The permission model is now stable.');
  assert.ok(first.publishedAt?.startsWith('2024-10-02'));
});

test('rss adapter drops items with short titles or unusable urls', () => {
  const items = rssAdapter.validate(rssAdapter.normalize(RSS, source));
  assert.equal(items.length, 1);
});

test('atom adapter prefers rel=alternate over other links', () => {
  const items = rssAdapter.validate(rssAdapter.normalize(ATOM, source));
  assert.equal(items[0]!.url, 'https://example.com/post');
  assert.equal(items[0]!.author, 'The V8 team');
});

test('validate deduplicates by guid within one fetch', () => {
  const doubled = RSS.replace('</channel>', `<item>
    <title>Node.js v22.0.0 released</title>
    <link>https://example.com/a</link>
    <guid>https://example.com/a</guid>
  </item></channel>`);
  const items = rssAdapter.validate(rssAdapter.normalize(doubled, source));
  assert.equal(items.length, 1);
});

test('malformed xml does not throw', () => {
  assert.doesNotThrow(() => rssAdapter.normalize('<rss><channel><item>', source));
});

test('github releases adapter marks prereleases as experimental', () => {
  const raw = JSON.stringify({
    repo: 'nodejs/node',
    releases: [
      { id: 1, html_url: 'https://github.com/nodejs/node/releases/v1', tag_name: 'v22.0.0',
        name: 'Version 22.0.0', body: 'Stable release.', draft: false, prerelease: false,
        published_at: '2024-10-02T00:00:00Z', author: { login: 'nodejs-bot' } },
      { id: 2, html_url: 'https://github.com/nodejs/node/releases/v2', tag_name: 'v23.0.0-rc.1',
        name: null, body: null, draft: false, prerelease: true,
        published_at: '2024-10-03T00:00:00Z', author: null },
      { id: 3, html_url: 'https://github.com/nodejs/node/releases/v3', tag_name: 'draft',
        name: 'Draft', body: '', draft: true, prerelease: false, published_at: null, author: null },
    ],
  });
  const items = githubReleasesAdapter.validate(
    githubReleasesAdapter.normalize(raw, { ...source, kind: 'github-releases' }),
  );
  assert.equal(items.length, 2, 'drafts are excluded');
  assert.equal(items[0]!.extra.stability, 'stable');
  assert.equal(items[1]!.extra.stability, 'experimental');
});

test('hacker news adapter falls back to the discussion url', () => {
  const raw = JSON.stringify({
    hits: [{ objectID: '123', title: 'Ask HN: how do you test hydration?', story_title: null,
      url: null, story_url: null, points: 140, num_comments: 90,
      created_at: '2024-10-02T00:00:00Z', author: 'someone' }],
  });
  const items = hackerNewsAdapter.validate(
    hackerNewsAdapter.normalize(raw, { ...source, kind: 'hackernews' }),
  );
  assert.equal(items[0]!.url, 'https://news.ycombinator.com/item?id=123');
  assert.equal(items[0]!.extra.points, 140);
});

test('getAdapter throws for an unregistered kind', () => {
  assert.throws(() => getAdapter('nope' as never), /No adapter registered/);
});

/* ------------------------------------------------------------ source checks */

import { checkSource, registeredKinds } from '../src/sources/adapters';
import { loadSources } from '../src/config';

test('every source kind in the shipped config has a registered adapter', () => {
  // Guards against adding a source to config/sources.json with a kind that
  // nothing can fetch — the failure would otherwise appear only at run time.
  const kinds = new Set(loadSources().map((s) => s.kind));
  const registered = new Set(registeredKinds());
  for (const kind of kinds) {
    assert.ok(registered.has(kind), `no adapter registered for kind "${kind}"`);
  }
});

test('checkSource reports a failure instead of throwing when a source is unreachable', async () => {
  const result = await checkSource({
    ...source,
    key: 'unreachable',
    // Port 1 is never listening; this fails fast without touching the network.
    url: 'http://127.0.0.1:1/feed.xml',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.items, 0);
  assert.ok(result.detail.length > 0, 'a failure must explain itself');
});

test('checkSource covers every source kind, not just rss and atom', async () => {
  // The check command previously skipped github-releases, github-search and
  // hackernews, so four shipped sources were never actually tested by it.
  // Every kind must now return a real verdict rather than being passed over.
  for (const kind of registeredKinds()) {
    const result = await checkSource({
      ...source,
      key: `probe-${kind}`,
      kind: kind as typeof source.kind,
      url: 'http://127.0.0.1:1/probe',
    });
    assert.ok(
      ['ok', 'empty', 'failed'].includes(result.status),
      `kind "${kind}" produced no verdict`,
    );
  }
});

/* --------------------------------------------------------- failure messages */

import { describeFailure } from '../src/util/http';

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

test('an exhausted GitHub quota is reported as rate limiting, not as a bad URL', () => {
  // GitHub answers an exhausted quota with 403, so without this the message
  // reads as "forbidden" and sends you editing a URL that was never wrong.
  const message = describeFailure(
    {
      status: 403,
      headers: headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-limit': '60',
        'x-ratelimit-reset': '1787663369',
      }),
    },
    'https://api.github.com/repos/nodejs/node/releases',
  );
  assert.ok(message.includes('rate limited'), message);
  assert.ok(message.includes('The URL is fine'), message);
  assert.ok(message.includes('GITHUB_TOKEN'), 'should point at the fix');
  assert.ok(!message.startsWith('HTTP 403'));
});

test('a genuine 403 is still reported as a 403', () => {
  const message = describeFailure(
    { status: 403, headers: headers({}) },
    'https://example.com/feed.xml',
  );
  assert.ok(message.startsWith('HTTP 403'), message);
});

test('a 403 with quota remaining is not mistaken for rate limiting', () => {
  const message = describeFailure(
    { status: 403, headers: headers({ 'x-ratelimit-remaining': '42' }) },
    'https://api.github.com/x',
  );
  assert.ok(message.startsWith('HTTP 403'), message);
});

test('a 429 with retry-after reports the wait', () => {
  const message = describeFailure(
    { status: 429, headers: headers({ 'retry-after': '120' }) },
    'https://example.com/feed.xml',
  );
  assert.ok(message.includes('120s'), message);
});

test('the GitHub token hint only appears for GitHub URLs', () => {
  const message = describeFailure(
    {
      status: 429,
      headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1787663369' }),
    },
    'https://example.com/feed.xml',
  );
  assert.ok(message.includes('rate limited'), message);
  assert.ok(!message.includes('GITHUB_TOKEN'));
});

test('a missing reset header degrades to a vague time rather than NaN', () => {
  const message = describeFailure(
    { status: 403, headers: headers({ 'x-ratelimit-remaining': '0' }) },
    'https://example.com/x',
  );
  assert.ok(!message.includes('NaN'), message);
  assert.ok(message.includes('shortly'), message);
});
