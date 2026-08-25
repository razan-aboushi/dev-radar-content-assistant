import { getNumberSetting, type DB } from '../db';
import { insertContent } from '../db/repositories';
import { createLogger } from '../logger';
import type { AIProvider } from '../ai/provider';
import { buildSystemPrompt } from './style';
import { buildHook } from './hooks';
import { detectAiTells, scoreStyle } from './evaluate';
import { languagePack, QUESTION_MARK } from './languages';
import { renderFactBlock, type GenerationContext } from './context';
import type { GeneratedContent, StyleScore } from '../types';

const log = createLogger('medium');

export interface MediumResult {
  content: GeneratedContent;
  attempts: number;
  belowThreshold: boolean;
}

/**
 * Medium articles are generated in two passes rather than one. Local 7–8B
 * models drift badly past roughly 800 tokens of continuous prose: they start
 * repeating, and the tail of the article reads nothing like the head. Writing
 * the outline first and then filling sections against it keeps each generation
 * short enough to stay in voice.
 */
export async function generateMedium(
  db: DB,
  context: GenerationContext,
  provider: AIProvider,
): Promise<MediumResult> {
  const minStyleScore = getNumberSetting(db, 'minStyleScore');
  const maxRewrites = getNumberSetting(db, 'maxStyleRewrites');
  const minWords = getNumberSetting(db, 'mediumMinWords');
  const maxWords = getNumberSetting(db, 'mediumMaxWords');

  const hook = buildHook(
    context.profile,
    context.angle.kind,
    context.topic,
    context.subject,
    context.language,
  );
  const title = articleTitle(context);
  const subtitle = articleSubtitle(context);

  const usable = await provider.available();
  let body: string;
  let mode: GeneratedContent['mode'] = 'scaffold';
  let styleScore: StyleScore;
  let attempts = 0;

  if (usable) {
    const system = buildSystemPrompt(context.profile, context.language);
    let feedback: string[] = [];
    let best: { body: string; score: StyleScore } | null = null;

    for (let attempt = 1; attempt <= maxRewrites + 1; attempt += 1) {
      attempts = attempt;
      try {
        const draft = await writeArticle(provider, system, context, hook, minWords, maxWords, feedback);
        const evaluated = evaluate(draft, context, minWords, maxWords);
        if (!best || evaluated.total > best.score.total) best = { body: draft, score: evaluated };

        if (evaluated.total >= minStyleScore) {
          return finish(db, context, hook, title, subtitle, draft, 'llm', evaluated, attempt, false);
        }
        log.info(`style score ${evaluated.total} < ${minStyleScore}, rewriting (attempt ${attempt})`);
        feedback = evaluated.notes;
      } catch (error) {
        log.warn(`generation failed on attempt ${attempt}`, error);
        break;
      }
    }

    if (best) {
      return finish(db, context, hook, title, subtitle, best.body, 'llm', best.score, attempts, true);
    }
  }

  body = scaffoldArticle(context, hook, title, subtitle);
  styleScore = evaluate(body, context, minWords, maxWords);
  mode = 'scaffold';
  return finish(db, context, hook, title, subtitle, body, mode, styleScore, attempts, true);
}

