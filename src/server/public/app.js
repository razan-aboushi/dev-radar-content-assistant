/*
  dev-radar dashboard client.

  Feed content is untrusted: every value that came from a remote source is put
  into the DOM with textContent or as an element property. innerHTML is never
  used with data from the API, and every URL is checked against an http/https
  allowlist before it reaches an href.

  Text direction is decided per string, not per page. The interface follows
  i18n.language; a topic title from an English feed and an Arabic draft both
  carry their own direction, so an Arabic interface never mangles an English
  headline and an English interface never mangles an Arabic post.
*/

'use strict';

/* Fixed component codes, in the same order as the CLI sparkline. */
const METER_KEYS = [
  'freshness',
  'relevance',
  'practicalValue',
  'discussionPotential',
  'educationalValue',
  'originality',
  'audienceFit',
];

const state = {
  view: 'radar',
  topicId: null,
  panelTrigger: null,
  /** Increments on every topic open so a slow response cannot overwrite a newer one. */
  panelToken: 0,
};

const t = (key, values) => window.i18n.t(key, values);

/* ------------------------------------------------------------ utilities */

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = String(opts.text);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, String(v));
  if (opts.on) for (const [event, fn] of Object.entries(opts.on)) node.addEventListener(event, fn);
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Text whose direction is decided by its own first strong character rather
 * than by the interface. Everything that came from a feed or a model goes
 * through here.
 */
function autoText(tag, className, text) {
  return el(tag, { class: className, text, attrs: { dir: 'auto' } });
}

/**
 * An href is the one place remote text becomes executable. Adapters already
 * reject anything that is not http or https, but a database written by hand or
 * carried over from an older version has not been through them, so the check
 * is repeated at the point of use.
 */
function safeUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function externalLink(url, label) {
  const href = safeUrl(url);
  if (!href) return el('span', { class: 'kv', text: label || url, attrs: { dir: 'ltr' } });
  const anchor = el('a', { class: 'kv', text: label || url, attrs: { dir: 'ltr' } });
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

/**
 * Every read and write goes through window.dataSource, which knows whether it
 * is talking to a local server or to the static JSON a scheduled job committed
 * to GitHub Pages. Nothing else in this file needs to care.
 *
 * The dashboard's language rides along on every read, because some of the
 * prose the server returns — weekly section headings, the sentence explaining
 * why a topic ranked where it did — is assembled from score data and cannot be
 * translated after the fact.
 */
async function call(fn) {
  try {
    return await fn(window.i18n.language);
  } catch (error) {
    if (error && error.readOnly) throw new Error(t('static.readOnly'));
    // fetch only rejects on a transport failure, which for a local dashboard
    // means the server stopped. Saying so beats "Failed to fetch".
    if (error instanceof TypeError) throw new Error(t('error.network'));
    throw error;
  }
}

let flashTimer = null;

/**
 * The auto-hide timer is cancelled before a new message is shown. Without
 * that, the timer from "Generating…" fired part-way through reading the
 * success message that replaced it and blanked the bar mid-sentence.
 */
function flash(message, kind) {
  const node = document.getElementById('flash');
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  node.textContent = message;
  node.dataset.kind = kind || 'ok';
  node.setAttribute('dir', 'auto');
  node.hidden = false;
  if (kind !== 'error') {
    flashTimer = setTimeout(() => {
      node.hidden = true;
      flashTimer = null;
    }, 6000);
  }
}

function relativeDate(iso) {
  if (!iso) return t('date.undated');
  const days = (Date.now() - Date.parse(iso)) / 86400000;
  if (!Number.isFinite(days)) return t('date.undated');
  if (days < 1) return t('date.today');
  if (days < 2) return t('date.yesterday');
  if (days < 30) return t('date.daysAgo', { count: Math.round(days) });
  return t('date.monthsAgo', { count: Math.round(days / 30) });
}

/**
 * Runs an async action with a disabled button and a busy label, and reports
 * failures instead of leaving a dead promise. Every async control on the page
 * goes through this, so none of them can end up stuck or silent.
 *
 * The button is captured by the caller before the first await. Reading
 * event.currentTarget afterwards returns null — the browser clears it the
 * moment the listener returns, which for an async listener is at the first
 * await, not at the end.
 */
async function withBusy(button, busyLabel, action) {
  const original = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
  }
  try {
    return await action();
  } catch (error) {
    flash(error.message, 'error');
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      if (busyLabel) button.textContent = original;
    }
  }
}

/* --------------------------------------------------------- components */

function meter(score) {
  const wrap = el('div');
  const bars = el('div', {
    class: 'meter',
    attrs: { role: 'img', 'aria-label': t('meter.legendLabel') },
  });
  for (const key of METER_KEYS) {
    const value = Math.max(0, Math.min(100, Number(score[key]) || 0));
    const bar = el('div', {
      class: 'meter-bar',
      attrs: { title: `${t(`meter.${key}`)}: ${Math.round(value)}` },
    });
    const fill = el('div', { class: 'meter-fill' });
    fill.style.height = `${value}%`;
    bar.appendChild(fill);
    bars.appendChild(bar);
  }
  wrap.appendChild(bars);

  // One initial per bar, each in its own box the same width as the bar above
  // it. As a single string the Arabic initials reorder themselves as one
  // right-to-left run inside the left-to-right chart, so the letters ended up
  // labelling the wrong bars. A one-character element has no run to reorder.
  const legend = el('div', { class: 'meter-legend', attrs: { 'aria-hidden': 'true' } });
  for (const initial of t('meter.legend').split(' ')) {
    legend.appendChild(el('span', { text: initial }));
  }
  wrap.appendChild(legend);

  const dials = el('div', { class: 'dials' }, [
    el('div', { class: 'dial' }, [
      el('b', { text: score.linkedinScore }),
      el('span', { text: t('meter.linkedin') }),
    ]),
    el('div', { class: 'dial' }, [
      el('b', { text: score.mediumScore }),
      el('span', { text: t('meter.medium') }),
    ]),
  ]);
  wrap.appendChild(dials);
  return wrap;
}

function statusTag(topic) {
  const map = {
    rejected: 'tag--bad',
    published: 'tag--primary',
    shortlisted: 'tag--primary',
    drafted: 'tag--warn',
  };
  return el('span', { class: `tag ${map[topic.status] || ''}`, text: t(`status.${topic.status}`) });
}

