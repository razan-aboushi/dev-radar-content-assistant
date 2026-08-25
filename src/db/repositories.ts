import type { DB } from './index';
import { sha1, slugify } from '../util/text';
import type {
  Angle,
  Category,
  Fact,
  GeneratedContent,
  NormalizedItem,
  PriorContent,
  ResearchRun,
  SourceConfig,
  SourceTier,
  StoredItem,
  Topic,
  TopicScore,
  TopicStatus,
} from '../types';

/**
 * All SQL lives here. Callers work with domain types only; JSON columns are
 * parsed and serialised at this boundary.
 */

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ sources */

interface SourceRow {
  key: string; name: string; url: string; kind: string; tier: string;
  category: string; enabled: number; weight: number; reach: number | null; query: string | null;
  last_fetched_at: string | null; last_status: string | null; last_error: string | null;
}

export interface SourceRecord extends SourceConfig {
  lastFetchedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

function toSource(row: SourceRow): SourceRecord {
  return {
    key: row.key,
    name: row.name,
    url: row.url,
    kind: row.kind as SourceConfig['kind'],
    tier: row.tier as SourceTier,
    category: row.category as Category,
    enabled: row.enabled === 1,
    weight: row.weight,
    reach: row.reach ?? 3,
    query: row.query ?? undefined,
    lastFetchedAt: row.last_fetched_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
  };
}

export function listSources(db: DB, onlyEnabled = false): SourceRecord[] {
  const sql = onlyEnabled
    ? 'SELECT * FROM sources WHERE enabled = 1 ORDER BY tier, key'
    : 'SELECT * FROM sources ORDER BY tier, key';
  return (db.prepare(sql).all() as SourceRow[]).map(toSource);
}

export function getSource(db: DB, key: string): SourceRecord | null {
  const row = db.prepare('SELECT * FROM sources WHERE key = ?').get(key) as SourceRow | undefined;
  return row ? toSource(row) : null;
}

export function recordSourceFetch(
  db: DB,
  key: string,
  status: 'ok' | 'error',
  error: string | null,
): void {
  db.prepare(
    'UPDATE sources SET last_fetched_at = ?, last_status = ?, last_error = ? WHERE key = ?',
  ).run(new Date().toISOString(), status, error, key);
}

export function setSourceEnabled(db: DB, key: string, enabled: boolean): void {
  db.prepare('UPDATE sources SET enabled = ? WHERE key = ?').run(enabled ? 1 : 0, key);
}

/* -------------------------------------------------------------------- items */

interface ItemRow {
  id: number; source_key: string; guid: string; title: string; url: string;
  summary: string; published_at: string | null; author: string | null;
  extra: string; content_hash: string; fetched_at: string;
}

function toItem(row: ItemRow): StoredItem {
  return {
    id: row.id,
    sourceKey: row.source_key,
    guid: row.guid,
    title: row.title,
    url: row.url,
    summary: row.summary,
    publishedAt: row.published_at,
    author: row.author,
    extra: parseJson(row.extra, {}),
    contentHash: row.content_hash,
    fetchedAt: row.fetched_at,
  };
}

export function contentHashOf(item: NormalizedItem): string {
  return sha1(`${item.title.trim().toLowerCase()}|${item.url.trim().toLowerCase()}`);
}

/** Returns the number of genuinely new rows. Existing (source, guid) pairs are ignored. */
export function insertItems(db: DB, items: NormalizedItem[]): { inserted: StoredItem[] } {
  const insert = db.prepare(`
    INSERT INTO items (source_key, guid, title, url, summary, published_at, author, extra, content_hash, fetched_at)
    VALUES (@source_key, @guid, @title, @url, @summary, @published_at, @author, @extra, @content_hash, @fetched_at)
    ON CONFLICT (source_key, guid) DO NOTHING
  `);
  const select = db.prepare('SELECT * FROM items WHERE source_key = ? AND guid = ?');
  const inserted: StoredItem[] = [];
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const item of items) {
      const result = insert.run({
        source_key: item.sourceKey,
        guid: item.guid,
        title: item.title,
        url: item.url,
        summary: item.summary,
        published_at: item.publishedAt,
        author: item.author,
        extra: JSON.stringify(item.extra ?? {}),
        content_hash: contentHashOf(item),
        fetched_at: now,
      });
      if (result.changes > 0) {
        const row = select.get(item.sourceKey, item.guid) as ItemRow | undefined;
        if (row) inserted.push(toItem(row));
      }
    }
  });
  tx();
  return { inserted };
}

