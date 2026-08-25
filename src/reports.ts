import { getNumberSetting, type DB } from './db';
import { listAngles, listScoredTopics, type ScoredTopic } from './db/repositories';
import { recommendedAngle } from './pipeline/angles';
import { displayScore } from './pipeline/score';
import type { Category } from './types';

/**
 * Report builders. Both the CLI and the dashboard render from these, so the
 * numbers can never disagree between the two surfaces.
 */

export interface DailyEntry {
  rank: number;
  topic: ScoredTopic['topic'];
  score: ScoredTopic['score'];
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

export function buildDaily(db: DB, limit?: number): DailyReport {
  const minScore = getNumberSetting(db, 'minTopicScore');
  const count = limit ?? getNumberSetting(db, 'dailyTopicCount');

  const candidates = listScoredTopics(db, { status: 'any', sinceDays: 14, limit: 300 }).filter(
    (entry) => entry.topic.status !== 'rejected' && entry.topic.status !== 'published',
  );

  const qualifying = candidates.filter((entry) => (entry.score?.total ?? 0) >= minScore);
  const pool = qualifying.length > 0 ? qualifying : candidates;

  const entries = pool.slice(0, count).map((entry, index) => toEntry(db, entry, index + 1));

  return {
    date: new Date().toISOString().slice(0, 10),
    entries,
    top: entries[0] ?? null,
    minScore,
    totalConsidered: candidates.length,
  };
}

function toEntry(db: DB, entry: ScoredTopic, rank: number): DailyEntry {
  const score = entry.score ? displayScore(entry.score) : null;
  const angle = recommendedAngle(listAngles(db, entry.topic.id));

  return {
    rank,
    topic: entry.topic,
    score,
    whyItMatters: whyItMatters(entry),
    whyYourAudienceCares: whyAudienceCares(entry),
    suggestedAngle: angle?.title ?? 'No angle stored',
    angleKind: angle?.kind ?? 'engineering-lesson',
    linkedinScore: score?.linkedinScore ?? 0,
    mediumScore: score?.mediumScore ?? 0,
  };
}

/**
 * These read the score breakdown back out as a sentence. They are descriptions
 * of why the topic ranked where it did — not claims about the topic itself.
 */
function whyItMatters(entry: ScoredTopic): string {
  const score = entry.score;
  if (!score) return 'Not scored yet.';
  const parts: string[] = [];
  if (score.freshness >= 70) parts.push('it is current');
  if (score.practicalValue >= 65) parts.push('there is something concrete to act on');
  if (score.discussionPotential >= 65) parts.push('developers disagree about it');
  if (score.originality >= 75) parts.push('few other people are covering it');
  if (score.educationalValue >= 70) parts.push('there is enough substance for a long read');
  if (parts.length === 0) return `Ranked ${Math.round(score.total)} overall; nothing stands out strongly.`;
  return `Ranked ${Math.round(score.total)} because ${joinList(parts)}.`;
}

function whyAudienceCares(entry: ScoredTopic): string {
  const score = entry.score;
  const category = entry.topic.category;
  if (!score) return 'Not scored yet.';
  if (score.audienceFit >= 68) {
    return `Sits directly in your ${categoryLabel(category)} territory, which is what your readers follow you for.`;
  }
  if (score.audienceFit >= 40) {
    return `Adjacent to your usual ${categoryLabel(category)} material. Would need a bridge back to frontend work.`;
  }
  return `Outside your usual subject matter. Only worth it if you have a personal angle on it.`;
}

function categoryLabel(category: Category): string {
  return category.replace(/-/g, ' ');
}

function joinList(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
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

const WEEKLY_BUCKETS: Array<{ key: string; label: string; categories: Category[] }> = [
  { key: 'javascript', label: 'Biggest JavaScript news', categories: ['javascript'] },
  { key: 'nodejs', label: 'Biggest Node.js news', categories: ['nodejs'] },
  { key: 'react-next', label: 'React and Next.js', categories: ['react', 'nextjs'] },
  { key: 'frontend', label: 'Frontend and the web platform', categories: ['frontend', 'web-platform', 'css-html', 'performance'] },
  { key: 'ai', label: 'AI for developers', categories: ['ai-for-developers'] },
  { key: 'security', label: 'Security', categories: ['security'] },
  { key: 'open-source', label: 'Interesting open source', categories: ['open-source', 'npm', 'devtools'] },
];

export function buildWeekly(db: DB): WeeklyReport {
  const all = listScoredTopics(db, { status: 'any', sinceDays: 7, limit: 400 }).filter(
    (entry) => entry.topic.status !== 'rejected',
  );

  const sections: WeeklySection[] = WEEKLY_BUCKETS.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    entries: all
      .filter((entry) => bucket.categories.includes(entry.topic.category))
      .slice(0, 3)
      .map((entry, index) => toEntry(db, entry, index + 1)),
  })).filter((section) => section.entries.length > 0);

  // The three special picks the brief asks for.
  const underrated = pick(all, (entry) =>
    (entry.score?.originality ?? 0) >= 75 && (entry.score?.discussionPotential ?? 0) < 55,
  );
  const controversial = pick(all, (entry) => (entry.score?.controversy ?? 0) >= 60);
  const evergreen = pick(all, (entry) =>
    (entry.score?.educationalValue ?? 0) >= 70 && (entry.score?.freshness ?? 100) < 60,
  );

  for (const [key, label, chosen] of [
    ['underrated', 'One underrated topic', underrated],
    ['controversial', 'One controversial topic', controversial],
    ['evergreen', 'One educational evergreen topic', evergreen],
  ] as const) {
    if (chosen) sections.push({ key, label, entries: [toEntry(db, chosen, 1)] });
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
