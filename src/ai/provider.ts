import { config } from '../config';
import { createLogger } from '../logger';
import { fetchText } from '../util/http';

const log = createLogger('ai');

/**
 * AIProvider is the only thing the writing layer knows about models. Adding a
 * provider means implementing this interface and registering it in getProvider.
 *
 * `available()` is what makes the no-LLM path work: the writing layer asks
 * first, and falls back to deterministic scaffolding when the answer is false.
 */
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  available(): Promise<boolean>;
  complete(request: CompletionRequest): Promise<string>;
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  /** Lower for structured output, higher for prose. */
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export class ProviderUnavailableError extends Error {
  constructor(providerName: string, cause: string) {
    super(`AI provider "${providerName}" is not reachable: ${cause}`);
    this.name = 'ProviderUnavailableError';
  }
}

/* ------------------------------------------------------------------- none */

/** Explicitly configured "no model". Never throws; the caller scaffolds instead. */
export class NullProvider implements AIProvider {
  readonly name = 'none';
  readonly model = 'none';

  async available(): Promise<boolean> {
    return false;
  }

  async complete(): Promise<string> {
    throw new ProviderUnavailableError('none', 'AI_PROVIDER is set to "none"');
  }
}

/* ----------------------------------------------------------------- ollama */

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

/** Free local inference via Ollama's native /api/chat endpoint. */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';

  constructor(
    readonly model: string = config.ai.ollamaModel,
    private readonly baseUrl: string = config.ai.ollamaBaseUrl,
  ) {}

  async available(): Promise<boolean> {
    try {
      const raw = await fetchText(`${this.baseUrl}/api/tags`, {
        timeoutMs: 3000,
        retries: 0,
        accept: 'application/json',
      });
      const parsed = JSON.parse(raw) as { models?: Array<{ name: string }> };
      const names = (parsed.models ?? []).map((m) => m.name);
      if (names.length === 0) {
        log.warn('Ollama is running but has no models pulled. Try: ollama pull ' + this.model);
        return false;
      }
      // Tags include the tag suffix ("llama3.1:8b"); match on either form.
      const base = this.model.split(':')[0] ?? this.model;
      const found = names.some((n) => n === this.model || n.split(':')[0] === base);
      if (!found) {
        log.warn(`Ollama does not have "${this.model}". Available: ${names.join(', ')}`);
        return false;
      }
      return true;
    } catch (error) {
      log.debug('Ollama not reachable', error);
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      stream: false,
      options: {
        temperature: request.temperature ?? 0.8,
        num_predict: request.maxTokens ?? 2048,
      },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
    });

    const raw = await postJson(
      `${this.baseUrl}/api/chat`,
      body,
      request.timeoutMs ?? 180_000,
      {},
    );
    const parsed = JSON.parse(raw) as OllamaChatResponse;
    if (parsed.error) throw new Error(`Ollama error: ${parsed.error}`);
    const content = parsed.message?.content?.trim();
    if (!content) throw new Error('Ollama returned an empty response');
    return content;
  }
}

/* ------------------------------------------------------ openai-compatible */

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

/**
 * Any server exposing POST /v1/chat/completions. That includes llama.cpp's
 * server, LM Studio, vLLM and text-generation-webui — all free and local — as
 * well as paid hosted APIs if you ever choose to point it at one.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name = 'openai-compatible';

  constructor(
    readonly model: string = config.ai.openaiModel,
    private readonly baseUrl: string = config.ai.openaiBaseUrl,
    private readonly apiKey: string = config.ai.openaiApiKey,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async available(): Promise<boolean> {
    try {
      await fetchText(`${this.baseUrl}/models`, {
        timeoutMs: 3000,
        retries: 0,
        headers: this.headers(),
        accept: 'application/json',
      });
      return true;
    } catch (error) {
      log.debug('OpenAI-compatible endpoint not reachable', error);
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      temperature: request.temperature ?? 0.8,
      max_tokens: request.maxTokens ?? 2048,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
    });

    const raw = await postJson(
      `${this.baseUrl}/chat/completions`,
      body,
      request.timeoutMs ?? 180_000,
      this.headers(),
    );
    const parsed = JSON.parse(raw) as OpenAIChatResponse;
    if (parsed.error?.message) throw new Error(`Provider error: ${parsed.error.message}`);
    const content = parsed.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Provider returned an empty response');
    return content;
  }
}

/* ---------------------------------------------------------------- helpers */

/**
 * POST helper. Kept separate from util/http because that module is GET-shaped
 * and rate-limits per host, which we do not want in front of a local model.
 */
async function postJson(
  url: string,
  body: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export function getProvider(): AIProvider {
  switch (config.ai.provider) {
    case 'ollama':
      return new OllamaProvider();
    case 'openai-compatible':
      return new OpenAICompatibleProvider();
    default:
      return new NullProvider();
  }
}

/** Strips ```fences``` and returns the first JSON object or array in the text. */
export function parseJsonResponse<T>(raw: string): T | null {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) return null;
  const opener = cleaned[start];
  const closer = opener === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(closer);
  if (end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