export function listRecentItems(db: DB, days: number, limit = 500): StoredItem[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM items
       WHERE COALESCE(published_at, fetched_at) >= ?
       ORDER BY COALESCE(published_at, fetched_at) DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as ItemRow[];
  return rows.map(toItem);
}

export function getItem(db: DB, id: number): StoredItem | null {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
  return row ? toItem(row) : null;
}

/* ------------------------------------------------------------------- topics */

interface TopicRow {
  id: number; item_id: number | null; title: string; slug: string; summary: string;
  category: string; source_key: string; source_url: string; source_tier: string;
  published_at: string | null; created_at: string; status: string;
  corroboration: string; rejection_reason: string | null;
}

function toTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    itemId: row.item_id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    category: row.category as Category,
    sourceKey: row.source_key,
    sourceUrl: row.source_url,
    sourceTier: row.source_tier as SourceTier,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    status: row.status as TopicStatus,
    corroborationUrls: parseJson<string[]>(row.corroboration, []),
    rejectionReason: row.rejection_reason,
  };
}

export type NewTopic = Omit<Topic, 'id' | 'createdAt' | 'slug'> & { slug?: string };

/** Inserts a topic. Returns null if a topic with the same slug already exists. */
export function insertTopic(db: DB, topic: NewTopic): Topic | null {
  const baseSlug = topic.slug ?? slugify(topic.title);
  const exists = db.prepare('SELECT id FROM topics WHERE slug = ?').get(baseSlug);
  if (exists) return null;

  const info = db
    .prepare(
      `INSERT INTO topics (item_id, title, slug, summary, category, source_key, source_url,
                           source_tier, published_at, created_at, status, corroboration, rejection_reason)
       VALUES (@item_id, @title, @slug, @summary, @category, @source_key, @source_url,
               @source_tier, @published_at, @created_at, @status, @corroboration, @rejection_reason)`,
    )
    .run({
      item_id: topic.itemId,
      title: topic.title,
      slug: baseSlug,
      summary: topic.summary,
      category: topic.category,
      source_key: topic.sourceKey,
      source_url: topic.sourceUrl,
      source_tier: topic.sourceTier,
      published_at: topic.publishedAt,
      created_at: new Date().toISOString(),
      status: topic.status,
      corroboration: JSON.stringify(topic.corroborationUrls),
      rejection_reason: topic.rejectionReason,
    });
  return getTopic(db, Number(info.lastInsertRowid));
}

export function getTopic(db: DB, id: number): Topic | null {
  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined;
  return row ? toTopic(row) : null;
}

export function getTopicBySlug(db: DB, slug: string): Topic | null {
  const row = db.prepare('SELECT * FROM topics WHERE slug = ?').get(slug) as TopicRow | undefined;
  return row ? toTopic(row) : null;
}

export function updateTopicStatus(
  db: DB,
  id: number,
  status: TopicStatus,
  reason: string | null = null,
): void {
  db.prepare('UPDATE topics SET status = ?, rejection_reason = ? WHERE id = ?').run(
    status,
    reason,
    id,
  );
}

export function setCorroboration(db: DB, id: number, urls: string[]): void {
  db.prepare('UPDATE topics SET corroboration = ? WHERE id = ?').run(JSON.stringify(urls), id);
}

export interface ScoredTopic {
  topic: Topic;
  score: TopicScore | null;
}

interface ScoreRow {
  topic_id: number; freshness: number; relevance: number; practical_value: number;
  discussion_potential: number; educational_value: number; originality: number;
  audience_fit: number; total: number; confidence: number; linkedin_score: number;
  medium_score: number; controversy: number; reasons: string; audience: string | null;
}

function toScore(row: ScoreRow): TopicScore {
  return {
    topicId: row.topic_id,
    freshness: row.freshness,
    relevance: row.relevance,
    practicalValue: row.practical_value,
    discussionPotential: row.discussion_potential,
    educationalValue: row.educational_value,
    originality: row.originality,
    audienceFit: row.audience_fit,
    total: row.total,
    confidence: row.confidence,
    linkedinScore: row.linkedin_score,
    mediumScore: row.medium_score,
    controversy: row.controversy,
    // Null on rows scored before audience interest existed; re-running the
    // radar fills them in.
    audience: parseJson<TopicScore['audience']>(row.audience ?? null, null),
    reasons: parseJson<string[]>(row.reasons, []),
  };
}

