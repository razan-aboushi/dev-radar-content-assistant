import { getNumberSetting, type DB } from '../db';
import { listAngles, listFacts, listPriorContent } from '../db/repositories';
import { checkRepeat } from '../pipeline/dedupe';
import { recommendedAngle, subjectOf } from '../pipeline/angles';
import { assertableFacts, renderClaim } from '../pipeline/verify';
import { CATEGORY_KEYWORDS, haystack, matchesPhrase } from '../pipeline/signals';
import { languagePack, type ContentLanguage } from './languages';
import type { Angle, AngleKind, Fact, StyleProfile, Topic, TopicScore } from '../types';

/**
 * The bundle every generator needs: the topic, the angle, the facts it is
 * allowed to assert, and the sources it must cite. Assembled once so the LLM
 * path and the scaffold path cannot drift apart on what is true.
 */
export interface GenerationContext {
  topic: Topic;
  score: TopicScore | null;
  angle: Angle;
  subject: string;
  /** Facts safe to state, already hedged where required. */
  claims: string[];
  facts: Fact[];
  sources: string[];
  hashtags: string[];
  /** Previously published pieces this could echo. Shown as a warning. */
  nearMatches: Array<{ title: string; similarity: number }>;
  profile: StyleProfile;
  /** The language the draft will be written in. Independent of the UI language. */
  language: ContentLanguage;
}

export function buildContext(
  db: DB,
  topic: Topic,
  score: TopicScore | null,
  profile: StyleProfile,
  angleKind?: AngleKind,
  language: ContentLanguage = 'en',
): GenerationContext {
  const angles = listAngles(db, topic.id);
  const angle =
    (angleKind ? angles.find((a) => a.kind === angleKind) : null) ??
    recommendedAngle(angles) ??
    fallbackAngle(topic);

  const facts = listFacts(db, topic.id);
  const usable = assertableFacts(facts);

  const repeatThreshold = getNumberSetting(db, 'repeatSimilarityThreshold');
  const repeat = checkRepeat(topic.title, topic.summary, listPriorContent(db), repeatThreshold);

  const sources = dedupe([topic.sourceUrl, ...topic.corroborationUrls]).slice(0, 5);

  return {
    topic,
    score,
    angle,
    subject: subjectOf(topic),
    claims: usable.map(renderClaim),
    facts,
    sources,
    hashtags: selectHashtags(profile, topic),
    nearMatches: repeat.nearMatches,
    profile,
    language,
  };
}

function fallbackAngle(topic: Topic): Angle {
  return {
    topicId: topic.id,
    kind: 'engineering-lesson',
    title: `What ${subjectOf(topic)} changes in a real production app`,
    description: 'Fallback angle: no angles were stored for this topic.',
    recommended: true,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Relates a hashtag to one of its category's keywords.
 *
 * Bare substring containment let two-letter terms match almost anything — "ai"
 * is inside "container", so a CSS article picked up #AI — so a short term has
 * to match exactly. Digits are kept when stripping punctuation, otherwise
 * "es2024" collapsed to "es" and matched just as loosely.
 */
function relatesTo(term: string, keyword: string): boolean {
  const bare = keyword.replace(/[^a-z0-9]/g, '');
  if (!bare) return false;
  if (bare === term) return true;
  const [shorter, longer] = bare.length < term.length ? [bare, term] : [term, bare];
  return shorter.length >= 4 && longer.includes(shorter);
}

/**
 * Hashtags are chosen by matching the topic text against the same category
 * keyword dictionary the scorer uses, so they describe the post rather than
 * chasing reach. Capped at 8 per the brief.
 */
export function selectHashtags(profile: StyleProfile, topic: Topic): string[] {
  const hay = haystack(topic.title, topic.summary);
  const scored = profile.preferredHashtags.map((tag) => {
    const term = tag.replace(/^#/, '').toLowerCase();
    let weight = 0;
    // Word edges, for the same reason the scorer needs them: "ai" matched
    // inside "again" and tagged a frontend article #AI.
    if (matchesPhrase(hay, term)) weight += 10;
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (category !== topic.category) continue;
      for (const keyword of keywords) {
        if (relatesTo(term, keyword)) weight += 6;
      }
    }
    return { tag, weight };
  });

  const matched = scored.filter((entry) => entry.weight > 0).sort((a, b) => b.weight - a.weight);
  const picked = matched.slice(0, 5).map((entry) => entry.tag);

  // Always finish with the two broad ones so a post is never under-tagged.
  for (const fallback of ['#SoftwareEngineering', '#WebDevelopment', '#Programming']) {
    if (picked.length >= 7) break;
    if (!picked.includes(fallback) && profile.preferredHashtags.includes(fallback)) picked.push(fallback);
  }

  return picked.slice(0, 8);
}

/**
 * The fact block handed to the model. Explicit about what may not be asserted.
 *
 * The claims themselves stay in the language of the source — they are lifted
 * verbatim precisely so nothing drifts — and the model is told to translate the
 * meaning rather than paste the sentence into an Arabic paragraph.
 */
export function renderFactBlock(context: GenerationContext): string {
  const foreignSource =
    context.language !== 'en'
      ? ['', 'The claims above are quoted from an English source. Express them naturally in ' +
         `${languagePack(context.language).englishName}; keep every number, version and API name exactly as written.`]
      : [];

  if (context.claims.length === 0) {
    return [
      'VERIFIED CLAIMS: none could be extracted from the source.',
      'Write about the idea and the engineering implications only.',
      'Do not state any version number, date, benchmark or statistic.',
    ].join('\n');
  }
  return [
    'CLAIMS YOU MAY USE (these are the only factual statements allowed):',
    ...context.claims.map((claim, index) => `${index + 1}. ${claim}`),
    '',
    'Anything not on this list must not appear as a fact.',
    ...foreignSource,
  ].join('\n');
}