/** Compact "1.2k" style, so a five-figure reach does not blow out the row. */
function shortNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1000) {
    const thousands = n / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(thousands % 1 === 0 ? 0 : 1)}k`;
  }
  return String(Math.round(n));
}

/**
 * The audience strip: band, score, estimated reach, and the measured facts
 * underneath. The evidence line is the point — it turns "interest 87" from a
 * number you have to trust into one you can check.
 */
function interestStrip(audience) {
  if (!audience) {
    return el('p', { class: 'topic-interest topic-interest--none', text: t('score.noInterest') });
  }

  const strip = el('div', { class: `topic-interest is-${audience.band}` }, [
    el('span', {
      class: 'interest-band',
      text: t(`band.${audience.band}`),
      attrs: { title: t(`band.${audience.band}Hint`) },
    }),
    el('span', { class: 'interest-score', text: audience.score, attrs: { title: t('score.interestHint') } }),
    el('span', {
      class: 'interest-reach',
      attrs: { dir: 'ltr' },
      text: t('score.reachShort', {
        min: shortNumber(audience.reachMin),
        max: shortNumber(audience.reachMax),
      }),
    }),
  ]);

  const evidence = renderEvidence(audience.evidence);
  if (evidence) {
    strip.appendChild(
      el('span', { class: 'interest-evidence', attrs: { dir: 'auto' }, text: evidence }),
    );
  }
  return strip;
}

/**
 * Evidence arrives as `{ code, params }` rather than finished sentences,
 * precisely so it can be said in the reader's language. Plain strings are
 * still accepted: a row scored by an older build has them, and showing English
 * evidence beats showing none.
 */
function renderEvidence(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item.code !== 'string') return '';
      const params = { ...(item.params || {}) };
      // `level` is itself a translatable bucket name, not a number.
      if (typeof params.level === 'string') params.level = t(`demand.${params.level}`);
      if (typeof params.count === 'number') params.count = params.count.toLocaleString('en-US');
      return t(`evidence.${item.code}`, params);
    })
    .filter(Boolean)
    .join(' · ');
}

function topicRow(entry, why) {
  const topic = entry.topic || entry;
  const score = entry.score;
  const audience = score ? score.audience : null;
  const opportunity = entry.opportunity !== undefined ? entry.opportunity : null;

  const tags = el('div', { class: 'topic-tags' }, [
    el('span', { class: 'tag', text: topic.category, attrs: { dir: 'ltr' } }),
    el('span', {
      class: `tag ${topic.sourceTier === 'primary' ? 'tag--primary' : ''}`,
      text: t(`tier.${topic.sourceTier}`),
    }),
    el('span', { class: 'tag', text: relativeDate(topic.publishedAt) }),
    statusTag(topic),
    score && score.controversy >= 60
      ? el('span', { class: 'tag tag--heat', text: t('topic.heat', { value: score.controversy }) })
      : null,
    score && score.confidence < 55
      ? el('span', { class: 'tag tag--warn', text: t('topic.lowConfidence', { value: score.confidence }) })
      : null,
  ]);

  // The headline number, plus the two it is made of. Previously the row showed
  // one score and left a wide empty band between the title and the meter; the
  // space now carries the evidence a decision actually needs.
  const scoreCell = el('div', { class: 'topic-scores' }, [
    el('div', { class: 'score-main', attrs: { title: t('score.opportunityHint') } }, [
      el('b', { text: opportunity !== null ? opportunity : '—' }),
      el('small', { text: t('score.opportunityShort') }),
    ]),
    el('div', { class: 'score-split' }, [
      el('span', { attrs: { title: t('score.fitHint') } }, [
        el('b', { text: score ? Math.round(score.total) : '—' }),
        document.createTextNode(` ${t('score.fitShort')}`),
      ]),
      el('span', { attrs: { title: t('score.interestHint') } }, [
        el('b', { text: audience ? audience.score : '—' }),
        document.createTextNode(` ${t('score.interestShort')}`),
      ]),
    ]),
  ]);

  const middle = el('div', { class: 'topic-main' }, [
    autoText('h3', 'topic-title', topic.title),
    why ? autoText('p', 'topic-why', why) : null,
    interestStrip(audience),
    tags,
  ]);

  return el(
    'li',
    {},
    [
      el(
        'button',
        {
          class: 'topic',
          attrs: { type: 'button' },
          on: { click: (event) => openTopic(topic.id, event.currentTarget) },
        },
        [scoreCell, middle, score ? meter(score) : el('div')],
      ),
    ],
  );
}

/**
 * The "what am I looking at" panel. Collapsed by default after the first read,
 * because the answer to "I don't understand this screen" is an explanation on
 * the screen itself rather than in a README nobody opens.
 */
const EXPLAIN_KEY = 'dev-radar.explainDismissed';

function readFlag(key) {
  try {
    return window.localStorage ? window.localStorage.getItem(key) === '1' : false;
  } catch {
    return false;
  }
}

function writeFlag(key, on) {
  try {
    if (window.localStorage) window.localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* A preference that cannot be stored still applies for this session. */
  }
}

function explainer() {
  const wrap = el('div', { class: 'explain' });
  let open = !readFlag(EXPLAIN_KEY);

  const toggle = el('button', {
    class: 'explain-toggle',
    attrs: { type: 'button', 'aria-expanded': open ? 'true' : 'false' },
    text: open ? t('explain.close') : t('explain.open'),
  });

  const body = el('div', { class: 'explain-body' }, [
    el('p', { class: 'explain-intro', text: t('explain.intro') }),
    el('div', { class: 'explain-grid' }, [
      ['oppTitle', 'oppBody'],
      ['fitTitle', 'fitBody'],
      ['interestTitle', 'interestBody'],
      ['barsTitle', 'barsBody'],
      ['nextTitle', 'nextBody'],
    ].map(([title, copy]) =>
      el('div', { class: 'explain-item' }, [
        el('h3', { text: t(`explain.${title}`) }),
        el('p', { text: t(`explain.${copy}`) }),
      ]),
    )),
  ]);
  body.hidden = !open;

  toggle.addEventListener('click', () => {
    open = !open;
    body.hidden = !open;
    toggle.textContent = open ? t('explain.close') : t('explain.open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    writeFlag(EXPLAIN_KEY, !open);
  });

  wrap.appendChild(el('div', { class: 'explain-head' }, [
    el('h2', { class: 'explain-title', text: t('explain.title') }),
    toggle,
  ]));
  wrap.appendChild(body);
  return wrap;
}

/* -------------------------------------------------------------- views */

async function loadRadar() {
  const data = await call((lang) => window.dataSource.overview(lang));

  const badge = document.getElementById('provider-badge');
  badge.textContent = data.provider.available
    ? `${data.provider.name} · ${data.provider.model}`
    : `${data.provider.name} · ${t('app.modelOffline')}`;

  document.getElementById('last-run').textContent = data.lastRun
    ? t('nav.lastRun', {
        when: relativeDate(data.lastRun.startedAt),
        items: data.lastRun.itemsNew,
        topics: data.lastRun.topicsNew,
      })
    : t('nav.noRuns');

  document.getElementById('radar-date').textContent = data.daily.date;
  document.getElementById('radar-summary').textContent =
    `${t('radar.summary', {
      count: data.daily.entries.length,
      min: data.daily.minScore,
      considered: data.daily.totalConsidered,
    })} ${data.provider.available ? t('radar.modelConnected') : t('radar.modelMissing')}`;

  const pick = document.getElementById('top-pick');
  clear(pick);
  if (data.daily.top) {
    const top = data.daily.top;
    const topAudience = top.score ? top.score.audience : null;

    // A scorecard beside the prose. The card used to be one column of text
    // against a full-width dark panel, which left half of it empty at desktop
    // width — the numbers now live in that space.
    const numbers = el('div', { class: 'pick-numbers' }, [
      el('div', { class: 'pick-figure' }, [
        el('b', { text: top.opportunity }),
        el('span', { text: t('score.opportunity') }),
      ]),
      el('div', { class: 'pick-figure' }, [
        el('b', { text: top.score ? Math.round(top.score.total) : '—' }),
        el('span', { text: t('score.fit') }),
      ]),
      el('div', { class: 'pick-figure' }, [
        el('b', { text: topAudience ? topAudience.score : '—' }),
        el('span', { text: t('score.interest') }),
      ]),
      topAudience
        ? el('p', {
            class: 'pick-reach',
            attrs: { dir: 'ltr' },
            text: t('score.reach', {
              min: shortNumber(topAudience.reachMin),
              max: shortNumber(topAudience.reachMax),
            }),
          })
        : null,
    ]);

    const prose = el('div', { class: 'pick-body' }, [
      el('p', { class: 'eyebrow', text: t('radar.topPick') }),
      autoText('h3', null, top.topic.title),
      autoText('p', null, top.whyItMatters),
      autoText('p', null, top.whyYourAudienceCares),
      autoText('p', null, t('radar.suggestedAngle', { angle: top.suggestedAngle })),
      el('div', { class: 'pick-actions' }, [
          el('button', {
            class: 'btn btn-ghost',
            attrs: { type: 'button' },
            text: t('radar.openTopic'),
            on: { click: (event) => openTopic(top.topic.id, event.currentTarget) },
          }),
          el('button', {
            class: 'btn btn-ghost',
            attrs: { type: 'button' },
            text: t('topic.generateLinkedIn'),
            on: {
              // The button carries its own busy state here too; without it the
              // top pick could be clicked repeatedly and generate duplicates.
              click: (event) => {
                const button = event.currentTarget;
                return withBusy(button, t('draft.generatingPost'), async () => {
                  await openTopic(top.topic.id, button);
                  await generate(top.topic.id, 'linkedin', undefined, null);
                });
              },
            },
          }),
      ]),
    ]);

    pick.appendChild(el('div', { class: 'pick' }, [prose, numbers]));
  }

  const explainHost = document.getElementById('radar-explain');
  clear(explainHost);
  explainHost.appendChild(explainer());

  const list = document.getElementById('radar-list');
  clear(list);
  if (data.daily.entries.length === 0) {
    list.appendChild(
      el('li', {}, [
        el('div', { class: 'empty' }, [
          el('p', { text: t('radar.emptyTitle') }),
          el('p', { text: t('radar.emptyHint') }),
        ]),
      ]),
    );
    return;
  }
  for (const entry of data.daily.entries) {
    list.appendChild(topicRow(entry, entry.whyItMatters));
  }
}

async function loadTopics() {
  const min = document.getElementById('filter-min').value;
  const minInterest = document.getElementById('filter-interest').value;
  const status = document.getElementById('filter-status').value;
  const sort = document.getElementById('filter-sort').value;
  const rows = await call((lang) => window.dataSource.topics({ min, minInterest, status, sort }, lang));
  const list = document.getElementById('topics-list');
  clear(list);
  if (rows.length === 0) {
    list.appendChild(
      el('li', {}, [
        el('div', { class: 'empty' }, [
          el('p', { text: t('topics.empty') }),
          el('p', { text: t('topics.emptyHint') }),
        ]),
      ]),
    );
    return;
  }
  for (const row of rows) list.appendChild(topicRow(row, row.topic.rejectionReason || ''));
}

async function loadWeekly() {
  const data = await call((lang) => window.dataSource.weekly(lang));
  document.getElementById('weekly-range').textContent = `${data.from} → ${data.to}`;
  const body = document.getElementById('weekly-body');
  clear(body);
  if (data.sections.length === 0) {
    body.appendChild(el('div', { class: 'empty', text: t('weekly.empty') }));
    return;
  }
  for (const section of data.sections) {
    body.appendChild(el('h2', { text: section.label, attrs: { dir: 'auto' } }));
    const list = el('ol', { class: 'topic-list' });
    for (const entry of section.entries) list.appendChild(topicRow(entry, entry.whyItMatters));
    body.appendChild(list);
  }
}

async function loadHistory() {
  const data = await call((lang) => window.dataSource.history(lang));
  const body = document.getElementById('history-body');
  clear(body);

  body.appendChild(el('h2', { text: t('history.runs') }));
  body.appendChild(
    table(
      [t('history.runStarted'), t('history.runSources'), t('history.runNewItems'), t('history.runNewTopics')],
      data.runs.map((run) => [
        run.startedAt.slice(0, 19).replace('T', ' '),
        `${run.sourcesOk}/${run.sourcesOk + run.sourcesFailed}`,
        String(run.itemsNew),
        String(run.topicsNew),
      ]),
      t('history.noRuns'),
    ),
  );

  body.appendChild(el('h2', { text: t('history.drafts') }));
  body.appendChild(
    table(
      [
        t('history.draftDate'),
        t('history.draftKind'),
        t('history.draftLanguage'),
        t('history.draftMode'),
        t('history.draftStyle'),
        t('history.draftStatus'),
        t('history.draftTopic'),
      ],
      data.drafts.map((draft) => [
        draft.createdAt.slice(0, 10),
        draft.kind,
        draft.language,
        draft.mode,
        draft.styleScore ? String(draft.styleScore.total) : '—',
        draft.status,
        draft.topicTitle,
      ]),
      t('history.noDrafts'),
    ),
  );

  body.appendChild(el('h2', { text: t('history.published') }));
  body.appendChild(
    table(
      [t('history.publishedTopic'), t('history.publishedCategory')],
      data.published.map((topic) => [topic.title, topic.category]),
      t('history.noPublished'),
    ),
  );

  body.appendChild(el('h2', { text: t('history.rejected') }));
  body.appendChild(
    table(
      [t('history.rejectedTopic'), t('history.rejectedReason')],
      data.rejected.map((topic) => [topic.title, topic.rejectionReason || '']),
      t('history.noRejected'),
    ),
  );
}

function table(headers, rows, emptyText) {
  if (rows.length === 0) return el('div', { class: 'empty', text: emptyText });
  const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);
  const tbody = el(
    'tbody',
    {},
    // Cells hold titles and reasons from remote sources, so each decides its
    // own direction rather than inheriting the interface's.
    rows.map((row) => el('tr', {}, row.map((cell) => el('td', { text: cell, attrs: { dir: 'auto' } })))),
  );
  return el('div', { class: 'table-scroll' }, [el('table', { class: 'grid' }, [thead, tbody])]);
}

async function loadSources() {
  const sources = await call((lang) => window.dataSource.sources(lang));
  const body = document.getElementById('sources-body');
  clear(body);

  if (sources.length === 0) {
    body.appendChild(el('div', { class: 'empty', text: t('sources.empty') }));
    return;
  }

  const tbody = el('tbody');
  for (const source of sources) {
    const toggle = el('input', {
      attrs: { type: 'checkbox', 'aria-label': t('sources.toggleLabel', { key: source.key }) },
    });
    toggle.checked = source.enabled;
    toggle.disabled = !window.dataSource.canWrite;
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        await call(() => window.dataSource.toggleSource(source.key, toggle.checked));
        flash(t(toggle.checked ? 'sources.enabled' : 'sources.disabled', { key: source.key }));
      } catch (error) {
        toggle.checked = !toggle.checked;
        flash(error.message, 'error');
      } finally {
        toggle.disabled = false;
      }
    });

    // The full error is kept in the title: a source that failed for a reason
    // longer than 60 characters used to have that reason cut off, which is
    // exactly when you need to read it.
    const status = source.lastStatus
      ? `${source.lastStatus}${source.lastError ? ` — ${source.lastError}` : ''}`
      : t('sources.neverFetched');

    tbody.appendChild(
      el('tr', {}, [
        el('td', {}, [toggle]),
        el('td', { class: 'num', text: source.key, attrs: { dir: 'ltr' } }),
        el('td', { text: source.name, attrs: { dir: 'auto' } }),
        el('td', { text: t(`tier.${source.tier}`) }),
        el('td', { class: 'num', text: source.kind, attrs: { dir: 'ltr' } }),
        el('td', {
          class: `source-status${source.lastStatus === 'error' ? ' is-error' : ''}`,
          text: status,
          attrs: { dir: 'auto', title: status },
        }),
      ]),
    );
  }

  body.appendChild(
    el('div', { class: 'table-scroll' }, [
      el('table', { class: 'grid' }, [
        el('thead', {}, [
          el(
            'tr',
            {},
            ['sources.on', 'sources.key', 'sources.name', 'sources.tier', 'sources.kind', 'sources.lastFetch'].map(
              (key) => el('th', { text: t(key) }),
            ),
          ),
        ]),
        tbody,
      ]),
    ]),
  );
}

/** Settings the tool reads but does not yet act on. Labelled, never hidden. */
const UNSUPPORTED_SETTINGS = new Set(['enabledCategories']);

function contentLanguageChooser(onChange) {
  const group = el('div', {
    class: 'lang-choice',
    attrs: { role: 'radiogroup', 'aria-label': t('settings.contentLanguageHeading') },
  });
  const buttons = [];

  for (const code of window.i18n.supported) {
    const selected = window.i18n.contentLanguage === code;
    const button = el('button', {
      class: `lang-choice-option${selected ? ' is-selected' : ''}`,
      text: window.i18n.meta(code).nativeName,
      attrs: {
        type: 'button',
        role: 'radio',
        lang: window.i18n.meta(code).htmlLang,
        'aria-checked': selected ? 'true' : 'false',
        tabindex: selected ? '0' : '-1',
      },
      on: {
        click: () => {
          window.i18n.setContentLanguage(code);
          for (const other of buttons) {
            const active = other.dataset.lang === code;
            other.classList.toggle('is-selected', active);
            other.setAttribute('aria-checked', active ? 'true' : 'false');
            other.tabIndex = active ? 0 : -1;
          }
          if (onChange) onChange(code);
        },
      },
    });
    button.dataset.lang = code;
    button.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(button);
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      const next = buttons[(index + step + buttons.length) % buttons.length];
      next.click();
      next.focus();
    });
    buttons.push(button);
    group.appendChild(button);
  }

  return group;
}

/**
 * Where the AI key lives.
 *
 * Only shown on the published site: locally the model comes from .env and the
 * server holds it, which is strictly better than putting it in a browser.
 */
function aiSettings() {
  const wrap = el('div', { class: 'ai-settings' });
  wrap.appendChild(el('h2', { text: t('ai.heading') }));
  wrap.appendChild(el('p', { class: 'lede', text: t('ai.intro') }));

  const providerRow = el('div', { class: 'setting' });
  const select = el('select', { attrs: { id: 'ai-provider' } });
  for (const [name, info] of Object.entries(window.aiClient.providers)) {
    const option = el('option', { text: info.label, attrs: { value: name } });
    if (name === window.aiClient.provider) option.selected = true;
    select.appendChild(option);
  }

  const privacyNote = el('span', { class: 'hint' });
  const updatePrivacy = () => {
    const info = window.aiClient.providers[select.value];
    privacyNote.textContent = info.trainsOnInput ? t('ai.trains') : t('ai.doesNotTrain');
    privacyNote.className = `hint${info.trainsOnInput ? ' hint--warn' : ''}`;
  };
  updatePrivacy();

  select.addEventListener('change', () => {
    window.aiClient.setProvider(select.value);
    updatePrivacy();
    syncKeyRow();
    const info = window.aiClient.providers[select.value];
    keyLink.href = safeUrl(info.keyUrl);
    keyLink.textContent = t('ai.getKey', { provider: info.label });
  });

  providerRow.appendChild(el('label', { text: t('ai.provider'), attrs: { for: 'ai-provider' } }));
  providerRow.appendChild(select);
  providerRow.appendChild(privacyNote);
  wrap.appendChild(providerRow);

  const keyRow = el('div', { class: 'setting' });
  const keyInput = el('input', {
    attrs: {
      type: 'password',
      id: 'ai-key',
      dir: 'ltr',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: window.aiClient.hasKey ? '••••••••••••••••' : '',
    },
  });
  // A local model has no credential to enter, so the field is not shown at all
  // rather than sitting there implying one is required.
  const syncKeyRow = () => {
    const local = !window.aiClient.needsKey;
    keyRow.hidden = local;
    localNote.hidden = !local;
  };
  const localNote = el('div', { class: 'callout callout--action ai-local-note' }, [
    el('p', {}, [
      document.createTextNode(`${t('ai.localIntro')} `),
      el('code', { text: `OLLAMA_ORIGINS=${window.location.origin}`, attrs: { dir: 'ltr' } }),
      document.createTextNode(` ${t('ai.localRestart')}`),
    ]),
  ]);
  const keyLink = el('a', { text: t('ai.getKey', { provider: window.aiClient.providerInfo.label }) });
  keyLink.href = safeUrl(window.aiClient.providerInfo.keyUrl);
  keyLink.target = '_blank';
  keyLink.rel = 'noopener noreferrer';

  keyRow.appendChild(el('label', { text: t('ai.key'), attrs: { for: 'ai-key' } }));
  keyRow.appendChild(keyInput);
  keyRow.appendChild(el('span', { class: 'hint' }, [keyLink]));
  wrap.appendChild(keyRow);
  wrap.appendChild(localNote);
  syncKeyRow();

  /*
    The model picker.

    Hosted model IDs are retired on a few months' notice — Groq dropped
    llama-3.3-70b-versatile and Google dropped gemini-2.0-flash, both of which
    shipped here as defaults and were already dead. Rather than hardcode a name
    that dies, ask the provider what it runs today.
  */
  const modelRow = el('div', { class: 'setting' });
  const modelSelect = el('select', { attrs: { id: 'ai-model' } });
  const modelHint = el('span', { class: 'hint', text: t('ai.modelHint') });

  const setModelOptions = (models) => {
    clear(modelSelect);
    const current = window.aiClient.model;
    const all = models.includes(current) ? models : [current, ...models];
    for (const id of all) {
      const option = el('option', { text: id, attrs: { value: id } });
      if (id === current) option.selected = true;
      modelSelect.appendChild(option);
    }
  };
  setModelOptions([window.aiClient.model]);
  modelSelect.addEventListener('change', () => {
    window.aiClient.setModel(modelSelect.value);
    flash(t('ai.modelSet', { model: modelSelect.value }));
  });

  modelRow.appendChild(el('label', { text: t('ai.model'), attrs: { for: 'ai-model' } }));
  modelRow.appendChild(modelSelect);
  modelRow.appendChild(modelHint);
  wrap.appendChild(modelRow);

  wrap.appendChild(
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        attrs: { type: 'button' },
        text: t('ai.saveAndTest'),
        on: {
          click: (event) => {
            const button = event.currentTarget;
            return withBusy(button, t('ai.testing'), async () => {
              if (keyInput.value.trim()) window.aiClient.setKey(keyInput.value.trim());
              if (!window.aiClient.ready) {
                flash(t('ai.errNoKey'), 'error');
                return;
              }
              try {
                // The model list first: if the configured model has been
                // retired, this is what turns a dead end into a dropdown.
                //
                // Best effort, never fatal. Some providers restrict /models
                // on a free key, and refusing to connect over that would be
                // punishing you for a listing you do not need.
                try {
                  const models = await window.aiClient.listModels();
                  if (models.length > 0) {
                    if (!models.includes(window.aiClient.model)) {
                      window.aiClient.setModel(models[0]);
                      flash(t('ai.modelRetired', { model: models[0] }), 'warn');
                    }
                    setModelOptions(models);
                  }
                } catch (listError) {
                  /* Fall through to the connection test, which is the real check. */
                }

                await window.aiClient.test();
                keyInput.value = '';
                keyInput.setAttribute('placeholder', '••••••••••••••••');
                flash(
                  t('ai.testOk', { provider: window.aiClient.providerInfo.label }) +
                    ` ${t('ai.usingModel', { model: window.aiClient.model })}`,
                );
              } catch (error) {
                flash(aiErrorMessage(error), 'error');
              }
            });
          },
        },
      }),
      window.aiClient.hasKey
        ? el('button', {
            class: 'btn',
            attrs: { type: 'button' },
            text: t('ai.clearKey'),
            on: {
              click: () => {
                window.aiClient.clearKey();
                flash(t('ai.keyCleared'));
                void loadSettings();
              },
            },
          })
        : null,
    ]),
  );

  wrap.appendChild(el('p', { class: 'hint ai-privacy', text: t('ai.privacy') }));
  return wrap;
}

async function loadSettings() {
  const data = await call((lang) => window.dataSource.settings(lang));
  const body = document.getElementById('settings-body');
  clear(body);

  // The key only belongs in a browser when there is no server to hold it.
  if (!window.dataSource.canWrite) body.appendChild(aiSettings());

  body.appendChild(el('h2', { text: t('settings.contentLanguageHeading') }));
  body.appendChild(el('p', { class: 'lede', text: t('settings.contentLanguageHint') }));
  body.appendChild(contentLanguageChooser());

  body.appendChild(el('h2', { text: t('settings.heading') }));
  body.appendChild(
    el('p', {
      class: 'lede',
      attrs: { dir: 'auto' },
      text: t('settings.provider', { provider: data.provider, model: data.model }),
    }),
  );

  const inputs = {};
  for (const [key, value] of Object.entries(data.settings)) {
    const unsupported = UNSUPPORTED_SETTINGS.has(key);
    const input = el('input', {
      attrs: { type: 'text', id: `setting-${key}`, dir: 'ltr', spellcheck: 'false' },
    });
    input.value = value;
    input.disabled = !window.dataSource.canWrite;
    inputs[key] = input;
    body.appendChild(
      el('div', { class: `setting${unsupported ? ' is-unsupported' : ''}` }, [
        el('label', { text: key, attrs: { for: `setting-${key}`, dir: 'ltr' } }),
        input,
        el('span', { class: 'hint', text: t(`settings.hints.${key}`) }),
      ]),
    );
  }

  if (window.dataSource.canWrite) {
    body.appendChild(
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn',
          attrs: { type: 'button' },
          text: t('settings.save'),
          on: {
            click: (event) => {
              const button = event.currentTarget;
              return withBusy(button, t('settings.saving'), async () => {
                const settings = {};
                for (const [key, input] of Object.entries(inputs)) settings[key] = input.value;
                await call(() => window.dataSource.saveSettings(settings));
                flash(t('settings.saved'));
              });
            },
          },
        }),
      ]),
    );
  }
}

/* ------------------------------------------------------- topic detail */

/**
 * Returns focus to whatever opened the panel. Without this a keyboard user
 * closes the panel and lands back at the top of the document, losing their
 * place in a list that can be dozens of topics long.
 */
function closePanel() {
  const panel = document.getElementById('panel');
  panel.hidden = true;
  const trigger = state.panelTrigger;
  state.panelTrigger = null;
  if (trigger && document.contains(trigger)) trigger.focus();
}

async function openTopic(id, trigger) {
  // Clicking two topics in quick succession used to render whichever request
  // finished last, which is not necessarily the one that was clicked last.
  const token = (state.panelToken += 1);
  state.topicId = id;

  const panel = document.getElementById('panel');
  const body = document.getElementById('panel-body');
  state.panelTrigger = trigger || document.activeElement;
  panel.hidden = false;
  panel.focus();
  clear(body);
  body.appendChild(el('p', { class: 'kv', text: t('topic.loading') }));

  let data;
  try {
    data = await call((lang) => window.dataSource.topic(id, lang));
  } catch (error) {
    if (token !== state.panelToken) return;
    clear(body);
    body.appendChild(el('div', { class: 'empty', text: error.message, attrs: { dir: 'auto' } }));
    return;
  }
  if (token !== state.panelToken) return;

  clear(body);
  renderTopic(body, data);
}

function renderTopic(body, data) {
  const { topic, score, facts, angles, drafts, nearMatches, hashtags } = data;

  body.appendChild(autoText('h3', null, topic.title));
  body.appendChild(
    el('p', { class: 'kv', attrs: { dir: 'auto' } }, [
      el('b', { text: topic.category }),
      document.createTextNode(
        ` · ${topic.sourceKey} (${t(`tier.${topic.sourceTier}`)}) · ${relativeDate(topic.publishedAt)}`,
      ),
    ]),
  );

  body.appendChild(el('p', { class: 'kv' }, [externalLink(topic.sourceUrl)]));

  if (topic.summary) body.appendChild(autoText('p', null, topic.summary));

  if (nearMatches.length > 0) {
    body.appendChild(el('h2', { text: t('topic.nearMatches') }));
    for (const match of nearMatches) {
      body.appendChild(
        autoText(
          'p',
          'kv',
          t('topic.nearMatch', { percent: Math.round(match.similarity * 100), title: match.title }),
        ),
      );
    }
  }

  if (score) {
    body.appendChild(
      el('h2', { text: t('topic.score', { total: score.total, confidence: score.confidence }) }),
    );
    body.appendChild(meter(score));
    body.appendChild(
      el(
        'ul',
        { class: 'reasons' },
        score.reasons.map((reason) => el('li', { text: reason, attrs: { dir: 'auto' } })),
      ),
    );
  }

  body.appendChild(el('h2', { text: t('topic.facts', { count: facts.length }) }));
  if (facts.length === 0) {
    body.appendChild(el('p', { class: 'kv', text: t('topic.noFacts') }));
  }
  for (const fact of facts) {
    body.appendChild(
      el('div', { class: `fact fact--${fact.status}`, attrs: { dir: 'auto' } }, [
        document.createTextNode(fact.claim),
        el('span', { class: 'fact-note', text: `${fact.status} — ${fact.note}` }),
      ]),
    );
  }

  body.appendChild(el('h2', { text: t('topic.angles') }));
  let selectedAngle = (angles.find((a) => a.recommended) || angles[0] || {}).kind;
  const angleNodes = [];
  // A radiogroup of buttons, not clickable divs: the angle decides what gets
  // written, so it has to be reachable and operable from the keyboard.
  const angleGroup = el('div', {
    class: 'angle-group',
    attrs: { role: 'radiogroup', 'aria-label': t('topic.anglesLabel') },
  });
  for (const angle of angles) {
    const isSelected = angle.kind === selectedAngle;
    const node = el(
      'button',
      {
        class: `angle${isSelected ? ' is-selected' : ''}`,
        attrs: {
          type: 'button',
          role: 'radio',
          'aria-checked': isSelected ? 'true' : 'false',
          // Roving tabindex: one stop for the group, arrows move within it.
          tabindex: isSelected ? '0' : '-1',
        },
      },
      [
        autoText('h4', null, angle.title),
        autoText('p', null, angle.description),
        el('p', {
          class: 'kv',
          text: angle.kind + (angle.recommended ? ` · ${t('topic.recommended')}` : ''),
        }),
      ],
    );

    node.addEventListener('click', () => {
      selectedAngle = angle.kind;
      for (const other of angleNodes) {
        const active = other === node;
        other.classList.toggle('is-selected', active);
        other.setAttribute('aria-checked', active ? 'true' : 'false');
        other.tabIndex = active ? 0 : -1;
      }
      node.focus();
    });
    node.addEventListener('keydown', (event) => {
      const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      const index = angleNodes.indexOf(node);
      angleNodes[(index + step + angleNodes.length) % angleNodes.length].click();
    });

    angleNodes.push(node);
    angleGroup.appendChild(node);
  }
  body.appendChild(angleGroup);

  body.appendChild(el('h2', { text: t('topic.hashtags') }));
  body.appendChild(
    el('p', {
      class: 'kv',
      attrs: { dir: 'ltr' },
      text: hashtags.length > 0 ? hashtags.join(' ') : t('topic.noHashtags'),
    }),
  );

  // The content language sits with the generate buttons, not buried in
  // Settings, because this is the moment the choice is actually made.
  body.appendChild(el('h2', { text: t('settings.contentLanguageHeading') }));
  body.appendChild(contentLanguageChooser());

  // Generating works on the published site too — the browser calls a free AI
  // API with a key you keep in this browser. Only the actions that need a
  // database (rejecting a topic) are limited to the local build.
  const canGenerate = window.dataSource.canWrite || window.aiClient.ready;

  const actions = [
    el('button', {
      class: 'btn btn-generate',
      attrs: { type: 'button' },
      text: t('topic.generateLinkedIn'),
      on: { click: (event) => generate(topic.id, 'linkedin', selectedAngle, event.currentTarget, data) },
    }),
    el('button', {
      class: 'btn btn-generate',
      attrs: { type: 'button' },
      text: t('topic.generateMedium'),
      on: { click: (event) => generate(topic.id, 'medium', selectedAngle, event.currentTarget, data) },
    }),
  ];

  if (window.dataSource.canWrite) {
    actions.push(
      el('button', {
        class: 'btn',
        attrs: { type: 'button' },
        text: t('topic.reject'),
        on: {
          click: (event) => {
            const button = event.currentTarget;
            // Previously an unhandled promise: a failure here changed nothing
            // on screen and reported nothing at all.
            return withBusy(button, t('topic.rejecting'), async () => {
              await call(() =>
                window.dataSource.setTopicStatus(topic.id, 'rejected', 'Rejected by hand'),
              );
              flash(t('topic.rejected'));
              await refresh();
            });
          },
        },
      }),
    );
  }

  // No key yet on the published site: a prominent callout above the buttons,
  // not a grey footnote below them. Muted small print next to a button that
  // will fail is a button that looks broken.
  if (!canGenerate) {
    body.appendChild(
      el('div', { class: 'callout callout--action' }, [
        el('p', { text: t('ai.needKey') }),
        el('button', {
          class: 'btn btn-solid',
          attrs: { type: 'button' },
          text: t('ai.openSettings'),
          on: { click: () => void show('settings') },
        }),
      ]),
    );
  }

  body.appendChild(el('div', { class: 'btn-row' }, actions));

  /*
    Feedback belongs beside the control that caused it.

    These buttons live in the detail panel on one side of the screen while the
    flash bar lives at the top of the main column on the other — measured at
    640px apart, and further once the panel is scrolled. Clicking Generate
    reported "no API key" into a region you were not looking at, which is
    indistinguishable from the button doing nothing at all.
  */
  const statusHost = el('div', { class: 'panel-status', attrs: { id: 'panel-status', role: 'status', 'aria-live': 'polite' } });
  body.appendChild(statusHost);

  const draftsHost = el('div', { attrs: { id: 'drafts-host' } });
  body.appendChild(draftsHost);
  for (const draft of drafts) draftsHost.appendChild(draftNode(draft));
}

/**
 * Shows a message inside the topic panel, next to the generate buttons.
 * Mirrored to the flash bar so the message is not missed either way.
 */
function panelStatus(message, kind, action) {
  const host = document.getElementById('panel-status');
  flash(message, kind);
  if (!host) return;

  clear(host);
  const box = el('div', { class: `callout callout--${kind || 'ok'}` }, [
    el('p', { text: message, attrs: { dir: 'auto' } }),
  ]);
  if (action) {
    box.appendChild(
      el('button', {
        class: 'btn btn-solid',
        attrs: { type: 'button' },
        text: action.label,
        on: { click: action.onClick },
      }),
    );
  }
  host.appendChild(box);
  // The panel scrolls independently; bring the message into view within it.
  box.scrollIntoView({ block: 'nearest' });
}

function clearPanelStatus() {
  const host = document.getElementById('panel-status');
  if (host) clear(host);
}

/* -------------------------------------------------------------- drafts */

/**
 * The copy button.
 *
 * `publishText` is the whole piece — for LinkedIn the post plus its hashtags,
 * for Medium the title, subtitle and every section as markdown. It is the same
 * string rendered in the <pre> above, so what is copied is what is read.
 *
 * The old version awaited navigator.clipboard and then wrote to
 * event.currentTarget, which the browser had already set to null. The
 * TypeError landed in the catch meant for clipboard failures, so a copy that
 * had actually succeeded reported "clipboard blocked" every single time.
 */
function copyButton(draft) {
  const isArticle = draft.kind === 'medium';
  const label = t(isArticle ? 'draft.copyArticle' : 'draft.copyPost');

  const button = el('button', {
    class: 'btn btn-copy',
    text: label,
    attrs: {
      type: 'button',
      'aria-label': t(isArticle ? 'draft.copyArticleLabel' : 'draft.copyPostLabel'),
    },
  });

  let restoreTimer = null;

  button.addEventListener('click', async () => {
    const result = await window.clipboard.copyText(draft.publishText);

    if (!result.ok) {
      const reasons = {
        insecure: t('error.clipboardInsecure'),
        denied: t('error.clipboardDenied'),
        unavailable: t('error.clipboardUnavailable'),
      };
      flash(t('draft.copyFailed', { reason: reasons[result.reason] || reasons.unavailable }), 'error');
      return;
    }

    button.textContent = t('draft.copied');
    button.classList.add('is-copied');
    flash(t(isArticle ? 'draft.copiedArticle' : 'draft.copiedPost'));

    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      button.textContent = label;
      button.classList.remove('is-copied');
      restoreTimer = null;
    }, 2200);
  });

  return button;
}

function draftNode(draft, extra) {
  const node = el('div', { class: 'draft' });
  const isArticle = draft.kind === 'medium';

  node.appendChild(
    el('div', { class: 'draft-head' }, [
      el('span', { class: 'draft-kind', text: t(isArticle ? 'draft.mediumArticle' : 'draft.linkedInPost') }),
      el('span', { class: 'kv', text: t('draft.words', { count: draft.wordCount }) }),
      el('span', { class: 'kv', attrs: { dir: 'ltr' }, text: draft.language }),
    ]),
  );

  // The full piece, never collapsed and never cut. Direction comes from the
  // draft's own language, so an Arabic post reads right-to-left inside an
  // English interface and vice versa.
  node.appendChild(
    el('pre', {
      class: 'draft-text',
      text: draft.publishText,
      attrs: { dir: draft.dir || 'auto', tabindex: '0' },
    }),
  );

  // Copying always works — it is pure client-side. Marking as published needs
  // a database, so it only appears where there is one.
  const actions = el('div', { class: 'btn-row' }, [
    copyButton(draft),
    window.dataSource.canWrite
      ? el('button', {
          class: 'btn',
          attrs: { type: 'button' },
          text: t('draft.markPublished'),
          on: {
            click: (event) => {
              const button = event.currentTarget;
              return withBusy(button, t('draft.marking'), async () => {
                await call(() => window.dataSource.publishContent(draft.id));
                flash(t('draft.markedPublished'));
                await refresh();
              });
            },
          },
        })
      : null,
  ]);
  node.appendChild(actions);

  const meta = el('div', { class: 'draft-meta' });
  meta.appendChild(
    el('p', {
      attrs: { dir: 'auto' },
      text:
        `${t('draft.mode', { mode: draft.mode })}${draft.mode === 'scaffold' ? ` — ${t('draft.scaffoldNote')}` : ''}` +
        ` · ${t('draft.styleScore', { score: draft.styleScore ? draft.styleScore.total : '—' })}` +
        (extra && extra.belowThreshold
          ? ` (${t('draft.belowThreshold', { min: extra.minStyleScore })})`
          : ''),
    }),
  );

  if (isArticle) meta.appendChild(el('p', { text: t('draft.markdownNote') }));

  if (draft.aiTells && draft.aiTells.length > 0) {
    meta.appendChild(el('p', { text: t('draft.flagged') }));
    meta.appendChild(
      el('ul', {}, draft.aiTells.map((tell) => el('li', { text: tell, attrs: { dir: 'auto' } }))),
    );
  }
  if (draft.styleScore && draft.styleScore.notes.length > 0) {
    meta.appendChild(el('p', { text: t('draft.reviewNotes') }));
    meta.appendChild(
      el('ul', {}, draft.styleScore.notes.map((note) => el('li', { text: note, attrs: { dir: 'auto' } }))),
    );
  }
  if (draft.sources && draft.sources.length > 0) {
    meta.appendChild(el('p', { text: t('draft.sources') }));
    const list = el('ul');
    for (const url of draft.sources) list.appendChild(el('li', {}, [externalLink(url)]));
    meta.appendChild(list);
  }
  if (extra && extra.exportedTo) {
    meta.appendChild(el('p', { attrs: { dir: 'ltr' }, text: t('draft.savedTo', { path: extra.exportedTo }) }));
  }
  meta.appendChild(el('p', { text: t('draft.footnote') }));

  node.appendChild(meta);
  return node;
}

/**
 * Generates in the browser, using prompts the snapshot already carries.
 *
 * The prompts were built by the same TypeScript the CLI uses, so this asks a
 * model for exactly what `npm run generate:linkedin` asks for. What is missing
 * compared with the local path is the style gate and its rewrite loop, which
 * needs the scorer; the draft is shown as written, and the panel says so.
 */
async function generateInBrowser(topicId, kind, angle, detail) {
  const language = window.i18n.contentLanguage;
  const prompts = detail && detail.prompts;
  if (!prompts || !prompts[kind] || !prompts[kind][angle] || !prompts[kind][angle][language]) {
    throw new Error(t('ai.noPrompt'));
  }

  const system = await loadSystemPrompt(language);
  const titles = (prompts.titles && prompts.titles[angle] && prompts.titles[angle][language]) || {};

  return window.aiClient.generate({
    topicId,
    kind,
    angle,
    language,
    system,
    prompt: prompts[kind][angle][language],
    hashtags: detail.hashtags || [],
    sources: detail.sources || [],
    title: kind === 'medium' ? titles.title : '',
    subtitle: kind === 'medium' ? titles.subtitle : '',
  });
}

/** One system prompt per language for the whole site; fetched once. */
const systemPromptCache = {};
async function loadSystemPrompt(language) {
  if (systemPromptCache[language]) return systemPromptCache[language];
  const response = await fetch('data/system-prompts.json');
  if (!response.ok) throw new Error(t('ai.noPrompt'));
  const all = await response.json();
  Object.assign(systemPromptCache, all);
  return systemPromptCache[language];
}

/** Maps an aiClient failure code onto something worth reading. */
function aiErrorMessage(error) {
  const reasons = {
    noKey: 'ai.errNoKey',
    noProvider: 'ai.errNoKey',
    invalidKey: 'ai.errInvalidKey',
    rateLimited: 'ai.errRateLimited',
    badModel: 'ai.errBadModel',
    providerDown: 'ai.errProviderDown',
    timeout: 'ai.errTimeout',
    network: 'ai.errNetwork',
    empty: 'ai.errEmpty',
    malformed: 'ai.errEmpty',
    ollamaDown: 'ai.errOllamaDown',
    ollamaOrigin: 'ai.errOllamaOrigin',
  };
  const key = error && error.reason ? reasons[error.reason] : null;
  return key ? t(key) : error.message;
}

async function generate(topicId, kind, angle, button, detail) {
  const isArticle = kind === 'medium';
  const busyLabel = t(isArticle ? 'draft.generatingArticle' : 'draft.generatingPost');

  // Nothing can be written without a model. Say so where the button is, and
  // offer the one action that fixes it, rather than failing into a message
  // in another column.
  if (!window.dataSource.canWrite && !window.aiClient.ready) {
    panelStatus(t('ai.errNoKey'), 'error', {
      label: t('ai.openSettings'),
      onClick: () => void show('settings'),
    });
    return;
  }

  panelStatus(t(isArticle ? 'draft.generatingArticleFlash' : 'draft.generatingPostFlash'), 'ok');

  const original = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    button.textContent = busyLabel;
  }

  try {
    let content;
    let extra = {};

    if (window.dataSource.canWrite) {
      const result = await call(() =>
        window.dataSource.generate({
          topicId,
          kind,
          angle,
          contentLanguage: window.i18n.contentLanguage,
        }),
      );
      content = result.content;
      extra = result;
    } else {
      content = await generateInBrowser(topicId, kind, angle, detail);
      content.publishText = renderPublishText(content);
      content.wordCount = countWords(content.publishText);
      content.dir = window.i18n.dirFor(content.language);
      extra = { browserGenerated: true };
    }

    const host = document.getElementById('drafts-host');
    if (host) host.insertBefore(draftNode(content, extra), host.firstChild);
    clearPanelStatus();
    flash(
      content.mode === 'scaffold'
        ? t('draft.generatedScaffold')
        : extra.browserGenerated
          ? t('draft.generatedInBrowser')
          : t('draft.generatedOk', {
              // A draft written before styleScore existed reads null here, and
              // dereferencing it took the success message down with it.
              score: content.styleScore ? content.styleScore.total : '—',
            }),
      extra.belowThreshold ? 'warn' : 'ok',
    );
  } catch (error) {
    // Failures land beside the button, with the fix attached when there is one.
    const needsKey = error && (error.reason === 'noKey' || error.reason === 'invalidKey');
    panelStatus(
      t('draft.generateFailed', { reason: aiErrorMessage(error) }),
      'error',
      needsKey ? { label: t('ai.openSettings'), onClick: () => void show('settings') } : null,
    );
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

/**
 * The same assembly as renderPublishText in src/writing/publish.ts. It has to
 * exist twice because a browser-made draft never passes through the server,
 * and a test runs both over the same fixtures so they cannot drift.
 */
function renderPublishText(content) {
  if (content.kind === 'linkedin') {
    const parts = [content.body.trim()];
    if (content.hashtags.length > 0) parts.push(content.hashtags.join(' '));
    return parts.join('\n\n');
  }
  const parts = [];
  if (content.title && content.title.trim()) parts.push(`# ${content.title.trim()}`);
  if (content.subtitle && content.subtitle.trim()) parts.push(`## ${content.subtitle.trim()}`);
  parts.push(content.body.trim());
  return parts.join('\n\n');
}

