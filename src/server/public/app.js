/*
  dev-radar dashboard client.

  Feed content is untrusted: every value that came from a remote source is put
  into the DOM with textContent or as an element property. innerHTML is never
  used with data from the API.
*/

'use strict';

const METER_KEYS = [
  ['freshness', 'F'],
  ['relevance', 'R'],
  ['practicalValue', 'P'],
  ['discussionPotential', 'D'],
  ['educationalValue', 'E'],
  ['originality', 'O'],
  ['audienceFit', 'A'],
];

const state = {
  view: 'radar',
  topicId: null,
  loaded: {},
  panelTrigger: null,
};

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

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({ error: 'Response was not JSON' }));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function flash(message, kind) {
  const node = document.getElementById('flash');
  node.textContent = message;
  node.dataset.kind = kind || 'ok';
  node.hidden = false;
  if (kind !== 'error') setTimeout(() => { node.hidden = true; }, 6000);
}

function relativeDate(iso) {
  if (!iso) return 'undated';
  const days = (Date.now() - Date.parse(iso)) / 86400000;
  if (!Number.isFinite(days)) return 'undated';
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${Math.round(days)}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/* --------------------------------------------------------- components */

function meter(score) {
  const wrap = el('div');
  const bars = el('div', { class: 'meter' });
  for (const [key] of METER_KEYS) {
    const value = Math.max(0, Math.min(100, Number(score[key]) || 0));
    const bar = el('div', { class: 'meter-bar', attrs: { title: `${key}: ${Math.round(value)}` } });
    const fill = el('div', { class: 'meter-fill' });
    fill.style.height = `${value}%`;
    bar.appendChild(fill);
    bars.appendChild(bar);
  }
  wrap.appendChild(bars);
  wrap.appendChild(el('div', { class: 'meter-legend', text: METER_KEYS.map((k) => k[1]).join(' ') }));

  const dials = el('div', { class: 'dials' }, [
    el('div', { class: 'dial' }, [
      el('b', { text: score.linkedinScore }),
      el('span', { text: 'LinkedIn' }),
    ]),
    el('div', { class: 'dial' }, [
      el('b', { text: score.mediumScore }),
      el('span', { text: 'Medium' }),
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
  return el('span', { class: `tag ${map[topic.status] || ''}`, text: topic.status });
}

function topicRow(entry, why) {
  const topic = entry.topic || entry;
  const score = entry.score;

  const tags = el('div', { class: 'topic-tags' }, [
    el('span', { class: 'tag', text: topic.category }),
    el('span', {
      class: `tag ${topic.sourceTier === 'primary' ? 'tag--primary' : ''}`,
      text: topic.sourceTier,
    }),
    el('span', { class: 'tag', text: relativeDate(topic.publishedAt) }),
    statusTag(topic),
    score && score.controversy >= 60
      ? el('span', { class: 'tag tag--heat', text: `heat ${score.controversy}` })
      : null,
    score && score.confidence < 55
      ? el('span', { class: 'tag tag--warn', text: `low confidence ${score.confidence}` })
      : null,
  ]);

  const middle = el('div', {}, [
    el('h3', { class: 'topic-title', text: topic.title }),
    why ? el('p', { class: 'topic-why', text: why }) : null,
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
          on: { click: () => openTopic(topic.id) },
        },
        [
          el('div', { class: 'topic-score', text: score ? Math.round(score.total) : '—' }, [
            el('small', { text: 'score' }),
          ]),
          middle,
          score ? meter(score) : el('div'),
        ],
      ),
    ],
  );
}

/* -------------------------------------------------------------- views */

async function loadRadar() {
  const data = await api('/api/overview');

  const badge = document.getElementById('provider-badge');
  badge.textContent = data.provider.available
    ? `${data.provider.name} · ${data.provider.model}`
    : `${data.provider.name} · offline`;

  const lastRun = document.getElementById('last-run');
  lastRun.textContent = data.lastRun
    ? `Last run ${relativeDate(data.lastRun.startedAt)} · +${data.lastRun.itemsNew} items · +${data.lastRun.topicsNew} topics`
    : 'No runs yet';

  document.getElementById('radar-date').textContent = data.daily.date;
  document.getElementById('radar-summary').textContent =
    `${data.daily.entries.length} topic(s) above score ${data.daily.minScore}, from ${data.daily.totalConsidered} considered. ` +
    (data.provider.available
      ? 'A model is connected, so drafts will be written as prose.'
      : 'No model connected — drafts will come out as research scaffolds with the facts filled in.');

  const pick = document.getElementById('top-pick');
  clear(pick);
  if (data.daily.top) {
    const top = data.daily.top;
    pick.appendChild(
      el('div', { class: 'pick' }, [
        el('p', { class: 'eyebrow', text: '⭐ Top recommendation' }),
        el('h3', { text: top.topic.title }),
        el('p', { text: top.whyItMatters }),
        el('p', { text: top.whyYourAudienceCares }),
        el('p', { text: `Suggested angle: ${top.suggestedAngle}` }),
        el('div', { class: 'pick-actions' }, [
          el('button', {
            class: 'btn btn-ghost',
            text: 'Open topic',
            on: { click: () => openTopic(top.topic.id) },
          }),
          el('button', {
            class: 'btn btn-ghost',
            text: 'Generate LinkedIn',
            on: { click: () => openTopic(top.topic.id).then(() => generate(top.topic.id, 'linkedin')) },
          }),
        ]),
      ]),
    );
  }

  const list = document.getElementById('radar-list');
  clear(list);
  if (data.daily.entries.length === 0) {
    list.appendChild(
      el('li', {}, [
        el('div', { class: 'empty' }, [
          el('p', { text: 'Nothing on the radar yet.' }),
          el('p', { text: 'Press "Run research" to fetch every source for the first time.' }),
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
  const status = document.getElementById('filter-status').value;
  const rows = await api(`/api/topics?min=${encodeURIComponent(min)}&status=${encodeURIComponent(status)}`);
  const list = document.getElementById('topics-list');
  clear(list);
  if (rows.length === 0) {
    list.appendChild(el('li', {}, [el('div', { class: 'empty', text: 'No topics match those filters.' })]));
    return;
  }
  for (const row of rows) list.appendChild(topicRow(row, row.topic.rejectionReason || ''));
}

async function loadWeekly() {
  const data = await api('/api/weekly');
  document.getElementById('weekly-range').textContent = `${data.from} → ${data.to}`;
  const body = document.getElementById('weekly-body');
  clear(body);
  if (data.sections.length === 0) {
    body.appendChild(el('div', { class: 'empty', text: 'Nothing from the last 7 days yet.' }));
    return;
  }
  for (const section of data.sections) {
    body.appendChild(el('h2', { text: section.label }));
    const list = el('ol', { class: 'topic-list' });
    for (const entry of section.entries) list.appendChild(topicRow(entry, entry.whyItMatters));
    body.appendChild(list);
  }
}

async function loadHistory() {
  const data = await api('/api/history');
  const body = document.getElementById('history-body');
  clear(body);

  body.appendChild(el('h2', { text: 'Research runs' }));
  body.appendChild(
    table(
      ['Started', 'Sources', 'New items', 'New topics'],
      data.runs.map((run) => [
        run.startedAt.slice(0, 19).replace('T', ' '),
        `${run.sourcesOk}/${run.sourcesOk + run.sourcesFailed}`,
        String(run.itemsNew),
        String(run.topicsNew),
      ]),
      'No runs yet.',
    ),
  );

  body.appendChild(el('h2', { text: 'Drafts written' }));
  body.appendChild(
    table(
      ['Date', 'Kind', 'Mode', 'Style', 'Status', 'Topic'],
      data.drafts.map((draft) => [
        draft.createdAt.slice(0, 10),
        draft.kind,
        draft.mode,
        draft.styleScore ? String(draft.styleScore.total) : '—',
        draft.status,
        draft.topicTitle,
      ]),
      'Nothing generated yet.',
    ),
  );

  body.appendChild(el('h2', { text: 'Published' }));
  body.appendChild(
    table(
      ['Topic', 'Category'],
      data.published.map((topic) => [topic.title, topic.category]),
      'Nothing marked as published yet.',
    ),
  );

  body.appendChild(el('h2', { text: 'Rejected as repeats' }));
  body.appendChild(
    table(
      ['Topic', 'Reason'],
      data.rejected.map((topic) => [topic.title, topic.rejectionReason || '']),
      'Nothing rejected.',
    ),
  );
}

function table(headers, rows, emptyText) {
  if (rows.length === 0) return el('div', { class: 'empty', text: emptyText });
  const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);
  const tbody = el(
    'tbody',
    {},
    rows.map((row) => el('tr', {}, row.map((cell) => el('td', { text: cell })))),
  );
  return el('table', { class: 'grid' }, [thead, tbody]);
}

async function loadSources() {
  const sources = await api('/api/sources');
  const body = document.getElementById('sources-body');
  clear(body);

  const tbody = el('tbody');
  for (const source of sources) {
    const toggle = el('input', { attrs: { type: 'checkbox' } });
    toggle.checked = source.enabled;
    toggle.addEventListener('change', async () => {
      try {
        await api('/api/sources/toggle', {
          method: 'POST',
          body: { key: source.key, enabled: toggle.checked },
        });
        flash(`${source.key} ${toggle.checked ? 'enabled' : 'disabled'}`);
      } catch (error) {
        toggle.checked = !toggle.checked;
        flash(error.message, 'error');
      }
    });

    tbody.appendChild(
      el('tr', {}, [
        el('td', {}, [toggle]),
        el('td', { class: 'num', text: source.key }),
        el('td', { text: source.tier }),
        el('td', { text: source.kind }),
        el('td', {
          text: source.lastStatus
            ? `${source.lastStatus}${source.lastError ? ` — ${source.lastError.slice(0, 60)}` : ''}`
            : 'never fetched',
        }),
      ]),
    );
  }

  body.appendChild(
    el('table', { class: 'grid' }, [
      el('thead', {}, [
        el('tr', {}, ['On', 'Key', 'Tier', 'Kind', 'Last fetch'].map((h) => el('th', { text: h }))),
      ]),
      tbody,
    ]),
  );
}

const SETTING_HINTS = {
  minTopicScore: 'Topics below this are not shortlisted or shown in the daily radar.',
  dailyTopicCount: 'How many topics the daily radar lists.',
  linkedinMinWords: 'Lower word bound requested from the model.',
  linkedinMaxWords: 'Upper word bound requested from the model.',
  mediumMinWords: 'Lower word bound for articles.',
  mediumMaxWords: 'Upper word bound for articles.',
  minStyleScore: 'Drafts below this are rewritten, up to maxStyleRewrites times.',
  maxStyleRewrites: 'How many times to retry a draft that fails the style gate.',
  repeatSimilarityThreshold: '0–1. Above this, a topic is rejected as a repeat of past work.',
  clusterSimilarityThreshold: '0–1. Above this, two articles are treated as the same story.',
  lookbackDays: 'How far back to consider items when building topics.',
  enabledCategories: 'Reserved. "*" means all categories.',
};

async function loadSettings() {
  const data = await api('/api/settings');
  const body = document.getElementById('settings-body');
  clear(body);

  body.appendChild(
    el('p', {
      class: 'lede',
      text: `AI provider: ${data.provider} (${data.model}). Change it in .env, not here — it needs a restart.`,
    }),
  );

  const inputs = {};
  for (const [key, value] of Object.entries(data.settings)) {
    const input = el('input', { attrs: { type: 'text', value } });
    input.value = value;
    inputs[key] = input;
    body.appendChild(
      el('div', { class: 'setting' }, [
        el('label', { text: key }),
        input,
        el('span', { class: 'hint', text: SETTING_HINTS[key] || '' }),
      ]),
    );
  }

  body.appendChild(
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        text: 'Save settings',
        on: {
          click: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              const settings = {};
              for (const [key, input] of Object.entries(inputs)) settings[key] = input.value;
              await api('/api/settings', { method: 'POST', body: { settings } });
              flash('Settings saved. Re-run research to apply scoring changes.');
            } catch (error) {
              flash(error.message, 'error');
            } finally {
              button.disabled = false;
            }
          },
        },
      }),
    ]),
  );
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

async function openTopic(id) {
  state.topicId = id;
  const panel = document.getElementById('panel');
  const body = document.getElementById('panel-body');
  // Remember the trigger before the panel steals focus.
  state.panelTrigger = document.activeElement;
  panel.hidden = false;
  panel.focus();
  clear(body);
  body.appendChild(el('p', { class: 'kv', text: 'Loading…' }));

  let data;
  try {
    data = await api(`/api/topic?id=${encodeURIComponent(id)}`);
  } catch (error) {
    clear(body);
    body.appendChild(el('div', { class: 'empty', text: error.message }));
    return;
  }

  clear(body);
  const { topic, score, facts, angles, drafts, nearMatches, hashtags } = data;

  body.appendChild(el('h3', { text: topic.title }));
  body.appendChild(
    el('p', { class: 'kv' }, [
      el('b', { text: topic.category }),
      document.createTextNode(` · ${topic.sourceKey} (${topic.sourceTier}) · ${relativeDate(topic.publishedAt)}`),
    ]),
  );

  const link = el('a', { text: topic.sourceUrl, class: 'kv' });
  link.href = topic.sourceUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  body.appendChild(el('p', { class: 'kv' }, [link]));

  if (topic.summary) body.appendChild(el('p', { text: topic.summary }));

  if (nearMatches.length > 0) {
    body.appendChild(el('h2', { text: 'Close to work you already published' }));
    for (const match of nearMatches) {
      body.appendChild(
        el('p', { class: 'kv', text: `${Math.round(match.similarity * 100)}% — ${match.title}` }),
      );
    }
  }

  if (score) {
    body.appendChild(el('h2', { text: `Score ${score.total} · confidence ${score.confidence}` }));
    body.appendChild(meter(score));
    body.appendChild(
      el('ul', { class: 'reasons' }, score.reasons.map((reason) => el('li', { text: reason }))),
    );
  }

  body.appendChild(el('h2', { text: `Facts (${facts.length})` }));
  if (facts.length === 0) {
    body.appendChild(
      el('p', {
        class: 'kv',
        text: 'Nothing checkable was extracted. Open the source before writing anything factual.',
      }),
    );
  }
  for (const fact of facts) {
    body.appendChild(
      el('div', { class: `fact fact--${fact.status}` }, [
        document.createTextNode(fact.claim),
        el('span', { class: 'fact-note', text: `${fact.status} — ${fact.note}` }),
      ]),
    );
  }

  body.appendChild(el('h2', { text: 'Angles' }));
  let selectedAngle = (angles.find((a) => a.recommended) || angles[0] || {}).kind;
  const angleNodes = [];
  // A radiogroup of buttons, not clickable divs: the angle decides what gets
  // written, so it has to be reachable and operable from the keyboard.
  const angleGroup = el('div', {
    class: 'angle-group',
    attrs: { role: 'radiogroup', 'aria-label': 'Choose an angle' },
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
        el('h4', { text: angle.title }),
        el('p', { text: angle.description }),
        el('p', { class: 'kv', text: angle.kind + (angle.recommended ? ' · recommended' : '') }),
      ],
    );

    const select = () => {
      selectedAngle = angle.kind;
      for (const other of angleNodes) {
        const active = other === node;
        other.classList.toggle('is-selected', active);
        other.setAttribute('aria-checked', active ? 'true' : 'false');
        other.tabIndex = active ? 0 : -1;
      }
      node.focus();
    };

    node.addEventListener('click', select);
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

  body.appendChild(el('h2', { text: 'Hashtags' }));
  body.appendChild(el('p', { class: 'kv', text: hashtags.join(' ') }));

  body.appendChild(
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        text: 'Generate LinkedIn',
        on: { click: (e) => generate(topic.id, 'linkedin', selectedAngle, e.currentTarget) },
      }),
      el('button', {
        class: 'btn',
        text: 'Generate Medium',
        on: { click: (e) => generate(topic.id, 'medium', selectedAngle, e.currentTarget) },
      }),
      el('button', {
        class: 'btn',
        text: 'Reject topic',
        on: {
          click: async () => {
            await api('/api/topic/status', {
              method: 'POST',
              body: { topicId: topic.id, status: 'rejected', reason: 'Rejected by hand' },
            });
            flash('Topic rejected.');
            refresh();
          },
        },
      }),
    ]),
  );

  const draftsHost = el('div', { attrs: { id: 'drafts-host' } });
  body.appendChild(draftsHost);
  for (const draft of drafts) draftsHost.appendChild(draftNode(draft));
}

