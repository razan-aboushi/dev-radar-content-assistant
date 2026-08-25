import { truncate } from '../util/text';
import type { Angle, AngleKind, Topic, TopicScore } from '../types';

/**
 * Three angles per topic, always the same three kinds so they can be compared
 * across topics. The recommendation is derived from the score breakdown rather
 * than picked arbitrarily: whichever component the topic is strongest on
 * decides which angle will land best.
 */

/** Trims a headline into a noun phrase usable inside a generated angle title. */
/** Verbs that separate the thing being announced from what it did. */
const HEADLINE_VERBS =
  /\s+(?:makes?|adds?|ships?|introduces?|brings?|gets?|lands?|replaces?|replaced|goes?|hits?|reaches?|drops?|removes?|deprecates?|improves?|fixes?|breaks?|is|are|was|were|now|will)\s+/i;

/** Question and framing openers that are not part of the subject. */
const LEADING_FRAME =
  /^(?:announcing|introducing|presenting|release[sd]?|why|how|what|do you really need|do we really need|do you need|you (?:probably )?don'?t need|stop using|understanding|inside)\s*:?\s+/i;

const LEADING_ARTICLE = /^(?:the|a|an|your|our|my|its)\s+/i;

export function subjectOf(topic: Pick<Topic, 'title'>): string {
  let text = topic.title
    .replace(/\s*[—–|]\s*(?:GitHub project|Node Weekly|JavaScript Weekly).*$/i, '')
    .replace(/,\s*(?:explained|revisited|in depth|a deep dive)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const cleaned = text;

  // Framing is stripped before the colon cut, otherwise "Announcing: React 19
  // ships the compiler" collapses to the word "Announcing".
  text = text.replace(LEADING_FRAME, '').trim();

  // "INP replaced FID: what actually changed" — keep the part before the colon.
  const colon = text.indexOf(': ');
  if (colon > 2) text = text.slice(0, colon).trim();

  // Cut the verb phrase and keep the subject. Three characters is enough:
  // acronyms like INP and CLS are legitimate subjects on their own.
  const verbMatch = HEADLINE_VERBS.exec(text);
  if (verbMatch && verbMatch.index >= 2) {
    const head = text.slice(0, verbMatch.index).trim();
    if (head.length >= 3) text = head;
  }

  text = text.replace(LEADING_ARTICLE, '').replace(/[?!.,;:]+$/, '').trim();

  // Never hand back a fragment shorter than a word.
  return truncate(text.length >= 3 ? text : cleaned, 70);
}

export function generateAngles(topic: Topic, score: TopicScore | null): Angle[] {
  const subject = subjectOf(topic);

  const angles: Angle[] = [
    {
      topicId: topic.id,
      kind: 'educational',
      title: `What ${subject} actually is, and why it matters`,
      description:
        'Explain the thing plainly for a developer who has seen the headline but has not read the docs. ' +
        'Best when the topic is genuinely new and most people have not formed an opinion yet.',
      recommended: false,
    },
    {
      topicId: topic.id,
      kind: 'opinion',
      title: `Do we actually need ${subject}?`,
      description:
        'Take a position and defend it. Best when developers are already split on the topic, ' +
        'because the comments do most of the work.',
      recommended: false,
    },
    {
      topicId: topic.id,
      kind: 'engineering-lesson',
      title: `What ${subject} changes in a real production app`,
      description:
        'Ground it in a system you have actually shipped: what breaks, what gets easier, what you would ' +
        'have to change on Monday. Best when you have first-hand experience to bring.',
      recommended: false,
    },
  ];

  const recommended = recommendAngle(score);
  for (const angle of angles) angle.recommended = angle.kind === recommended;
  return angles;
}

/**
 * Picks the angle the topic's own scores support. Ties break towards the
 * engineering lesson, because first-hand production detail is the hardest thing
 * for anyone else to reproduce.
 */
export function recommendAngle(score: TopicScore | null): AngleKind {
  if (!score) return 'engineering-lesson';

  const candidates: Array<{ kind: AngleKind; weight: number }> = [
    { kind: 'educational', weight: score.educationalValue * 0.6 + score.freshness * 0.4 },
    { kind: 'opinion', weight: score.discussionPotential * 0.7 + score.controversy * 0.3 },
    {
      kind: 'engineering-lesson',
      weight: score.practicalValue * 0.55 + score.audienceFit * 0.3 + score.originality * 0.15 + 3,
    },
  ];

  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0]?.kind ?? 'engineering-lesson';
}

export function angleByKind(angles: Angle[], kind: AngleKind): Angle | null {
  return angles.find((angle) => angle.kind === kind) ?? null;
}

export function recommendedAngle(angles: Angle[]): Angle | null {
  return angles.find((angle) => angle.recommended) ?? angles[0] ?? null;
}
