import { clamp, daysSince } from '../util/text';
import type {
  AudienceInterest,
  Category,
  InterestBand,
  InterestEvidence,
  SourceTier,
  StoredItem,
} from '../types';

export type { AudienceInterest, InterestBand, InterestEvidence };

/**
 * "How many people will care about this?"
 *
 * That is the question a content creator actually asks, and it is the one the
 * TOPIC SCORE does not answer — a topic can be a perfect fit for your readers
 * and still be something nobody is talking about.
 *
 * The honest constraint: nobody can know how many people will read your post.
 * So nothing here is invented. Every input is either a real number that real
 * people generated, or a weight written down in config where you can see and
 * change it:
 *
 *   engagement   Hacker News points and comments, GitHub stars. Actual humans.
 *   syndication  How many independent outlets carried the story. If five
 *                publications covered it, five editors judged it newsworthy.
 *   sourceReach  The audience size of the outlets involved, from
 *                config/sources.json. The Node.js blog reaches more developers
 *                than a personal newsletter, and that is a fact about the
 *                outlet, not about the story.
 *   demand       How large the developer audience is for the subject area.
 *                React has more practitioners than SMIL animation.
 *   recency      Attention decays. A three-week-old story has had its moment.
 *
 * The output is a 0–100 score, a plain-language band, an order-of-magnitude
 * reach range, and the evidence list that produced it. The evidence is shown in
 * the dashboard so the number is never a black box: if it says 82, you can see
 * that it is 82 because 480 people upvoted it on Hacker News and four outlets
 * covered it.
 *
 * Treat the reach range as what it is — a modelled estimate with a wide band,
 * not a measurement. The evidence lines above it are the measurements.
 */

/**
 * Roughly how many working developers touch each area. Used to separate "lots
 * of people could care about this" from "this is excellent but for 200 people".
 *
 * These are judgement calls, deliberately written down here rather than buried
 * in a formula, so disagreeing with one is a one-line edit.
 */
const CATEGORY_DEMAND: Record<Category, number> = {
  javascript: 5,
  typescript: 5,
  react: 5,
  nodejs: 5,
  'ai-for-developers': 5,
  security: 5,
  nextjs: 4,
  frontend: 4,
  backend: 4,
  performance: 4,
  'web-platform': 4,
  'css-html': 4,
  apis: 4,
  databases: 4,
  devtools: 4,
  npm: 4,
  architecture: 3,
  testing: 3,
  'software-engineering': 3,
  'open-source': 3,
  seo: 3,
  productivity: 2,
  career: 2,
};

export interface InterestInput {
  category: Category;
  publishedAt: string | null;
  sourceTier: SourceTier;
  /** Every item in the cluster, so engagement is read from the real payloads. */
  members: StoredItem[];
  /** Audience-size weight (1–5) for each member's source, from config. */
  reachOf: (sourceKey: string) => number;
  now?: number;
}

/** Reads the engagement numbers an adapter stored, defensively. */
function readNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface Engagement {
  points: number;
  comments: number;
  stars: number;
}

function collectEngagement(members: StoredItem[]): Engagement {
  let points = 0;
  let comments = 0;
  let stars = 0;
  for (const item of members) {
    // The best-performing member represents the story, rather than a sum that
    // would double-count the same discussion appearing twice.
    points = Math.max(points, readNumber(item.extra.points));
    comments = Math.max(comments, readNumber(item.extra.comments));
    stars = Math.max(stars, readNumber(item.extra.stars));
  }
  return { points, comments, stars };
}

/**
 * Engagement is log-scaled. 500 upvotes is not ten times more meaningful than
 * 50 — it is roughly twice as meaningful, which is what a log curve says.
 *
 * A comment is weighted above an upvote because writing one costs more.
 */
function engagementScore(engagement: Engagement): number {
  const weighted = engagement.points + engagement.comments * 2 + engagement.stars / 12;
  if (weighted <= 0) return 0;
  // log10(1000) = 3, so ~1000 weighted interactions saturates the component.
  return clamp((Math.log10(weighted + 1) / 3) * 100);
}

