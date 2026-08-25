import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { getDb } from '../db';
import { createLogger } from '../logger';
import { handleApi } from './api';

const log = createLogger('server');

/**
 * Static file server plus JSON API, on Node's built-in http module.
 *
 * It binds to 127.0.0.1 by default and has no authentication, because it is a
 * single-user local tool and adding auth would be the kind of complexity the
 * brief rules out. Do not expose it on a public interface.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function publicDir(): string {
  const local = path.join(__dirname, 'public');
  if (fs.existsSync(local)) return local;
  return path.join(config.root, 'src/server/public');
}

const MAX_BODY_BYTES = 1_000_000;

/**
 * A malformed or oversized request body is the caller's fault, so it has to
 * come back as 4xx. Without this distinction every bad body was reported as a
 * 500, which reads as "the tool is broken" when nothing is broken.
 */
class BadRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BadRequestError';
    this.status = status;
  }
}

function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequestError('Request body too large', 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new BadRequestError('Body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response: http.ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  response.writeHead(status, {
    'x-content-type-options': 'nosniff',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * Sent on every response. The same rules as the meta tag in index.html, which
 * exists because GitHub Pages cannot set headers; here we can, so we also get
 * frame-ancestors, which a meta tag is not permitted to carry.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function serveStatic(response: http.ServerResponse, pathname: string): void {
  const root = path.resolve(publicDir());
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);

  // Path traversal guard: the resolved path must stay inside the public dir.
  if (!resolved.startsWith(root + path.sep) && resolved !== path.resolve(root, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }

  // The prefix check above compares the path we were asked for, not the file
  // it points at. A symlink inside the public directory satisfies it while
  // resolving anywhere on disk, so the real path is checked too.
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(fs.realpathSync(root) + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  const body = fs.readFileSync(real);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': MIME[path.extname(real)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

/**
 * Rejects state-changing requests that came from another origin.
 *
 * The dashboard has no authentication because it listens on 127.0.0.1 and is
 * yours alone. That is fine for reads, but any page you happen to have open
 * can POST to localhost from your browser, and a POST here starts a research
 * run or rewrites your settings. Same-origin requests send no Origin header or
 * send ours; anything else is not the dashboard talking.
 */
export function isSameOrigin(request: Pick<http.IncomingMessage, 'headers'>): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = request.headers.host ?? `${config.server.host}:${config.server.port}`;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createServer(): http.Server {
  const db = getDb();

  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (!url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') {
        response.writeHead(405).end('Method not allowed');
        return;
      }
      serveStatic(response, url.pathname);
      return;
    }

    if (request.method === 'POST' && !isSameOrigin(request)) {
      log.warn(`rejected cross-origin POST to ${url.pathname} from ${request.headers.origin}`);
      sendJson(response, 403, { error: 'Cross-origin requests are not accepted.' });
      return;
    }

    void (async () => {
      try {
        const body = request.method === 'POST' ? await readBody(request) : {};
        const result = await handleApi(db, {
          method: request.method ?? 'GET',
          pathname: url.pathname,
          query: url.searchParams,
          body,
        });
        sendJson(response, result.status, result.data);
      } catch (error) {
        const status = error instanceof BadRequestError ? error.status : 500;
        // Only genuine faults are logged at error level; a bad body is noise.
        if (status >= 500) log.error(`${request.method} ${url.pathname} failed`, error);
        else log.warn(`${request.method} ${url.pathname} rejected`, error);
        sendJson(response, status, {
          error: error instanceof Error ? error.message : 'Unexpected error',
        });
      }
    })();
  });
}

if (require.main === module) {
  const server = createServer();

  // A busy port is the single most likely startup failure — you left the
  // dashboard running in another tab. Unhandled, net emits an 'error' event
  // that Node turns into a twenty-line stack trace, which reads as a crash in
  // the tool rather than as "it is already running over there".
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      process.stderr.write(
        `Port ${config.server.port} is already in use.\n` +
          `The dashboard may already be running at http://${config.server.host}:${config.server.port}\n` +
          `Start it on another port with:  PORT=4312 npm run dashboard\n`,
      );
    } else {
      process.stderr.write(`${error.message}\n`);
    }
    process.exit(1);
  });

  server.listen(config.server.port, config.server.host, () => {
    process.stdout.write(
      `dev-radar dashboard  →  http://${config.server.host}:${config.server.port}\n`,
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}
