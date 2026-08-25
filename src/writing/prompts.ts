import { getNumberSetting, type DB } from '../db';
import { buildContext } from './context';
import { buildHook } from './hooks';
import { CONTENT_LANGUAGES, type ContentLanguage } from './languages';
import { buildPrompt as buildLinkedInPrompt } from './linkedin';
import { buildSinglePassPrompt as buildMediumPrompt } from './medium';
import { buildSystemPrompt } from './style';
import { articleSubtitleFor, articleTitleFor } from './titles';
import type { AngleKind, ContentKind, StyleProfile, Topic } from '../types';

export { articleSubtitleFor, articleTitleFor } from './titles';

/**
 * Prompts, assembled here and shipped inside the snapshot.
 *
 * The published site has no server, so generating there means the browser
 * talks to a free AI API directly. The tempting shortcut is to rebuild the
 * prompt in JavaScript — and then there are two prompt builders that drift
 * apart the first time either is edited, with the browser quietly producing
 * worse drafts than the CLI for reasons nobody can see.
 *
 * So the prompt is built once, by the same TypeScript the CLI uses, and
 * written into the topic's JSON. The browser picks one by angle and language
 * and sends it. There is exactly one definition of how to ask.
 *
 * Cost: roughly 15KB per topic file. Those are fetched one at a time when you
 * open a topic, so it is 15KB on click, not on load.
 */

export interface TopicPrompts {
  /** prompts[kind][angleKind][language] */
  linkedin: Record<string, Record<string, string>>;
  medium: Record<string, Record<string, string>>;
  /** Word targets, so the browser can report length against the same bounds. */
  bounds: Record<ContentKind, { min: number; max: number }>;
  /** The angle titles and subtitles a Medium draft needs, per angle+language. */
  titles: Record<string, Record<string, { title: string; subtitle: string }>>;
}

const ANGLE_KINDS: AngleKind[] = ['educational', 'opinion', 'engineering-lesson'];

export function buildTopicPrompts(db: DB, topic: Topic, profile: StyleProfile): TopicPrompts {
  const bounds = {
    linkedin: {
      min: getNumberSetting(db, 'linkedinMinWords'),
      max: getNumberSetting(db, 'linkedinMaxWords'),
    },
    medium: {
      min: getNumberSetting(db, 'mediumMinWords'),
      max: getNumberSetting(db, 'mediumMaxWords'),
    },
  } as const;

  const linkedin: TopicPrompts['linkedin'] = {};
  const medium: TopicPrompts['medium'] = {};
  const titles: TopicPrompts['titles'] = {};

  for (const angle of ANGLE_KINDS) {
    linkedin[angle] = {};
    medium[angle] = {};
    titles[angle] = {};

    for (const language of CONTENT_LANGUAGES) {
      const context = buildContext(db, topic, null, profile, angle, language);
      const hook = buildHook(profile, context.angle.kind, topic, context.subject, language);

      linkedin[angle]![language] = buildLinkedInPrompt(
        context, hook, bounds.linkedin.min, bounds.linkedin.max,
      );
      medium[angle]![language] = buildMediumPrompt(
        context, hook, bounds.medium.min, bounds.medium.max,
      );
      titles[angle]![language] = {
        title: articleTitleFor(context.subject, context.angle.kind, language),
        subtitle: articleSubtitleFor(context.angle.kind, language),
      };
    }
  }

  return { linkedin, medium, bounds: { linkedin: bounds.linkedin, medium: bounds.medium }, titles };
}

/** One system prompt per language, shared by every topic. */
export function buildSystemPrompts(profile: StyleProfile): Record<ContentLanguage, string> {
  const out = {} as Record<ContentLanguage, string>;
  for (const language of CONTENT_LANGUAGES) out[language] = buildSystemPrompt(profile, language);
  return out;
}
