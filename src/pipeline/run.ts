import { getNumberSetting, type DB } from '../db';
import {
  finishRun,
  getTopicBySlug,
  insertItems,
  insertTopic,
  listPriorContent,
  listRecentItems,
  listSources,
  recordSourceFetch,
  replaceAngles,
  replaceFacts,
  setCorroboration,
  startRun,
  updateTopicStatus,
  upsertScore,
  type SourceRecord,
} from '../db/repositories';
import { createLogger, recentLog } from '../logger';
import { getAdapter } from '../sources/adapters';
import { slugify } from '../util/text';
import { clusterItems, checkRepeat } from './dedupe';
import { generateAngles } from './angles';
import { scoreAudienceInterest } from './interest';
import { opportunityScore, scoreTopic } from './score';
import { detectCategory } from './signals';
import { extractFacts } from './verify';
import type { NormalizedItem, SourceTier, StoredItem, Topic } from '../types';

const log = createLogger('pipeline');

export interface RunResult {
  runId: number;
  sourcesOk: number;
  sourcesFailed: number;
  failures: Array<{ source: string; error: string }>;
  itemsSeen: number;
  itemsNew: number;
  topicsNew: number;
  topicsRejected: number;
  /** Existing topics re-scored against the current settings. */
  topicsRescored: number;
}

export interface RunOptions {
  /** Restrict to specific source keys. Empty means all enabled sources. */
  only?: string[];
  /** Skip network entirely and re-score items already in the database. */
  offline?: boolean;
}

/**
 * STEP 1-8 of the brief. Collect, normalise, dedupe, extract, score, verify,
 * check against prior content, generate angles.
 *
 * Failures are per-source: one dead feed never fails the run.
 */
export async function runResearch(db: DB, options: RunOptions = {}): Promise<RunResult> {
  const runId = startRun(db);
  const sources = listSources(db, true).filter(
    (source) => !options.only?.length || options.only.includes(source.key),
  );

  let itemsSeen = 0;
  let itemsNew = 0;
  const failures: Array<{ source: string; error: string }> = [];

  if (!options.offline) {
    log.info(`collecting from ${sources.length} source(s)`);
    const collected = await Promise.allSettled(sources.map((source) => collectSource(source)));

    collected.forEach((result, index) => {
      const source = sources[index];
      if (!source) return;
      if (result.status === 'fulfilled') {
        itemsSeen += result.value.length;
        const { inserted } = insertItems(db, result.value);
        itemsNew += inserted.length;
        recordSourceFetch(db, source.key, 'ok', null);
        log.info(`${source.key}: ${result.value.length} item(s), ${inserted.length} new`);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push({ source: source.key, error: message });
        recordSourceFetch(db, source.key, 'error', message);
        log.warn(`${source.key} failed: ${message}`);
      }
    });
  } else {
    log.info('offline mode: re-scoring items already stored');
  }

  const { topicsNew, topicsRejected, topicsRescored } = buildTopics(db);

  const result: RunResult = {
    runId,
    // Nothing is fetched offline, so no source can be reported as reached.
    sourcesOk: options.offline ? 0 : sources.length - failures.length,
    sourcesFailed: failures.length,
    failures,
    itemsSeen,
    itemsNew,
    topicsNew,
    topicsRejected,
    topicsRescored,
  };

  finishRun(db, runId, { ...result, log: recentLog(120) });
  return result;
}

async function collectSource(source: SourceRecord): Promise<NormalizedItem[]> {
  const adapter = getAdapter(source.kind);
  const raw = await adapter.fetch(source);
  const normalized = adapter.normalize(raw, source);
  return adapter.validate(normalized);
}

/**
 * STEP 3-8. Reads recent items, clusters them, and promotes each cluster lead
 * to a topic. Idempotent: a slug that already exists is never inserted twice,
 * so running the radar twice in a day does not duplicate work.
 *
 * An existing topic is re-scored rather than skipped outright. Skipping it made
 * `radar --offline` and every settings change a no-op: the command advertises
 * "re-score what is already stored", and it re-scored nothing at all because
 * every slug it saw was one it had already inserted.
 *
 * Re-scoring never resurrects a decision you made by hand — a topic you
 * rejected or published keeps its status.
 */
