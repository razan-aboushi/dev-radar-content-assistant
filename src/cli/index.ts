import { config } from '../config';
import { allSettings, getDb, setSetting, DEFAULT_SETTINGS, type DB } from '../db';
import {
  getScore,
  getTopic,
  getTopicBySlug,
  insertPriorContent,
  listAngles,
  listContent,
  listFacts,
  listRuns,
  listScoredTopics,
  listSources,
  setSourceEnabled,
  updateTopicStatus,
} from '../db/repositories';
import { getProvider } from '../ai/provider';
import { runResearch } from '../pipeline/run';
import { displayScore } from '../pipeline/score';
import { buildDaily, buildWeekly } from '../reports';
import { checkSource } from '../sources/adapters';
import { buildContext } from '../writing/context';
import { exportContent, exportDaily, type ExportFormat } from '../writing/export';
import { CONTENT_LANGUAGES, toContentLanguage, type ContentLanguage } from '../writing/languages';
import { generateLinkedIn } from '../writing/linkedin';
import { generateMedium } from '../writing/medium';
import { publishWordCount, renderPublishText } from '../writing/publish';
import { learnStyle, loadProfile } from '../writing/style';
import type { AngleKind, ScoreBreakdown } from '../types';

/* ----------------------------------------------------------- tiny arg parse */

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      if (!key) continue;
      if (inline !== undefined) {
        flags[key] = inline;
      } else {
        const next = rest[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

/* --------------------------------------------------------------- rendering */

const BAR_CHARS = '▁▂▃▄▅▆▇█';

function bar(value: number): string {
  const index = Math.min(BAR_CHARS.length - 1, Math.max(0, Math.round((value / 100) * (BAR_CHARS.length - 1))));
  return BAR_CHARS[index] ?? '▁';
}

function scoreSparkline(score: ScoreBreakdown): string {
  return [
    score.freshness, score.relevance, score.practicalValue, score.discussionPotential,
    score.educationalValue, score.originality, score.audienceFit,
  ]
    .map(bar)
    .join('');
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/* ---------------------------------------------------------------- commands */

async function cmdRadar(db: DB, args: Args): Promise<void> {
  const only = typeof args.flags.source === 'string' ? args.flags.source.split(',') : undefined;
  out('Running research…');
  const result = await runResearch(db, { only, offline: args.flags.offline === true });

  out('');
  out(`Sources:  ${result.sourcesOk} ok, ${result.sourcesFailed} failed`);
  out(`Items:    ${result.itemsSeen} seen, ${result.itemsNew} new`);
  out(
    `Topics:   ${result.topicsNew} new, ${result.topicsRejected} rejected as repeats, ` +
      `${result.topicsRescored} re-scored`,
  );

  if (result.failures.length > 0) {
    out('');
    out('Failed sources:');
    for (const failure of result.failures) out(`  ${pad(failure.source, 24)} ${failure.error}`);
    out('');
    out('Disable a broken source with:  npm run sources -- --disable <key>');
  }
  out('');
  out('Next:  npm run daily');
}

function cmdTopics(db: DB, args: Args): void {
  const minScore = args.flags.min ? Number(args.flags.min) : undefined;
  const status = typeof args.flags.status === 'string' ? args.flags.status : 'any';
  const limit = args.flags.limit ? Number(args.flags.limit) : 25;

  const rows = listScoredTopics(db, {
    status: status as 'any',
    minScore,
    limit,
    category: typeof args.flags.category === 'string' ? (args.flags.category as never) : undefined,
  });

  if (rows.length === 0) {
    out('No topics yet. Run:  npm run radar');
    return;
  }

  out(`${pad('SCORE', 6)}${pad('SIGNAL', 9)}${pad('LI', 4)}${pad('MED', 5)}${pad('CATEGORY', 20)}TOPIC`);
  out('─'.repeat(110));
  for (const row of rows) {
    const score = row.score ? displayScore(row.score) : null;
    out(
      pad(score ? String(Math.round(score.total)) : '—', 6) +
        pad(score ? scoreSparkline(score) : '', 9) +
        pad(score ? String(score.linkedinScore) : '—', 4) +
        pad(score ? String(score.mediumScore) : '—', 5) +
        pad(row.topic.category, 20) +
        row.topic.title.slice(0, 60),
    );
    out(`${' '.repeat(6)}${row.topic.slug}`);
  }
  out('');
  out('Signal bars: freshness · relevance · practical · discussion · educational · originality · fit');
  out('Details:     npm run topic -- <slug>');
}

function cmdTopic(db: DB, args: Args): void {
  const slug = args.positional[0];
  if (!slug) {
    out('Usage: npm run topic -- <slug>');
    process.exitCode = 1;
    return;
  }
  const topic = getTopicBySlug(db, slug) ?? (Number.isFinite(Number(slug)) ? getTopic(db, Number(slug)) : null);
  if (!topic) {
    out(`No topic with slug "${slug}".`);
    process.exitCode = 1;
    return;
  }

  const score = getScore(db, topic.id);
  out(topic.title);
  out('─'.repeat(Math.min(topic.title.length, 100)));
  out(`Category:  ${topic.category}`);
  out(`Status:    ${topic.status}${topic.rejectionReason ? ` — ${topic.rejectionReason}` : ''}`);
  out(`Published: ${topic.publishedAt ?? 'unknown'}`);
  out(`Source:    ${topic.sourceKey} (${topic.sourceTier})`);
  out(`Link:      ${topic.sourceUrl}`);
  if (topic.corroborationUrls.length > 1) {
    out(`Also at:   ${topic.corroborationUrls.slice(1).join('\n           ')}`);
  }

  if (topic.summary) {
    out('');
    out('Summary');
    out(wrap(topic.summary, 96, '  '));
  }

  if (score) {
    const display = displayScore(score);
    out('');
    out(`Score ${display.total}  (confidence ${display.confidence})   LinkedIn ${display.linkedinScore} · Medium ${display.mediumScore} · Controversy ${display.controversy}`);
    for (const reason of display.reasons) out(`  ${reason}`);
  }

  const facts = listFacts(db, topic.id);
  out('');
  out(`Facts (${facts.length})`);
  if (facts.length === 0) out('  Nothing checkable was extracted. Open the source before writing.');
  for (const fact of facts) {
    out(`  [${fact.status}] ${fact.claim}`);
    out(`      ${fact.note}`);
  }

  const angles = listAngles(db, topic.id);
  out('');
  out('Angles');
  for (const angle of angles) {
    out(`  ${angle.recommended ? '→' : ' '} ${pad(angle.kind, 20)} ${angle.title}`);
    out(`      ${wrap(angle.description, 90, '      ').trimStart()}`);
  }

  const drafts = listContent(db, topic.id);
  if (drafts.length > 0) {
    out('');
    out('Drafts');
    for (const draft of drafts) {
      out(`  ${pad(draft.kind, 10)} ${pad(draft.mode, 10)} style ${draft.styleScore?.total ?? '—'}  ${draft.createdAt}`);
    }
  }

  out('');
  out(`Generate:  npm run generate:linkedin -- ${topic.slug}`);
  out(`           npm run generate:medium -- ${topic.slug}`);
}

function cmdDaily(db: DB, args: Args): void {
  const report = buildDaily(db, args.flags.limit ? Number(args.flags.limit) : undefined);

  if (report.entries.length === 0) {
    out('Nothing on the radar. Run:  npm run radar');
    return;
  }

  out(`🔥 TOP ${report.entries.length} TOPICS TODAY — ${report.date}`);
  out(`   ${report.totalConsidered} topic(s) considered, minimum score ${report.minScore}`);
  out('');

  for (const entry of report.entries) {
    out(`${String(entry.rank).padStart(2)}. ${entry.topic.title}`);
    out(`    Why it matters:   ${entry.whyItMatters}`);
    out(`    Your audience:    ${entry.whyYourAudienceCares}`);
    out(`    Suggested angle:  ${entry.suggestedAngle}  (${entry.angleKind})`);
    out(`    LinkedIn ${entry.linkedinScore} · Medium ${entry.mediumScore}`);
    out(`    Source:           ${entry.topic.sourceUrl}`);
    out(`    Slug:             ${entry.topic.slug}`);
    out('');
  }

  if (report.top) {
    out('⭐ TOP RECOMMENDATION');
    out(`   ${report.top.topic.title}`);
    out(`   ${report.top.suggestedAngle}`);
    out('');
    out(`   npm run generate:linkedin -- ${report.top.topic.slug}`);
  }

  if (args.flags.export) {
    const markdown = dailyMarkdown(report);
    out('');
    out(`Written to ${exportDaily(markdown)}`);
  }
}

function dailyMarkdown(report: ReturnType<typeof buildDaily>): string {
  const lines = [`# Daily Radar — ${report.date}`, ''];
  for (const entry of report.entries) {
    lines.push(
      `## ${entry.rank}. ${entry.topic.title}`,
      '',
      `- **Why it matters:** ${entry.whyItMatters}`,
      `- **Your audience:** ${entry.whyYourAudienceCares}`,
      `- **Suggested angle:** ${entry.suggestedAngle} (${entry.angleKind})`,
      `- **LinkedIn:** ${entry.linkedinScore} · **Medium:** ${entry.mediumScore}`,
      `- **Source:** ${entry.topic.sourceUrl}`,
      `- **Slug:** \`${entry.topic.slug}\``,
      '',
    );
  }
  if (report.top) {
    lines.push('---', '', `**Top recommendation:** ${report.top.topic.title}`, '');
  }
  return lines.join('\n');
}

function cmdWeekly(db: DB): void {
  const report = buildWeekly(db);
  if (report.sections.length === 0) {
    out('Nothing from the last 7 days. Run:  npm run radar');
    return;
  }
  out(`WEEKLY DEVELOPER RADAR — ${report.from} to ${report.to}`);
  for (const section of report.sections) {
    out('');
    out(section.label.toUpperCase());
    for (const entry of section.entries) {
      out(`  ${pad(String(Math.round(entry.score?.total ?? 0)), 5)}${entry.topic.title.slice(0, 84)}`);
      out(`       ${entry.topic.slug}`);
    }
  }
  out('');
}

async function cmdSources(db: DB, args: Args): Promise<void> {
  if (typeof args.flags.disable === 'string') {
    setSourceEnabled(db, args.flags.disable, false);
    out(`Disabled ${args.flags.disable}`);
    return;
  }
  if (typeof args.flags.enable === 'string') {
    setSourceEnabled(db, args.flags.enable, true);
    out(`Enabled ${args.flags.enable}`);
    return;
  }

  const sources = listSources(db);

  if (args.flags.check) {
    out('Checking every enabled source. This makes one real request each.');
    out('');
    const enabled = sources.filter((s) => s.enabled);
    const results = [];
    for (const source of enabled) {
      const result = await checkSource(source);
      results.push(result);
      const label =
        result.status === 'ok' ? 'OK' : result.status === 'failed' ? 'FAIL' : 'WARN';
      out(`${pad(label, 7)}${pad(source.key, 26)}${result.detail}`);
    }
    out('');

    const ok = results.filter((r) => r.status === 'ok').length;
    const empty = results.filter((r) => r.status === 'empty').length;
    const unparseable = results.filter((r) => r.status === 'unparseable').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    out(`${ok} of ${enabled.length} source(s) returned usable items.`);
    if (empty > 0) out(`${empty} responded but produced no items matching the filters.`);
    if (unparseable > 0) out(`${unparseable} responded but the adapter could not parse the payload.`);
    if (failed > 0) {
      out(`${failed} could not be reached.`);
      out('');
      out('If every source failed the same way, suspect your network or a proxy');
      out('before assuming the URLs are wrong.');
    }
    if (empty + unparseable + failed > 0) {
      out('');
      out('Disable anything broken:  npm run sources -- --disable <key>');
      out('Feed URLs live in config/sources.json.');
    }
    return;
  }

  out(`${pad('', 4)}${pad('KEY', 26)}${pad('TIER', 11)}${pad('KIND', 17)}${pad('LAST', 12)}NAME`);
  out('─'.repeat(110));
  for (const source of sources) {
    const last = source.lastStatus ?? 'never';
    out(
      pad(source.enabled ? 'on' : 'off', 4) +
        pad(source.key, 26) +
        pad(source.tier, 11) +
        pad(source.kind, 17) +
        pad(last, 12) +
        source.name,
    );
    if (source.lastError) out(`    ↳ ${source.lastError.slice(0, 100)}`);
  }
  out('');
  out('Verify feeds respond:  npm run sources -- --check');
}

function cmdHistory(db: DB): void {
  const runs = listRuns(db, 10);
  out('RESEARCH RUNS');
  if (runs.length === 0) out('  none yet');
  for (const run of runs) {
    out(
      `  ${pad(run.startedAt.slice(0, 19), 21)}sources ${run.sourcesOk}/${run.sourcesOk + run.sourcesFailed}  ` +
        `items +${run.itemsNew}  topics +${run.topicsNew}`,
    );
  }

  out('');
  out('GENERATED CONTENT');
  const drafts = listContent(db, undefined, 25);
  if (drafts.length === 0) out('  none yet');
  for (const draft of drafts) {
    const topic = getTopic(db, draft.topicId);
    out(
      `  ${pad(draft.createdAt.slice(0, 10), 12)}${pad(draft.kind, 10)}${pad(draft.mode, 10)}` +
        `${pad(`style ${draft.styleScore?.total ?? '—'}`, 11)}${pad(draft.status, 11)}${topic?.title.slice(0, 46) ?? ''}`,
    );
  }

  out('');
  out('REJECTED TOPICS');
  const rejected = listScoredTopics(db, { status: 'rejected', limit: 15 });
  if (rejected.length === 0) out('  none');
  for (const entry of rejected) {
    out(`  ${entry.topic.title.slice(0, 70)}`);
    out(`     ${entry.topic.rejectionReason ?? ''}`);
  }
}

function cmdSettings(db: DB, args: Args): void {
  const [key, value] = args.positional;
  if (key && value !== undefined) {
    if (!(key in DEFAULT_SETTINGS)) {
      out(`Unknown setting "${key}". Known: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    setSetting(db, key, value);
    out(`${key} = ${value}`);
    return;
  }
  const settings = allSettings(db);
  for (const [name, current] of Object.entries(settings)) out(`${pad(name, 30)}${current}`);
  out('');
  out('Change one:  npm run settings -- minTopicScore 65');
}

async function cmdGenerate(db: DB, args: Args, kind: 'linkedin' | 'medium'): Promise<void> {
  const slug = args.positional[0];
  if (!slug) {
    out(
      `Usage: npm run generate:${kind} -- <slug> ` +
        `[--angle educational|opinion|engineering-lesson] [--language en|ar]`,
    );
    process.exitCode = 1;
    return;
  }

  const topic = getTopicBySlug(db, slug) ?? (Number.isFinite(Number(slug)) ? getTopic(db, Number(slug)) : null);
  if (!topic) {
    out(`No topic with slug "${slug}". List them with:  npm run topics`);
    process.exitCode = 1;
    return;
  }

  // Rejected outright rather than quietly falling back to English: silently
  // writing the wrong language is worse than refusing.
  const requestedLanguage = typeof args.flags.language === 'string' ? args.flags.language : 'en';
  if (!CONTENT_LANGUAGES.includes(requestedLanguage as ContentLanguage)) {
    out(`Unknown --language "${requestedLanguage}". Expected one of: ${CONTENT_LANGUAGES.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const language = toContentLanguage(requestedLanguage);

  const provider = getProvider();
  const available = await provider.available();
  if (!available) {
    out(`No language model available (AI_PROVIDER=${config.ai.provider}).`);
    out('Producing a research scaffold instead: hook, verified facts, angle and sources,');
    out('with the prose left for you to write. See the README to set up Ollama.');
    out('');
  }

  const context = buildContext(
    db,
    topic,
    getScore(db, topic.id),
    loadProfile(),
    typeof args.flags.angle === 'string' ? (args.flags.angle as AngleKind) : undefined,
    language,
  );

  if (context.nearMatches.length > 0) {
    out('⚠ Similar to work already in your history:');
    for (const match of context.nearMatches) {
      out(`   ${Math.round(match.similarity * 100)}%  ${match.title}`);
    }
    out('');
  }

  const result =
    kind === 'linkedin'
      ? await generateLinkedIn(db, context, provider)
      : await generateMedium(db, context, provider);

  const content = result.content;

  // Exactly what renderPublishText produces, so stdout, the file in out/ and
  // the dashboard's clipboard are the same characters.
  out('─'.repeat(78));
  out(renderPublishText(content));
  out('─'.repeat(78));
  out('');

  out(`Mode:        ${content.mode}${content.mode === 'scaffold' ? '  (outline — not publishable prose)' : ''}`);
  out(`Language:    ${content.language}`);
  out(`Words:       ${publishWordCount(content)}`);
  out(`Style score: ${content.styleScore?.total ?? '—'}/100${result.belowThreshold ? '  — below your threshold, review before posting' : ''}`);
  if (content.aiTells.length > 0) {
    out('Flagged:');
    for (const tell of content.aiTells) out(`  · ${tell}`);
  }
  if (content.styleScore?.notes.length) {
    out('Review notes:');
    for (const note of content.styleScore.notes) out(`  · ${note}`);
  }

  out('');
  out('Sources:');
  for (const url of content.sources) out(`  ${url}`);

  // Unvalidated, `--format pdf` wrote markdown into a file named .pdf.
  const requested = typeof args.flags.format === 'string' ? args.flags.format : 'md';
  const formats: ExportFormat[] = ['md', 'json', 'txt'];
  if (!formats.includes(requested as ExportFormat)) {
    out(`Unknown --format "${requested}". Expected one of: ${formats.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const file = exportContent(content, topic, requested as ExportFormat);
  out('');
  out(`Saved to ${file}`);
  out('Nothing is published automatically. Copy it yourself when you are happy with it.');

  if (args.flags.publish) {
    updateTopicStatus(db, topic.id, 'published');
    insertPriorContent(db, {
      platform: kind,
      title: content.title || topic.title,
      url: null,
      text: content.body,
      publishedAt: new Date().toISOString(),
    });
    out('Marked as published and added to your history, so it will not be suggested again.');
  } else {
    updateTopicStatus(db, topic.id, 'drafted');
  }
}

function cmdStyleLearn(): void {
  // learnStyle reads the corpus itself; reading it again here parsed every
  // sample twice and could disagree if a file changed between the two reads.
  const { profile, docCount } = learnStyle();
  if (docCount === 0) {
    out(`No samples found in ${config.corpusDir}.`);
    out('');
    out('Save some of your own past posts there as .md or .txt files — one post per file —');
    out('then run this again. The tool measures sentence length, paragraph shape, question');
    out('rate and emoji rate from them. It never copies the text into generated content.');
    return;
  }
  const measured = profile.measured;
  out(`Measured ${docCount} sample(s):`);
  if (measured) {
    out(`  ${measured.avgSentenceWords} words per sentence`);
    out(`  ${measured.avgParagraphSentences} sentences per paragraph`);
    out(`  ${Math.round(measured.questionRatio * 100)}% of sentences are questions`);
    out(`  ${Math.round(measured.firstPersonRatio * 100)}% use first person`);
    out(`  ${measured.emojiPerPost} emoji per post`);
  }
  out('');
  out(`Written to ${config.styleProfileFile}`);
}

function cmdHelp(): void {
  out('dev-radar — local developer content radar and writing assistant');
  out('');
  out('  npm run radar                     Fetch every source, score new topics');
  out('  npm run radar -- --offline        Re-score what is already stored, no network');
  out('  npm run daily                     Today\'s top topics and one recommendation');
  out('  npm run daily -- --export         …and write it to out/');
  out('  npm run weekly                    Weekly roundup by area');
  out('  npm run topics                    All scored topics');
  out('  npm run topics -- --min 70        …above a score');
  out('  npm run topic -- <slug>           Everything known about one topic');
  out('  npm run generate:linkedin -- <slug>');
  out('  npm run generate:medium -- <slug>');
  out('      --angle educational|opinion|engineering-lesson');
  out('      --language en|ar              Language of the draft (default en)');
  out('      --format md|json|txt          Export format (default md)');
  out('      --publish                     Mark done and add to history');
  out('  npm run sources                   List sources');
  out('  npm run sources -- --check        Test that each feed responds');
  out('  npm run sources -- --disable <key>');
  out('  npm run history                   Runs, drafts and rejections');
  out('  npm run settings                  Show settings');
  out('  npm run settings -- <key> <value>');
  out('  npm run style:learn               Measure your voice from style/corpus/');
  out('  npm run dashboard                 Web UI');
}

function wrap(text: string, width: number, indent = ''): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = indent;
  for (const word of words) {
    if (line.length + word.length + 1 > width && line.trim().length > 0) {
      lines.push(line);
      line = indent;
    }
    line += (line === indent ? '' : ' ') + word;
  }
  if (line.trim()) lines.push(line);
  return lines.join('\n');
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.flags.help) {
    cmdHelp();
    return;
  }

  const db = getDb();

  switch (args.command) {
    case 'radar': await cmdRadar(db, args); break;
    case 'topics': cmdTopics(db, args); break;
    case 'topic': cmdTopic(db, args); break;
    case 'daily': cmdDaily(db, args); break;
    case 'weekly': cmdWeekly(db); break;
    case 'sources': await cmdSources(db, args); break;
    case 'history': cmdHistory(db); break;
    case 'settings': cmdSettings(db, args); break;
    case 'style:learn': cmdStyleLearn(); break;
    case 'generate:linkedin': await cmdGenerate(db, args, 'linkedin'); break;
    case 'generate:medium': await cmdGenerate(db, args, 'medium'); break;
    default:
      out(`Unknown command "${args.command}".`);
      out('');
      cmdHelp();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