/** Pass 1: outline. Pass 2: prose for each section, in one call per group. */
async function writeArticle(
  provider: AIProvider,
  system: string,
  context: GenerationContext,
  hook: string,
  minWords: number,
  maxWords: number,
  feedback: string[],
): Promise<string> {
  const outlinePrompt = [
    'Plan a technical article. Return the plan only, nothing else.',
    '',
    `TOPIC: ${context.topic.title}`,
    `SOURCE SAYS: ${context.topic.summary || '(no summary available)'}`,
    `ANGLE (${context.angle.kind}): ${context.angle.title} — ${context.angle.description}`,
    '',
    renderFactBlock(context),
    '',
    'Return 7 to 9 section headings, one per line, no numbering, no explanation.',
    'The sections must cover, in this order: why this matters, a plain explanation,',
    'how it actually works, a real-world scenario, common mistakes, best practices,',
    'and a personal takeaway. Adapt the wording to the topic; do not use those labels verbatim.',
    ...languagePack(context.language).outputRule,
  ].join('\n');

  const outlineRaw = await provider.complete({
    system,
    prompt: outlinePrompt,
    temperature: 0.6,
    maxTokens: 400,
  });

  const sections = outlineRaw
    .split('\n')
    .map((line) => line.replace(/^[\s\-*#\d.)]+/, '').trim())
    .filter((line) => line.length > 3 && line.length < 120)
    .filter((line) => !isOutlinePreamble(line))
    .slice(0, 9);

  if (sections.length < 4) throw new Error('outline pass produced too few sections');

  const perSection = Math.round(Math.min(maxWords, Math.max(minWords, 1200)) / sections.length);
  const parts: string[] = [];

  // Sections are written in two halves so each call stays short, but the second
  // half receives the first so the article does not restate its own opening.
  const half = Math.ceil(sections.length / 2);
  for (const [index, group] of [sections.slice(0, half), sections.slice(half)].entries()) {
    if (group.length === 0) continue;
    const prompt = [
      index === 0
        ? `Write the opening of the article. Start with this line: "${hook}"`
        : 'Continue the same article. Do not repeat anything already written.',
      '',
      `ARTICLE TOPIC: ${context.topic.title}`,
      `ANGLE: ${context.angle.title}`,
      '',
      renderFactBlock(context),
      '',
      'WRITE THESE SECTIONS, each with a "## " markdown heading:',
      ...group.map((heading) => `- ${heading}`),
      '',
      `About ${perSection} words per section.`,
      'Include a short, correct code example where it genuinely helps. Use fenced blocks with a language tag.',
      'Never invent an API, a flag or a method that you are not certain exists. If unsure, describe it in prose instead of writing code.',
      'No preamble. Output the article text only.',
      ...languagePack(context.language).outputRule,
      index > 0 ? `\nALREADY WRITTEN (do not repeat):\n${truncateForPrompt(parts.join('\n\n'))}` : '',
      feedback.length ? `\nFIX THESE ISSUES FROM THE LAST DRAFT:\n${feedback.map((n) => `- ${n}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await provider.complete({ system, prompt, temperature: 0.82, maxTokens: 2200 });
    parts.push(cleanArticle(raw));
  }

  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function truncateForPrompt(text: string): string {
  return text.length > 2500 ? `${text.slice(0, 2500)}…` : text;
}

/**
 * Lines the model writes *about* the outline rather than as part of it.
 *
 * Against a real llama3.1:8b the outline pass answered "Here are the section
 * headings for the technical article:" before listing them. That line passed
 * the length filter, became section one, and the article opened with the
 * heading "## Here are the section headings for the technical article:".
 */
function isOutlinePreamble(line: string): boolean {
  return /^(?:here (?:are|is)|here's|below (?:are|is)|the following|sure|certainly|of course)\b/i.test(line)
    || /\b(?:section headings?|outline|article plan)\b\s*:?\s*$/i.test(line);
}

function cleanArticle(raw: string): string {
  let text = raw.trim();
  // Broader than "here's the": the model also opens with "Here are the…",
  // "Sure, here is…", "Below is…".
  text = text.replace(
    /^(?:(?:sure|certainly|of course)[,!]?\s*)?(?:here(?:'s| is| are)|below (?:is|are))\b[^\n]*:\s*\n?/i,
    '',
  );
  // Drop a leading heading of any level when it is talk about the article
  // rather than a section of it.
  text = text.replace(/^#{1,6}\s+([^\n]*)\n?/, (match, heading: string) =>
    isOutlinePreamble(heading.trim()) ? '' : match,
  );
  // Drop a duplicated H1; the title is stored separately.
  text = text.replace(/^#\s+.*\n/, '');
  return text.trim();
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
    kind: 'medium',
    language: context.language,
    minWords,
    maxWords,
    hasPersonalTake: rules.firstPerson.test(text),
    hasQuestion: QUESTION_MARK.test(text),
    hasConcreteDetail: /```|`[^`]+`|\bv?\d+\.\d+/.test(text) || context.claims.length > 0,
  });
}

function finish(
  db: DB,
  context: GenerationContext,
  hook: string,
  title: string,
  subtitle: string,
  body: string,
  mode: GeneratedContent['mode'],
  styleScore: StyleScore,
  attempts: number,
  belowThreshold: boolean,
): MediumResult {
  const { tells, bannedHits } = detectAiTells(body, context.profile, context.language);
  const content = insertContent(db, {
    topicId: context.topic.id,
    kind: 'medium',
    angleKind: context.angle.kind,
    mode,
    hook,
    title,
    subtitle,
    body,
    hashtags: context.hashtags.slice(0, 5),
    sources: context.sources,
    styleScore,
    aiTells: [...tells, ...bannedHits.map((h) => `banned phrase: ${h}`)],
    status: 'draft',
    model: mode === 'llm' ? (process.env.AI_PROVIDER ?? 'unknown') : null,
    createdAt: new Date().toISOString(),
    language: context.language,
  });
  return { content, attempts, belowThreshold };
}

/**
 * The headline is written here rather than by the model so it is stable and
 * reviewable. The subject stays in its original form — an Arabic article about
 * React Server Components still calls them React Server Components, because
 * that is what an Arabic-speaking developer searches for.
 */
function articleTitle(context: GenerationContext): string {
  const arabic = context.language === 'ar';
  switch (context.angle.kind) {
    case 'opinion':
      return arabic ? `هل نحتاج ${context.subject} فعلاً؟` : `Do we actually need ${context.subject}?`;
    case 'educational':
      return arabic ? `${context.subject}: شرح كما يجب` : `${context.subject}, explained properly`;
    default:
      return arabic
        ? `ما الذي يغيّره ${context.subject} في تطبيق إنتاجي حقيقي`
        : `What ${context.subject} changes in a real production app`;
  }
}

function articleSubtitle(context: GenerationContext): string {
  const arabic = context.language === 'ar';
  switch (context.angle.kind) {
    case 'opinion':
      return arabic
        ? 'نظرة على ما يحلّه، وما يكلّفه، ومتى يكون الخيار الخاطئ.'
        : 'A look at what it solves, what it costs, and when it is the wrong call.';
    case 'educational':
      return arabic
        ? 'ما هو، وكيف يعمل، والأجزاء التي يقفز عنها التوثيق.'
        : 'What it is, how it works, and the parts the docs skip past.';
    default:
      return arabic
        ? 'الأجزاء التي لا تظهر إلا بعد أن يصطدم بها تحميل حقيقي.'
        : 'The parts that only show up once real traffic hits it.';
  }
}

/** The no-LLM output: a fully researched outline, honestly labelled as an outline. */
export function scaffoldArticle(
  context: GenerationContext,
  hook: string,
  title: string,
  subtitle: string,
): string {
  const strings = languagePack(context.language).scaffold;

  const claims = context.claims.length
    ? context.claims.map((claim) => `- ${claim}`).join('\n')
    : strings.articleNoClaims;

  const sources = context.sources.map((url) => `- ${url}`).join('\n');

  return [
    `> ${subtitle}`,
    '',
    hook,
    '',
    `## ${strings.articleWhyThisMatters}`,
    '[Two or three paragraphs. Who hits this problem, and what it costs them.]',
    '',
    `## ${strings.articleWhatItIs}`,
    '[Plain explanation. Assume the reader has seen the headline and nothing else.]',
    '',
    `### ${strings.articleVerifiedFacts}`,
    claims,
    '',
    `## ${strings.articleHowItWorks}`,
    '[The mechanism. This is where a diagram or a short code example belongs.]',
    '',
    '```ts',
    strings.articleCodePlaceholder,
    '```',
    '',
    `## ${strings.articleScenarioHeading}`,
    strings.articleScenario(context.subject),
    '',
    `## ${strings.articleMistakes}`,
    '[Three or four. Each one: the mistake, why it looks reasonable, what it costs.]',
    '',
    `## ${strings.articleBestPractices}`,
    '[What you would tell a teammate on Monday.]',
    '',
    `## ${strings.articleTakeaway}`,
    '[First person. The thing you changed your mind about.]',
    '',
    `## ${strings.articleRemember}`,
    '[Three short bullets someone can screenshot.]',
    '',
    '---',
    '',
    `**${strings.articleSources}**`,
    sources,
    '',
    strings.articleOutlineFor(title),
  ].join('\n');
}