function countWords(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/* ---------------------------------------------------------- navigation */

const LOADERS = {
  radar: loadRadar,
  topics: loadTopics,
  weekly: loadWeekly,
  history: loadHistory,
  sources: loadSources,
  settings: loadSettings,
};

async function show(view) {
  state.view = view;
  for (const link of document.querySelectorAll('.rail-link')) {
    const active = link.dataset.view === view;
    link.classList.toggle('is-active', active);
    // Screen readers get no signal from a CSS class alone.
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('.view')) {
    section.classList.toggle('is-active', section.dataset.view === view);
  }
  try {
    await LOADERS[view]();
  } catch (error) {
    flash(error.message, 'error');
  }
}

function refresh() {
  return show(state.view);
}

/* ------------------------------------------------------------- chrome */

/** Re-labels everything marked with data-i18n. Called on boot and on switch. */
function applyStaticTranslations() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-label]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  }

  document.title = t('app.title');
  document.getElementById('rail').setAttribute('aria-label', t('nav.sections'));
  document.getElementById('panel').setAttribute('aria-label', t('topic.panelLabel'));
  document.getElementById('panel-close').setAttribute('aria-label', t('topic.closeLabel'));
  document.getElementById('lang-switch').setAttribute('aria-label', t('app.uiLanguage'));

  const status = document.getElementById('filter-status');
  for (const option of status.options) {
    option.textContent = option.value === 'any' ? t('topics.statusAny') : t(`status.${option.value}`);
  }

  for (const button of document.querySelectorAll('.lang-option')) {
    const active = button.dataset.lang === window.i18n.language;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.setAttribute(
      'aria-label',
      t(button.dataset.lang === 'ar' ? 'app.switchToArabic' : 'app.switchToEnglish'),
    );
  }
}

