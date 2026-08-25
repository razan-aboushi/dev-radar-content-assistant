import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { config } from '../src/config';

/**
 * Tests for the browser-side modules.
 *
 * There is no build step and no framework in the dashboard, so i18n and
 * clipboard are plain scripts that attach one object to `window`. That makes
 * them loadable into a vm context with a hand-built fake window, which is
 * enough to test the parts that actually break: dictionary coverage,
 * preference persistence, and the clipboard fallback chain. It needs no
 * headless browser and adds no dependency.
 */

const PUBLIC_DIR = path.join(config.root, 'src/server/public');

function read(file: string): string {
  return fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
}

interface FakeWindow {
  [key: string]: unknown;
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  navigator: Record<string, unknown>;
  document?: unknown;
}

/**
 * A window with just enough surface for the modules under test. The storage
 * object is shared by reference, not copied, so passing one window's store to
 * the next models a page reload rather than a fresh browser profile.
 */
function makeWindow(options: { languages?: string[]; storage?: Record<string, string>; throwOnStorage?: boolean } = {}) {
  const store: Record<string, string> = options.storage ?? {};
  const win: FakeWindow = {
    localStorage: {
      getItem(key) {
        if (options.throwOnStorage) throw new Error('SecurityError: storage disabled');
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key]! : null;
      },
      setItem(key, value) {
        if (options.throwOnStorage) throw new Error('SecurityError: storage disabled');
        store[key] = value;
      },
    },
    navigator: { languages: options.languages ?? ['en-GB', 'en'] },
    document: {
      documentElement: {
        attributes: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          (this.attributes as Record<string, string>)[name] = value;
        },
        getAttribute(name: string) {
          return (this.attributes as Record<string, string>)[name] ?? null;
        },
      },
    },
  };
  win.window = win;
  return { win, store };
}

function loadI18n(options: Parameters<typeof makeWindow>[0] = {}) {
  const { win, store } = makeWindow(options);
  const context = vm.createContext(win);
  for (const file of ['i18n/en.js', 'i18n/ar.js', 'i18n/index.js']) {
    vm.runInContext(read(file), context, { filename: file });
  }
  return { i18n: win.i18n as any, win, store };
}

/* ------------------------------------------------------ dictionaries */

/** Every leaf string path in a nested dictionary. */
function paths(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    paths(value, prefix ? `${prefix}.${key}` : key),
  );
}

test('English and Arabic dictionaries define exactly the same keys', () => {
  const { win } = loadI18n();
  const dictionaries = win.DEV_RADAR_I18N as Record<string, unknown>;
  const english = new Set(paths(dictionaries.en));
  const arabic = new Set(paths(dictionaries.ar));

  const missingInArabic = [...english].filter((key) => !arabic.has(key));
  const extraInArabic = [...arabic].filter((key) => !english.has(key));

  assert.deepEqual(missingInArabic, [], `untranslated: ${missingInArabic.join(', ')}`);
  assert.deepEqual(extraInArabic, [], `orphaned Arabic keys: ${extraInArabic.join(', ')}`);
  assert.ok(english.size > 100, `expected a substantial dictionary, got ${english.size} keys`);
});

test('no Arabic string was left as its English original', () => {
  const { win } = loadI18n();
  const dictionaries = win.DEV_RADAR_I18N as Record<string, any>;

  // Product names and format strings are the same in both by design.
  const shared = new Set([
    'app.title',
    'meta.name',
    'meter.linkedin',
    'meter.medium',
    'settings.hints.minStyleScore',
    'settings.hints.maxStyleRewrites',
  ]);

  const untranslated: string[] = [];
  for (const key of paths(dictionaries.en)) {
    if (shared.has(key)) continue;
    const en = key.split('.').reduce<any>((n, k) => n?.[k], dictionaries.en);
    const ar = key.split('.').reduce<any>((n, k) => n?.[k], dictionaries.ar);
    // A translated string either differs, or is pure punctuation/placeholders.
    if (en === ar && /[A-Za-z]{4,}/.test(en)) untranslated.push(key);
  }
  assert.deepEqual(untranslated, [], `still English: ${untranslated.join(', ')}`);
});

