import { getNumberSetting, type DB } from '../db';
import { insertContent } from '../db/repositories';
import { createLogger } from '../logger';
import { wordCount } from '../util/text';
import type { AIProvider } from '../ai/provider';
import { buildSystemPrompt } from './style';
import { buildHook, alternativeHooks } from './hooks';
import { detectAiTells, scoreStyle } from './evaluate';
import { renderFactBlock, type GenerationContext } from './context';
import type { GeneratedContent, StyleScore } from '../types';

const log = createLogger('linkedin');

export interface GenerateResult {
  content: GeneratedContent;
  alternativeHooks: string[];
  attempts: number;
  /** Populated when the style gate never reached the threshold. */
  belowThreshold: boolean;
}

export async function generateLinkedIn(
  db: DB,
  context: GenerationContext,
  provider: AIProvider,
): Promise<GenerateResult> {
  const minStyleScore = getNumberSetting(db, 'minStyleScore');
  const maxRewrites = getNumberSetting(db, 'maxStyleRewrites');
  const minWords = getNumberSetting(db, 'linkedinMinWords');
  const maxWords = getNumberSetting(db, 'linkedinMaxWords');

  const hook = buildHook(context.profile, context.angle.kind, context.topic, context.subject);
  const usable = await provider.available();
  let attempts = 0;

  if (usable) {
    const system = buildSystemPrompt(context.profile);
    let feedback: string[] = [];
    // The best draft so far is kept, so a transient provider failure on a
    // rewrite falls back to the previous LLM draft rather than throwing away a
    // usable post and emitting a scaffold. medium.ts already worked this way.
    let best: { body: string; score: StyleScore } | null = null;

    for (let attempt = 1; attempt <= maxRewrites + 1; attempt += 1) {
      attempts = attempt;
      const prompt = buildPrompt(context, hook, minWords, maxWords, feedback);
      let draft: string;
      try {
        draft = await provider.complete({ system, prompt, temperature: 0.85, maxTokens: 1200 });
      } catch (error) {
        log.warn(`generation failed on attempt ${attempt}`, error);
        break;
      }

      const cleaned = cleanDraft(draft, context);
      const evaluated = evaluate(cleaned, context, minWords, maxWords);
      if (!best || evaluated.total > best.score.total) best = { body: cleaned, score: evaluated };

      if (evaluated.total >= minStyleScore) {
        return finish(db, context, hook, cleaned, 'llm', evaluated, attempts, false);
      }

      log.info(`style score ${evaluated.total} < ${minStyleScore}, rewriting (attempt ${attempt})`);
      feedback = evaluated.notes;
    }

    if (best) {
      return finish(db, context, hook, best.body, 'llm', best.score, attempts, true);
    }
  }

  // No model, or the model failed before producing anything. Scaffold, labelled.
  const body = scaffold(context, hook);
  const styleScore = evaluate(body, context, minWords, maxWords);
  return finish(db, context, hook, body, 'scaffold', styleScore, attempts, styleScore.total < minStyleScore);
}

