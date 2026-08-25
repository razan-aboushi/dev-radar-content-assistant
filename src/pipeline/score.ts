import { clamp, daysSince, round, wordCount } from '../util/text';
import {
  AUDIENCE_FOCUS,
  DISCUSSION_SIGNALS,
  EDUCATIONAL_SIGNALS,
  NOISE_SIGNALS,
  PRACTICAL_SIGNALS,
  RELEASE_SIGNALS,
  countSignals,
  haystack,
  matchedSignals,
} from './signals';
import type { ScoreBreakdown, SourceTier, Topic, TopicScore } from '../types';

/**
 * Scoring is deterministic and LLM-free by design: the radar has to be useful
 * before any model is configured, and a stable score is something you can
 * actually tune. Every component returns 0–100 and carries a written reason.
 *
 * TOPIC SCORE = weighted sum of the seven components in the brief.
 */

export const WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  freshness: 0.15,
  relevance: 0.15,
  practicalValue: 0.18,
  discussionPotential: 0.14,
  educationalValue: 0.14,
  originality: 0.14,
  audienceFit: 0.10,
};

export interface ScoreInput {
  topic: Pick<Topic, 'title' | 'summary' | 'category' | 'publishedAt' | 'sourceTier'>;
  /** Source weight from config, 0.5–1.5. */
  sourceWeight: number;
  /** How many distinct sources carried this story. 1 = exclusive. */
  clusterSize: number;
  /** 0–1 similarity to the most similar already-published piece. */
  priorSimilarity: number;
  /** Optional community engagement signal (HN points, GitHub stars). */
  engagement?: number;
}

/**
 * Freshness decays with a 7-day half-life. Items with no date get a neutral 50
 * rather than 0 — many primary feeds omit dates, and punishing them would bias
 * the radar towards blogspam.
 */
function scoreFreshness(publishedAt: string | null): { value: number; reason: string } {
  const days = daysSince(publishedAt);
  if (days === null) return { value: 50, reason: 'Freshness 50: no publication date in the feed' };
  if (days < 0) return { value: 95, reason: 'Freshness 95: dated in the future, treated as brand new' };
  const value = clamp(100 * 0.5 ** (days / 7));
  return { value, reason: `Freshness ${Math.round(value)}: published ${Math.round(days)} day(s) ago` };
}

function scoreRelevance(text: string, sourceWeight: number, tier: SourceTier): { value: number; reason: string } {
  const hay = haystack(text);
  const focusHits = countSignals(hay, AUDIENCE_FOCUS);
  const noiseHits = countSignals(hay, NOISE_SIGNALS);
  const tierBonus = tier === 'primary' ? 15 : tier === 'reputable' ? 7 : 0;
  const base = clamp(28 + focusHits * 9 + tierBonus - noiseHits * 30);
  const value = clamp(base * sourceWeight);
  return {
    value,
    reason: `Relevance ${Math.round(value)}: ${focusHits} focus keyword(s), ${tier} source${noiseHits ? `, ${noiseHits} noise signal(s)` : ''}`,
  };
}

function scorePractical(text: string): { value: number; reason: string } {
  const hay = haystack(text);
  const hits = matchedSignals(hay, PRACTICAL_SIGNALS);
  const releaseHits = countSignals(hay, RELEASE_SIGNALS);
  const value = clamp(25 + hits.length * 11 + releaseHits * 6);
  return {
    value,
    reason: `Practical value ${Math.round(value)}: ${hits.length ? hits.slice(0, 3).join(', ') : 'no explicit action signals'}`,
  };
}

function scoreDiscussion(text: string, engagement: number): { value: number; reason: string } {
  const hay = haystack(text);
  const hits = matchedSignals(hay, DISCUSSION_SIGNALS);
  // Engagement is log-scaled: 500 HN points is not 10x more interesting than 50.
  const engagementBonus = engagement > 0 ? clamp(Math.log10(engagement + 1) * 14, 0, 32) : 0;
  const value = clamp(22 + hits.length * 13 + engagementBonus);
  return {
    value,
    reason: `Discussion ${Math.round(value)}: ${hits.length ? hits.slice(0, 3).join(', ').trim() : 'no debate signals'}${engagement > 0 ? `, engagement ${engagement}` : ''}`,
  };
}

function scoreEducational(text: string, summaryWords: number): { value: number; reason: string } {
  const hay = haystack(text);
  const hits = countSignals(hay, EDUCATIONAL_SIGNALS);
  // Longer summaries usually mean the source itself explained something.
  const depthBonus = clamp(Math.min(summaryWords, 400) / 400 * 30, 0, 30);
  const value = clamp(22 + hits * 12 + depthBonus);
  return {
    value,
    reason: `Educational ${Math.round(value)}: ${hits} depth signal(s), ${summaryWords}-word summary`,
  };
}

/**
 * Originality falls when many sources carry the same story and falls hard when
 * it overlaps something already published. An exclusive from a primary source
 * is the ideal case.
 */
