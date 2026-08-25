/**
 * Core domain types. Everything crossing a module boundary is typed here so the
 * pipeline stages stay decoupled from each other and from storage.
 */

export type Category =
  | 'javascript'
  | 'typescript'
  | 'nodejs'
  | 'react'
  | 'nextjs'
  | 'frontend'
  | 'backend'
  | 'web-platform'
  | 'css-html'
  | 'performance'
  | 'seo'
  | 'apis'
  | 'databases'
  | 'architecture'
  | 'security'
  | 'testing'
  | 'devtools'
  | 'ai-for-developers'
  | 'productivity'
  | 'open-source'
  | 'npm'
  | 'career'
  | 'software-engineering';

export const CATEGORIES: readonly Category[] = [
  'javascript', 'typescript', 'nodejs', 'react', 'nextjs', 'frontend', 'backend',
  'web-platform', 'css-html', 'performance', 'seo', 'apis', 'databases',
  'architecture', 'security', 'testing', 'devtools', 'ai-for-developers',
  'productivity', 'open-source', 'npm', 'career', 'software-engineering',
] as const;

/**
 * The languages the tool speaks. Used for two independent things: the language
 * the dashboard is displayed in, and the language a draft is written in.
 */
export type Language = 'en' | 'ar';

/** How much a source is trusted for factual claims. Drives verification. */
export type SourceTier = 'primary' | 'reputable' | 'community';

export type SourceKind = 'rss' | 'atom' | 'github-releases' | 'github-search' | 'hackernews';

export interface SourceConfig {
  key: string;
  name: string;
  url: string;
  kind: SourceKind;
  tier: SourceTier;
  /** Default category for items that carry no better signal. */
  category: Category;
  enabled: boolean;
  /** 0.5–1.5. Multiplies relevance; primary sources sit above 1. */
  weight: number;
  /**
   * 1–5. How large this outlet's developer audience is, used by audience
   * interest scoring. Independent of `weight`, which is about topical fit:
   * a niche newsletter can be highly relevant to you and still small.
   * Defaults to 3 when absent.
   */
  reach?: number;
  /** github-search only. */
  query?: string;
}

/** A raw article after an adapter has normalised it. Not yet a topic. */
export interface NormalizedItem {
  sourceKey: string;
  guid: string;
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null; // ISO-8601
  author: string | null;
  extra: Record<string, string | number | boolean | null>;
}

export interface StoredItem extends NormalizedItem {
  id: number;
  contentHash: string;
  fetchedAt: string;
}

export type TopicStatus = 'new' | 'shortlisted' | 'rejected' | 'drafted' | 'published';

export interface Topic {
  id: number;
  itemId: number | null;
  title: string;
  slug: string;
  summary: string;
  category: Category;
  sourceKey: string;
  sourceUrl: string;
  sourceTier: SourceTier;
  publishedAt: string | null;
  createdAt: string;
  status: TopicStatus;
  /** Other items covering the same story. Feeds originality + verification. */
  corroborationUrls: string[];
  rejectionReason: string | null;
}

/** The seven components of TOPIC SCORE, each 0–100 before weighting. */
export interface ScoreBreakdown {
  freshness: number;
  relevance: number;
  practicalValue: number;
  discussionPotential: number;
  educationalValue: number;
  originality: number;
  audienceFit: number;
}

export interface TopicScore extends ScoreBreakdown {
  topicId: number;
  /** Weighted 0–100. */
  total: number;
  /** 0–100. How complete and trustworthy the underlying metadata is. */
  confidence: number;
  linkedinScore: number;
  mediumScore: number;
  controversy: number;
  /**
   * How many people are demonstrably paying attention, separate from how well
   * the topic fits you. Null on rows scored before this existed.
   */
  audience: AudienceInterest | null;
  /** Human-readable justification per component. Shown in the dashboard. */
  reasons: string[];
}

export type InterestBand = 'niche' | 'growing' | 'broad' | 'major';