function draftNode(draft, extra) {
  const node = el('div', { class: 'draft' });

  if (draft.kind === 'medium') {
    node.appendChild(el('h4', { text: draft.title }));
    node.appendChild(el('p', { class: 'kv', text: draft.subtitle }));
  }
  node.appendChild(el('pre', { text: draft.publishText }));

  const actions = el('div', { class: 'btn-row' }, [
    el('button', {
      class: 'btn',
      text: 'Copy',
      on: {
        click: async (event) => {
          try {
            await navigator.clipboard.writeText(draft.publishText);
            event.currentTarget.textContent = 'Copied';
            setTimeout(() => { event.currentTarget.textContent = 'Copy'; }, 1600);
          } catch {
            flash('Clipboard blocked by the browser. Select the text and copy it manually.', 'warn');
          }
        },
      },
    }),
    el('button', {
      class: 'btn',
      text: 'Mark as published',
      on: {
        click: async () => {
          await api('/api/content/publish', { method: 'POST', body: { contentId: draft.id } });
          flash('Marked as published and added to your history.');
          refresh();
        },
      },
    }),
  ]);
  node.appendChild(actions);

  const meta = el('div', { class: 'draft-meta' });
  meta.appendChild(
    el('p', {
      text:
        `Mode: ${draft.mode}${draft.mode === 'scaffold' ? ' — outline, not publishable prose' : ''}` +
        ` · Style ${draft.styleScore ? draft.styleScore.total : '—'}/100` +
        (extra && extra.belowThreshold ? ` (below your minimum of ${extra.minStyleScore})` : ''),
    }),
  );

  if (draft.aiTells && draft.aiTells.length > 0) {
    meta.appendChild(el('p', { text: 'Flagged as AI-sounding:' }));
    meta.appendChild(el('ul', {}, draft.aiTells.map((tell) => el('li', { text: tell }))));
  }
  if (draft.styleScore && draft.styleScore.notes.length > 0) {
    meta.appendChild(el('p', { text: 'Review notes:' }));
    meta.appendChild(el('ul', {}, draft.styleScore.notes.map((note) => el('li', { text: note }))));
  }
  if (draft.sources && draft.sources.length > 0) {
    meta.appendChild(el('p', { text: 'Sources:' }));
    const list = el('ul');
    for (const url of draft.sources) {
      const anchor = el('a', { text: url });
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      list.appendChild(el('li', {}, [anchor]));
    }
    meta.appendChild(list);
  }
  if (extra && extra.exportedTo) {
    meta.appendChild(el('p', { text: `Saved to ${extra.exportedTo}` }));
  }
  meta.appendChild(el('p', { text: 'Nothing is published automatically. Copy it when you are happy with it.' }));

  node.appendChild(meta);
  return node;
}

