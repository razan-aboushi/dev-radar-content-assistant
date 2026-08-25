import fs from 'node:fs';
import path from 'node:path';
import { allSettings, getNumberSetting, type DB } from './db';
import {
  getScore,
  listAngles,
  listContent,
  listFacts,
  listRuns,
  listScoredTopics,
  listSources,
} from './db/repositories';
import { createLogger } from './logger';
import { displayScore, opportunityScore } from './pipeline/score';
import { buildDaily, buildWeekly } from './reports';
import { buildContext } from './writing/context';
import { publishWordCount, renderPublishText } from './writing/publish';
import { languagePack } from './writing/languages';
import { loadProfile } from './writing/style';
import type { Language } from './types';

/**
 * Freezes the database into static JSON the dashboard can read with no server.
 *
 * This is what makes free always-on hosting possible. A scheduled GitHub
 * Action runs the radar, calls this, and commits the result; GitHub Pages
 * serves it. There is no backend to keep awake, nothing to pay for, and no
 * cold start — the site is a handful of JSON files behind a CDN.
 *
 * The shapes here mirror the live API exactly, so the client does not care
 * which one it is talking to. Anything that requires a database write —
 * running research, rejecting a topic, saving settings — is simply absent in
 * snapshot mode, and the client hides those controls rather than offering
 * buttons that cannot work.
 *
 * Both languages are emitted, because the report prose is assembled
 * server-side and there is no server to re-ask once this is published.
 */

const log = createLogger('snapshot');

export interface SnapshotOptions {
  /** Directory to write into. Created if missing. */
  outDir: string;
  /** How many topics to include. The rest are dropped to keep the site small. */
  topicLimit?: number;
}

export interface SnapshotManifest {
  generatedAt: string;
  topicCount: number;
  draftCount: number;
  languages: Language[];
  /** Set when the snapshot was produced by CI rather than by hand. */
  source: 'local' | 'ci';
}

const LANGUAGES: Language[] = ['en', 'ar'];

function writeJson(dir: string, name: string, data: unknown): number {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${JSON.stringify(data)}\n`;
  fs.writeFileSync(file, payload, 'utf8');
  return Buffer.byteLength(payload);
}

export function buildSnapshot(db: DB, options: SnapshotOptions): SnapshotManifest {
  const outDir = options.outDir;
  const limit = options.topicLimit ?? 120;
  fs.mkdirSync(outDir, { recursive: true });

  const rows = listScoredTopics(db, { status: 'any', limit, sort: 'opportunity' });
  const profile = loadProfile();

  // One file per language for the reports, because their prose is built on the
  // server and cannot be re-rendered by a static client.
  for (const language of LANGUAGES) {
    writeJson(outDir, `overview.${language}.json`, {
      daily: serialiseDaily(buildDaily(db, undefined, language)),
      provider: { name: 'snapshot', model: 'none', available: false },
      sources: {
        total: listSources(db).length,
        enabled: listSources(db, true).length,
        failing: listSources(db).filter((s) => s.lastStatus === 'error').length,
      },
      lastRun: listRuns(db, 1)[0] ?? null,
    });
    writeJson(outDir, `weekly.${language}.json`, buildWeekly(db, language));
  }

  writeJson(
    outDir,
    'topics.json',
    rows.map((row) => ({
      topic: row.topic,
      score: row.score ? displayScore(row.score) : null,
      opportunity: row.score ? opportunityScore(row.score) : 0,
    })),
  );

  // One file per topic, so opening a topic fetches a few kilobytes rather than
  // the whole corpus.
  let draftCount = 0;
  for (const row of rows) {
    const id = row.topic.id;
    const score = getScore(db, id);
    const context = buildContext(db, row.topic, score, profile);
    const drafts = listContent(db, id).map((content) => ({
      ...content,
      publishText: renderPublishText(content),
      wordCount: publishWordCount(content),
      dir: languagePack(content.language).dir,
    }));
    draftCount += drafts.length;

    writeJson(outDir, `topic/${id}.json`, {
      topic: row.topic,
      score: score ? displayScore(score) : null,
      opportunity: score ? opportunityScore(score) : 0,
      facts: listFacts(db, id),
      angles: listAngles(db, id),
      drafts,
      nearMatches: context.nearMatches,
      hashtags: context.hashtags,
    });
  }

  writeJson(outDir, 'sources.json', listSources(db));

  writeJson(outDir, 'history.json', {
    runs: listRuns(db, 15),
    drafts: listContent(db, undefined, 40).map((draft) => ({
      ...draft,
      publishText: renderPublishText(draft),
      wordCount: publishWordCount(draft),
      dir: languagePack(draft.language).dir,
      topicTitle: rows.find((r) => r.topic.id === draft.topicId)?.topic.title ?? '',
    })),
    rejected: listScoredTopics(db, { status: 'rejected', limit: 30 }).map((r) => r.topic),
    published: listScoredTopics(db, { status: 'published', limit: 30 }).map((r) => r.topic),
  });

  writeJson(outDir, 'settings.json', {
    settings: allSettings(db),
    provider: 'snapshot',
    model: 'none',
    minStyleScore: getNumberSetting(db, 'minStyleScore'),
  });

  const manifest: SnapshotManifest = {
    generatedAt: new Date().toISOString(),
    topicCount: rows.length,
    draftCount,
    languages: LANGUAGES,
    source: process.env.CI === 'true' ? 'ci' : 'local',
  };
  writeJson(outDir, 'manifest.json', manifest);

  log.info(`snapshot: ${rows.length} topic(s), ${draftCount} draft(s) → ${outDir}`);
  return manifest;
}

function serialiseDaily(report: ReturnType<typeof buildDaily>) {
  return {
    ...report,
    entries: report.entries.map((entry) => ({
      ...entry,
      score: entry.score ? displayScore(entry.score) : null,
    })),
  };
}
