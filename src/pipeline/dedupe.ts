import { dice, jaccard, tokenSet } from '../util/text';
import type { PriorContent, StoredItem } from '../types';

/**
 * Two jobs:
 *  1. Cluster items that are the same story seen through different sources.
 *     Cluster size is evidence for corroboration and against originality.
 *  2. Detect that a candidate topic repeats something already published.
 */

export interface Cluster {
  /** The item chosen to represent the cluster (highest-tier, then newest). */
  lead: StoredItem;
  members: StoredItem[];
  urls: string[];
}

export interface ClusterOptions {
  threshold: number;
  /** Ranks sources so the most authoritative item leads the cluster. */
  tierRank: (sourceKey: string) => number;
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|mc_)/i.test(key)) parsed.searchParams.delete(key);
    }
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.host.replace(/^www\./, '')}${path}${parsed.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Greedy single-pass clustering. O(n·k) where k is the number of clusters;
 * with a few hundred items per run that is comfortably fast and, unlike
 * hierarchical clustering, produces stable output across runs.
 */
export function clusterItems(items: StoredItem[], options: ClusterOptions): Cluster[] {
  const clusters: Array<{ lead: StoredItem; members: StoredItem[]; tokens: Set<string>; urls: Set<string> }> = [];
  const seenUrls = new Map<string, number>();

  for (const item of items) {
    const url = canonicalUrl(item.url);
    const itemTokens = tokenSet(item.title);

    const existingByUrl = seenUrls.get(url);
    if (existingByUrl !== undefined) {
      const cluster = clusters[existingByUrl];
      if (cluster) {
        cluster.members.push(item);
        cluster.urls.add(item.url);
        // Same handling as the title-match path below. Without it, two feeds
        // carrying the identical link left the cluster led by whichever one
        // was read first, so a community aggregator could out-rank the primary
        // source it was quoting and become the cited lead.
        for (const token of itemTokens) cluster.tokens.add(token);
        if (rank(item, options) > rank(cluster.lead, options)) cluster.lead = item;
        continue;
      }
    }

    let matchedIndex = -1;
    for (let i = 0; i < clusters.length; i += 1) {
      const candidate = clusters[i];
      if (!candidate) continue;
      if (jaccard(itemTokens, candidate.tokens) >= options.threshold) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex >= 0) {
      const cluster = clusters[matchedIndex];
      if (cluster) {
        cluster.members.push(item);
        cluster.urls.add(item.url);
        for (const token of itemTokens) cluster.tokens.add(token);
        if (rank(item, options) > rank(cluster.lead, options)) cluster.lead = item;
        seenUrls.set(url, matchedIndex);
        continue;
      }
    }

    clusters.push({ lead: item, members: [item], tokens: itemTokens, urls: new Set([item.url]) });
    seenUrls.set(url, clusters.length - 1);
  }

  return clusters.map((cluster) => ({
    lead: cluster.lead,
    members: cluster.members,
    urls: [...cluster.urls],
  }));
}

/** Higher is better: authoritative source first, then newer, then longer summary. */
function rank(item: StoredItem, options: ClusterOptions): number {
  const tier = options.tierRank(item.sourceKey) * 1000;
  const recency = item.publishedAt ? Date.parse(item.publishedAt) / 1e11 : 0;
  const depth = Math.min(item.summary.length, 2000) / 10000;
  return tier + recency + depth;
}

export interface RepeatCheck {
  isRepeat: boolean;
  similarity: number;
  match: PriorContent | null;
  /** Present when similar but below the reject threshold — a warning, not a block. */
  nearMatches: Array<{ title: string; similarity: number }>;
}

/**
 * Compare a candidate topic against everything already published.
 *
 * Title is compared against title, and body against body. Comparing a full
 * candidate summary against a short prior title looks like a low score purely
 * because of the length difference — an identical headline scored around 0.44
 * that way and slipped past the repeat threshold. Like-for-like fixes it.
 *
 * Dice rather than Jaccard, because bodies still differ a lot in length.
 */
export function checkRepeat(
  candidateTitle: string,
  candidateBody: string,
  prior: PriorContent[],
  threshold: number,
): RepeatCheck {
  const titleTokens = tokenSet(candidateTitle);
  const bodyTokens = tokenSet(`${candidateTitle} ${candidateBody}`);
  let best: { entry: PriorContent; similarity: number } | null = null;
  const nearMatches: Array<{ title: string; similarity: number }> = [];

  for (const entry of prior) {
    const similarity = Math.max(
      dice(titleTokens, tokenSet(entry.title)),
      dice(bodyTokens, tokenSet(entry.text.slice(0, 4000))),
    );
    if (similarity >= threshold * 0.7) {
      nearMatches.push({ title: entry.title, similarity: Math.round(similarity * 100) / 100 });
    }
    if (!best || similarity > best.similarity) best = { entry, similarity };
  }

  nearMatches.sort((a, b) => b.similarity - a.similarity);

  return {
    isRepeat: (best?.similarity ?? 0) >= threshold,
    similarity: Math.round((best?.similarity ?? 0) * 100) / 100,
    match: best && best.similarity >= threshold ? best.entry : null,
    nearMatches: nearMatches.slice(0, 3),
  };
}
