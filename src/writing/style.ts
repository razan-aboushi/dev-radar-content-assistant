import fs from 'node:fs';
import path from 'node:path';
import { config, loadStyleProfile, saveStyleProfile } from '../config';
import { createLogger } from '../logger';
import { countEmoji, paragraphs, sentences, wordCount } from '../util/text';
import type { MeasuredStyle, StyleProfile } from '../types';

const log = createLogger('style');

/**
 * Style handling has two halves.
 *
 * The declared half lives in style/style-profile.json: the phrases, hooks and
 * banned wording you told the tool about.
 *
 * The measured half is computed from style/corpus/ — your own past posts, saved
 * as plain .md or .txt files by you. Nothing is scraped: LinkedIn blocks
 * automated access and scraping it risks your account, so the corpus is a
 * folder you paste into. `npm run style:learn` reads it and derives sentence
 * length, paragraph shape, question rate and emoji rate.
 *
 * Both halves are fed to the model as instructions. The corpus text itself is
 * never copied into output — only its statistics and your own opener lines are
 * used, and openers are only surfaced back to you as suggestions.
 */

export function loadProfile(): StyleProfile {
  return loadStyleProfile();
}

export interface CorpusDoc {
  file: string;
  text: string;
}

export function readCorpus(): CorpusDoc[] {
  if (!fs.existsSync(config.corpusDir)) return [];
  return fs
    .readdirSync(config.corpusDir)
    .filter((file) => /\.(md|txt)$/i.test(file) && !/^readme/i.test(file))
    .map((file) => ({
      file,
      text: fs.readFileSync(path.join(config.corpusDir, file), 'utf8').trim(),
    }))
    .filter((doc) => doc.text.length > 80);
}

/** Derives measurable style traits. Pure given the docs, so it is unit tested. */
export function measureStyle(docs: CorpusDoc[]): MeasuredStyle | null {
  if (docs.length === 0) return null;

  let totalSentences = 0;
  let totalSentenceWords = 0;
  let totalParagraphs = 0;
  let questionCount = 0;
  let firstPersonSentences = 0;
  let totalEmoji = 0;
  const openers: string[] = [];

  for (const doc of docs) {
    const paras = paragraphs(doc.text);
    totalParagraphs += paras.length;
    totalEmoji += countEmoji(doc.text);

    const firstPara = paras[0];
    if (firstPara) {
      const firstSentence = sentences(firstPara)[0];
      if (firstSentence && firstSentence.length <= 120) openers.push(firstSentence);
    }

    for (const sentence of sentences(doc.text)) {
      totalSentences += 1;
      totalSentenceWords += wordCount(sentence);
      if (sentence.trim().endsWith('?')) questionCount += 1;
      if (/\b(i|i'm|i've|my|me)\b/i.test(sentence)) firstPersonSentences += 1;
    }
  }

  if (totalSentences === 0) return null;

  return {
    sampleCount: docs.length,
    avgSentenceWords: round1(totalSentenceWords / totalSentences),
    avgParagraphSentences: round1(totalSentences / Math.max(totalParagraphs, 1)),
    questionRatio: round2(questionCount / totalSentences),
    firstPersonRatio: round2(firstPersonSentences / totalSentences),
    emojiPerPost: round1(totalEmoji / docs.length),
    topOpeners: openers.slice(0, 12),
  };
}

export function learnStyle(): { profile: StyleProfile; docCount: number } {
  const docs = readCorpus();
  const profile = loadProfile();
  const measured = measureStyle(docs);
  profile.measured = measured;
  saveStyleProfile(profile);
  if (measured) {
    log.info(
      `measured ${measured.sampleCount} sample(s): ${measured.avgSentenceWords} words/sentence, ` +
        `${measured.emojiPerPost} emoji/post, ${Math.round(measured.questionRatio * 100)}% questions`,
    );
  } else {
    log.warn(`no usable samples in ${config.corpusDir}. Falling back to the declared profile only.`);
  }
  return { profile, docCount: docs.length };
}

/**
 * The system prompt. Everything the model needs to write as Razan and nothing
 * about the specific topic, so it can be cached and reused across generations.
 */
export function buildSystemPrompt(profile: StyleProfile): string {
  const lines: string[] = [
    `You are ghost-writing as ${profile.name}, a frontend-focused software engineer who writes for other developers.`,
    '',
    'VOICE',
    '- Simple, clear, human, conversational. Talk directly to another developer.',
    '- Practical and specific. Every paragraph should either teach something or set up something that does.',
    '- Slightly humorous, never forced. Personal when there is a real observation to share.',
    '- Short sentences. Short paragraphs. Plain words over impressive ones.',
    '',
    'NEVER WRITE',
    '- Corporate or academic register. No filler transitions.',
    '- Fake motivation, hype, clickbait, or exaggerated claims.',
    '- Any of these phrases or anything close to them:',
    ...profile.bannedPhrases.slice(0, 40).map((phrase) => `  · ${phrase}`),
    '',
    'PHRASES THAT SOUND LIKE HER (use sparingly, do not force all of them in)',
    ...profile.signaturePhrases.map((phrase) => `  · ${phrase}`),
    '',
    'FACTS',
    '- You will be given a list of verified claims. Use only those.',
    '- Never invent release dates, version numbers, benchmarks, percentages, star counts, adoption figures or quotes.',
    '- If a claim is labelled single-source, hedge it ("reported by one source").',
    '- If a claim is labelled unverified, leave it out entirely.',
    '- If a feature is a proposal or experimental, say so plainly.',
  ];

  const measured = profile.measured;
  if (measured) {
    lines.push(
      '',
      'MEASURED FROM HER OWN PAST POSTS (match these, do not copy the posts)',
      `- Average sentence length: about ${measured.avgSentenceWords} words.`,
      `- Average paragraph: about ${measured.avgParagraphSentences} sentence(s).`,
      `- Roughly ${Math.round(measured.questionRatio * 100)}% of sentences are questions.`,
      `- Roughly ${Math.round(measured.firstPersonRatio * 100)}% of sentences use "I" or "my".`,
      `- About ${measured.emojiPerPost} emoji per post. Use only where one genuinely fits.`,
    );
  } else {
    lines.push(
      '',
      'No writing samples have been supplied yet, so follow the declared voice rules above closely.',
      'Keep sentences under about 18 words and paragraphs to one or two sentences.',
    );
  }

  return lines.join('\n');
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