function evaluate(
  text: string,
  context: GenerationContext,
  minWords: number,
  maxWords: number,
): StyleScore {
  return scoreStyle({
    text,
    profile: context.profile,
    kind: 'linkedin',
    minWords,
    maxWords,
    hasPersonalTake: /\b(?:I|my|I've|I'm)\b/.test(text),
    hasQuestion: /\?\s*$/m.test(text.split('#')[0] ?? text),
    hasConcreteDetail: context.claims.length > 0 || /`[^`]+`|\bv?\d+\.\d+/.test(text),
  });
}

function finish(
  db: DB,
  context: GenerationContext,
  hook: string,
  body: string,
  mode: GeneratedContent['mode'],
  styleScore: StyleScore,
  attempts: number,
  belowThreshold: boolean,
): GenerateResult {
  const { tells, bannedHits } = detectAiTells(body, context.profile);
  const content = insertContent(db, {
    topicId: context.topic.id,
    kind: 'linkedin',
    angleKind: context.angle.kind,
    mode,
    hook,
    title: context.angle.title,
    subtitle: '',
    body,
    hashtags: context.hashtags,
    sources: context.sources,
    styleScore,
    aiTells: [...tells, ...bannedHits.map((h) => `banned phrase: ${h}`)],
    status: 'draft',
    model: mode === 'llm' ? `${process.env.AI_PROVIDER ?? 'unknown'}` : null,
    createdAt: new Date().toISOString(),
  });

  return {
    content,
    alternativeHooks: alternativeHooks(context.profile, context.angle.kind, context.topic, context.subject),
    attempts,
    belowThreshold,
  };
}

function buildPrompt(
  context: GenerationContext,
  hook: string,
  minWords: number,
  maxWords: number,
  feedback: string[],
): string {
  const lines = [
    `Write one LinkedIn post about this topic.`,
    '',
    `TOPIC: ${context.topic.title}`,
    `WHAT THE SOURCE SAYS: ${context.topic.summary || '(no summary available)'}`,
    `ANGLE (${context.angle.kind}): ${context.angle.title}`,
    `ANGLE BRIEF: ${context.angle.description}`,
    '',
    renderFactBlock(context),
    '',
    'STRUCTURE',
    `1. Open with this hook, or something equally sharp in the same spirit: "${hook}"`,
    `2. Greeting on its own line: "${context.profile.greetings[0] ?? 'Hello Everyone! 💛'}"`,
    '3. The observation or problem, in plain language.',
    '4. A concrete example a developer would recognise.',
    '5. Why it matters — the part people miss.',
    '6. Your own take or the lesson, in first person.',
    '7. A closing question that people can actually answer from experience.',
    '',
    'RULES',
    `- ${minWords}–${maxWords} words, not counting hashtags.`,
    '- Short paragraphs, one or two sentences each. Blank line between them.',
    '- Do not include hashtags; they are appended separately.',
    '- Do not write a title or a heading. Start with the hook line.',
    '- Do not use markdown formatting, bold or bullet characters. LinkedIn renders plain text.',
    '- Output only the post text. No preamble, no explanation, no quotation marks around it.',
  ];

  if (context.nearMatches.length > 0) {
    lines.push(
      '',
      'ALREADY COVERED (find a different angle, do not repeat these):',
      ...context.nearMatches.map((match) => `- ${match.title}`),
    );
  }

  if (feedback.length > 0) {
    lines.push(
      '',
      'THE PREVIOUS DRAFT FAILED REVIEW. FIX EXACTLY THESE:',
      ...feedback.map((note) => `- ${note}`),
    );
  }

  return lines.join('\n');
}

/** Removes the wrappers models like to add. */
function cleanDraft(raw: string, context: GenerationContext): string {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  text = text.replace(/^(?:here(?:'s| is) (?:the|your|a) [^\n:]*:?\s*)/i, '');
  text = text.replace(/^["'](.*)["']$/s, '$1');
  // Strip any hashtag block the model added anyway; hashtags are appended later.
  text = text.replace(/(?:^|\n)(?:#[A-Za-z0-9_]+\s*)+$/g, '');
  // Strip markdown emphasis LinkedIn cannot render.
  text = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');
  void context;
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The no-LLM output. This is a structured draft with the research already
 * filled in — it is NOT publishable prose, and the CLI and dashboard both say
 * so. The value here is that the hook, the verified claims, the angle and the
 * sources are assembled and correct; the sentences are yours to write.
 */
export function scaffold(context: GenerationContext, hook: string): string {
  const greeting = context.profile.greetings[0] ?? 'Hello Everyone! 💛';
  const claims = context.claims.length
    ? context.claims.map((claim) => `  - ${claim}`).join('\n')
    : '  - (No verifiable claim was extracted. Open the source link before writing anything factual.)';

  return [
    hook,
    '',
    greeting,
    '',
    '[OBSERVATION] Say plainly what changed or what people get wrong. Two sentences.',
    '',
    '[EXAMPLE] The concrete case a developer would recognise. Use one of these verified facts:',
    claims,
    '',
    '[WHY IT MATTERS] The part most people skip past. Two sentences.',
    '',
    `[YOUR TAKE] First person. What you would actually do about ${context.subject}, and why.`,
    '',
    '[QUESTION] One question people can answer from their own experience.',
  ].join('\n');
}

/** Assembles the final copy-paste text: body, blank line, hashtags. */
export function renderForPublishing(content: GeneratedContent): string {
  const parts = [content.body.trim()];
  if (content.hashtags.length > 0) parts.push(content.hashtags.join(' '));
  return parts.join('\n\n');
}

export function linkedInWordCount(content: GeneratedContent): number {
  return wordCount(content.body);
}