test('every Arabic string that should be Arabic actually contains Arabic script', () => {
  const { win } = loadI18n();
  const dictionaries = win.DEV_RADAR_I18N as Record<string, any>;
  // Keys whose value is legitimately Latin: product names and the meta block.
  const latinAllowed = /^(meta\.|app\.title|meter\.(linkedin|medium)|status\.|tier\.)/;
  /** Format strings made only of placeholders, digits and punctuation. */
  const hasNoWords = (value: string) => !/\p{L}/u.test(value.replace(/\{\w+\}/g, ''));

  const suspicious: string[] = [];
  for (const key of paths(dictionaries.ar)) {
    if (latinAllowed.test(key)) continue;
    const value: string = key.split('.').reduce<any>((n, k) => n?.[k], dictionaries.ar);
    if (hasNoWords(value)) continue;
    if (!/[\u0600-\u06FF]/.test(value)) suspicious.push(key);
  }
  assert.deepEqual(suspicious, [], `no Arabic script in: ${suspicious.join(', ')}`);
});

/* --------------------------------------------------------- i18n service */

test('translation interpolates placeholders and leaves unknown ones visible', () => {
  const { i18n } = loadI18n();
  i18n.init();
  assert.equal(i18n.t('draft.words', { count: 42 }), '42 words');
  assert.equal(i18n.t('draft.words', {}), '{count} words');
});

test('a missing key falls back to English, then to the key itself', () => {
  const { i18n, win } = loadI18n();
  i18n.init();
  i18n.setLanguage('ar');
  // Simulate a key that exists in English but not yet in Arabic.
  delete (win.DEV_RADAR_I18N as any).ar.draft.copied;
  assert.equal(i18n.t('draft.copied'), 'Copied ✓');
  assert.equal(i18n.t('nothing.here.at.all'), 'nothing.here.at.all');
});

test('switching to Arabic sets dir=rtl and lang=ar on the document', () => {
  const { i18n, win } = loadI18n();
  i18n.init();
  const root = (win.document as any).documentElement;
  assert.equal(root.getAttribute('dir'), 'ltr');
  assert.equal(root.getAttribute('lang'), 'en');

  i18n.setLanguage('ar');
  assert.equal(root.getAttribute('dir'), 'rtl');
  assert.equal(root.getAttribute('lang'), 'ar');
  assert.equal(i18n.dir, 'rtl');

  i18n.setLanguage('en');
  assert.equal(root.getAttribute('dir'), 'ltr');
  assert.equal(root.getAttribute('lang'), 'en');
});

test('the interface language survives a reload', () => {
  const { i18n, store } = loadI18n();
  i18n.init();
  i18n.setLanguage('ar');
  assert.equal(store['dev-radar.uiLanguage'], 'ar');

  // A fresh page load reading the same storage.
  const reloaded = loadI18n({ storage: store });
  reloaded.i18n.init();
  assert.equal(reloaded.i18n.language, 'ar');
  assert.equal((reloaded.win.document as any).documentElement.getAttribute('dir'), 'rtl');
});

test('an unsupported stored language does not poison the next load', () => {
  const { i18n } = loadI18n({ storage: { 'dev-radar.uiLanguage': 'klingon' } });
  i18n.init();
  assert.equal(i18n.language, 'en');
  assert.equal(i18n.setLanguage('klingon'), false);
});

test('the first visit follows the browser language', () => {
  const arabicBrowser = loadI18n({ languages: ['ar-JO', 'ar', 'en'] });
  arabicBrowser.i18n.init();
  assert.equal(arabicBrowser.i18n.language, 'ar');

  const otherBrowser = loadI18n({ languages: ['fr-FR'] });
  otherBrowser.i18n.init();
  assert.equal(otherBrowser.i18n.language, 'en');
});

test('a browser with storage disabled still switches language for the session', () => {
  // Safari private windows throw from localStorage rather than returning null.
  const { i18n } = loadI18n({ throwOnStorage: true });
  assert.doesNotThrow(() => i18n.init());
  assert.equal(i18n.setLanguage('ar'), true);
  assert.equal(i18n.language, 'ar');
});

