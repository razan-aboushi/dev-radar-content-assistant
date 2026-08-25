import crypto from 'node:crypto';

/**
 * Text utilities. Everything here is pure and synchronous so it can be unit
 * tested and reused by the scorer, the deduper and the style evaluator.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to',
  'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'it', 'its',
  'you', 'your', 'we', 'our', 'i', 'my', 'they', 'their', 'he', 'she', 'his',
  'her', 'not', 'no', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'will',
  'would', 'should', 'could', 'about', 'into', 'over', 'out', 'up', 'down',
  'new', 'now', 'more', 'most', 'some', 'all', 'any', 'how', 'what', 'why',
  'when', 'which', 'who', 'via', 'using', 'use', 'used',
]);

/**
 * Strip tags and decode the handful of entities that actually appear in feeds.
 * Feed content is untrusted input: this is the only path by which remote text
 * reaches storage or the dashboard, and the dashboard renders via textContent.
 */
export function stripHtml(input: string): string {
  if (!input) return '';
  return decodeEntities(
    input
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#34': '"', '#160': ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201C', rdquo: '\u201D',
};

/**
 * Feed text is untrusted, so an out-of-range numeric entity has to be left
 * alone rather than thrown on. `String.fromCodePoint` raises a RangeError above
 * U+10FFFF and on surrogate halves, and a single `&#99999999;` anywhere in a
 * feed used to take the whole source down with it.
 */
function isValidCodePoint(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff;
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name: string) => {
    const direct = ENTITIES[name];
    if (direct !== undefined) return direct;
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/** Lowercase, remove punctuation, collapse whitespace. */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(input: string): string[] {
  return normalize(input)
    .split(' ')
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export function tokenSet(input: string): Set<string> {
  return new Set(tokens(input));
}

/** Jaccard similarity of two token sets, 0–1. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Dice coefficient over token sets. More forgiving than Jaccard when one text
 * is much longer than the other, which is the usual case when comparing a feed
 * title against a full previous article.
 */
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

export function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

export function slugify(input: string): string {
  // Dots are kept: "next.js" and "v22.5.0" are the names people search for.
  const base = normalize(input)
    .replace(/[^a-z0-9.\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
  return base.slice(0, 80).replace(/^[-.]+|[-.]+$/g, '') || 'topic';
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  const cut = input.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function sentences(input: string): string[] {
  return input
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function paragraphs(input: string): string[] {
  return input.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

export function wordCount(input: string): number {
  const trimmed = input.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

export function countEmoji(input: string): number {
  return (input.match(EMOJI_RE) ?? []).length;
}

/** Clamp to an inclusive range. */
export function clamp(value: number, min = 0, max = 100): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Try hard to turn whatever a feed gave us into an ISO date, or null. */
export function toIsoDate(input: unknown): string | null {
  if (!input) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.toISOString();
  const raw = String(input).trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const epoch = Number(raw);
  if (Number.isFinite(epoch) && epoch > 1_000_000_000) {
    return new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString();
  }
  return null;
}

export function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now - t) / 86_400_000;
}
