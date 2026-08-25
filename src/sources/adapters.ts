import { XMLParser } from 'fast-xml-parser';
import { config } from '../config';
import { fetchJson, fetchText } from '../util/http';
import { stripHtml, toIsoDate, truncate } from '../util/text';
import type { NormalizedItem, SourceConfig } from '../types';

/**
 * A SourceAdapter turns one remote endpoint into NormalizedItem[].
 *
 *   fetch()     -> raw payload (string)
 *   normalize() -> NormalizedItem[]
 *   validate()  -> drop anything malformed
 *
 * New sources are added by registering an adapter here and adding an entry to
 * config/sources.json. No other file changes.
 */
export interface SourceAdapter {
  readonly kind: SourceConfig['kind'];
  fetch(source: SourceConfig): Promise<string>;
  normalize(raw: string, source: SourceConfig): NormalizedItem[];
  validate(items: NormalizedItem[]): NormalizedItem[];
}

const MAX_SUMMARY = 1200;

/** Shared validation. Anything without a usable title and absolute URL is dropped. */
function defaultValidate(items: NormalizedItem[]): NormalizedItem[] {
  const seen = new Set<string>();
  const out: NormalizedItem[] = [];
  for (const item of items) {
    const title = item.title.trim();
    if (title.length < 12 || title.length > 400) continue;
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const guid = item.guid.trim() || url.toString();
    if (seen.has(guid)) continue;
    seen.add(guid);
    out.push({
      ...item,
      title,
      url: url.toString(),
      guid,
      summary: truncate(item.summary.trim(), MAX_SUMMARY),
    });
  }
  return out;
}

/* --------------------------------------------------------------- RSS / Atom */

/**
 * `processEntities: true` applies fast-xml-parser's default budget of 1000
 * entity expansions per document. Real feeds blow straight through that on
 * ordinary content — every `&amp;` and `&#8217;` counts — and the V8 blog,
 * JavaScript Weekly and Node Weekly all failed to parse with "Entity expansion
 * limit exceeded: 1241 > 1000".
 *
 * The budget is raised to a level no honest feed reaches, while the limits that
 * actually stop a billion-laughs attack — expansion depth and total expanded
 * length — stay bounded. Depth is the vector; a flat count of predefined
 * entities is not.
 */
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  processEntities: {
    enabled: true,
    maxTotalExpansions: 200_000,
    maxExpandedLength: 5_000_000,
    maxExpansionDepth: 10,
  },
} as ConstructorParameters<typeof XMLParser>[0]);

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Feed fields are sometimes strings, sometimes `{ '#text': '...' }`. */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['#text'] === 'string') return record['#text'];
    if (typeof record['@_href'] === 'string') return record['@_href'];
  }
  return '';
}

/** Atom entries carry several <link> elements; prefer rel="alternate". */
function atomLink(entry: Record<string, unknown>): string {
  const links = asArray(entry.link as unknown);
  for (const link of links) {
    if (typeof link === 'object' && link !== null) {
      const record = link as Record<string, unknown>;
      const rel = String(record['@_rel'] ?? 'alternate');
      if (rel === 'alternate' && typeof record['@_href'] === 'string') return record['@_href'];
    }
  }
  const first = links[0];
  return typeof first === 'string' ? first : text(first);
}

