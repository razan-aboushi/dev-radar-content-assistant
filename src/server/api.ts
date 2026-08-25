import { config } from '../config';
import { allSettings, getNumberSetting, setSetting, DEFAULT_SETTINGS, type DB } from '../db';
import {
  getContent,
  getScore,
  getTopic,
  insertPriorContent,
  listAngles,
  listContent,
  listFacts,
  listRuns,
  listScoredTopics,
  listSources,
  setSourceEnabled,
  updateContentStatus,
  updateTopicStatus,
} from '../db/repositories';
import { getProvider } from '../ai/provider';
import { runResearch } from '../pipeline/run';
import { displayScore } from '../pipeline/score';
import { buildDaily, buildWeekly } from '../reports';
import { buildContext } from '../writing/context';
import { exportContent } from '../writing/export';
import { generateLinkedIn, renderForPublishing } from '../writing/linkedin';
import { generateMedium } from '../writing/medium';
import { loadProfile } from '../writing/style';
import type { AngleKind, TopicStatus } from '../types';

/**
 * API handlers. Each returns a plain object that the server serialises.
 * Nothing here renders HTML — the client builds DOM with textContent, so
 * scraped feed text can never execute.
 */

export interface ApiRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

export type ApiResult = { status: number; data: unknown };

const TOPIC_STATUSES: readonly TopicStatus[] = [
  'new', 'shortlisted', 'rejected', 'drafted', 'published',
];

