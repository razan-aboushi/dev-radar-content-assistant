import { config } from '../config';
import { createLogger } from '../logger';

const log = createLogger('http');

/**
 * Small fetch wrapper. Native fetch, no dependency. Adds:
 *  - request timeout via AbortController
 *  - bounded retries with exponential backoff, only for transient failures
 *  - a politeness delay per host so we never hammer a free feed
 *  - a global concurrency cap
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const hostNextAllowedAt = new Map<string, number>();

/**
 * Turns a failed response into a message that says what actually went wrong.
 *
 * GitHub answers an exhausted quota with 403, not 429, so a bare "HTTP 403"
 * reads as "this URL is wrong or forbidden" and sends you off editing a
 * perfectly good feed URL. The rate-limit headers say plainly that the URL is
 * fine and you simply ran out of requests, so that is what gets reported.
 *
 * Unauthenticated GitHub allows 60 requests an hour, and a full source check
 * can spend most of that in one go.
 */
export function describeFailure(
  response: { status: number; headers: { get(name: string): string | null } },
  url: string,
): string {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const isRateLimited =
    (response.status === 403 || response.status === 429) && remaining === '0';

  if (!isRateLimited) {
    const retryAfter = response.headers.get('retry-after');
    if (response.status === 429 && retryAfter) {
      return `rate limited, retry after ${retryAfter}s: ${url}`;
    }
    return `HTTP ${response.status} for ${url}`;
  }

  const resetAt = Number(response.headers.get('x-ratelimit-reset'));
  const limit = response.headers.get('x-ratelimit-limit');
  const when = Number.isFinite(resetAt) && resetAt > 0
    ? new Date(resetAt * 1000).toISOString().slice(11, 16) + ' UTC'
    : 'shortly';

  const hint = url.includes('api.github.com')
    ? ' Set GITHUB_TOKEN in .env to raise the limit from 60/hour to 5000.'
    : '';

  return `rate limited${limit ? ` (${limit}/hour used up)` : ''}, resets at ${when}. The URL is fine.${hint}`;
}

let active = 0;
const waiting: Array<() => void> = [];

/**
 * The slot is claimed by whoever hands it over, not by the task that wakes up.
 *
 * Incrementing `active` after the await let a caller arriving synchronously
 * between the release and the waiter's resumption take the same slot, so the
 * cap could be exceeded — exactly the politeness guarantee this is here to
 * provide.
 */
async function acquireSlot(): Promise<void> {
  if (active < config.http.concurrency) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  // Hand the slot straight to the next waiter; `active` never dips.
  if (next) next();
  else active -= 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHost(host: string): Promise<void> {
  const delay = config.http.hostDelayMs;
  if (delay <= 0) return;
  const now = Date.now();
  const nextAllowed = hostNextAllowedAt.get(host) ?? 0;
  if (nextAllowed > now) await sleep(nextAllowed - now);
  hostNextAllowedAt.set(host, Math.max(Date.now(), nextAllowed) + delay);
}

/** 408/429 and 5xx are worth retrying. 4xx otherwise is not. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  accept?: string;
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpError(`Refusing non-http protocol: ${parsed.protocol}`, 0, url, false);
  }

  const timeoutMs = options.timeoutMs ?? config.http.timeoutMs;
  const maxRetries = options.retries ?? config.http.retries;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let backoff = 0;
    await acquireSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await waitForHost(parsed.host);
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': config.http.userAgent,
          accept: options.accept ?? 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
          'accept-language': 'en',
          ...options.headers,
        },
      });

      if (!response.ok) {
        throw new HttpError(
          describeFailure(response, url),
          response.status,
          url,
          isRetryableStatus(response.status),
        );
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof HttpError
          ? error.retryable
          : error instanceof Error && (error.name === 'AbortError' || error.name === 'TypeError');
      if (!retryable || attempt === maxRetries) break;
      backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      log.warn(`retrying ${url} in ${backoff}ms (attempt ${attempt + 1}/${maxRetries})`, error);
    } finally {
      clearTimeout(timer);
      releaseSlot();
    }
    // Waited outside the slot: a backoff against one dead host used to hold a
    // concurrency slot the other sources were queueing for.
    await sleep(backoff);
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`Request failed: ${url}`);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, { ...options, accept: options.accept ?? 'application/json' });
  return JSON.parse(text) as T;
}

/** Run tasks with the global concurrency cap, collecting successes and failures. */
export async function settleAll<T>(
  tasks: Array<() => Promise<T>>,
): Promise<{ ok: T[]; failed: Array<{ index: number; error: unknown }> }> {
  const results = await Promise.allSettled(tasks.map((task) => task()));
  const ok: T[] = [];
  const failed: Array<{ index: number; error: unknown }> = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') ok.push(result.value);
    else failed.push({ index, error: result.reason });
  });
  return { ok, failed };
}
