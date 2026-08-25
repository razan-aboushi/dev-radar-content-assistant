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
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function serveStatic(response: http.ServerResponse, pathname: string): void {
  const root = publicDir();
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);

  // Path traversal guard: the resolved path must stay inside the public dir.
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }

  const body = fs.readFileSync(resolved);
  response.writeHead(200, {
    'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
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