/**
 * Independent outlets carrying the same story. The strongest available signal
 * that an industry, not just one blogger, thinks something happened.
 */
function syndicationScore(distinctSources: number): number {
  if (distinctSources <= 1) return 20;
  return clamp(20 + (distinctSources - 1) * 22);
}

function reachScore(members: StoredItem[], reachOf: (key: string) => number): number {
  const keys = [...new Set(members.map((item) => item.sourceKey))];
  if (keys.length === 0) return 40;
  const best = Math.max(...keys.map((key) => clamp(reachOf(key), 1, 5)));
  return ((best - 1) / 4) * 100;
}

function demandScore(category: Category): number {
  const demand = CATEGORY_DEMAND[category] ?? 3;
  return ((demand - 1) / 4) * 100;
}

/** Attention decay, gentler than freshness: a good story stays interesting. */
function recencyScore(publishedAt: string | null, now: number): number {
  const days = daysSince(publishedAt, now);
  if (days === null) return 55;
  if (days < 0) return 90;
  return clamp(100 * 0.5 ** (days / 14));
}

const WEIGHTS = {
  engagement: 0.30,
  syndication: 0.22,
  reach: 0.20,
  demand: 0.20,
  recency: 0.08,
} as const;

function bandOf(score: number): InterestBand {
  if (score >= 72) return 'major';
  if (score >= 55) return 'broad';
  if (score >= 36) return 'growing';
  return 'niche';
}

/**
 * Order-of-magnitude ranges per band. Wide, because the honest error bar is
 * wide. These describe developers plausibly reached across the outlets the
 * radar tracks, not readers of your post.
 */
const BAND_REACH: Record<InterestBand, [number, number]> = {
  niche: [100, 1_000],
  growing: [1_000, 10_000],
  broad: [10_000, 60_000],
  major: [60_000, 250_000],
};

export function scoreAudienceInterest(input: InterestInput): AudienceInterest {
  const now = input.now ?? Date.now();
  const engagement = collectEngagement(input.members);
  const distinctSources = new Set(input.members.map((item) => item.sourceKey)).size;

  const parts = {
    engagement: engagementScore(engagement),
    syndication: syndicationScore(distinctSources),
    reach: reachScore(input.members, input.reachOf),
    demand: demandScore(input.category),
    recency: recencyScore(input.publishedAt, now),
  };

  const score = Math.round(
    (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).reduce(
      (sum, key) => sum + parts[key] * WEIGHTS[key],
      0,
    ),
  );

  const band = bandOf(score);
  const [reachMin, reachMax] = BAND_REACH[band];

  // Only facts go in here. If a number was not measured, it is not claimed.
  // Structured rather than prose, so the dashboard can say it in Arabic.
  const evidence: InterestEvidence[] = [];
  if (engagement.points > 0 || engagement.comments > 0) {
    evidence.push({
      code: 'hackerNews',
      params: { points: engagement.points, comments: engagement.comments },
    });
  }
  if (engagement.stars > 0) {
    evidence.push({ code: 'stars', params: { count: engagement.stars } });
  }
  evidence.push(
    distinctSources > 1
      ? { code: 'sources', params: { count: distinctSources } }
      : { code: 'oneSource' },
  );
  evidence.push({
    code: 'demand',
    params: { category: input.category.replace(/-/g, ' '), level: demandLabel(input.category) },
  });
  if (engagement.points === 0 && engagement.comments === 0 && engagement.stars === 0) {
    evidence.push({ code: 'noEngagement' });
  }

  return { score: clamp(score), band, reachMin, reachMax, evidence };
}

/** Bucket name for the category's audience size. Translated in the dashboard. */
export type DemandLevel = 'veryWide' | 'wide' | 'moderate' | 'specialised';

function demandLabel(category: Category): DemandLevel {
  const demand = CATEGORY_DEMAND[category] ?? 3;
  if (demand >= 5) return 'veryWide';
  if (demand >= 4) return 'wide';
  if (demand >= 3) return 'moderate';
  return 'specialised';
}

/** Exposed so the dashboard and tests agree on the thresholds. */
export const INTEREST_BANDS: readonly InterestBand[] = ['niche', 'growing', 'broad', 'major'];
