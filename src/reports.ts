import { getNumberSetting, type DB } from './db';
import { listAngles, listScoredTopics, type ScoredTopic } from './db/repositories';
import { recommendedAngle } from './pipeline/angles';
import { displayScore, opportunityScore } from './pipeline/score';
import type { Category, Language } from './types';

/**
 * Report builders. Both the CLI and the dashboard render from these, so the
 * numbers can never disagree between the two surfaces.
 *
 * The prose these produce — the weekly section headings, and the sentence
 * explaining why a topic ranked where it did — is dashboard chrome that a
 * reader sees on every row, so it is built in the requested language. The CLI
 * asks for English and is unaffected.
 */

export interface DailyEntry {
  rank: number;
  topic: ScoredTopic['topic'];
  score: ScoredTopic['score'];
  /** Fit blended with audience interest. The number the list is ranked by. */
  opportunity: number;
  whyItMatters: string;
  whyYourAudienceCares: string;
  suggestedAngle: string;
  angleKind: string;
  linkedinScore: number;
  mediumScore: number;
}

export interface DailyReport {
  date: string;
  entries: DailyEntry[];
  top: DailyEntry | null;
  minScore: number;
  totalConsidered: number;
}

interface ReportStrings {
  notScored: string;
  noAngle: string;
  current: string;
  actionable: string;
  debated: string;
  uncovered: string;
  substantial: string;
  rankedPlain: (total: number) => string;
  rankedBecause: (total: number, reasons: string) => string;
  audienceCore: (category: string) => string;
  audienceAdjacent: (category: string) => string;
  audienceOutside: string;
  and: string;
  listSeparator: string;
  buckets: Record<string, string>;
}

const STRINGS: Record<Language, ReportStrings> = {
  en: {
    notScored: 'Not scored yet.',
    noAngle: 'No angle stored',
    current: 'it is current',
    actionable: 'there is something concrete to act on',
    debated: 'developers disagree about it',
    uncovered: 'few other people are covering it',
    substantial: 'there is enough substance for a long read',
    rankedPlain: (total) => `Ranked ${total} overall; nothing stands out strongly.`,
    rankedBecause: (total, reasons) => `Ranked ${total} because ${reasons}.`,
    audienceCore: (category) =>
      `Sits directly in your ${category} territory, which is what your readers follow you for.`,
    audienceAdjacent: (category) =>
      `Adjacent to your usual ${category} material. Would need a bridge back to frontend work.`,
    audienceOutside: 'Outside your usual subject matter. Only worth it if you have a personal angle on it.',
    and: 'and',
    listSeparator: ', ',
    buckets: {
      javascript: 'Biggest JavaScript news',
      nodejs: 'Biggest Node.js news',
      'react-next': 'React and Next.js',
      frontend: 'Frontend and the web platform',
      ai: 'AI for developers',
      security: 'Security',
      'open-source': 'Interesting open source',
      underrated: 'One underrated topic',
      controversial: 'One controversial topic',
      evergreen: 'One educational evergreen topic',
    },
  },
  ar: {
    notScored: 'لم يُقيَّم بعد.',
    noAngle: 'لا توجد زاوية محفوظة',
    current: 'الموضوع حديث',
    actionable: 'فيه شيء ملموس يمكن العمل عليه',
    debated: 'المطورون مختلفون حوله',
    uncovered: 'قلّة يكتبون عنه',
    substantial: 'فيه مادة تكفي لمقالة طويلة',
    rankedPlain: (total) => `حصل على ${total}؛ لا شيء فيه يبرز بقوة.`,
    rankedBecause: (total, reasons) => `حصل على ${total} لأن ${reasons}.`,
    audienceCore: (category) => `يقع مباشرة في مجال ${category}، وهو ما يتابعك قرّاؤك من أجله.`,
    audienceAdjacent: (category) =>
      `قريب من مادتك المعتادة في ${category}، لكنه يحتاج جسراً يعيده إلى شغل الـ frontend.`,
    audienceOutside: 'خارج مواضيعك المعتادة. لا يستحق إلا إذا كان لديك زاوية شخصية فيه.',
    and: 'و',
    listSeparator: '، ',
    buckets: {
      javascript: 'أبرز أخبار JavaScript',
      nodejs: 'أبرز أخبار Node.js',
      'react-next': 'React و Next.js',
      frontend: 'الـ frontend ومنصة الويب',
      ai: 'الذكاء الاصطناعي للمطورين',
      security: 'الأمان',
      'open-source': 'مفتوح المصدر المثير للاهتمام',
      underrated: 'موضوع لا يأخذ حقه',
      controversial: 'موضوع مثير للجدل',
      evergreen: 'موضوع تعليمي دائم القيمة',
    },
  },
};

function strings(language: Language): ReportStrings {
  return STRINGS[language] ?? STRINGS.en;
}

export function buildDaily(db: DB, limit?: number, language: Language = 'en'): DailyReport {
  const minScore = getNumberSetting(db, 'minTopicScore');
  const count = limit ?? getNumberSetting(db, 'dailyTopicCount');

  // Ranked by opportunity — fit blended with how many people are actually
  // paying attention — because "what should I write today" is not answered by
  // either number alone.
  const candidates = listScoredTopics(db, {
    status: 'any',
    sinceDays: 14,
    limit: 300,
    sort: 'opportunity',
  }).filter((entry) => entry.topic.status !== 'rejected' && entry.topic.status !== 'published');

  // Qualify on opportunity, not on fit alone. Filtering by fit dropped exactly
  // the topics this list exists to surface: a story with fit 51 and interest 87
  // is a better use of your afternoon than one with fit 60 that nobody is
  // discussing, and the fit-only threshold hid the first while keeping the
  // second.
  const qualifying = candidates.filter(
    (entry) => (entry.score ? opportunityScore(entry.score) : 0) >= minScore,
  );
  const pool = qualifying.length > 0 ? qualifying : candidates;

  const entries = pool.slice(0, count).map((entry, index) => toEntry(db, entry, index + 1, language));

  return {
    date: new Date().toISOString().slice(0, 10),
    entries,
    top: entries[0] ?? null,
    minScore,
    totalConsidered: candidates.length,
  };
}

