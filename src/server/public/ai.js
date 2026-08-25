/*
  Browser-side generation, for the published site.

  On your own machine the server does this: it holds the model connection and
  the database. The published copy has neither, so if the Generate buttons are
  to work there, the browser has to call a free AI API itself.

  How the key is handled, because it matters:

    - It is stored in this browser's localStorage and nowhere else. It is not
      in the repository, not in the snapshot, and not in any build artifact.
    - It is sent to exactly one place: the HTTPS endpoint of the provider you
      picked. The page's Content-Security-Policy names those four origins and
      nothing else, so even a script that somehow ran here could not post your
      key anywhere but the provider you chose.
    - Clearing it clears it. There is no copy.

  The prompts are not built here. They are assembled by the same TypeScript
  the CLI uses and shipped inside each topic's JSON, so the browser and the
  command line ask a model for exactly the same thing.
*/
(function (global) {
  'use strict';

  var KEY_STORAGE = 'dev-radar.aiKey';
  var PROVIDER_STORAGE = 'dev-radar.aiProvider';

  /**
   * Free tiers, no credit card. Kept in step with FREE_PROVIDER_PRESETS in
   * src/config.ts; a test asserts the two lists match.
   */
  var PROVIDERS = {
    groq: {
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      keyUrl: 'https://console.groq.com/keys',
      trainsOnInput: false,
    },
    gemini: {
      label: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.0-flash',
      keyUrl: 'https://aistudio.google.com/apikey',
      trainsOnInput: true,
    },
    openrouter: {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      keyUrl: 'https://openrouter.ai/keys',
      trainsOnInput: false,
    },
    cerebras: {
      label: 'Cerebras',
      baseUrl: 'https://api.cerebras.ai/v1',
      model: 'llama-3.3-70b',
      keyUrl: 'https://cloud.cerebras.ai',
      trainsOnInput: false,
    },
  };

  function read(key) {
    try {
      return global.localStorage ? global.localStorage.getItem(key) : null;
    } catch (error) {
      return null;
    }
  }

  function write(key, value) {
    try {
      if (!global.localStorage) return;
      if (value) global.localStorage.setItem(key, value);
      else global.localStorage.removeItem(key);
    } catch (error) {
      /* Private browsing. The setting applies for this session only. */
    }
  }

  function providerName() {
    var stored = read(PROVIDER_STORAGE);
    return Object.prototype.hasOwnProperty.call(PROVIDERS, stored) ? stored : 'groq';
  }

  /**
   * The wrappers a model puts around a post: a fenced block, a "Here's the
   * post you asked for:" preamble, quotation marks, a hashtag block we append
   * ourselves. Deliberately the same steps as cleanDraft in linkedin.ts, and a
   * test runs both over the same fixtures to keep them honest.
   */
  function cleanDraft(raw) {
    var text = String(raw || '').trim();
    text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    text = text.replace(/^(?:here(?:'s| is) (?:the|your|a) [^\n:]*:?\s*)/i, '').trim();
    text = text.replace(/(?:^|\n)\s*(?:#[\p{L}\p{N}_]+[ \t]*)+$/u, '').trim();
    text = text.replace(/^["'\u201C\u00AB]([\s\S]*)["'\u201D\u00BB]$/, '$1').trim();
    text = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Article bodies keep their markdown; only the talking-about-it is stripped. */
  function cleanArticle(raw) {
    var text = String(raw || '').trim();
    text = text.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();
    text = text.replace(
      /^(?:(?:sure|certainly|of course)[,!]?\s*)?(?:here(?:'s| is| are)|below (?:is|are))\b[^\n]*:\s*\n?/i,
      '',
    );
    // A duplicated H1: the title is stored and rendered separately.
    text = text.replace(/^#\s+.*\n/, '');
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Turns a failed call into something that says what to do about it. */
  function describe(status, body) {
    if (status === 401 || status === 403) return 'invalidKey';
    if (status === 429) return 'rateLimited';
    if (status === 404) return 'badModel';
    if (status >= 500) return 'providerDown';
    if (/model/i.test(body || '')) return 'badModel';
    return 'failed';
  }

  function failure(reason, detail) {
    var error = new Error(reason);
    error.reason = reason;
    error.detail = detail || '';
    return error;
  }

  async function chat(options) {
    var provider = PROVIDERS[options.provider || providerName()];
    var key = options.apiKey || read(KEY_STORAGE);
    if (!provider) throw failure('noProvider');
    if (!key) throw failure('noKey');

    var controller = new AbortController();
    // Long, because a full article on a busy free tier is not quick. Still
    // bounded, so a hung request cannot leave the button spinning forever.
    var timer = setTimeout(function () {
      controller.abort();
    }, options.timeoutMs || 180000);

    var response;
    try {
      response = await fetch(provider.baseUrl + '/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + key,
        },
        body: JSON.stringify({
          model: options.model || provider.model,
          temperature: options.temperature === undefined ? 0.85 : options.temperature,
          max_tokens: options.maxTokens || 2400,
          messages: [
            { role: 'system', content: options.system },
            { role: 'user', content: options.prompt },
          ],
        }),
      });
    } catch (error) {
      throw failure(error && error.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }

    var text = await response.text();
    if (!response.ok) throw failure(describe(response.status, text), text.slice(0, 200));

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw failure('malformed', text.slice(0, 200));
    }
    if (parsed.error) throw failure('failed', parsed.error.message || '');

    var content =
      parsed.choices && parsed.choices[0] && parsed.choices[0].message
        ? String(parsed.choices[0].message.content || '').trim()
        : '';
    if (!content) throw failure('empty');
    return content;
  }

  var api = {
    providers: PROVIDERS,

    get provider() {
      return providerName();
    },

    get providerInfo() {
      return PROVIDERS[providerName()];
    },

    get hasKey() {
      return Boolean(read(KEY_STORAGE));
    },

    setProvider: function (name) {
      if (!Object.prototype.hasOwnProperty.call(PROVIDERS, name)) return false;
      write(PROVIDER_STORAGE, name);
      return true;
    },

    setKey: function (value) {
      write(KEY_STORAGE, String(value || '').trim());
    },

    clearKey: function () {
      write(KEY_STORAGE, '');
    },

    /** A cheap round trip, to tell a bad key from a bad prompt. */
    test: async function () {
      await chat({ system: 'Reply with the single word OK.', prompt: 'OK', maxTokens: 5, temperature: 0 });
      return true;
    },

    /**
     * Generates one draft from a prompt already built by the server.
     * Returns the same shape the API returns, so draftNode renders it
     * unchanged whichever path produced it.
     */
    generate: async function (request) {
      var raw = await chat({
        system: request.system,
        prompt: request.prompt,
        maxTokens: request.kind === 'medium' ? 4000 : 1400,
      });

      var body = request.kind === 'medium' ? cleanArticle(raw) : cleanDraft(raw);
      var hashtags = request.kind === 'medium' ? (request.hashtags || []).slice(0, 5) : request.hashtags || [];

      return {
        id: null,
        topicId: request.topicId,
        kind: request.kind,
        angleKind: request.angle,
        mode: 'llm',
        hook: '',
        title: request.title || '',
        subtitle: request.subtitle || '',
        body: body,
        hashtags: hashtags,
        sources: request.sources || [],
        styleScore: null,
        aiTells: [],
        status: 'draft',
        createdAt: new Date().toISOString(),
        model: PROVIDERS[providerName()].model,
        language: request.language,
      };
    },

    cleanDraft: cleanDraft,
    cleanArticle: cleanArticle,
  };

  global.aiClient = api;
})(typeof window !== 'undefined' ? window : globalThis);
