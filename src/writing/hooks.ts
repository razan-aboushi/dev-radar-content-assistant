import { sha1, truncate } from '../util/text';
import type { AngleKind, StyleProfile, Topic } from '../types';

/**
 * Hook selection. The brief is explicit that the same hook structure must not
 * come back every time, so the pattern is chosen deterministically from the
 * topic slug rather than at random: the same topic always yields the same hook
 * (stable, reviewable), but consecutive topics rotate through the list.
 *
 * Patterns are also filtered by angle, because an opinion piece and a tutorial
 * do not open the same way.
 */

const ANGLE_PATTERN_INDEX: Record<AngleKind, number[]> = {
  // Indices into profile.hookPatterns.
  educational: [0, 5, 9, 4],
  opinion: [1, 2, 0, 6],
  'engineering-lesson': [3, 4, 7, 8, 6],
};

export interface HookContext {
  subject: string;
  commonAction: string;
  complication: string;
  belief: string;
  quality: string;
}

export function buildHookContext(subject: string): HookContext {
  return {
    subject,
    commonAction: 'reach for the default',
    complication: 'the default stops being the right answer once the app is real',
    belief: `${subject} was mostly a detail`,
    quality: 'being correct',
  };
}

/** Fills {placeholders} in a pattern. Unknown placeholders are stripped, not left visible. */
export function fillPattern(pattern: string, context: HookContext): string {
  return pattern
    .replace(/\{subject\}/g, context.subject)
    .replace(/\{common_action\}/g, context.commonAction)
    .replace(/\{complication\}/g, context.complication)
    .replace(/\{belief\}/g, context.belief)
    .replace(/\{quality\}/g, context.quality)
    .replace(/\{[a-z_]+\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Deterministic index derived from the slug, so reruns are stable. */
function slugIndex(slug: string, modulo: number): number {
  if (modulo <= 0) return 0;
  const hash = sha1(slug).slice(0, 8);
  return Number.parseInt(hash, 16) % modulo;
}

export function selectHookPattern(profile: StyleProfile, angle: AngleKind, slug: string): string {
  const allowed = (ANGLE_PATTERN_INDEX[angle] ?? [])
    .map((index) => profile.hookPatterns[index])
    .filter((pattern): pattern is string => typeof pattern === 'string');

  const pool = allowed.length > 0 ? allowed : profile.hookPatterns;
  if (pool.length === 0) return '{subject} — here is what actually changed.';
  return pool[slugIndex(slug, pool.length)] ?? pool[0]!;
}

export function buildHook(
  profile: StyleProfile,
  angle: AngleKind,
  topic: Pick<Topic, 'title' | 'slug' | 'category'>,
  subject: string,
): string {
  const pattern = selectHookPattern(profile, angle, topic.slug);
  return truncate(fillPattern(pattern, buildHookContext(subject)), 140);
}

/** Alternative hooks offered alongside the chosen one, so you can swap. */
export function alternativeHooks(
  profile: StyleProfile,
  angle: AngleKind,
  topic: Pick<Topic, 'title' | 'slug' | 'category'>,
  subject: string,
  count = 3,
): string[] {
  const context = buildHookContext(subject);
  const chosen = selectHookPattern(profile, angle, topic.slug);
  return profile.hookPatterns
    .filter((pattern) => pattern !== chosen)
    .map((pattern) => truncate(fillPattern(pattern, context), 140))
    .slice(0, count);
}
