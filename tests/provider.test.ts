import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OllamaProvider, OpenAICompatibleProvider, NullProvider, parseJsonResponse } from '../src/ai/provider';

/**
 * The LLM paths are exercised against a stub that speaks the same wire protocol
 * as Ollama and as an OpenAI-compatible server. This verifies request shape,
 * response parsing and failure handling. It says nothing about the quality of a
 * real model's output.
 */
function stubServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; requests: Array<{ path: string; body: string }> }> {
  const requests: Array<{ path: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: req.url ?? '', body });
      handler(req, body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

test('ollama reports available only when the model is actually pulled', async () => {
  const stub = await stubServer((req, _body, res) => {
    if (req.url === '/api/tags') json(res, 200, { models: [{ name: 'llama3.1:8b' }] });
    else json(res, 404, {});
  });
  try {
    assert.equal(await new OllamaProvider('llama3.1:8b', stub.url).available(), true);
    // Tag suffix should not matter.
    assert.equal(await new OllamaProvider('llama3.1', stub.url).available(), true);
    assert.equal(await new OllamaProvider('mistral', stub.url).available(), false);
  } finally {
    await stub.close();
  }
});

test('ollama reports unavailable when no models are pulled', async () => {
  const stub = await stubServer((_req, _body, res) => json(res, 200, { models: [] }));
  try {
    assert.equal(await new OllamaProvider('llama3.1:8b', stub.url).available(), false);
  } finally {
    await stub.close();
  }
});

test('ollama reports unavailable rather than throwing when nothing is listening', async () => {
  const provider = new OllamaProvider('llama3.1:8b', 'http://127.0.0.1:1');
  assert.equal(await provider.available(), false);
});

test('ollama sends system and user messages and returns the content', async () => {
  const stub = await stubServer((req, _body, res) => {
    if (req.url === '/api/chat') json(res, 200, { message: { content: '  Written text.  ' } });
    else json(res, 200, { models: [{ name: 'llama3.1:8b' }] });
  });
  try {
    const provider = new OllamaProvider('llama3.1:8b', stub.url);
    const result = await provider.complete({ system: 'SYS', prompt: 'PROMPT' });
    assert.equal(result, 'Written text.');

    const chat = stub.requests.find((r) => r.path === '/api/chat');
    assert.ok(chat);
    const sent = JSON.parse(chat!.body);
    assert.equal(sent.stream, false, 'streaming must be off; the parser expects one object');
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[0].content, 'SYS');
    assert.equal(sent.messages[1].content, 'PROMPT');
  } finally {
    await stub.close();
  }
});

test('an ollama error field is surfaced as an exception', async () => {
  const stub = await stubServer((_req, _body, res) => json(res, 200, { error: 'model not found' }));
  try {
    await assert.rejects(
      new OllamaProvider('x', stub.url).complete({ system: 's', prompt: 'p' }),
      /model not found/,
    );
  } finally {
    await stub.close();
  }
});

test('an empty completion is treated as a failure, not as empty content', async () => {
  const stub = await stubServer((_req, _body, res) => json(res, 200, { message: { content: '   ' } }));
  try {
    await assert.rejects(
      new OllamaProvider('x', stub.url).complete({ system: 's', prompt: 'p' }),
      /empty/,
    );
  } finally {
    await stub.close();
  }
});

test('openai-compatible provider parses choices and omits auth when no key is set', async () => {
  let sawAuthHeader = true;
  const stub = await stubServer((req, _body, res) => {
    if (req.url === '/chat/completions') {
      sawAuthHeader = req.headers.authorization !== undefined;
      json(res, 200, { choices: [{ message: { content: 'Local model output.' } }] });
    } else {
      json(res, 200, { data: [] });
    }
  });
  try {
    const provider = new OpenAICompatibleProvider('local-model', stub.url, '');
    assert.equal(await provider.available(), true);
    assert.equal(await provider.complete({ system: 's', prompt: 'p' }), 'Local model output.');
    assert.equal(sawAuthHeader, false, 'no Authorization header should be sent without a key');
  } finally {
    await stub.close();
  }
});

test('an http error from the provider is surfaced', async () => {
  const stub = await stubServer((_req, _body, res) => json(res, 500, { error: { message: 'boom' } }));
  try {
    await assert.rejects(
      new OpenAICompatibleProvider('m', stub.url, '').complete({ system: 's', prompt: 'p' }),
      /HTTP 500/,
    );
  } finally {
    await stub.close();
  }
});

test('the null provider is never available and always throws on use', async () => {
  const provider = new NullProvider();
  assert.equal(await provider.available(), false);
  await assert.rejects(provider.complete(), /not reachable/);
});

test('parseJsonResponse survives code fences and surrounding chatter', () => {
  assert.deepEqual(parseJsonResponse('Here you go:\n```json\n{"a":1}\n```\nHope that helps'), { a: 1 });
  assert.deepEqual(parseJsonResponse('[1,2,3]'), [1, 2, 3]);
  assert.equal(parseJsonResponse('no json at all'), null);
  assert.equal(parseJsonResponse('{broken'), null);
});