export function upsertScore(db: DB, score: TopicScore): void {
  db.prepare(`
    INSERT INTO topic_scores (topic_id, freshness, relevance, practical_value, discussion_potential,
                              educational_value, originality, audience_fit, total, confidence,
                              linkedin_score, medium_score, controversy, reasons, audience, scored_at)
    VALUES (@topic_id, @freshness, @relevance, @practical_value, @discussion_potential,
            @educational_value, @originality, @audience_fit, @total, @confidence,
            @linkedin_score, @medium_score, @controversy, @reasons, @audience, @scored_at)
    ON CONFLICT(topic_id) DO UPDATE SET
      freshness = excluded.freshness, relevance = excluded.relevance,
      practical_value = excluded.practical_value, discussion_potential = excluded.discussion_potential,
      educational_value = excluded.educational_value, originality = excluded.originality,
      audience_fit = excluded.audience_fit, total = excluded.total, confidence = excluded.confidence,
      linkedin_score = excluded.linkedin_score, medium_score = excluded.medium_score,
      controversy = excluded.controversy, reasons = excluded.reasons,
      audience = excluded.audience, scored_at = excluded.scored_at
  `).run({
    topic_id: score.topicId,
    freshness: score.freshness,
    relevance: score.relevance,
    practical_value: score.practicalValue,
    discussion_potential: score.discussionPotential,
    educational_value: score.educationalValue,
    originality: score.originality,
    audience_fit: score.audienceFit,
    total: score.total,
    confidence: score.confidence,
    linkedin_score: score.linkedinScore,
    medium_score: score.mediumScore,
    controversy: score.controversy,
    reasons: JSON.stringify(score.reasons),
    audience: score.audience ? JSON.stringify(score.audience) : null,
    scored_at: new Date().toISOString(),
  });
}

export function getScore(db: DB, topicId: number): TopicScore | null {
  const row = db.prepare('SELECT * FROM topic_scores WHERE topic_id = ?').get(topicId) as
    | ScoreRow
    | undefined;
  return row ? toScore(row) : null;
}

export type TopicSort = 'opportunity' | 'fit' | 'interest' | 'newest';

export interface TopicQuery {
  status?: TopicStatus | 'any';
  minScore?: number;
  /** Filters on audience interest rather than topical fit. */
  minInterest?: number;
  category?: Category;
  sinceDays?: number;
  limit?: number;
  /** Defaults to 'opportunity': the blend of fit and interest. */
  sort?: TopicSort;
}

/**
 * Audience interest is stored as JSON in one column rather than five, so it is
 * read back out with json_extract for sorting and filtering. SQLite has had
 * this built in since 3.38 and better-sqlite3 ships far newer.
 */
const INTEREST_SQL = "COALESCE(json_extract(s.audience, '$.score'), 0)";
const FIT_SQL = 'COALESCE(s.total, 0)';

const ORDER_BY: Record<TopicSort, string> = {
  opportunity: `(${FIT_SQL} * 0.6 + ${INTEREST_SQL} * 0.4) DESC, ${FIT_SQL} DESC`,
  fit: `${FIT_SQL} DESC`,
  interest: `${INTEREST_SQL} DESC, ${FIT_SQL} DESC`,
  newest: 'COALESCE(t.published_at, t.created_at) DESC',
};

