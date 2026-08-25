import { clamp, countEmoji, paragraphs, sentences, wordCount } from '../util/text';
import {
  QUESTION_MARK_AT_END,
  languagePack,
  type ContentLanguage,
} from './languages';
import type { StyleProfile, StyleScore } from '../types';

/**
 * Two gates run on every draft before it is shown.
 *
 *   detectAiTells() — pattern-matches the specific things that make text read as
 *                     machine-written. Any hit is reported, never silently fixed.
 *   scoreStyle()    — nine 0–100 dimensions from the brief, averaged.
 *
 * These are heuristics over surface features. They catch the obvious failures
 * (banned phrases, uniform sentence length, triadic lists, no first person);
 * they cannot judge whether an idea is interesting. Treat the number as a smoke
 * alarm, not a verdict.
 *
 * Every pattern lives in languages.ts, one set per language, because the
 * English set reads zero against Arabic and would fail every Arabic draft on
 * dimensions it never measured.
 */

export interface AiTellReport {
  tells: string[];
  bannedHits: string[];
}

export function detectAiTells(
  text: string,
  profile: StyleProfile,
  language: ContentLanguage = 'en',
): AiTellReport {
  const rules = languagePack(language).style;
  const lower = text.toLowerCase();
  const tells: string[] = [];

  for (const pattern of rules.aiPatterns) {
    if (pattern.re.test(text)) tells.push(pattern.label);
  }

  const banned = [...profile.bannedPhrases, ...rules.bannedPhrases];
  const bannedHits = banned.filter((phrase) => lower.includes(phrase.toLowerCase()));

  // Uniform sentence length is one of the strongest structural tells.
  const lengths = sentences(text).map(wordCount).filter((n) => n > 2);
  if (lengths.length >= 6) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / lengths.length;
    if (Math.sqrt(variance) < 3.2) {
      tells.push('sentence lengths are unusually uniform — vary the rhythm');
    }
  }

  // Three-item lists everywhere is another.
  const triads = text.match(/\b\w+,\s+\w+,?\s+and\s+\w+\b/g) ?? [];
  if (triads.length >= 3) tells.push(`${triads.length} rule-of-three lists — cut some`);

  return { tells, bannedHits: [...new Set(bannedHits)] };
}

export interface StyleScoreInput {
  text: string;
  profile: StyleProfile;
  kind: 'linkedin' | 'medium';
  /** Target word range, from settings. Falls back to the shipped defaults. */
  minWords?: number;
  maxWords?: number;
  /** Which language the draft is written in. Selects the pattern set. */
  language?: ContentLanguage;
  /** Whether the draft carries a real first-hand observation. */
  hasPersonalTake: boolean;
  /** Whether it ends on a question that invites replies. */
  hasQuestion: boolean;
  /** Whether it teaches a concrete, checkable thing. */
  hasConcreteDetail: boolean;
}