export function buildTopics(db: DB): {
  topicsNew: number;
  topicsRejected: number;
  topicsRescored: number;
} {
  const lookbackDays = getNumberSetting(db, 'lookbackDays');
  const clusterThreshold = getNumberSetting(db, 'clusterSimilarityThreshold');
  const repeatThreshold = getNumberSetting(db, 'repeatSimilarityThreshold');

  const items = listRecentItems(db, lookbackDays, 600);
  if (items.length === 0) return { topicsNew: 0, topicsRejected: 0, topicsRescored: 0 };

  const sourcesByKey = new Map(listSources(db).map((source) => [source.key, source]));
  const tierScore: Record<SourceTier, number> = { primary: 3, reputable: 2, community: 1 };

  const clusters = clusterItems(items, {
    threshold: clusterThreshold,
    tierRank: (key) => tierScore[sourcesByKey.get(key)?.tier ?? 'community'],
  });

  const prior = listPriorContent(db);
  let topicsNew = 0;
  let topicsRejected = 0;
  let topicsRescored = 0;

  for (const cluster of clusters) {
    const lead = cluster.lead;
    const source = sourcesByKey.get(lead.sourceKey);
    if (!source) continue;

    const slug = slugify(lead.title);
    const category = detectCategory(`${lead.title} ${lead.summary}`, source.category);

    const repeat = checkRepeat(lead.title, lead.summary, prior, repeatThreshold);

    const existing = getTopicBySlug(db, slug);
    if (existing) {
      setCorroboration(db, existing.id, cluster.urls);
      scoreAndAnnotate(
        db,
        { ...existing, corroborationUrls: cluster.urls },
        cluster.members,
        source.weight,
        repeat.similarity,
        sourcesByKey,
      );
      topicsRescored += 1;
      continue;
    }

    const topic = insertTopic(db, {
      itemId: lead.id,
      title: lead.title,
      slug,
      summary: lead.summary,
      category,
      sourceKey: lead.sourceKey,
      sourceUrl: lead.url,
      sourceTier: source.tier,
      publishedAt: lead.publishedAt,
      status: repeat.isRepeat ? 'rejected' : 'new',
      corroborationUrls: cluster.urls,
      rejectionReason: repeat.isRepeat
        ? `Too close to previously published work (${Math.round(repeat.similarity * 100)}% overlap with "${repeat.match?.title ?? 'unknown'}"). Reject, or find an angle that does not repeat it.`
        : null,
    });

    if (!topic) continue; // Lost a race, or the slug was taken between checks.

    if (repeat.isRepeat) topicsRejected += 1;
    else topicsNew += 1;

    setCorroboration(db, topic.id, cluster.urls);
    scoreAndAnnotate(db, topic, cluster.members, source.weight, repeat.similarity, sourcesByKey);
  }

  return { topicsNew, topicsRejected, topicsRescored };
}

function scoreAndAnnotate(
  db: DB,
  topic: Topic,
  members: StoredItem[],
  sourceWeight: number,
  priorSimilarity: number,
  sourcesByKey: Map<string, SourceRecord>,
): void {
  const engagement = members.reduce((max, item) => {
    const points = Number(item.extra.points ?? 0);
    const stars = Number(item.extra.stars ?? 0);
    return Math.max(max, Number.isFinite(points) ? points : 0, Number.isFinite(stars) ? stars / 20 : 0);
  }, 0);

  const score = scoreTopic(topic.id, {
    topic,
    sourceWeight,
    clusterSize: new Set(members.map((m) => m.sourceKey)).size,
    priorSimilarity,
    engagement,
  });

  // How many people care, as opposed to how well it fits. Computed from the
  // cluster's real payloads so the engagement numbers are the ones the sources
  // actually reported.
  score.audience = scoreAudienceInterest({
    category: topic.category,
    publishedAt: topic.publishedAt,
    sourceTier: topic.sourceTier,
    members,
    reachOf: (key) => sourcesByKey.get(key)?.reach ?? 3,
  });

  upsertScore(db, score);

  const lead = members.find((m) => m.id === topic.itemId) ?? members[0];
  if (lead) {
    const facts = extractFacts({
      topicId: topic.id,
      lead,
      leadTier: topic.sourceTier,
      corroborators: members.map((item) => ({
        item,
        tier: sourcesByKey.get(item.sourceKey)?.tier ?? 'community',
      })),
    });
    replaceFacts(db, topic.id, facts);
  }

  replaceAngles(db, topic.id, generateAngles(topic, score));

  // Shortlisting moves in both directions so that lowering or raising
  // minTopicScore and re-running actually changes the shortlist. Statuses you
  // set yourself — rejected, drafted, published — are never overwritten.
  //
  // Measured against opportunity, matching the daily radar: the shortlist and
  // the radar disagreeing about what qualifies would be its own bug.
  const minScore = getNumberSetting(db, 'minTopicScore');
  const qualifies = opportunityScore(score);
  if (topic.status === 'new' && qualifies >= minScore) {
    updateTopicStatus(db, topic.id, 'shortlisted');
  } else if (topic.status === 'shortlisted' && qualifies < minScore) {
    updateTopicStatus(db, topic.id, 'new');
  }
}

/**
 * Re-scores every topic still inside the lookback window against the current
 * settings. Used after a settings change and by `radar --offline`.
 */
export function rescoreAll(db: DB): number {
  const { topicsRescored } = buildTopics(db);
  return topicsRescored;
}