/* ----------------------------------------------- content language split */

test('content language is stored separately and never follows the interface', () => {
  const { i18n, store } = loadI18n();
  i18n.init();

  i18n.setContentLanguage('ar');
  assert.equal(i18n.contentLanguage, 'ar');
  assert.equal(i18n.language, 'en', 'switching content language must not move the interface');

  i18n.setLanguage('ar');
  i18n.setContentLanguage('en');
  assert.equal(i18n.language, 'ar');
  assert.equal(i18n.contentLanguage, 'en', 'an Arabic interface must be able to write English');

  assert.equal(store['dev-radar.uiLanguage'], 'ar');
  assert.equal(store['dev-radar.contentLanguage'], 'en');
});

test('switching the interface never drags the content language with it', () => {
  // The regression: the content language was seeded from the interface on
  // every load instead of being written down once. Switch the interface to
  // Arabic, refresh, and English drafts silently became Arabic drafts.
  const { i18n, store } = loadI18n();
  i18n.init();
  assert.equal(i18n.contentLanguage, 'en');

  i18n.setLanguage('ar');
  assert.equal(i18n.contentLanguage, 'en');

  const reloaded = loadI18n({ storage: store });
  reloaded.i18n.init();
  assert.equal(reloaded.i18n.language, 'ar');
  assert.equal(reloaded.i18n.contentLanguage, 'en');
});

test('both preferences survive a reload independently', () => {
  const { i18n, store } = loadI18n();
  i18n.init();
  i18n.setLanguage('ar');
  i18n.setContentLanguage('ar');

  const reloaded = loadI18n({ storage: store });
  reloaded.i18n.init();
  assert.equal(reloaded.i18n.language, 'ar');
  assert.equal(reloaded.i18n.contentLanguage, 'ar');

  reloaded.i18n.setLanguage('en');
  const again = loadI18n({ storage: store });
  again.i18n.init();
  assert.equal(again.i18n.language, 'en');
  assert.equal(again.i18n.contentLanguage, 'ar', 'content language must stay where it was put');
});

test('listeners fire for both kinds of language change', () => {
  const { i18n } = loadI18n();
  i18n.init();
  const seen: Array<[string, string]> = [];
  i18n.onChange((ui: string, content: string) => seen.push([ui, content]));
  i18n.setLanguage('ar');
  i18n.setContentLanguage('ar');
  // Setting the same value again is not a change.
  i18n.setLanguage('ar');
  i18n.setContentLanguage('ar');
  assert.deepEqual(seen, [['ar', 'en'], ['ar', 'ar']]);
});

/* ------------------------------------------------------------ clipboard */

interface ClipboardHarness {
  copyText(text: string): Promise<{ ok: boolean; reason?: string }>;
  execCommandCalls: string[];
  copiedViaTextarea: string[];
  removedNodes: number;
}

function loadClipboard(options: {
  asyncClipboard?: 'ok' | 'reject-denied' | 'reject-other' | 'absent';
  execCommand?: boolean | 'absent';
  secure?: boolean;
} = {}): ClipboardHarness {
  const execCommandCalls: string[] = [];
  const copiedViaTextarea: string[] = [];
  let removedNodes = 0;
  let focusRestored = false;

  const body = {
    appendChild() {},
    removeChild() {
      removedNodes += 1;
    },
  };

  const doc: Record<string, unknown> = {
    body,
    activeElement: {
      focus() {
        focusRestored = true;
      },
    },
    createElement() {
      return {
        value: '',
        style: {},
        setAttribute() {},
        select() {},
        setSelectionRange() {},
      };
    },
  };

  if (options.execCommand !== 'absent') {
    doc.execCommand = (command: string) => {
      execCommandCalls.push(command);
      // The textarea holds the text at the moment execCommand is called.
      copiedViaTextarea.push('called');
      if (options.execCommand === false) return false;
      return true;
    };
  }

  const win: Record<string, unknown> = {
    document: doc,
    isSecureContext: options.secure !== false,
    location: { protocol: 'http:', hostname: '127.0.0.1' },
    navigator: {},
  };

  const mode = options.asyncClipboard ?? 'ok';
  if (mode !== 'absent') {
    (win.navigator as Record<string, unknown>).clipboard = {
      writeText: async () => {
        if (mode === 'ok') return;
        const error = new Error('blocked');
        error.name = mode === 'reject-denied' ? 'NotAllowedError' : 'TypeError';
        throw error;
      },
    };
  }

  win.window = win;
  const context = vm.createContext(win);
  vm.runInContext(read('clipboard.js'), context, { filename: 'clipboard.js' });

  return {
    copyText: (text) => (win.clipboard as any).copyText(text),
    execCommandCalls,
    copiedViaTextarea,
    get removedNodes() {
      return removedNodes;
    },
    get focusRestored() {
      return focusRestored;
    },
  } as ClipboardHarness;
}