export function listScoredTopics(db: DB, query: TopicQuery = {}): ScoredTopic[] {
  const where: string[] = [];
  const params: Record<string, string | number> = {};

  if (query.status && query.status !== 'any') {
    where.push('t.status = @status');
    params.status = query.status;
  }
  if (query.category) {
    where.push('t.category = @category');
    params.category = query.category;
  }
  if (typeof query.minScore === 'number') {
    where.push(`${FIT_SQL} >= @minScore`);
    params.minScore = query.minScore;
  }
  if (typeof query.minInterest === 'number') {
    where.push(`${INTEREST_SQL} >= @minInterest`);
    params.minInterest = query.minInterest;
  }
  if (typeof query.sinceDays === 'number') {
    where.push('COALESCE(t.published_at, t.created_at) >= @cutoff');
    params.cutoff = new Date(Date.now() - query.sinceDays * 86_400_000).toISOString();
  }

  // Whitelisted lookup, never interpolated from caller input.
  const orderBy = ORDER_BY[query.sort ?? 'opportunity'] ?? ORDER_BY.opportunity;

  const rows = db
    .prepare(
      `SELECT t.*, s.topic_id AS s_topic_id, s.freshness, s.relevance, s.practical_value,
              s.discussion_potential, s.educational_value, s.originality, s.audience_fit,
              s.total, s.confidence, s.linkedin_score, s.medium_score, s.controversy,
              s.reasons, s.audience
       FROM topics t
       LEFT JOIN topic_scores s ON s.topic_id = t.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${orderBy}, COALESCE(t.published_at, t.created_at) DESC
       LIMIT @limit`,
    )
    .all({ ...params, limit: query.limit ?? 100 }) as Array<TopicRow & Partial<ScoreRow> & { s_topic_id: number | null }>;

  // topic_id is aliased to s_topic_id so it cannot collide with t.*, which
  // means toScore has to be handed the id explicitly. Reading row.topic_id
  // here produced scores whose topicId was undefined.
  return rows.map((row) => ({
    topic: toTopic(row),
    score:
      row.s_topic_id === null || row.s_topic_id === undefined
        ? null
        : toScore({ ...(row as unknown as ScoreRow), topic_id: row.s_topic_id }),
  }));
}

/* ------------------------------------------------------------------- angles */

export function replaceAngles(db: DB, topicId: number, angles: Angle[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM angles WHERE topic_id = ?').run(topicId);
    const insert = db.prepare(
      'INSERT INTO angles (topic_id, kind, title, description, recommended) VALUES (?, ?, ?, ?, ?)',
    );
    for (const angle of angles) {
      insert.run(topicId, angle.kind, angle.title, angle.description, angle.recommended ? 1 : 0);
    }
  });
  tx();
}

export function listAngles(db: DB, topicId: number): Angle[] {
  const rows = db.prepare('SELECT * FROM angles WHERE topic_id = ? ORDER BY id').all(topicId) as Array<{
    id: number; topic_id: number; kind: string; title: string; description: string; recommended: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    topicId: r.topic_id,
    kind: r.kind as Angle['kind'],
    title: r.title,
    description: r.description,
    recommended: r.recommended === 1,
  }));
}

/* -------------------------------------------------------------------- facts */

export function replaceFacts(db: DB, topicId: number, facts: Fact[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM facts WHERE topic_id = ?').run(topicId);
    const insert = db.prepare(
      'INSERT INTO facts (topic_id, claim, source_url, source_tier, status, note) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const fact of facts) {
      insert.run(topicId, fact.claim, fact.sourceUrl, fact.sourceTier, fact.status, fact.note);
    }
  });
  tx();
}

export function listFacts(db: DB, topicId: number): Fact[] {
  const rows = db.prepare('SELECT * FROM facts WHERE topic_id = ? ORDER BY id').all(topicId) as Array<{
    id: number; topic_id: number; claim: string; source_url: string;
    source_tier: string; status: string; note: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    topicId: r.topic_id,
    claim: r.claim,
    sourceUrl: r.source_url,
    sourceTier: r.source_tier as SourceTier,
    status: r.status as Fact['status'],
    note: r.note,
  }));
}

/* ------------------------------------------------------------------ content */

interface ContentRow {
  id: number; topic_id: number; kind: string; angle_kind: string; mode: string;
  hook: string; title: string; subtitle: string; body: string; hashtags: string;
  sources: string; style_score: string | null; ai_tells: string; status: string;
  model: string | null; created_at: string; language: string | null;
}

function toContent(row: ContentRow): GeneratedContent {
  return {
    id: row.id,
    topicId: row.topic_id,
    kind: row.kind as GeneratedContent['kind'],
    angleKind: row.angle_kind as Angle['kind'],
    mode: row.mode as GeneratedContent['mode'],
    hook: row.hook,
    title: row.title,
    subtitle: row.subtitle,
    body: row.body,
    hashtags: parseJson<string[]>(row.hashtags, []),
    sources: parseJson<string[]>(row.sources, []),
    styleScore: parseJson<GeneratedContent['styleScore']>(row.style_score, null),
    aiTells: parseJson<string[]>(row.ai_tells, []),
    status: row.status as GeneratedContent['status'],
    model: row.model,
    createdAt: row.created_at,
    // Rows written before the column existed are English by definition.
    language: row.language === 'ar' ? 'ar' : 'en',
  };
}