function scoreOriginality(clusterSize: number, priorSimilarity: number): { value: number; reason: string } {
  const crowding = clamp((clusterSize - 1) * 16, 0, 55);
  const repetition = clamp(priorSimilarity * 100, 0, 100);
  const value = clamp(95 - crowding - repetition * 0.6);
  return {
    value,
    reason: `Originality ${Math.round(value)}: covered by ${clusterSize} source(s), ${Math.round(repetition)}% overlap with prior work`,
  };
}

/**
 * A real headline plus summary hits 1–3 focus terms, rarely more, so the step
 * per hit has to be large: at 12 points a hit, a squarely on-topic Node.js
 * item scored 44 and the daily report described it as outside her subject
 * matter. One hit is a maybe, two is on-topic, three is squarely on-topic.
 */
function scoreAudienceFit(text: string): { value: number; reason: string } {
  const hay = haystack(text);
  const hits = matchedSignals(hay, AUDIENCE_FOCUS);
  const value = clamp(25 + hits.length * 15);
  return {
    value,
    reason: `Audience fit ${Math.round(value)}: ${hits.length ? hits.slice(0, 4).join(', ') : 'outside stated focus areas'}`,
  };
}

/**
 * Confidence is about metadata quality, not about how good the topic is. Low
 * confidence means "the score is a guess" and the dashboard says so.
 */
function scoreConfidence(input: ScoreInput, summaryWords: number): { value: number; reason: string } {
  let value = 40;
  const notes: string[] = [];
  if (input.topic.publishedAt) { value += 15; } else { notes.push('no date'); }
  if (summaryWords >= 25) { value += 20; } else { notes.push('thin summary'); }
  if (input.topic.sourceTier === 'primary') { value += 20; }
  else if (input.topic.sourceTier === 'reputable') { value += 10; }
  else { notes.push('community source'); }
  if (input.clusterSize > 1) { value += 5; }
  value = clamp(value);
  return {
    value,
    reason: `Confidence ${Math.round(value)}${notes.length ? `: ${notes.join(', ')}` : ': complete metadata'}`,
  };
}

export function scoreTopic(topicId: number, input: ScoreInput): TopicScore {
  const text = `${input.topic.title} ${input.topic.summary}`;
  const summaryWords = wordCount(input.topic.summary);
  const engagement = input.engagement ?? 0;

  const freshness = scoreFreshness(input.topic.publishedAt);
  const relevance = scoreRelevance(text, input.sourceWeight, input.topic.sourceTier);
  const practical = scorePractical(text);
  const discussion = scoreDiscussion(text, engagement);
  const educational = scoreEducational(text, summaryWords);
  const originality = scoreOriginality(input.clusterSize, input.priorSimilarity);
  const audienceFit = scoreAudienceFit(text);
  const confidence = scoreConfidence(input, summaryWords);

  const breakdown: ScoreBreakdown = {
    freshness: freshness.value,
    relevance: relevance.value,
    practicalValue: practical.value,
    discussionPotential: discussion.value,
    educationalValue: educational.value,
    originality: originality.value,
    audienceFit: audienceFit.value,
  };

  const total = round(
    (Object.keys(WEIGHTS) as Array<keyof ScoreBreakdown>).reduce(
      (sum, key) => sum + breakdown[key] * WEIGHTS[key],
      0,
    ),
  );

  /**
   * LinkedIn rewards a strong opinionated hook on something current.
   * Medium rewards depth and something worth 1500 words.
   */
  const linkedinScore = round(
    clamp(
      breakdown.discussionPotential * 0.32 +
        breakdown.freshness * 0.24 +
        breakdown.practicalValue * 0.22 +
        breakdown.audienceFit * 0.22,
    ),
  );

  const mediumScore = round(
    clamp(
      breakdown.educationalValue * 0.36 +
        breakdown.practicalValue * 0.24 +
        breakdown.originality * 0.22 +
        breakdown.audienceFit * 0.18,
    ),
  );

  const controversy = round(
    clamp(breakdown.discussionPotential * 0.7 + (100 - breakdown.freshness) * 0.1),
  );

  return {
    topicId,
    ...breakdown,
    total,
    confidence: confidence.value,
    linkedinScore,
    mediumScore,
    controversy,
    reasons: [
      freshness.reason,
      relevance.reason,
      practical.reason,
      discussion.reason,
      educational.reason,
      originality.reason,
      audienceFit.reason,
      confidence.reason,
    ],
  };
}

/** Rounds every numeric field for display without changing stored precision. */
export function displayScore(score: TopicScore): TopicScore {
  return {
    ...score,
    freshness: Math.round(score.freshness),
    relevance: Math.round(score.relevance),
    practicalValue: Math.round(score.practicalValue),
    discussionPotential: Math.round(score.discussionPotential),
    educationalValue: Math.round(score.educationalValue),
    originality: Math.round(score.originality),
    audienceFit: Math.round(score.audienceFit),
    total: Math.round(score.total),
    confidence: Math.round(score.confidence),
    linkedinScore: Math.round(score.linkedinScore),
    mediumScore: Math.round(score.mediumScore),
    controversy: Math.round(score.controversy),
  };
}
