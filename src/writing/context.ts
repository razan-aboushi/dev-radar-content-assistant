import { getNumberSetting, type DB } from '../db';
import { listAngles, listFacts, listPriorContent } from '../db/repositories';
import { checkRepeat } from '../pipeline/dedupe';
import { recommendedAngle, subjectOf } from '../pipeline/angles';
import { assertableFacts, renderClaim } from '../pipeline/verify';
import { CATEGORY_KEYWORDS } from '../pipeline/signals';
import { haystack } from '../pipeline/signals';
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
}

export function buildContext(
  db: DB,
  topic: Topic,
  score: TopicScore | null,
  profile: StyleProfile,
  angleKind?: AngleKind,
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
 * Hashtags are chosen by matching the topic text against the same category
 * keyword dictionary the scorer uses, so they describe the post rather than
 * chasing reach. Capped at 8 per the brief.
 */
export function selectHashtags(profile: StyleProfile, topic: Topic): string[] {
  const hay = haystack(topic.title, topic.summary);
  const scored = profile.preferredHashtags.map((tag) => {
    const term = tag.replace(/^#/, '').toLowerCase();
    let weight = 0;
    if (hay.includes(term)) weight += 10;
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (category !== topic.category) continue;
      for (const keyword of keywords) {
        if (term.includes(keyword.replace(/[^a-z]/g, '')) || keyword.includes(term)) weight += 6;
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

/** The fact block handed to the model. Explicit about what may not be asserted. */
export function renderFactBlock(context: GenerationContext): string {
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
  ].join('\n');
}