export function insertContent(db: DB, content: GeneratedContent): GeneratedContent {
  const info = db
    .prepare(
      `INSERT INTO content (topic_id, kind, angle_kind, mode, hook, title, subtitle, body,
                            hashtags, sources, style_score, ai_tells, status, model, created_at, language)
       VALUES (@topic_id, @kind, @angle_kind, @mode, @hook, @title, @subtitle, @body,
               @hashtags, @sources, @style_score, @ai_tells, @status, @model, @created_at, @language)`,
    )
    .run({
      topic_id: content.topicId,
      kind: content.kind,
      angle_kind: content.angleKind,
      mode: content.mode,
      hook: content.hook,
      title: content.title,
      subtitle: content.subtitle,
      body: content.body,
      hashtags: JSON.stringify(content.hashtags),
      sources: JSON.stringify(content.sources),
      style_score: content.styleScore ? JSON.stringify(content.styleScore) : null,
      ai_tells: JSON.stringify(content.aiTells),
      status: content.status,
      model: content.model,
      created_at: content.createdAt,
      language: content.language ?? 'en',
    });
  return getContent(db, Number(info.lastInsertRowid))!;
}

export function getContent(db: DB, id: number): GeneratedContent | null {
  const row = db.prepare('SELECT * FROM content WHERE id = ?').get(id) as ContentRow | undefined;
  return row ? toContent(row) : null;
}

export function listContent(db: DB, topicId?: number, limit = 100): GeneratedContent[] {
  const rows = (
    topicId === undefined
      ? db.prepare('SELECT * FROM content ORDER BY created_at DESC LIMIT ?').all(limit)
      : db
          .prepare('SELECT * FROM content WHERE topic_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(topicId, limit)
  ) as ContentRow[];
  return rows.map(toContent);
}

export function latestContent(
  db: DB,
  topicId: number,
  kind: GeneratedContent['kind'],
): GeneratedContent | null {
  const row = db
    .prepare('SELECT * FROM content WHERE topic_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
    .get(topicId, kind) as ContentRow | undefined;
  return row ? toContent(row) : null;
}

export function updateContentStatus(db: DB, id: number, status: GeneratedContent['status']): void {
  db.prepare('UPDATE content SET status = ? WHERE id = ?').run(status, id);
}

/* ------------------------------------------------------------ prior content */

export function insertPriorContent(db: DB, entry: PriorContent): boolean {
  const fingerprint = sha1(`${entry.platform}|${entry.title.toLowerCase()}|${entry.text.length}`);
  const result = db
    .prepare(
      `INSERT INTO prior_content (platform, title, url, text, published_at, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO NOTHING`,
    )
    .run(entry.platform, entry.title, entry.url, entry.text, entry.publishedAt, fingerprint);
  return result.changes > 0;
}

export function listPriorContent(db: DB): PriorContent[] {
  const rows = db.prepare('SELECT * FROM prior_content ORDER BY id DESC').all() as Array<{
    id: number; platform: string; title: string; url: string | null;
    text: string; published_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform as PriorContent['platform'],
    title: r.title,
    url: r.url,
    text: r.text,
    publishedAt: r.published_at,
  }));
}

/* ----------------------------------------------------------- research runs */

export function startRun(db: DB): number {
  const info = db
    .prepare('INSERT INTO research_runs (started_at) VALUES (?)')
    .run(new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function finishRun(db: DB, id: number, stats: Partial<ResearchRun>): void {
  db.prepare(
    `UPDATE research_runs SET finished_at = ?, sources_ok = ?, sources_failed = ?,
       items_seen = ?, items_new = ?, topics_new = ?, log = ? WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    stats.sourcesOk ?? 0,
    stats.sourcesFailed ?? 0,
    stats.itemsSeen ?? 0,
    stats.itemsNew ?? 0,
    stats.topicsNew ?? 0,
    stats.log ?? '',
    id,
  );
}

export function listRuns(db: DB, limit = 20): ResearchRun[] {
  const rows = db
    .prepare('SELECT * FROM research_runs ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<{
    id: number; started_at: string; finished_at: string | null; sources_ok: number;
    sources_failed: number; items_seen: number; items_new: number; topics_new: number; log: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    sourcesOk: r.sources_ok,
    sourcesFailed: r.sources_failed,
    itemsSeen: r.items_seen,
    itemsNew: r.items_new,
    topicsNew: r.topics_new,
    log: r.log,
  }));
}