export const rssAdapter: SourceAdapter = {
  kind: 'rss',

  fetch(source) {
    return fetchText(source.url);
  },

  normalize(raw, source) {
    const parsed = xml.parse(raw) as Record<string, unknown>;
    const items: NormalizedItem[] = [];

    // RSS 2.0
    const channel = (parsed.rss as Record<string, unknown> | undefined)?.channel as
      | Record<string, unknown>
      | undefined;
    for (const entry of asArray<Record<string, unknown>>(channel?.item as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const link = text(entry.link) || text(entry.guid);
      items.push({
        sourceKey: source.key,
        guid: text(entry.guid) || link,
        title: stripHtml(text(entry.title)),
        url: link,
        summary: stripHtml(
          text(entry['content:encoded']) || text(entry.description) || text(entry.summary),
        ),
        publishedAt: toIsoDate(text(entry.pubDate) || text(entry['dc:date'])),
        author: stripHtml(text(entry['dc:creator']) || text(entry.author)) || null,
        extra: { feedKind: 'rss' },
      });
    }

    // Atom
    const feed = parsed.feed as Record<string, unknown> | undefined;
    for (const entry of asArray<Record<string, unknown>>(feed?.entry as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const link = atomLink(entry);
      items.push({
        sourceKey: source.key,
        guid: text(entry.id) || link,
        title: stripHtml(text(entry.title)),
        url: link,
        summary: stripHtml(text(entry.content) || text(entry.summary)),
        publishedAt: toIsoDate(text(entry.updated) || text(entry.published)),
        author: stripHtml(text((entry.author as Record<string, unknown> | undefined)?.name)) || null,
        extra: { feedKind: 'atom' },
      });
    }

    // RDF / RSS 1.0
    const rdf = parsed['rdf:RDF'] as Record<string, unknown> | undefined;
    for (const entry of asArray<Record<string, unknown>>(rdf?.item as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const link = text(entry.link);
      items.push({
        sourceKey: source.key,
        guid: text(entry['@_rdf:about']) || link,
        title: stripHtml(text(entry.title)),
        url: link,
        summary: stripHtml(text(entry.description)),
        publishedAt: toIsoDate(text(entry['dc:date'])),
        author: null,
        extra: { feedKind: 'rdf' },
      });
    }

    return items;
  },

  validate: defaultValidate,
};

/** Atom is handled by the same parser; kept as a distinct kind for clarity in config. */
export const atomAdapter: SourceAdapter = { ...rssAdapter, kind: 'atom' };

/* ------------------------------------------------------------------- GitHub */

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (config.github.token) headers.authorization = `Bearer ${config.github.token}`;
  return headers;
}

interface GithubRelease {
  id: number;
  html_url: string;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  author: { login: string } | null;
}

/**
 * Automated per-commit builds. Next.js publishes dozens of canaries a week with
 * generated changelogs, and they crowded out everything else: three of the four
 * daily recommendations on a live run were consecutive canary tags of the same
 * release. They are dropped by tag rather than by the `prerelease` flag,
 * because a real beta or release candidate — TypeScript's `v6.0-rc`, tc39's
 * `es2026-candidate` — is worth writing about and carries the same flag.
 */
const AUTOMATED_BUILD_TAG = /-(?:canary|nightly|dev|experimental|insiders)[.-]/i;

/**
 * Release notes for a repo. source.url is "owner/repo".
 * Unauthenticated this endpoint allows 60 req/hour, which covers the defaults.
 */
export const githubReleasesAdapter: SourceAdapter = {
  kind: 'github-releases',

  async fetch(source) {
    const repo = source.url.replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
    // 30 rather than 10: a repo that publishes canaries daily can fill the
    // first ten slots with builds that are about to be filtered out. Page size
    // does not affect the rate limit.
    const releases = await fetchJson<GithubRelease[]>(
      `https://api.github.com/repos/${repo}/releases?per_page=30`,
      { headers: githubHeaders() },
    );
    return JSON.stringify({ repo, releases });
  },

  normalize(raw, source) {
    const { repo, releases } = JSON.parse(raw) as { repo: string; releases: GithubRelease[] };
    return releases
      .filter((release) => !release.draft && !AUTOMATED_BUILD_TAG.test(release.tag_name))
      .map((release) => ({
        sourceKey: source.key,
        guid: `gh-release:${repo}:${release.id}`,
        title: `${repo} ${release.name?.trim() || release.tag_name}`,
        url: release.html_url,
        summary: stripHtml(release.body ?? ''),
        publishedAt: toIsoDate(release.published_at),
        author: release.author?.login ?? null,
        extra: {
          repo,
          tag: release.tag_name,
          prerelease: release.prerelease,
          stability: release.prerelease ? 'experimental' : 'stable',
        },
      }));
  },

  validate: defaultValidate,
};

interface GithubSearchResponse {
  items: Array<{
    id: number;
    full_name: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
    language: string | null;
    pushed_at: string;
    created_at: string;
    license: { spdx_id: string | null } | null;
  }>;
}

/**
 * Repository search, used as a free stand-in for "GitHub trending" (which has
 * no official API). source.query holds the search qualifiers.
 */
export const githubSearchAdapter: SourceAdapter = {
  kind: 'github-search',

  async fetch(source) {
    const query = source.query ?? 'stars:>500 pushed:>2024-01-01';
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=15`;
    return JSON.stringify(await fetchJson<GithubSearchResponse>(url, { headers: githubHeaders() }));
  },

  normalize(raw, source) {
    const parsed = JSON.parse(raw) as GithubSearchResponse;
    return (parsed.items ?? []).map((repo) => ({
      sourceKey: source.key,
      guid: `gh-repo:${repo.id}`,
      title: repo.full_name,
      url: repo.html_url,
      summary: stripHtml(repo.description ?? ''),
      publishedAt: toIsoDate(repo.created_at),
      author: repo.full_name.split('/')[0] ?? null,
      extra: {
        stars: repo.stargazers_count,
        language: repo.language,
        license: repo.license?.spdx_id ?? null,
        pushedAt: repo.pushed_at,
        isRepo: true,
      },
    }));
  },

  validate(items) {
    // Repo names are short; relax the title length floor for this adapter only.
    return defaultValidate(items.map((i) => ({ ...i, title: `${i.title} — GitHub project` })));
  },
};

/* ------------------------------------------------------- Hacker News (free) */

interface AlgoliaResponse {
  hits: Array<{
    objectID: string;
    title: string | null;
    story_title: string | null;
    url: string | null;
    story_url: string | null;
    points: number | null;
    num_comments: number | null;
    created_at: string;
    author: string | null;
  }>;
}

/**
 * HN via the free Algolia API. Treated as a discovery signal only: tier is
 * "community" in config, so the scorer will not accept it as a factual source.
 */
export const hackerNewsAdapter: SourceAdapter = {
  kind: 'hackernews',

  /**
   * Algolia has no OR operator in `query`: the words are ANDed, and a literal
   * "OR" is matched as a word of its own. The configured multi-term queries
   * therefore returned zero hits every time — both HN sources were dead.
   *
   * `optionalWords` is the supported way to say "any of these": the terms stay
   * in the query for ranking, but a story only has to match some of them.
   */
  async fetch(source) {
    const query = (source.query ?? 'javascript').replace(/\bOR\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const since = Math.floor((Date.now() - 7 * 86_400_000) / 1000);
    const url =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}` +
      `&optionalWords=${encodeURIComponent(query)}` +
      `&tags=story&numericFilters=created_at_i>${since},points>60&hitsPerPage=20`;
    return JSON.stringify(await fetchJson<AlgoliaResponse>(url));
  },

  normalize(raw, source) {
    const parsed = JSON.parse(raw) as AlgoliaResponse;
    return (parsed.hits ?? [])
      .map((hit) => {
        const url = hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`;
        return {
          sourceKey: source.key,
          guid: `hn:${hit.objectID}`,
          title: stripHtml(hit.title ?? hit.story_title ?? ''),
          url,
          summary: '',
          publishedAt: toIsoDate(hit.created_at),
          author: hit.author,
          extra: {
            points: hit.points ?? 0,
            comments: hit.num_comments ?? 0,
            discussionUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          },
        };
      })
      .filter((item) => item.title.length > 0);
  },

  validate: defaultValidate,
};

/* ----------------------------------------------------------------- registry */

const ADAPTERS: Record<SourceConfig['kind'], SourceAdapter> = {
  rss: rssAdapter,
  atom: atomAdapter,
  'github-releases': githubReleasesAdapter,
  'github-search': githubSearchAdapter,
  hackernews: hackerNewsAdapter,
};

export function getAdapter(kind: SourceConfig['kind']): SourceAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`No adapter registered for source kind "${kind}"`);
  return adapter;
}

export function registeredKinds(): string[] {
  return Object.keys(ADAPTERS);
}

/* ------------------------------------------------------------ liveness check */

export interface SourceCheck {
  readonly key: string;
  readonly status: 'ok' | 'empty' | 'failed' | 'unparseable';
  readonly detail: string;
  readonly items: number;
}

/**
 * Probes a single source by running the real fetch → normalize → validate
 * chain and reporting how many usable items came back.
 *
 * An earlier version only probed rss and atom sources, and skipped
 * github-releases, github-search and hackernews with "checked at fetch time".
 * That meant four of the shipped sources were never tested by the command whose
 * entire job is testing sources. Running the whole chain also catches more than
 * a liveness ping would: a feed that responds 200 with markup the adapter
 * cannot parse is broken for our purposes, and this reports it as empty rather
 * than ok.
 *
 * Costs one real request per source, which is what the command advertises.
 */
export async function checkSource(source: SourceConfig): Promise<SourceCheck> {
  let adapter: SourceAdapter;
  try {
    adapter = getAdapter(source.kind);
  } catch (error) {
    return {
      key: source.key,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      items: 0,
    };
  }

  let raw: string;
  try {
    raw = await adapter.fetch(source);
  } catch (error) {
    return {
      key: source.key,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      items: 0,
    };
  }

  // Reported separately from a fetch failure. Three feeds that answered 200
  // with perfectly good XML were being listed as "could not be reached", which
  // sends you off checking your network instead of the parser.
  let items: NormalizedItem[];
  try {
    items = adapter.validate(adapter.normalize(raw, source));
  } catch (error) {
    return {
      key: source.key,
      status: 'unparseable',
      detail: `responded (${raw.length} bytes) but the adapter could not parse it: ${
        error instanceof Error ? error.message : String(error)
      }`,
      items: 0,
    };
  }

  if (items.length === 0) {
    return {
      key: source.key,
      status: 'empty',
      detail: `responded (${raw.length} bytes) but produced no usable items`,
      items: 0,
    };
  }
  return {
    key: source.key,
    status: 'ok',
    detail: `${items.length} item(s), latest: ${truncate(items[0]!.title, 44)}`,
    items: items.length,
  };
}
