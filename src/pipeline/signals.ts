import type { Category } from '../types';

/**
 * Keyword dictionaries. These are the entire "understanding" layer when no LLM
 * is configured, so they are deliberately explicit and easy to tune.
 *
 * Matching is done on the normalised token stream plus raw-substring checks for
 * multi-word phrases.
 */

export const CATEGORY_KEYWORDS: Record<Category, string[]> = {
  javascript: ['javascript', 'ecmascript', 'tc39', 'es2024', 'es2025', 'es2026', 'v8', 'jsc', 'spidermonkey', 'proposal', 'temporal', 'iterator helpers'],
  typescript: ['typescript', 'tsc', 'type inference', 'generics', 'satisfies', 'tsconfig', 'declaration files', 'type narrowing'],
  nodejs: ['node.js', 'nodejs', 'npm run', 'libuv', 'worker_threads', 'esm', 'commonjs', 'node --', 'permission model', 'node test runner'],
  react: ['react', 'jsx', 'hooks', 'usestate', 'useeffect', 'server components', 'suspense', 'concurrent', 'reconciler', 'react compiler'],
  nextjs: ['next.js', 'nextjs', 'app router', 'pages router', 'server actions', 'turbopack', 'isr', 'ssg', 'middleware', 'route handler'],
  frontend: ['frontend', 'front-end', 'browser', 'ui', 'component', 'hydration', 'client-side', 'spa', 'bundler'],
  backend: ['backend', 'back-end', 'server', 'microservice', 'queue', 'worker', 'cron', 'rpc', 'grpc'],
  'web-platform': ['web platform', 'whatwg', 'w3c', 'baseline', 'browser support', 'web api', 'chrome', 'firefox', 'safari', 'webkit', 'interop'],
  'css-html': ['css', 'html', 'flexbox', 'grid', 'container queries', 'selector', 'cascade layers', 'anchor positioning', 'view transitions'],
  performance: ['performance', 'core web vitals', 'lcp', 'inp', 'cls', 'ttfb', 'lighthouse', 'bundle size', 'code splitting', 'memory leak', 'profiling', 'benchmark', 'faster', 'latency'],
  seo: ['seo', 'crawl', 'indexing', 'canonical', 'hreflang', 'structured data', 'search console', 'sitemap', 'robots.txt', 'googlebot', 'rich results'],
  apis: ['api', 'rest', 'graphql', 'openapi', 'webhook', 'endpoint', 'rate limit', 'pagination', 'json schema'],
  databases: ['database', 'sql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'index', 'query plan', 'orm', 'migration'],
  architecture: ['architecture', 'monolith', 'microservice', 'design pattern', 'coupling', 'boundaries', 'refactor', 'system design', 'scalability', 'technical debt'],
  security: ['security', 'vulnerability', 'cve', 'exploit', 'xss', 'csrf', 'supply chain', 'malicious package', 'auth', 'oauth', 'token leak', 'patch'],
  testing: ['testing', 'unit test', 'integration test', 'e2e', 'vitest', 'jest', 'playwright', 'coverage', 'flaky', 'mocking'],
  devtools: ['devtools', 'tooling', 'bundler', 'vite', 'webpack', 'esbuild', 'rollup', 'turbopack', 'linter', 'eslint', 'formatter', 'compiler', 'build time'],
  'ai-for-developers': ['ai', 'llm', 'copilot', 'code generation', 'agent', 'prompt', 'vibe coding', 'ai-assisted', 'model', 'chatgpt', 'claude'],
  productivity: ['productivity', 'workflow', 'developer experience', 'dx', 'automation', 'shortcut', 'focus', 'code review'],
  'open-source': ['open source', 'oss', 'maintainer', 'contributor', 'license', 'fork', 'governance', 'sponsorship'],
  npm: ['npm', 'package', 'registry', 'dependency', 'semver', 'lockfile', 'pnpm', 'yarn', 'node_modules', 'peer dependency'],
  career: ['career', 'interview', 'promotion', 'senior engineer', 'hiring', 'job', 'salary', 'mentorship', 'burnout', 'growth'],
  'software-engineering': ['engineering', 'production', 'incident', 'postmortem', 'debugging', 'root cause', 'code quality', 'maintainability', 'lesson', 'best practice'],
};

/**
 * Razan's focus areas, in two tiers. Together they drive audienceFit, and they
 * are the first thing to edit if the radar keeps surfacing the wrong subjects.
 *
 * CORE terms are specific to web and JavaScript work. A hit is real evidence
 * the topic is for her readers.
 */
const CORE_FOCUS: string[] = [
  // Frameworks and runtimes
  'react', 'next.js', 'nextjs', 'javascript', 'typescript', 'node.js', 'nodejs',
  'vue', 'svelte', 'angular', 'deno', 'bun',
  // Rendering and the React model
  'frontend', 'ssr', 'hydration', 'server components', 'server actions',
  'app router', 'suspense', 'code splitting',
  // Performance measurement
  'core web vitals', 'web vitals', 'lcp', 'inp', 'cls', 'lighthouse',
  'bundle', 'bundler', 'tree shaking',
  // Search
  'seo', 'canonical', 'crawl', 'indexing', 'sitemap', 'structured data',
  // The platform itself
  'web platform', 'browser', 'chrome', 'safari', 'firefox', 'webkit',
  'css', 'html', 'tailwind', 'flexbox', 'accessibility', 'a11y',
  'service worker', 'web component',
  // Packaging and tooling
  'npm', 'pnpm', 'yarn', 'lockfile', 'tsconfig', 'esm', 'commonjs',
  'vite', 'webpack', 'esbuild', 'turbopack',
  'vitest', 'playwright', 'jest', 'graphql',
];

/**
 * BROAD terms are genuine focus areas that almost any technical article also
 * matches. They are not evidence on their own: an Apple silicon launch ranked
 * first on a live run because "a big leap in performance and AI compute" hit
 * two of them and counted the same as two hits on "react" and "hydration". A
 * broad hit is worth roughly a third of a core hit.
 */
const BROAD_FOCUS_TERMS: string[] = [
  'performance', 'api', 'production', 'debugging', 'ai', 'developer experience',
  'memory leak', 'rendering', 'routing', 'streaming', 'dependency', 'testing',
  'security',
];

export const AUDIENCE_FOCUS: string[] = [...CORE_FOCUS, ...BROAD_FOCUS_TERMS];

export const BROAD_FOCUS: ReadonlySet<string> = new Set(BROAD_FOCUS_TERMS);

/** Splits focus hits into the specific ones and the ones anything can match. */
export function splitFocusHits(hits: string[]): { core: string[]; broad: string[] } {
  return {
    core: hits.filter((hit) => !BROAD_FOCUS.has(hit)),
    broad: hits.filter((hit) => BROAD_FOCUS.has(hit)),
  };
}

/** Signals that a topic gives the reader something they can act on. */
export const PRACTICAL_SIGNALS: string[] = [
  'how to', 'guide', 'fix', 'fixes', 'workaround', 'migration', 'migrate',
  'upgrade', 'breaking change', 'deprecated', 'deprecation', 'gotcha', 'pitfall',
  'mistake', 'anti-pattern', 'checklist', 'step by step', 'in practice',
  'production', 'real world', 'debugging', 'root cause', 'performance',
  'security', 'patch', 'cve', 'regression', 'best practice', 'tips',
];

/** Signals that developers will actually argue about it in the comments. */
export const DISCUSSION_SIGNALS: string[] = [
  ' vs ', 'versus', 'should you', 'do you really need', "don't need", 'stop using',
  'is dead', 'considered harmful', 'controversial', 'debate', 'unpopular',
  'why i left', 'why we moved', 'rewrite', 'overrated', 'underrated', 'myth',
  'wrong', 'mistake', 'hot take', 'opinion', 'rant', 'tradeoff', 'trade-off',
];

/** Signals that there is enough substance for a long-form article. */
export const EDUCATIONAL_SIGNALS: string[] = [
  'deep dive', 'under the hood', 'internals', 'how it works', 'explained',
  'understanding', 'introduction to', 'complete guide', 'anatomy of',
  'behind the scenes', 'from scratch', 'architecture', 'algorithm',
  'walkthrough', 'tutorial', 'concept', 'fundamentals', 'why',
];

/** Release-note style words indicating hard, citable facts exist. */
export const RELEASE_SIGNALS: string[] = [
  'release', 'released', 'launch', 'announcing', 'now available', 'ships',
  'v1', 'v2', 'v3', 'rc', 'beta', 'alpha', 'stable', 'lts', 'general availability',
];

/** Words that flag an unverified or provisional status. */
export const STABILITY_SIGNALS: Record<string, 'stable' | 'experimental' | 'proposal' | 'deprecated'> = {
  stable: 'stable',
  ga: 'stable',
  lts: 'stable',
  experimental: 'experimental',
  flag: 'experimental',
  unflagged: 'experimental',
  canary: 'experimental',
  beta: 'experimental',
  alpha: 'experimental',
  rc: 'experimental',
  proposal: 'proposal',
  'stage 1': 'proposal',
  'stage 2': 'proposal',
  'stage 3': 'proposal',
  'stage 4': 'stable',
  draft: 'proposal',
  deprecated: 'deprecated',
  'end-of-life': 'deprecated',
  eol: 'deprecated',
  removed: 'deprecated',
};

/** Low-value noise we do not want on the radar at all. */
export const NOISE_SIGNALS: string[] = [
  'sponsored', 'webinar', 'sign up now', 'discount', 'black friday',
  'hiring now', 'newsletter issue', 'top 10 vscode themes', 'best laptop',
  'crypto', 'nft', 'giveaway',
];

const PHRASE_RE_CACHE = new Map<string, RegExp>();

/**
 * Phrases match at word edges only.
 *
 * Plain substring matching fired short entries inside unrelated words: "ai"
 * matched "explained" and "maintainers", "api" matched "rapid", "ui" matched
 * "building", and "rc" matched "search" and "architecture". A Rust article
 * about maintainers collected three bogus focus keywords that way and scored
 * 56 — over the default shortlist threshold of 55.
 *
 * A word edge is any non-alphanumeric character, so "ai-assisted", "node.js's"
 * and "v22.5.0" still match the phrases they should.
 */
function phraseRegex(phrase: string): RegExp {
  let cached = PHRASE_RE_CACHE.get(phrase);
  if (!cached) {
    const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cached = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
    PHRASE_RE_CACHE.set(phrase, cached);
  }
  return cached;
}

/** True when `phrase` occurs in `haystack` as a whole word or phrase. */
export function matchesPhrase(haystack: string, phrase: string): boolean {
  return phraseRegex(phrase).test(haystack);
}

/**
 * Count how many phrases from `dictionary` appear in `haystack`.
 * `haystack` must already be lowercased and space-padded.
 */
export function countSignals(haystack: string, dictionary: string[]): number {
  let hits = 0;
  for (const phrase of dictionary) {
    if (matchesPhrase(haystack, phrase)) hits += 1;
  }
  return hits;
}

export function matchedSignals(haystack: string, dictionary: string[]): string[] {
  return dictionary.filter((phrase) => matchesPhrase(haystack, phrase));
}

/** Pads and lowercases so ' vs ' style phrases match at string edges. */
export function haystack(...parts: string[]): string {
  return ` ${parts.join(' ').toLowerCase().replace(/\s+/g, ' ')} `;
}

/** Best-guess category from text, falling back to the source's default. */
export function detectCategory(text: string, fallback: Category): Category {
  const hay = haystack(text);
  let best: Category = fallback;
  let bestScore = 0;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as Array<[Category, string[]]>) {
    let score = 0;
    for (const keyword of keywords) {
      if (matchesPhrase(hay, keyword)) score += keyword.includes(' ') ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return bestScore === 0 ? fallback : best;
}

export function detectStability(text: string): 'stable' | 'experimental' | 'proposal' | 'deprecated' | null {
  const hay = haystack(text);
  for (const [word, stability] of Object.entries(STABILITY_SIGNALS)) {
    if (matchesPhrase(hay, word)) return stability;
  }
  return null;
}