/**
 * On the published copy there is no database to write to, so the controls that
 * would write are removed rather than left to fail. A disabled button with no
 * explanation is worse than no button.
 */
function applyMode() {
  const readOnly = !window.dataSource.canWrite;
  document.body.classList.toggle('is-static', readOnly);
  if (!readOnly) return;

  const runButton = document.getElementById('run-radar');
  if (runButton) runButton.hidden = true;

  const note = document.getElementById('last-run');
  const manifest = window.dataSource.manifest;
  if (note) {
    note.textContent = manifest
      ? t('static.updated', { when: relativeDate(manifest.generatedAt) })
      : t('static.badge');
  }

  const banner = document.getElementById('mode-banner');
  if (banner) {
    banner.hidden = false;
    clear(banner);
    banner.appendChild(el('strong', { text: t('static.badge') }));
    banner.appendChild(document.createTextNode(` ${t('static.readOnly')}`));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.i18n.init();
  applyStaticTranslations();

  // Re-labelling the chrome is not enough: every list, table and panel holds
  // translated strings baked in at render time, so the active view is rebuilt.
  window.i18n.onChange(() => {
    applyStaticTranslations();
    applyMode();
    const panelOpen = !document.getElementById('panel').hidden;
    const openId = state.topicId;
    void refresh().then(() => {
      if (panelOpen && openId !== null) void openTopic(openId, state.panelTrigger);
    });
  });

  for (const button of document.querySelectorAll('.lang-option')) {
    button.addEventListener('click', () => window.i18n.setLanguage(button.dataset.lang));
  }

  for (const link of document.querySelectorAll('.rail-link')) {
    link.addEventListener('click', () => show(link.dataset.view));
  }

  document.getElementById('panel-close').addEventListener('click', closePanel);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('panel').hidden) closePanel();
  });

  for (const id of ['filter-min', 'filter-interest', 'filter-status', 'filter-sort']) {
    document.getElementById(id).addEventListener('change', () => void loadTopics());
  }

  document.getElementById('run-radar').addEventListener('click', (event) => {
    const button = event.currentTarget;
    flash(t('radar.fetching'));
    return withBusy(button, t('nav.running'), async () => {
      const result = await call(() => window.dataSource.runRadar());
      flash(
        t('radar.ranResearch', {
          ok: result.sourcesOk,
          failed: result.sourcesFailed,
          items: result.itemsNew,
          topics: result.topicsNew,
          rejected: result.topicsRejected,
          rescored: result.topicsRescored,
        }),
        result.sourcesFailed > 0 ? 'warn' : 'ok',
      );
      await refresh();
    });
  });

  // Mode is settled before the first render, so no control is ever shown and
  // then taken away.
  void window.dataSource
    .init()
    .then(() => {
      applyMode();
      return show('radar');
    })
    .catch((error) => flash(error.message, 'error'));
});
