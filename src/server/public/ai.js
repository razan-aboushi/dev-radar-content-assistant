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
  var MODEL_STORAGE = 'dev-radar.aiModel';

  /**
   * Free tiers, no credit card. Kept in step with FREE_PROVIDER_PRESETS in
   * src/config.ts; a test asserts the two lists match.
   *
   * `model` is a starting guess, not a promise: hosted model IDs get retired
   * on a few months' notice and the call then fails with a bare 404. Both
   * defaults originally shipped here were already dead when written. That is
   * why listModels() exists and why Settings offers a picker — a retired model
   * should be a dropdown, not a dead end.
   */
  var PROVIDERS = {
    groq: {
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
      keyUrl: 'https://console.groq.com/keys',
      trainsOnInput: false,
    },
    gemini: {
      label: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.5-flash',
      keyUrl: 'https://aistudio.google.com/apikey',
      trainsOnInput: true,
    },
    openrouter: {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      // Only ":free" suffixed IDs cost nothing on OpenRouter.
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      keyUrl: 'https://openrouter.ai/keys',
      trainsOnInput: false,
    },
    cerebras: {
      label: 'Cerebras',
      baseUrl: 'https://api.cerebras.ai/v1',
      model: 'gpt-oss-120b',
      keyUrl: 'https://cloud.cerebras.ai',
      trainsOnInput: false,
    },
    /*
      Your own machine. No key, no account, no signup — Ollama exposes an
      OpenAI-compatible endpoint on 11434, so it needs no special handling.

      Two caveats worth knowing before choosing it. It only answers while your
      laptop is awake with Ollama running, which is the opposite of why this
      site exists. And Ollama refuses cross-origin requests by default, so it
      has to be told this site is allowed; the UI explains how when you pick it.
    */
    ollama: {
      label: 'Ollama (on your machine)',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3.1:8b',
      keyUrl: 'https://ollama.com/download',
      trainsOnInput: false,
      local: true,
      needsKey: false,
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

  /** Models are remembered per provider, so switching back keeps your choice. */
  function modelKey(provider) {
    return MODEL_STORAGE + '.' + (provider || providerName());
  }

  function currentModel(provider) {
    var name = provider || providerName();
    return read(modelKey(name)) || PROVIDERS[name].model;
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
  function describe(status, body, provider) {
    // A local Ollama answers 403 when it has not been told this origin is
    // allowed. That is a one-line setting, not a bad key, and saying "your key
    // was rejected" would send you looking in entirely the wrong place.
    if (provider && provider.local && status === 403) return 'ollamaOrigin';
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
    if (!provider) throw failure('noProvider');
    var key = options.apiKey || read(KEY_STORAGE);
    // A local model needs no credential; requiring one would be theatre.
    if (!key && provider.needsKey !== false) throw failure('noKey');

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
        headers: key
          ? { 'content-type': 'application/json', authorization: 'Bearer ' + key }
          : { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model || currentModel(options.provider),
          temperature: options.temperature === undefined ? 0.85 : options.temperature,
          max_tokens: options.maxTokens || 2400,
          messages: [
            { role: 'system', content: options.system },
            { role: 'user', content: options.prompt },
          ],
        }),
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw failure('timeout');
      // A local endpoint that cannot be reached means Ollama is not running,
      // which is a different problem from the internet being down.
      throw failure(provider.local ? 'ollamaDown' : 'network');
    } finally {
      clearTimeout(timer);
    }

    var text = await response.text();
    if (!response.ok) throw failure(describe(response.status, text, provider), text.slice(0, 200));

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

    /** Whether the current provider can be called at all right now. */
    get ready() {
      var provider = PROVIDERS[providerName()];
      return provider.needsKey === false || Boolean(read(KEY_STORAGE));
    },

    get needsKey() {
      return PROVIDERS[providerName()].needsKey !== false;
    },

    get model() {
      return currentModel();
    },

    setProvider: function (name) {
      if (!Object.prototype.hasOwnProperty.call(PROVIDERS, name)) return false;
      write(PROVIDER_STORAGE, name);
      return true;
    },

    setModel: function (id) {
      write(modelKey(), String(id || '').trim());
    },

    /**
     * Asks the provider what it can actually run today.
     *
     * This is the answer to model IDs being retired without warning: rather
     * than shipping a name that dies in three months, ask. Every provider here
     * speaks the OpenAI /models endpoint.
     */
    listModels: async function () {
      var provider = PROVIDERS[providerName()];
      var key = read(KEY_STORAGE);
      if (!key && provider.needsKey !== false) throw failure('noKey');

      var response;
      try {
        response = await fetch(provider.baseUrl + '/models', {
          headers: key ? { authorization: 'Bearer ' + key } : {},
        });
      } catch (error) {
        throw failure(provider.local ? 'ollamaDown' : 'network');
      }
      var text = await response.text();
      if (!response.ok) throw failure(describe(response.status, text, provider), text.slice(0, 200));

      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw failure('malformed');
      }
      var models = (parsed.data || parsed.models || [])
        .map(function (entry) {
          return typeof entry === 'string' ? entry : entry.id || entry.name;
        })
        .filter(Boolean);
      models.sort();
      return models;
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
        model: currentModel(),
        language: request.language,
      };
    },

    cleanDraft: cleanDraft,
    cleanArticle: cleanArticle,
  };

  global.aiClient = api;
})(typeof window !== 'undefined' ? window : globalThis);
