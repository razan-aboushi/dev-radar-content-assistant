/*
  Serves the built static site so you can check it before pushing.

  Deliberately a plain Node http server rather than a dependency: `npx serve`
  pulls ~90 packages to do what forty lines do, and this project has two
  runtime dependencies on purpose.

  It mimics GitHub Pages in the way that matters — static files only, no API —
  so if the dashboard works here it will work there.

    npm run site:preview
*/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'site');
const port = Number(process.env.PORT || 4312);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

if (!fs.existsSync(root)) {
  process.stderr.write('No site/ directory. Run `npm run site` first.\n');
  process.exit(1);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);

  // Same traversal guard as the real server: the resolved path must stay inside.
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }

  // Checked against the real path too: a symlink inside site/ passes the
  // prefix test above while pointing anywhere on disk.
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(fs.realpathSync(root) + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  const body = fs.readFileSync(real);
  response.writeHead(200, {
    'content-type': MIME[path.extname(real)] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
});

server.on('error', (error) => {
  process.stderr.write(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Try:  PORT=4313 npm run site:preview\n`
      : `${error.message}\n`,
  );
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`static preview  →  http://127.0.0.1:${port}\n`);
});