/**
 * The result object is built inside the vm realm, so its prototype is a
 * different Object than this file's and deepStrictEqual rejects it on identity
 * alone. Comparing the two fields is what the assertion was about anyway.
 */
async function expectCopy(
  harness: ClipboardHarness,
  text: string,
  expected: { ok: boolean; reason?: string },
) {
  const result = await harness.copyText(text);
  assert.equal(result.ok, expected.ok, `ok mismatch (reason: ${result.reason})`);
  assert.equal(result.reason, expected.reason);
}

test('the modern clipboard API is used when it works', async () => {
  const harness = loadClipboard({ asyncClipboard: 'ok' });
  await expectCopy(harness, 'hello', { ok: true });
  assert.deepEqual(harness.execCommandCalls, [], 'should not have needed the fallback');
});

test('a rejected clipboard write falls back to execCommand and still succeeds', async () => {
  // The usual case: Firefox refuses writeText outside a gesture it recognises.
  const harness = loadClipboard({ asyncClipboard: 'reject-denied', execCommand: true });
  await expectCopy(harness, 'hello', { ok: true });
  assert.deepEqual(harness.execCommandCalls, ['copy']);
});

test('a browser with no clipboard API at all uses the fallback', async () => {
  const harness = loadClipboard({ asyncClipboard: 'absent', execCommand: true });
  await expectCopy(harness, 'hello', { ok: true });
  assert.deepEqual(harness.execCommandCalls, ['copy']);
});

test('when both paths fail the reason is reported, never silent success', async () => {
  const denied = loadClipboard({ asyncClipboard: 'reject-denied', execCommand: false });
  await expectCopy(denied, 'hello', { ok: false, reason: 'denied' });

  const unavailable = loadClipboard({ asyncClipboard: 'reject-other', execCommand: false });
  await expectCopy(unavailable, 'hello', { ok: false, reason: 'unavailable' });

  // No clipboard API and no execCommand, over plain http on a LAN address.
  const insecure = loadClipboard({ asyncClipboard: 'absent', execCommand: 'absent', secure: false });
  await expectCopy(insecure, 'hello', { ok: false, reason: 'insecure' });
});

test('the fallback always removes its textarea and restores focus', async () => {
  const harness = loadClipboard({ asyncClipboard: 'absent', execCommand: false });
  await harness.copyText('hello');
  assert.equal(harness.removedNodes, 1, 'the offscreen textarea must not be left in the document');
  assert.equal((harness as unknown as { focusRestored: boolean }).focusRestored, true);
});

test('copying empty text is refused rather than reported as a success', async () => {
  const harness = loadClipboard({ asyncClipboard: 'ok' });
  await expectCopy(harness, '', { ok: false, reason: 'unavailable' });
});

test('long Arabic content with emoji goes through the modern path unchanged', async () => {
  const harness = loadClipboard({ asyncClipboard: 'ok' });
  const long = `${'أهلاً بالجميع! 💛 '.repeat(500)}\n\n#برمجة`;
  await expectCopy(harness, long, { ok: true });
});

/* ------------------------------------------------------------- markup */

