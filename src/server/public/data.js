/*
  The data layer.

  The dashboard runs in two places and this is the only file that knows the
  difference:

    live      `npm run dashboard` on your machine. A real server, a real
              database, everything works — research, generation, settings.

    static    GitHub Pages. A scheduled job froze the database into JSON and
              committed it. Reading works exactly as it does locally; anything
              that would write to a database is unavailable, and the client
              hides those controls rather than showing buttons that fail.

  Mode is detected once, by asking for data/mode.json. A local server has no
  such file and answers 404, which is the signal that a backend exists. No
  build flag, no separate bundle, no way for the two to drift apart.
*/
(function (global) {
  'use strict';

  var MODE_UNKNOWN = 'unknown';
  var mode = MODE_UNKNOWN;
  var manifest = null;

  function dataUrl(name) {
    return 'data/' + name;
  }

  async function getJson(url) {
    var response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      var error = new Error('Request failed (' + response.status + ')');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /**
   * Runs once before the first render. A static host answers mode.json; a
   * local server 404s it, because the file only exists in a built site.
   */
  async function detect() {
    if (mode !== MODE_UNKNOWN) return mode;
    try {
      var found = await getJson(dataUrl('mode.json'));
      mode = found && found.mode === 'static' ? 'static' : 'live';
    } catch (error) {
      mode = 'live';
    }
    if (mode === 'static') {
      try {
        manifest = await getJson(dataUrl('manifest.json'));
      } catch (error) {
        manifest = null;
      }
    }
    return mode;
  }

  /* ------------------------------------------------------------- live */

  function withLanguage(path, language) {
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'lang=' + encodeURIComponent(language);
  }

  async function liveRequest(path, options) {
    var settings = options || {};
    var response = await fetch(path, {
      method: settings.method || 'GET',
      headers: settings.body ? { 'content-type': 'application/json' } : undefined,
      body: settings.body ? JSON.stringify(settings.body) : undefined,
    });
    var payload = await response.json().catch(function () {
      return { error: 'Response was not JSON' };
    });
    if (!response.ok) {
      throw new Error(payload.error || 'Request failed (' + response.status + ')');
    }
    return payload;
  }

  /* ----------------------------------------------------------- static */

  /**
   * Filtering and sorting happen in SQL on the live path. On a static host
   * there is no SQL, so the same rules are applied here over the full list.
   * They are kept deliberately simple and identical in effect.
   */
  function filterTopics(rows, query) {
    var minFit = Number(query.min) || 0;
    var minInterest = Number(query.minInterest) || 0;
    var status = query.status || 'any';

    var filtered = rows.filter(function (row) {
      var fit = row.score ? row.score.total : 0;
      var audience = row.score && row.score.audience;
      var interest = audience ? audience.score : 0;
      if (fit < minFit) return false;
      if (interest < minInterest) return false;
      if (status !== 'any' && row.topic.status !== status) return false;
      return true;
    });

    var sorters = {
      opportunity: function (a, b) {
        return (b.opportunity || 0) - (a.opportunity || 0);
      },
      fit: function (a, b) {
        return (b.score ? b.score.total : 0) - (a.score ? a.score.total : 0);
      },
      interest: function (a, b) {
        var av = a.score && a.score.audience ? a.score.audience.score : 0;
        var bv = b.score && b.score.audience ? b.score.audience.score : 0;
        return bv - av;
      },
      newest: function (a, b) {
        var at = Date.parse(a.topic.publishedAt || a.topic.createdAt) || 0;
        var bt = Date.parse(b.topic.publishedAt || b.topic.createdAt) || 0;
        return bt - at;
      },
    };
    return filtered.sort(sorters[query.sort] || sorters.opportunity);
  }

  /** Actions that need a database. Refused clearly rather than half-working. */
  function readOnly() {
    var error = new Error('READ_ONLY');
    error.readOnly = true;
    throw error;
  }

  var api = {
    init: detect,

    get mode() {
      return mode;
    },

    get isStatic() {
      return mode === 'static';
    },

    get manifest() {
      return manifest;
    },

    /** True when this build can write: run research, reject, save settings. */
    get canWrite() {
      return mode !== 'static';
    },

    async overview(language) {
      if (mode === 'static') return getJson(dataUrl('overview.' + language + '.json'));
      return liveRequest(withLanguage('/api/overview', language));
    },

    async weekly(language) {
      if (mode === 'static') return getJson(dataUrl('weekly.' + language + '.json'));
      return liveRequest(withLanguage('/api/weekly', language));
    },

    async topics(query, language) {
      if (mode === 'static') {
        var rows = await getJson(dataUrl('topics.json'));
        return filterTopics(rows, query);
      }
      var search =
        '/api/topics?min=' + encodeURIComponent(query.min) +
        '&minInterest=' + encodeURIComponent(query.minInterest) +
        '&status=' + encodeURIComponent(query.status) +
        '&sort=' + encodeURIComponent(query.sort);
      return liveRequest(withLanguage(search, language));
    },

    async topic(id, language) {
      if (mode === 'static') return getJson(dataUrl('topic/' + encodeURIComponent(id) + '.json'));
      return liveRequest(withLanguage('/api/topic?id=' + encodeURIComponent(id), language));
    },

    async history(language) {
      if (mode === 'static') return getJson(dataUrl('history.json'));
      return liveRequest(withLanguage('/api/history', language));
    },

    async sources(language) {
      if (mode === 'static') return getJson(dataUrl('sources.json'));
      return liveRequest(withLanguage('/api/sources', language));
    },

    async settings(language) {
      if (mode === 'static') return getJson(dataUrl('settings.json'));
      return liveRequest(withLanguage('/api/settings', language));
    },

    async saveSettings(settings) {
      if (mode === 'static') return readOnly();
      return liveRequest('/api/settings', { method: 'POST', body: { settings: settings } });
    },

    async toggleSource(key, enabled) {
      if (mode === 'static') return readOnly();
      return liveRequest('/api/sources/toggle', { method: 'POST', body: { key: key, enabled: enabled } });
    },

    async runRadar() {
      if (mode === 'static') return readOnly();
      return liveRequest('/api/radar', { method: 'POST' });
    },

    async generate(body) {
      if (mode === 'static') return readOnly();
      return liveRequest('/api/generate', { method: 'POST', body: body });
    },

    async setTopicStatus(topicId, status, reason) {
      if (mode === 'static') return readOnly();
      return liveRequest('/api/topic/status', {
        method: 'POST',
        body: { topicId: topicId, status: status, reason: reason },
      });
    },

    async publishContent(contentId) {
      if (mode === 'static') return readOnly();
      return liveRequest('/api/content/publish', { method: 'POST', body: { contentId: contentId } });
    },
  };

  global.dataSource = api;
})(typeof window !== 'undefined' ? window : globalThis);