export async function handleApi(db: DB, request: ApiRequest): Promise<ApiResult> {
  const { method, pathname, query, body } = request;

  if (method === 'GET' && pathname === '/api/overview') {
    const provider = getProvider();
    return {
      status: 200,
      data: {
        daily: serialiseDaily(buildDaily(db)),
        provider: {
          name: provider.name,
          model: provider.model,
          available: await provider.available(),
        },
        sources: {
          total: listSources(db).length,
          enabled: listSources(db, true).length,
          failing: listSources(db).filter((s) => s.lastStatus === 'error').length,
        },
        lastRun: listRuns(db, 1)[0] ?? null,
      },
    };
  }

  if (method === 'GET' && pathname === '/api/topics') {
    const requested = query.get('status') ?? 'any';
    const min = Number(query.get('min'));
    const rows = listScoredTopics(db, {
      // An unrecognised status silently matched nothing, which reads as "no
      // topics" rather than "bad filter". Fall back to showing everything.
      status: TOPIC_STATUSES.includes(requested as TopicStatus) ? (requested as TopicStatus) : 'any',
      minScore: Number.isFinite(min) ? min : undefined,
      limit: 120,
    });
    return {
      status: 200,
      data: rows.map((row) => ({
        topic: row.topic,
        score: row.score ? displayScore(row.score) : null,
      })),
    };
  }

  if (method === 'GET' && pathname === '/api/topic') {
    const id = Number(query.get('id'));
    const topic = getTopic(db, id);
    if (!topic) return { status: 404, data: { error: 'Topic not found' } };
    const score = getScore(db, id);
    const context = buildContext(db, topic, score, loadProfile());
    return {
      status: 200,
      data: {
        topic,
        score: score ? displayScore(score) : null,
        facts: listFacts(db, id),
        angles: listAngles(db, id),
        drafts: listContent(db, id).map(serialiseContent),
        nearMatches: context.nearMatches,
        hashtags: context.hashtags,
      },
    };
  }

  if (method === 'POST' && pathname === '/api/radar') {
    const result = await runResearch(db, { offline: body.offline === true });
    return { status: 200, data: result };
  }

  if (method === 'POST' && pathname === '/api/generate') {
    const id = Number(body.topicId);
    const topic = getTopic(db, id);
    if (!topic) return { status: 404, data: { error: 'Topic not found' } };

    const kind = body.kind === 'medium' ? 'medium' : 'linkedin';
    const provider = getProvider();
    const context = buildContext(
      db,
      topic,
      getScore(db, id),
      loadProfile(),
      typeof body.angle === 'string' ? (body.angle as AngleKind) : undefined,
    );

    const result =
      kind === 'linkedin'
        ? await generateLinkedIn(db, context, provider)
        : await generateMedium(db, context, provider);

    updateTopicStatus(db, id, 'drafted');
    const file = exportContent(result.content, topic, 'md');

    return {
      status: 200,
      data: {
        content: serialiseContent(result.content),
        belowThreshold: result.belowThreshold,
        minStyleScore: getNumberSetting(db, 'minStyleScore'),
        exportedTo: file.replace(config.root, '.'),
        alternativeHooks: 'alternativeHooks' in result ? result.alternativeHooks : [],
      },
    };
  }

  if (method === 'POST' && pathname === '/api/topic/status') {
    const id = Number(body.topicId);
    const status = String(body.status);
    // Without this check any string reached the status column, and a topic
    // stamped with an unknown status vanishes from every filtered view.
    if (!TOPIC_STATUSES.includes(status as TopicStatus)) {
      return {
        status: 400,
        data: { error: `Unknown status "${status}". Expected one of: ${TOPIC_STATUSES.join(', ')}` },
      };
    }
    if (!getTopic(db, id)) return { status: 404, data: { error: 'Topic not found' } };
    updateTopicStatus(db, id, status as TopicStatus, typeof body.reason === 'string' ? body.reason : null);
    return { status: 200, data: { ok: true } };
  }

  if (method === 'POST' && pathname === '/api/content/publish') {
    const contentId = Number(body.contentId);
    // Looked up by id rather than filtered out of the 100 most recent drafts,
    // which made anything older than that unpublishable.
    const draft = getContent(db, contentId);
    if (!draft) return { status: 404, data: { error: 'Draft not found' } };
    const topic = getTopic(db, draft.topicId);
    updateContentStatus(db, contentId, 'published');
    updateTopicStatus(db, draft.topicId, 'published');
    insertPriorContent(db, {
      platform: draft.kind,
      title: draft.title || topic?.title || 'Untitled',
      url: typeof body.url === 'string' ? body.url : null,
      text: draft.body,
      publishedAt: new Date().toISOString(),
    });
    return { status: 200, data: { ok: true } };
  }

  if (method === 'GET' && pathname === '/api/weekly') {
    return { status: 200, data: buildWeekly(db) };
  }

  if (method === 'GET' && pathname === '/api/history') {
    return {
      status: 200,
      data: {
        runs: listRuns(db, 15),
        drafts: listContent(db, undefined, 40).map((draft) => ({
          ...serialiseContent(draft),
          topicTitle: getTopic(db, draft.topicId)?.title ?? '',
        })),
        rejected: listScoredTopics(db, { status: 'rejected', limit: 30 }).map((r) => r.topic),
        published: listScoredTopics(db, { status: 'published', limit: 30 }).map((r) => r.topic),
      },
    };
  }

  if (method === 'GET' && pathname === '/api/sources') {
    return { status: 200, data: listSources(db) };
  }

  if (method === 'POST' && pathname === '/api/sources/toggle') {
    const key = String(body.key);
    // Reported ok for keys that do not exist, so a stale checkbox looked like
    // it had taken effect.
    if (!listSources(db).some((source) => source.key === key)) {
      return { status: 404, data: { error: `No source with key "${key}"` } };
    }
    setSourceEnabled(db, key, body.enabled === true);
    return { status: 200, data: { ok: true } };
  }

  if (method === 'GET' && pathname === '/api/settings') {
    return {
      status: 200,
      data: {
        settings: allSettings(db),
        defaults: DEFAULT_SETTINGS,
        provider: config.ai.provider,
        model: config.ai.provider === 'ollama' ? config.ai.ollamaModel : config.ai.openaiModel,
      },
    };
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const updates = body.settings;
    if (typeof updates !== 'object' || updates === null) {
      return { status: 400, data: { error: 'Expected a settings object' } };
    }
    for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      setSetting(db, key, String(value));
    }
    return { status: 200, data: { settings: allSettings(db) } };
  }

  return { status: 404, data: { error: `No route for ${method} ${pathname}` } };
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

function serialiseContent(content: ReturnType<typeof listContent>[number]) {
  return {
    ...content,
    publishText: content.kind === 'linkedin' ? renderForPublishing(content) : content.body,
  };
}