async function generate(topicId, kind, angle, button) {
  if (button) {
    button.disabled = true;
    button.textContent = kind === 'medium' ? 'Writing article…' : 'Writing post…';
  }
  flash(kind === 'medium' ? 'Generating the article. A local model can take a minute or two.' : 'Generating the post…');
  try {
    const data = await api('/api/generate', { method: 'POST', body: { topicId, kind, angle } });
    const host = document.getElementById('drafts-host');
    if (host) host.insertBefore(draftNode(data.content, data), host.firstChild);
    flash(
      data.content.mode === 'scaffold'
        ? 'No model was reachable, so this is a research scaffold — the facts and angle are filled in, the prose is yours.'
        : `Draft written. Style score ${data.content.styleScore.total}/100.`,
      data.belowThreshold ? 'warn' : 'ok',
    );
  } catch (error) {
    flash(error.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = kind === 'medium' ? 'Generate Medium' : 'Generate LinkedIn';
    }
  }
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

document.addEventListener('DOMContentLoaded', () => {
  for (const link of document.querySelectorAll('.rail-link')) {
    link.addEventListener('click', () => show(link.dataset.view));
  }

  document.getElementById('panel-close').addEventListener('click', closePanel);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('panel').hidden) closePanel();
  });

  document.getElementById('filter-min').addEventListener('change', loadTopics);
  document.getElementById('filter-status').addEventListener('change', loadTopics);

  document.getElementById('run-radar').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Fetching…';
    flash('Fetching every enabled source. This takes a moment.');
    try {
      const result = await api('/api/radar', { method: 'POST' });
      flash(
        `${result.sourcesOk} source(s) ok, ${result.sourcesFailed} failed. ` +
          `+${result.itemsNew} items, +${result.topicsNew} topics, ${result.topicsRejected} rejected as repeats, ` +
          `${result.topicsRescored} re-scored.`,
        result.sourcesFailed > 0 ? 'warn' : 'ok',
      );
      await refresh();
    } catch (error) {
      flash(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Run research';
    }
  });

  show('radar');
});
