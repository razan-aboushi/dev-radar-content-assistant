import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import { SECURITY_HEADERS, isSameOrigin } from '../src/server/server';

/**
 * Security properties that must not quietly regress.
 *
 * Two of these guard things that are easy to break by accident: the policy
 * that stops injected markup from doing anything, and the check that stops a
 * page you happen to have open from POSTing to your dashboard.
 */

/* ------------------------------------------------------ cross-origin POST */

function request(origin?: string, host = '127.0.0.1:4311') {
  return { headers: origin === undefined ? { host } : { origin, host } };
}

test('a POST from another site is not treated as same-origin', () => {
  // The dashboard has no login because it is yours on localhost. That is fine
  // until a page you have open POSTs to it and starts a research run.
  assert.equal(isSameOrigin(request('https://evil.example')), false);
  assert.equal(isSameOrigin(request('http://localhost:4311')), false, 'a different host is a different origin');
  assert.equal(isSameOrigin(request('http://127.0.0.1:9999')), false, 'a different port is a different origin');
  assert.equal(isSameOrigin(request('null')), false, 'a sandboxed iframe sends Origin: null');
  assert.equal(isSameOrigin(request('not a url')), false);
});

test('the dashboard itself, and command-line clients, are allowed', () => {
  assert.equal(isSameOrigin(request('http://127.0.0.1:4311')), true);
  // curl and fetch from Node send no Origin at all; refusing those would break
  // every scripted use of the API.
  assert.equal(isSameOrigin(request(undefined)), true);
});

/* ------------------------------------------------------------------ CSP */

test('the policy allows only same-origin scripts, styles and connections', () => {
  const csp = SECURITY_HEADERS['content-security-policy']!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);

  // Any of these would defeat the point of having a policy at all.
  for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'", '*']) {
    assert.ok(!csp.includes(unsafe), `policy contains ${unsafe}`);
  }
  assert.equal(SECURITY_HEADERS['x-content-type-options'], 'nosniff');
});

test('the static build carries the same policy, because Pages cannot send headers', () => {
  const html = fs.readFileSync(path.join(config.root, 'src/server/public/index.html'), 'utf8');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(meta, 'index.html has no CSP meta tag');
  const policy = meta[1]!;
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.ok(!policy.includes("'unsafe-inline'"));
});

test('the page has no inline script or style for the policy to have to allow', () => {
  const html = fs.readFileSync(path.join(config.root, 'src/server/public/index.html'), 'utf8');
  // A <script> with a body, or a style attribute, would need 'unsafe-inline'.
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html), 'inline <script> found');
  assert.ok(!/<style[\s>]/i.test(html), 'inline <style> found');
  assert.ok(!/\son\w+=/i.test(html), 'inline event handler attribute found');
});

/* ---------------------------------------------------- client-side sinks */

/** Strips comments, so prose about a sink is not mistaken for using one. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('the client never writes untrusted data into markup', () => {
  // Feed titles and model output both reach the DOM. textContent is what makes
  // that safe, so the dangerous sinks must stay absent.
  const dir = path.join(config.root, 'src/server/public');
  const scripts = ['app.js', 'data.js', 'clipboard.js', 'i18n/index.js', 'i18n/en.js', 'i18n/ar.js'];

  for (const name of scripts) {
    const source = code(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
      assert.ok(!source.includes(sink), `${name} uses ${sink}`);
    }
    // new Function() is eval by another name.
    assert.ok(!/new\s+Function\s*\(/.test(source), `${name} uses new Function()`);
  }
});

test('every href is filtered through the http/https allowlist', () => {
  const app = fs.readFileSync(path.join(config.root, 'src/server/public/app.js'), 'utf8');
  assert.ok(app.includes('function safeUrl'), 'safeUrl is gone');
  assert.match(app, /protocol === 'http:' \|\| .*protocol === 'https:'/);

  // Assignments to .href must go through the allowlist, never straight from
  // API data — a javascript: URL in a feed would otherwise be clickable.
  const assignments = [...app.matchAll(/^\s*\w+\.href\s*=\s*(.+);$/gm)].map((m) => m[1]!.trim());
  assert.ok(assignments.length > 0, 'expected at least one href assignment to check');
  for (const value of assignments) {
    const validated = value === 'href' || /^safeUrl\(/.test(value);
    assert.ok(validated, `unchecked href assignment: ${value}`);
  }
});

test('the policy names the AI endpoints and nothing else', () => {
  // Browser-side generation posts an API key to a provider. connect-src is
  // what stops a compromised script from posting it somewhere else instead.
  const html = fs.readFileSync(path.join(config.root, 'src/server/public/index.html'), 'utf8');
  const policy = html.match(/Content-Security-Policy" content="([^"]+)"/)![1]!;
  const connect = policy.match(/connect-src ([^;]+)/)![1]!.trim().split(/\s+/);

  assert.deepEqual(connect.slice().sort(), [
    "'self'",
    'https://api.cerebras.ai',
    'https://api.groq.com',
    'https://generativelanguage.googleapis.com',
    'https://openrouter.ai',
  ]);

  // Every origin the client can actually call must be in that list.
  const ai = fs.readFileSync(path.join(config.root, 'src/server/public/ai.js'), 'utf8');
  for (const url of [...ai.matchAll(/baseUrl:\s*'([^']+)'/g)].map((m) => m[1]!)) {
    const origin = new URL(url).origin;
    assert.ok(connect.includes(origin), `${origin} is called but not allowed by the policy`);
    assert.match(url, /^https:/, `${url} must be https`);
  }
});

test('the API key is never sent anywhere but the chosen provider', () => {
  const ai = fs.readFileSync(path.join(config.root, 'src/server/public/ai.js'), 'utf8');
  // Exactly one fetch, and its URL is built from the preset table.
  const fetches = [...ai.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]!.trim());
  assert.deepEqual(fetches, ["provider.baseUrl + '/chat/completions'"]);
  // The key is read from storage and put in an Authorization header only.
  assert.ok(ai.includes("authorization: 'Bearer ' + key"));
  assert.ok(!/console\.(log|info|warn|error)\s*\(\s*key/.test(ai), 'the key must never be logged');
});

/* ----------------------------------------------------------- workflow */

test('the publishing workflow asks for no more permission than it needs', () => {
  const workflow = fs.readFileSync(path.join(config.root, '.github/workflows/radar.yml'), 'utf8');
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /pages: write/);
  assert.ok(!/contents: write/.test(workflow), 'the workflow must not be able to write to the repo');
  // Only the built site is published, never the whole checkout.
  assert.match(workflow, /upload-pages-artifact[\s\S]*?path: site/);
  // The AI key is only ever in the step that talks to the model.
  const pregenerate = workflow.slice(workflow.indexOf('Pre-write drafts'));
  assert.match(pregenerate, /OPENAI_API_KEY: \$\{\{ secrets\.AI_API_KEY \}\}/);
  const siteStep = workflow.slice(workflow.indexOf('Build the static site'));
  assert.ok(!siteStep.includes('secrets.AI_API_KEY'), 'the site build must not see the AI key');
});

test('nothing in the repository looks like a committed credential', () => {
  const tracked = ['config/sources.json', 'style/style-profile.json', 'package.json', '.env.example'];
  for (const name of tracked) {
    const file = path.join(config.root, name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of [/\bsk-[A-Za-z0-9]{20,}/, /\bgsk_[A-Za-z0-9]{20,}/, /\bghp_[A-Za-z0-9]{20,}/]) {
      assert.ok(!pattern.test(source), `${name} contains something shaped like an API key`);
    }
  }
});