/**
 * One measured fact behind an interest score, as a code plus its numbers
 * rather than a finished sentence.
 *
 * Stored structured so the dashboard can render it in whichever language is
 * selected. The score reasons in TopicScore are English sentences baked in at
 * scoring time, which is exactly why they cannot be translated without
 * re-scoring the database; this avoids repeating that mistake.
 */
export interface InterestEvidence {
  code: 'hackerNews' | 'stars' | 'sources' | 'oneSource' | 'demand' | 'noEngagement';
  params?: Record<string, string | number>;
}

export interface AudienceInterest {
  score: number;
  band: InterestBand;
  reachMin: number;
  reachMax: number;
  /** The measured facts behind the score, never a derived claim. */
  evidence: InterestEvidence[];
}

export type AngleKind = 'educational' | 'opinion' | 'engineering-lesson';

export interface Angle {
  id?: number;
  topicId: number;
  kind: AngleKind;
  title: string;
  description: string;
  recommended: boolean;
}

export type FactStatus = 'verified' | 'single-source' | 'unverified';

export interface Fact {
  id?: number;
  topicId: number;
  claim: string;
  sourceUrl: string;
  sourceTier: SourceTier;
  status: FactStatus;
  note: string;
}

export type ContentKind = 'linkedin' | 'medium';
export type ContentStatus = 'draft' | 'approved' | 'published' | 'discarded';
/** How the text was produced. Surfaced in the UI so drafts are never oversold. */
export type GenerationMode = 'llm' | 'scaffold';

export interface GeneratedContent {
  id?: number;
  topicId: number;
  kind: ContentKind;
  angleKind: AngleKind;
  mode: GenerationMode;
  hook: string;
  title: string;
  subtitle: string;
  body: string;
  hashtags: string[];
  sources: string[];
  styleScore: StyleScore | null;
  aiTells: string[];
  status: ContentStatus;
  createdAt: string;
  model: string | null;
  /**
   * The language the draft is written in, independent of the dashboard's own
   * language. Stored so history, exports and text direction stay correct after
   * the UI is switched.
   */
  language: 'en' | 'ar';
}

export interface StyleScore {
  simplicity: number;
  conversational: number;
  technicalClarity: number;
  personality: number;
  usefulness: number;
  originality: number;
  hookStrength: number;
  naturalness: number;
  discussionPotential: number;
  total: number;
  notes: string[];
}

/** Previously published work, used to block repeats. */
export interface PriorContent {
  id?: number;
  platform: 'linkedin' | 'medium' | 'other';
  title: string;
  url: string | null;
  text: string;
  publishedAt: string | null;
}

export interface ResearchRun {
  id?: number;
  startedAt: string;
  finishedAt: string | null;
  sourcesOk: number;
  sourcesFailed: number;
  itemsSeen: number;
  itemsNew: number;
  topicsNew: number;
  log: string;
}

export interface StyleProfile {
  name: string;
  greetings: string[];
  signaturePhrases: string[];
  hookPatterns: string[];
  bannedPhrases: string[];
  emojis: string[];
  preferredHashtags: string[];
  /** Derived from style/corpus by `npm run style:learn`; null until then. */
  measured: MeasuredStyle | null;
  /**
   * Optional Arabic voice overrides. Absent means the defaults in
   * writing/languages.ts are used, so the file stays valid without it.
   */
  arabic?: ArabicStyleProfile;
}

export interface ArabicStyleProfile {
  greetings?: string[];
  signaturePhrases?: string[];
  /** Same order as hookPatterns; hooks are picked by index per angle. */
  hookPatterns?: string[];
  bannedPhrases?: string[];
}

export interface MeasuredStyle {
  sampleCount: number;
  avgSentenceWords: number;
  avgParagraphSentences: number;
  questionRatio: number;
  firstPersonRatio: number;
  emojiPerPost: number;
  topOpeners: string[];
}
