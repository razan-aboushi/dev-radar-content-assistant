/**
 * Seeds the database with a handful of realistic fixture items so you can see
 * the whole pipeline work before confirming that any real feed is reachable.
 *
 * This exists because the feed URLs in config/sources.json were written from
 * knowledge and never verified against the live web — see the README. Running
 * this proves the scoring, clustering, fact extraction and drafting all work,
 * independently of whether a given RSS URL still responds.
 *
 *   npm run demo
 *
 * Everything it inserts is clearly marked as fixture data via the demo- source
 * keys and can be removed by deleting data/radar.db.
 */
import { getDb } from '../src/db';
import { insertItems } from '../src/db/repositories';
import { buildTopics } from '../src/pipeline/run';
import type { NormalizedItem } from '../src/types';

const db = getDb();
const now = Date.now();
const daysAgo = (n: number): string => new Date(now - n * 86_400_000).toISOString();

const FIXTURES: NormalizedItem[] = [
  {
    sourceKey: 'nodejs-blog',
    guid: 'demo-node-1',
    title: 'Node.js v22.5.0 makes the permission model stable',
    url: 'https://nodejs.org/en/blog/release/v22.5.0',
    summary:
      'The permission model graduated to stable in v22.5.0. The team measured a 12% startup ' +
      'improvement in the release benchmark. This changes how you sandbox a production worker process.',
    publishedAt: daysAgo(1),
    author: null,
    extra: {},
  },
  {
    // Same story from a weaker source: exercises clustering and corroboration.
    sourceKey: 'javascript-weekly',
    guid: 'demo-jsw-1',
    title: 'Node.js v22.5.0 makes the permission model stable',
    url: 'https://javascriptweekly.com/issues/700',
    summary: 'Coverage of the v22.5.0 release and the stable permission model.',
    publishedAt: daysAgo(1),
    author: null,
    extra: {},
  },
  {
    sourceKey: 'react-blog',
    guid: 'demo-react-1',
    title: 'React Server Components and the hydration boundary, explained',
    url: 'https://react.dev/blog/rsc-hydration',
    summary:
      'A deep dive into how the server component payload is streamed and where hydration actually ' +
      'begins. Understanding this removes most of the confusion around the 2 common mismatch errors.',
    publishedAt: daysAgo(3),
    author: null,
    extra: {},
  },
  {
    // High engagement, no summary, community tier: exercises the fact gate.
    sourceKey: 'hn-frontend',
    guid: 'demo-hn-1',
    title: 'Do you really need a state management library in 2026?',
    url: 'https://news.ycombinator.com/item?id=99',
    summary: '',
    publishedAt: daysAgo(2),
    author: null,
    extra: { points: 480, comments: 320 },
  },
  {
    sourceKey: 'webdev',
    guid: 'demo-web-1',
    title: 'INP replaced FID: what actually changed for Core Web Vitals',
    url: 'https://web.dev/blog/inp-cwv',
    summary:
      'INP became a Core Web Vitals metric in March 2024. Most sites that passed FID at 100ms do ' +
      'not pass INP at 200ms. Here is how to profile and fix the long tasks causing it.',
    publishedAt: daysAgo(5),
    author: null,
    extra: {},
  },
  {
    sourceKey: 'github-security',
    guid: 'demo-sec-1',
    title: 'A malicious npm package impersonated a popular build tool for 3 days',
    url: 'https://github.blog/security/npm-typosquat',
    summary:
      'The package was downloaded 4200 times before removal. It shipped a postinstall script that ' +
      'exfiltrated environment variables. Check your lockfile.',
    publishedAt: daysAgo(1),
    author: null,
    extra: {},
  },
  {
    sourceKey: 'typescript-blog',
    guid: 'demo-ts-1',
    title: 'Why your tsconfig strict flag is probably not doing what you think',
    url: 'https://devblogs.microsoft.com/typescript/strict-flags',
    summary:
      'strict enables 8 separate checks. Most teams enable it and never look at ' +
      'noUncheckedIndexedAccess, which is not included. Here is what each flag actually does.',
    publishedAt: daysAgo(9),
    author: null,
    extra: {},
  },
];

const { inserted } = insertItems(db, FIXTURES);
const result = buildTopics(db);

process.stdout.write(
  `Seeded ${inserted.length} demo item(s) → ${result.topicsNew} new topic(s), ` +
    `${result.topicsRejected} rejected as repeats.\n\n` +
    `  npm run topics      see them ranked\n` +
    `  npm run daily       see the daily radar\n` +
    `  npm run dashboard   see all of it in the browser\n\n` +
    `This is fixture data, not live research. Delete data/radar.db to clear it.\n`,
);

db.close();
