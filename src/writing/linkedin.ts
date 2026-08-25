import { getNumberSetting, type DB } from '../db';
import { insertContent } from '../db/repositories';
import { createLogger } from '../logger';
import type { AIProvider } from '../ai/provider';
import { buildSystemPrompt, voiceFor } from './style';
import { buildHook, alternativeHooks } from './hooks';
import { detectAiTells, scoreStyle } from './evaluate';
import { languagePack, QUESTION_MARK_AT_END } from './languages';
import { renderPublishText } from './publish';
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

  const hook = buildHook(
    context.profile,
    context.angle.kind,
    context.topic,
    context.subject,
    context.language,
  );
  const usable = await provider.available();
  let attempts = 0;

  if (usable) {
    const system = buildSystemPrompt(context.profile, context.language);
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

      const cleaned = cleanDraft(draft);
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
  const rules = languagePack(context.language).style;
  return scoreStyle({
    text,
    profile: context.profile,
    kind: 'linkedin',
    language: context.language,
    minWords,
    maxWords,
    hasPersonalTake: rules.firstPerson.test(text),
    // Look before the hashtag block: the closing question is the last line of
    // the post, and the tags come after it.
    hasQuestion: QUESTION_MARK_AT_END.test((text.split('#')[0] ?? text).trimEnd()),
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
  const { tells, bannedHits } = detectAiTells(body, context.profile, context.language);
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
    language: context.language,
  });

  return {
    content,
    alternativeHooks: alternativeHooks(
      context.profile,
      context.angle.kind,
      context.topic,
      context.subject,
      context.language,
    ),
    attempts,
    belowThreshold,
  };
}

export function buildPrompt(
  context: GenerationContext,
  hook: string,
  minWords: number,
  maxWords: number,
  feedback: string[] = [],
): string {
  const pack = languagePack(context.language);
  const greeting = voiceFor(context.profile, context.language).greeting;

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
    `2. Greeting on its own line: "${greeting}"`,
    '3. The observation or problem, in plain language.',
    '4. A concrete example a developer would recognise.',
    '5. Why it matters — the part people miss.',
    '6. Your own take or the lesson, in first person.',
    '7. A closing question that people can actually answer from experience.',
    '',
    'RULES',
    ...pack.outputRule,
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
export function cleanDraft(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  text = text.replace(/^(?:here(?:'s| is) (?:the|your|a) [^\n:]*:?\s*)/i, '').trim();

  // Hashtags first, then the surrounding quotes. A model that both wrapped the
  // post in quotes and appended tags left the closing quote no longer at the
  // end of the string, so the unwrap silently did nothing and the post shipped
  // with a stray « on the front. \p{L} rather than A-Za-z: an Arabic hashtag is
  // still a hashtag, and one left in the body was then appended a second time.
  text = text.replace(/(?:^|\n)\s*(?:#[\p{L}\p{N}_]+[ \t]*)+$/u, '').trim();
  text = text.replace(/^["'\u201C\u00AB]([\s\S]*)["'\u201D\u00BB]$/, '$1').trim();

  // Strip markdown emphasis LinkedIn cannot render.
  text = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The no-LLM output. This is a structured draft with the research already
 * filled in — it is NOT publishable prose, and the CLI and dashboard both say
 * so. The value here is that the hook, the verified claims, the angle and the
 * sources are assembled and correct; the sentences are yours to write.
 */
export function scaffold(context: GenerationContext, hook: string): string {
  const pack = languagePack(context.language);
  const strings = pack.scaffold;
  const greeting = voiceFor(context.profile, context.language).greeting;
  const claims = context.claims.length
    ? context.claims.map((claim) => `  - ${claim}`).join('\n')
    : `  - ${strings.noClaims}`;

  return [
    hook,
    '',
    greeting,
    '',
    strings.observation,
    '',
    strings.example,
    claims,
    '',
    strings.whyItMatters,
    '',
    strings.yourTake(context.subject),
    '',
    strings.question,
  ].join('\n');
}

/**
 * Kept as the historical name for the LinkedIn renderer. New code should call
 * renderPublishText, which handles both kinds.
 */
export function renderForPublishing(content: GeneratedContent): string {
  return renderPublishText(content);
}