test('the page loads i18n, clipboard and the data layer before the app', () => {
  const html = read('index.html');
  const order = ['i18n/en.js', 'i18n/ar.js', 'i18n/index.js', 'clipboard.js', 'data.js', 'app.js'];
  const positions = order.map((src) => html.indexOf(`src="${src}"`));
  for (const [index, position] of positions.entries()) {
    assert.ok(position > -1, `${order[index]} is not referenced`);
    if (index > 0) assert.ok(position > positions[index - 1]!, `${order[index]} loads too early`);
  }
});

test('every asset path is relative, so the site works under a GitHub Pages subpath', () => {
  // Pages serves this from /<repo>/, where a leading slash resolves to the
  // user's root domain and 404s every script and stylesheet.
  const html = read('index.html');
  const absolute = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)]
    .map((match) => match[1]!)
    .filter((url) => !url.startsWith('//'));
  assert.deepEqual(absolute, [], `absolute asset paths found: ${absolute.join(', ')}`);
});

test('the language switch is present, keyboard reachable and labelled in both languages', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="lang-switch"'));
  // Real buttons, so they are focusable and operable without any extra work.
  assert.ok(/<button[^>]+data-lang="en"/.test(html));
  assert.ok(/<button[^>]+data-lang="ar"/.test(html));
  // Each option is marked with its own language for screen readers.
  assert.ok(/data-lang="ar"[^>]*lang="ar"/.test(html));
  assert.ok(html.includes('العربية'));
});

test('action feedback is reported beside the control, not only in the flash bar', () => {
  /*
    The regression this pins: the generate buttons live in the detail panel on
    one side of a wide screen and the flash bar lives at the top of the main
    column on the other — measured 640px apart, and off-screen entirely once
    the panel is scrolled. Clicking Generate with no API key reported the
    problem into a region the reader was not looking at, which is
    indistinguishable from the button doing nothing.
  */
  const app = read('app.js');
  assert.ok(app.includes('function panelStatus'), 'panelStatus is gone');
  assert.ok(app.includes("id: 'panel-status'"), 'the panel has no status host');

  // generate() must report failures into the panel, not just flash().
  const generate = app.slice(app.indexOf('async function generate(topicId'));
  const body = generate.slice(0, generate.indexOf('\n}\n'));
  assert.ok(body.includes('panelStatus('), 'generate() does not report into the panel');

  // And the case where no model can be reached must be caught before any
  // request is attempted. `ready` rather than `hasKey`: a local Ollama needs
  // no key, so requiring one would block a provider that works.
  assert.ok(
    /!window\.dataSource\.canWrite && !window\.aiClient\.ready/.test(body),
    'generate() does not short-circuit when no model is reachable',
  );
  // The message must carry the action that fixes it.
  assert.ok(body.includes("t('ai.openSettings')"), 'the failure offers no way forward');
});

test('the panel warns about a missing key before the buttons, not after', () => {
  // A muted footnote under a button that will fail is a button that looks
  // broken. The callout goes above them.
  const app = read('app.js');
  const calloutAt = app.indexOf("callout--action");
  const buttonsAt = app.indexOf("el('div', { class: 'btn-row' }, actions)");
  assert.ok(calloutAt > -1, 'the missing-key callout is gone');
  assert.ok(buttonsAt > -1, 'the generate button row is gone');
  assert.ok(calloutAt < buttonsAt, 'the callout must render before the buttons');
});

test('the stylesheet has no physical left/right properties left to break RTL', () => {
  const css = read('styles.css');
  const offenders: string[] = [];
  for (const line of css.split('\n')) {
    const rule = line.split('/*')[0] ?? '';
    // Deliberate exceptions live under [dir="rtl"] or inside the meter, which
    // is a chart and must not mirror.
    if (/\[dir=/.test(rule)) continue;
    if (/(?:^|[\s;{])(?:margin|padding|border)-(?:left|right)\b/.test(rule)) offenders.push(line.trim());
    if (/text-align:\s*(?:left|right)/.test(rule)) offenders.push(line.trim());
  }
  assert.deepEqual(offenders, [], `physical properties found:\n${offenders.join('\n')}`);
});
