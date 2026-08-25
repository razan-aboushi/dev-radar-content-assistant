/*
  i18n service.

  Two independent preferences live here, and keeping them apart is the whole
  point of the module:

    uiLanguage      what the dashboard chrome is written in
    contentLanguage what a generated post or article is written in

  An Arabic interface writing English posts is a normal thing to want. So is the
  reverse. Nothing couples them.

  Both survive a refresh in localStorage. Every read and write is wrapped,
  because localStorage throws rather than returning null in a Safari private
  window and in any browser where site data is blocked — an unguarded read there
  takes the whole dashboard down before it renders a single row.
*/
(function (global) {
  'use strict';

  var UI_KEY = 'dev-radar.uiLanguage';
  var CONTENT_KEY = 'dev-radar.contentLanguage';
  var SUPPORTED = ['en', 'ar'];
  var DEFAULT = 'en';

  var listeners = [];
  var uiLanguage = DEFAULT;
  var contentLanguage = DEFAULT;

  function isSupported(value) {
    return SUPPORTED.indexOf(value) !== -1;
  }

  function readStored(key) {
    try {
      return global.localStorage ? global.localStorage.getItem(key) : null;
    } catch (error) {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      if (global.localStorage) global.localStorage.setItem(key, value);
    } catch (error) {
      // A preference that cannot be persisted still applies for this session.
    }
  }

  /** First run: follow the browser rather than assuming English. */
  function detectFromBrowser() {
    var languages = (global.navigator && (global.navigator.languages || [global.navigator.language])) || [];
    for (var i = 0; i < languages.length; i += 1) {
      var tag = String(languages[i] || '').toLowerCase();
      if (tag.indexOf('ar') === 0) return 'ar';
      if (tag.indexOf('en') === 0) return 'en';
    }
    return DEFAULT;
  }

  function dictionary(language) {
    var all = global.DEV_RADAR_I18N || {};
    return all[language] || all[DEFAULT] || {};
  }

  /** Walks "draft.copyPost" through the dictionary. */
  function lookup(dict, path) {
    var parts = path.split('.');
    var node = dict;
    for (var i = 0; i < parts.length; i += 1) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[parts[i]];
    }
    return typeof node === 'string' ? node : undefined;
  }

  function interpolate(template, values) {
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
    });
  }

  /**
   * Falls back to English before falling back to the key itself, so a missing
   * Arabic string shows readable English rather than "draft.copyPost".
   */
  function translate(path, values) {
    var text = lookup(dictionary(uiLanguage), path);
    if (text === undefined) text = lookup(dictionary(DEFAULT), path);
    if (text === undefined) return path;
    return interpolate(text, values);
  }

  function meta(language) {
    var dict = dictionary(language || uiLanguage);
    return dict.meta || { dir: 'ltr', htmlLang: 'en', nativeName: 'English', name: 'English' };
  }

  function applyDocumentLanguage() {
    var info = meta(uiLanguage);
    var root = global.document && global.document.documentElement;
    if (!root) return;
    root.setAttribute('dir', info.dir);
    root.setAttribute('lang', info.htmlLang);
  }

  function notify() {
    for (var i = 0; i < listeners.length; i += 1) listeners[i](uiLanguage, contentLanguage);
  }

  var api = {
    supported: SUPPORTED.slice(),

    init: function () {
      var storedUi = readStored(UI_KEY);
      uiLanguage = isSupported(storedUi) ? storedUi : detectFromBrowser();

      var storedContent = readStored(CONTENT_KEY);
      if (isSupported(storedContent)) {
        contentLanguage = storedContent;
      } else {
        // Seeded from the interface language on a first visit, then written
        // down immediately. Leaving it underived meant it was re-derived on
        // every load: switch the interface to Arabic, refresh, and the content
        // language you never touched had quietly become Arabic too.
        contentLanguage = uiLanguage;
        writeStored(CONTENT_KEY, contentLanguage);
      }

      applyDocumentLanguage();
      return api;
    },

    get language() {
      return uiLanguage;
    },

    get contentLanguage() {
      return contentLanguage;
    },

    get dir() {
      return meta(uiLanguage).dir;
    },

    isSupported: isSupported,
    t: translate,
    meta: meta,

    setLanguage: function (language) {
      if (!isSupported(language) || language === uiLanguage) return false;
      uiLanguage = language;
      writeStored(UI_KEY, language);
      applyDocumentLanguage();
      notify();
      return true;
    },

    setContentLanguage: function (language) {
      if (!isSupported(language) || language === contentLanguage) return false;
      contentLanguage = language;
      writeStored(CONTENT_KEY, language);
      notify();
      return true;
    },

    /** Text direction for a specific piece of content, not for the chrome. */
    dirFor: function (language) {
      return meta(language).dir;
    },

    onChange: function (listener) {
      listeners.push(listener);
    },
  };

  global.i18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
