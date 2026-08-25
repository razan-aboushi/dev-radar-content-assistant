import { sha1, truncate } from '../util/text';
import { languagePack, type ContentLanguage } from './languages';
import type { AngleKind, StyleProfile, Topic } from '../types';

/**
 * Hook selection. The brief is explicit that the same hook structure must not
 * come back every time, so the pattern is chosen deterministically from the
 * topic slug rather than at random: the same topic always yields the same hook
 * (stable, reviewable), but consecutive topics rotate through the list.
 *
 * Patterns are also filtered by angle, because an opinion piece and a tutorial
 * do not open the same way.
 *
 * Arabic drafts draw from the Arabic pattern list, held in the same order as
 * the English one so the per-angle indices below stay meaningful. An English
 * hook pasted into the top of an Arabic post is the single most obvious way for
 * a translated-feeling draft to give itself away.
 */

const ANGLE_PATTERN_INDEX: Record<AngleKind, number[]> = {
  // Indices into the pattern list for the target language.
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

export function buildHookContext(subject: string, language: ContentLanguage = 'en'): HookContext {
  const { hookFills } = languagePack(language);
  return {
    subject,
    commonAction: hookFills.commonAction,
    complication: hookFills.complication(subject),
    belief: hookFills.belief(subject),
    quality: hookFills.quality,
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

/**
 * English patterns are the author's own, from style/style-profile.json.
 * Arabic ones ship with the language pack unless the profile overrides them,
 * so the voice stays editable in one place per language.
 */
function patternsFor(profile: StyleProfile, language: ContentLanguage): string[] {
  if (language === 'en') return profile.hookPatterns;
  const override = profile.arabic?.hookPatterns;
  return override && override.length > 0 ? override : [...languagePack(language).hookPatterns];
}

export function selectHookPattern(
  profile: StyleProfile,
  angle: AngleKind,
  slug: string,
  language: ContentLanguage = 'en',
): string {
  const patterns = patternsFor(profile, language);
  const allowed = (ANGLE_PATTERN_INDEX[angle] ?? [])
    .map((index) => patterns[index])
    .filter((pattern): pattern is string => typeof pattern === 'string');

  const pool = allowed.length > 0 ? allowed : patterns;
  if (pool.length === 0) {
    return language === 'ar'
      ? '{subject} — إليك ما تغيّر فعلاً.'
      : '{subject} — here is what actually changed.';
  }
  return pool[slugIndex(slug, pool.length)] ?? pool[0]!;
}

export function buildHook(
  profile: StyleProfile,
  angle: AngleKind,
  topic: Pick<Topic, 'title' | 'slug' | 'category'>,
  subject: string,
  language: ContentLanguage = 'en',
): string {
  const pattern = selectHookPattern(profile, angle, topic.slug, language);
  return truncate(fillPattern(pattern, buildHookContext(subject, language)), 140);
}

/** Alternative hooks offered alongside the chosen one, so you can swap. */
export function alternativeHooks(
  profile: StyleProfile,
  angle: AngleKind,
  topic: Pick<Topic, 'title' | 'slug' | 'category'>,
  subject: string,
  language: ContentLanguage = 'en',
  count = 3,
): string[] {
  const context = buildHookContext(subject, language);
  const chosen = selectHookPattern(profile, angle, topic.slug, language);
  return patternsFor(profile, language)
    .filter((pattern) => pattern !== chosen)
    .map((pattern) => truncate(fillPattern(pattern, context), 140))
    .slice(0, count);
}