function toEntry(db: DB, entry: ScoredTopic, rank: number, language: Language): DailyEntry {
  const score = entry.score ? displayScore(entry.score) : null;
  const angle = recommendedAngle(listAngles(db, entry.topic.id));

  return {
    rank,
    topic: entry.topic,
    score,
    opportunity: score ? opportunityScore(score) : 0,
    whyItMatters: whyItMatters(entry, language),
    whyYourAudienceCares: whyAudienceCares(entry, language),
    suggestedAngle: angle?.title ?? strings(language).noAngle,
    angleKind: angle?.kind ?? 'engineering-lesson',
    linkedinScore: score?.linkedinScore ?? 0,
    mediumScore: score?.mediumScore ?? 0,
  };
}

/**
 * These read the score breakdown back out as a sentence. They are descriptions
 * of why the topic ranked where it did — not claims about the topic itself.
 */
function whyItMatters(entry: ScoredTopic, language: Language): string {
  const s = strings(language);
  const score = entry.score;
  if (!score) return s.notScored;
  const parts: string[] = [];
  if (score.freshness >= 70) parts.push(s.current);
  if (score.practicalValue >= 65) parts.push(s.actionable);
  if (score.discussionPotential >= 65) parts.push(s.debated);
  if (score.originality >= 75) parts.push(s.uncovered);
  if (score.educationalValue >= 70) parts.push(s.substantial);
  const total = Math.round(score.total);
  if (parts.length === 0) return s.rankedPlain(total);
  return s.rankedBecause(total, joinList(parts, s));
}

function whyAudienceCares(entry: ScoredTopic, language: Language): string {
  const s = strings(language);
  const score = entry.score;
  const category = entry.topic.category;
  if (!score) return s.notScored;
  if (score.audienceFit >= 68) return s.audienceCore(categoryLabel(category));
  if (score.audienceFit >= 40) return s.audienceAdjacent(categoryLabel(category));
  return s.audienceOutside;
}

/**
 * Category slugs are left in English on purpose: they are the taxonomy the
 * tool is configured with, they appear verbatim in config/sources.json and in
 * the CLI, and they are the words developers use for these areas anyway.
 */
function categoryLabel(category: Category): string {
  return category.replace(/-/g, ' ');
}

function joinList(parts: string[], s: ReportStrings): string {
  if (parts.length === 1) return parts[0]!;
  // Arabic joins with a prefixed و attached to the following word, so the
  // separator is not simply " and ".
  const join = s.and === 'و' ? `${s.and}` : `${s.and} `;
  if (parts.length === 2) return `${parts[0]} ${join}${parts[1]}`;
  return `${parts.slice(0, -1).join(s.listSeparator)} ${join}${parts[parts.length - 1]}`;
}

/* ------------------------------------------------------------------ weekly */

export interface WeeklySection {
  key: string;
  label: string;
  entries: DailyEntry[];
}

export interface WeeklyReport {
  from: string;
  to: string;
  sections: WeeklySection[];
}

const WEEKLY_BUCKETS: Array<{ key: string; categories: Category[] }> = [
  { key: 'javascript', categories: ['javascript'] },
  { key: 'nodejs', categories: ['nodejs'] },
  { key: 'react-next', categories: ['react', 'nextjs'] },
  { key: 'frontend', categories: ['frontend', 'web-platform', 'css-html', 'performance'] },
  { key: 'ai', categories: ['ai-for-developers'] },
  { key: 'security', categories: ['security'] },
  { key: 'open-source', categories: ['open-source', 'npm', 'devtools'] },
];

export function buildWeekly(db: DB, language: Language = 'en'): WeeklyReport {
  const s = strings(language);
  const all = listScoredTopics(db, { status: 'any', sinceDays: 7, limit: 400 }).filter(
    (entry) => entry.topic.status !== 'rejected',
  );

  const sections: WeeklySection[] = WEEKLY_BUCKETS.map((bucket) => ({
    key: bucket.key,
    label: s.buckets[bucket.key] ?? bucket.key,
    entries: all
      .filter((entry) => bucket.categories.includes(entry.topic.category))
      .slice(0, 3)
      .map((entry, index) => toEntry(db, entry, index + 1, language)),
  })).filter((section) => section.entries.length > 0);

  // The three special picks the brief asks for.
  const underrated = pick(all, (entry) =>
    (entry.score?.originality ?? 0) >= 75 && (entry.score?.discussionPotential ?? 0) < 55,
  );
  const controversial = pick(all, (entry) => (entry.score?.controversy ?? 0) >= 60);
  const evergreen = pick(all, (entry) =>
    (entry.score?.educationalValue ?? 0) >= 70 && (entry.score?.freshness ?? 100) < 60,
  );

  for (const [key, chosen] of [
    ['underrated', underrated],
    ['controversial', controversial],
    ['evergreen', evergreen],
  ] as const) {
    if (chosen) {
      sections.push({ key, label: s.buckets[key] ?? key, entries: [toEntry(db, chosen, 1, language)] });
    }
  }

  return {
    from: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
    sections,
  };
}

function pick(entries: ScoredTopic[], predicate: (entry: ScoredTopic) => boolean): ScoredTopic | null {
  return entries.find(predicate) ?? null;
}