export function scoreStyle(input: StyleScoreInput): StyleScore {
  const { text, profile, kind } = input;
  const language = input.language ?? 'en';
  const rules = languagePack(language).style;
  const notes: string[] = [];

  const sents = sentences(text);
  const lengths = sents.map(wordCount).filter((n) => n > 0);
  const avgSentence = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const paras = paragraphs(text);
  const avgParaSentences = paras.length ? sents.length / paras.length : 0;
  const words = wordCount(text);

  const target = profile.measured?.avgSentenceWords ?? (kind === 'linkedin' ? 13 : 16);

  // simplicity: closeness to the target sentence length, penalising long ones harder.
  const drift = avgSentence - target;
  const simplicity = clamp(100 - Math.abs(drift) * (drift > 0 ? 6 : 3.5));
  if (avgSentence > target + 5) notes.push(`Sentences average ${Math.round(avgSentence)} words; aim for about ${target}.`);

  // conversational: informal markers, second person, short paragraphs.
  const informal = (text.match(rules.informal) ?? []).length;
  const secondPerson = (text.match(rules.secondPerson) ?? []).length;
  const conversational = clamp(
    30 + Math.min(informal, 8) * 5 + Math.min(secondPerson, 8) * 4 - Math.max(0, avgParaSentences - 3) * 8,
  );
  if (avgParaSentences > 3.5) notes.push('Paragraphs are long. Break them up.');

  // technicalClarity: concrete nouns, code or version references, no vagueness.
  // Deliberately language-neutral: an Arabic draft still writes `useEffect()`
  // and `v22.5.0` in Latin script, which is exactly the signal being counted.
  const concrete = (text.match(/`[^`]+`|\bv?\d+\.\d+|\b[A-Za-z]+\(\)|\b[a-z]+[A-Z][a-zA-Z]*\b/g) ?? []).length;
  const vague = (text.match(rules.vague) ?? []).length;
  const technicalClarity = clamp(35 + Math.min(concrete, 12) * 5 - vague * 8 + (input.hasConcreteDetail ? 15 : 0));
  if (!input.hasConcreteDetail) notes.push('No concrete, checkable detail. Add a specific version, API, number or symptom.');

  // personality: first person plus at least one signature-ish move.
  const firstPerson = (text.match(rules.firstPerson) ?? []).length;
  const signatureHits = profile.signaturePhrases.filter((p) =>
    text.toLowerCase().includes(p.toLowerCase().slice(0, 18)),
  ).length;
  const personality = clamp(
    20 + Math.min(firstPerson, 8) * 7 + signatureHits * 10 + (input.hasPersonalTake ? 15 : 0),
  );
  if (firstPerson === 0) notes.push('No first-person voice anywhere. Add the part only you could have written.');

  // usefulness: does the reader leave with something they can do.
  const actionable = (text.match(rules.actionable) ?? []).length;
  const usefulness = clamp(30 + Math.min(actionable, 10) * 6 + (input.hasConcreteDetail ? 12 : 0));

  // originality: penalise generic openers and banned phrasing.
  const { tells, bannedHits } = detectAiTells(text, profile, language);
  const originality = clamp(90 - bannedHits.length * 25 - tells.length * 9);
  for (const hit of bannedHits) notes.push(`Banned phrase present: "${hit}".`);
  for (const tell of tells.slice(0, 4)) notes.push(`AI tell: ${tell}.`);

  // hookStrength: the first line has to do the work.
  const firstLine = (text.split('\n').find((line) => line.trim().length > 0) ?? '').trim();
  const hookWords = wordCount(firstLine);
  let hookStrength = 45;
  if (hookWords > 0 && hookWords <= 16) hookStrength += 20;
  if (/[?؟.]$|\.\.\.$/.test(firstLine)) hookStrength += 8;
  if (rules.hookPronouns.test(firstLine)) hookStrength += 12;
  if (rules.weakOpener.test(firstLine)) hookStrength -= 25;
  if (hookWords > 25) hookStrength -= 20;
  hookStrength = clamp(hookStrength);
  if (hookStrength < 60) notes.push('Weak first line. Lead with the surprising part.');

  // naturalness: emoji rate near target, no banned phrases, varied rhythm.
  const emojiTarget = profile.measured?.emojiPerPost ?? (kind === 'linkedin' ? 3 : 1);
  const emoji = countEmoji(text);
  const naturalness = clamp(
    85 - Math.abs(emoji - emojiTarget) * 6 - bannedHits.length * 20 - tells.length * 7,
  );
  if (emoji > emojiTarget + 3) notes.push('Too many emoji.');

  // discussionPotential: a real question, an opinion, a stake.
  const questions = sents.filter((s) => QUESTION_MARK_AT_END.test(s.trim())).length;
  const opinionated = rules.opinionated.test(text);
  const discussionPotential = clamp(
    30 + questions * 14 + (opinionated ? 20 : 0) + (input.hasQuestion ? 15 : 0),
  );
  if (!input.hasQuestion && kind === 'linkedin') notes.push('No closing question. Give people something to reply to.');

  // Length compliance is a hard note rather than a scored dimension. The bounds
  // come from settings; they used to be hardcoded here, so changing
  // linkedinMinWords or mediumMaxWords in the dashboard changed the prompt but
  // not the review note that judged the result against it.
  const minWords = input.minWords ?? (kind === 'linkedin' ? 150 : 1000);
  const maxWords = input.maxWords ?? (kind === 'linkedin' ? 300 : 1800);
  // A 20% grace band either side, so a draft is not flagged for one word over.
  const floor = Math.round(minWords * 0.8);
  const ceiling = Math.round(maxWords * 1.13);
  if (words < floor || words > ceiling) {
    const label = kind === 'linkedin' ? 'LinkedIn' : 'Medium';
    notes.push(`${label} draft is ${words} words; target ${minWords}–${maxWords}.`);
  }

  const dimensions = {
    simplicity,
    conversational,
    technicalClarity,
    personality,
    usefulness,
    originality,
    hookStrength,
    naturalness,
    discussionPotential,
  };

  const total = Math.round(
    Object.values(dimensions).reduce((sum, value) => sum + value, 0) / Object.keys(dimensions).length,
  );

  return { ...roundAll(dimensions), total, notes };
}

function roundAll<T extends Record<string, number>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v)])) as T;
}
