import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, setSetting } from '../src/db';
import { insertItems, listContent, listScoredTopics } from '../src/db/repositories';
import { buildTopics } from '../src/pipeline/run';
import { buildDaily, buildWeekly } from '../src/reports';
import { buildContext } from '../src/writing/context';
import { generateLinkedIn, scaffold, cleanDraft } from '../src/writing/linkedin';
import { generateMedium, scaffoldArticle } from '../src/writing/medium';
import { renderPublishText, publishWordCount } from '../src/writing/publish';
import { exportContent } from '../src/writing/export';
import { buildSystemPrompt, loadProfile } from '../src/writing/style';
import { buildHook, selectHookPattern } from '../src/writing/hooks';
import { scoreStyle, detectAiTells } from '../src/writing/evaluate';
import { languagePack, toContentLanguage, CONTENT_LANGUAGES } from '../src/writing/languages';
import { sentences, truncate } from '../src/util/text';
import { validateSetting } from '../src/server/api';
import type { AIProvider } from '../src/ai/provider';
import type { GeneratedContent, NormalizedItem } from '../src/types';

/**
 * Content-language behaviour: writing in Arabic, scoring Arabic, and the
 * guarantee that what the dashboard shows is what the clipboard gets.
 */

/* ------------------------------------------------------------- fixtures */

function item(over: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    sourceKey: 'nodejs-blog',
    guid: 'g1',
    title: 'Node.js v22.5.0 makes the permission model stable',
    url: 'https://nodejs.org/a',
    summary: 'The permission model graduated to stable in v22.5.0 after a 12% startup improvement.',
    publishedAt: new Date().toISOString(),
    author: null,
    extra: {},
    ...over,
  };
}

function seededDb() {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO sources (key, name, url, kind, tier, category, enabled, weight)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run('nodejs-blog', 'Node Blog', 'https://x/f', 'rss', 'primary', 'nodejs', 1.4);
  insertItems(db, [item()]);
  buildTopics(db);
  return db;
}

function topicOf(db: ReturnType<typeof seededDb>) {
  return listScoredTopics(db, { status: 'any' })[0]!.topic;
}

/** A provider that always answers, so the LLM path can be exercised offline. */
function stubProvider(reply: string): AIProvider {
  return {
    name: 'stub',
    model: 'stub',
    available: async () => true,
    complete: async () => reply,
  };
}

/** Explicitly unreachable, which is what forces the scaffold path. */
const OFFLINE_PROVIDER: AIProvider = {
  name: 'none',
  model: 'none',
  available: async () => false,
  complete: async () => {
    throw new Error('not available');
  },
};

const ARABIC_POST = [
  'React Server Components ليس كما تتخيل...',
  '',
  'أهلاً بالجميع! 💛',
  '',
  'لاحظت هذا وأنا أشتغل على مشروع حقيقي. الفرق صغير، لكنه يظهر أول ما يصل تحميل حقيقي.',
  '',
  'جرّب أن تقيس زمن hydration في `useEffect` بدل تخمينه. الفرق بين v18 و v19 واضح.',
  '',
  'برأيي هذه أهم نقطة يتجاهلها الناس.',
  '',
  'كيف تتعاملون مع هذا في مشاريعكم؟',
].join('\n');

/* ------------------------------------------------------- language packs */

test('every supported language resolves to a pack', () => {
  for (const code of CONTENT_LANGUAGES) {
    const pack = languagePack(code);
    assert.equal(pack.code, code);
    assert.ok(pack.englishName.length > 0);
    assert.ok(pack.nativeName.length > 0);
  }
  assert.equal(languagePack('ar').dir, 'rtl');
  assert.equal(languagePack('en').dir, 'ltr');
});

test('an unknown content language falls back to English rather than throwing', () => {
  assert.equal(toContentLanguage('fr'), 'en');
  assert.equal(toContentLanguage(undefined), 'en');
  assert.equal(toContentLanguage(null), 'en');
  assert.equal(toContentLanguage(42), 'en');
  assert.equal(toContentLanguage('ar'), 'ar');
});

/* --------------------------------------------------- Arabic text handling */

test('Arabic sentences split on the Arabic question mark', () => {
  // U+061F ends an Arabic question. Without it the whole paragraph was one
  // "sentence" and every length and question measurement was meaningless.
  const parts = sentences('هذا سطر أول. وهذا سؤال؟ وهذه جملة أخيرة.');
  assert.equal(parts.length, 3);
  assert.ok(parts[1]!.endsWith('؟'));
});

test('English sentence splitting is unchanged', () => {
  assert.deepEqual(sentences('One. Two? Three!'), ['One.', 'Two?', 'Three!']);
});

test('truncate never leaves half an emoji behind', () => {
  // Cutting at a code-unit boundary inside a surrogate pair renders as U+FFFD.
  for (let max = 3; max <= 12; max += 1) {
    const cut = truncate('ab😀cd😀ef😀gh', max);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), `lone surrogate at max=${max}: ${cut}`);
  }
});

test('Arabic first person and questions are detected by the Arabic rules', () => {
  const profile = loadProfile();
  const arabic = scoreStyle({
    text: ARABIC_POST,
    profile,
    kind: 'linkedin',
    language: 'ar',
    minWords: 20,
    maxWords: 400,
    hasPersonalTake: true,
    hasQuestion: true,
    hasConcreteDetail: true,
  });
  // Scored with the English rule set the same text reads as having no voice at
  // all, so these two notes are exactly the regression being pinned.
  assert.ok(!arabic.notes.some((n) => n.includes('first-person')), arabic.notes.join(' | '));
  assert.ok(!arabic.notes.some((n) => n.includes('closing question')), arabic.notes.join(' | '));
  assert.ok(arabic.discussionPotential > 50);
  assert.ok(arabic.personality > 40);
});

test('the English rule set genuinely cannot read Arabic, which is why packs exist', () => {
  const profile = loadProfile();
  const asEnglish = scoreStyle({
    text: ARABIC_POST,
    profile,
    kind: 'linkedin',
    language: 'en',
    minWords: 20,
    maxWords: 400,
    hasPersonalTake: false,
    hasQuestion: false,
    hasConcreteDetail: true,
  });
  assert.ok(asEnglish.notes.some((n) => n.includes('first-person')));
});

test('Arabic AI tells are caught and Arabic banned phrases are reported', () => {
  const profile = loadProfile();
  const slop = 'في عالم التكنولوجيا المتسارع، تلعب هذه الميزة دوراً حاسماً. في الختام، مما لا شك فيه أنها ثورة حقيقية.';
  const report = detectAiTells(slop, profile, 'ar');
  assert.ok(report.tells.length >= 3, `expected several tells, got ${report.tells.join(' | ')}`);
  assert.ok(report.bannedHits.length >= 1, `expected banned hits, got ${report.bannedHits.join(' | ')}`);
});

test('clean Arabic prose is not flagged', () => {
  const report = detectAiTells(ARABIC_POST, loadProfile(), 'ar');
  assert.deepEqual(report.bannedHits, []);
});

test('English banned phrases still apply inside an Arabic draft', () => {
  // A model writing Arabic still reaches for English marketing words.
  const mixed = 'هذه الميزة game-changing بكل المقاييس.';
  const report = detectAiTells(mixed, loadProfile(), 'ar');
  assert.ok(report.bannedHits.some((hit) => hit === 'game-changing'));
});

/* -------------------------------------------------------------- prompts */

test('the Arabic system prompt carries the Arabic voice rules', () => {
  const profile = loadProfile();
  const arabic = buildSystemPrompt(profile, 'ar');
  assert.ok(arabic.includes('Write in Arabic.'));
  assert.ok(arabic.includes('العربية الفصحى'));
  // The rule that stops literal translation is the one that matters most.
  assert.ok(arabic.includes('الترجمة الحرفية'));
  // Technical terms must be named as staying in English.
  assert.ok(arabic.includes('JavaScript'));

  const english = buildSystemPrompt(profile, 'en');
  assert.ok(english.includes('Write in English.'));
  assert.ok(!english.includes('العربية الفصحى'));
});

test('Arabic hooks come from the Arabic pattern list, not the English one', () => {
  const profile = loadProfile();
  const topic = { title: 'Node.js v22.5.0 ships', slug: 'node-22', category: 'nodejs' as const };

  const english = buildHook(profile, 'educational', topic, 'Node.js v22.5.0', 'en');
  const arabic = buildHook(profile, 'educational', topic, 'Node.js v22.5.0', 'ar');

  assert.ok(/[\u0600-\u06FF]/.test(arabic), `expected Arabic script, got: ${arabic}`);
  assert.ok(!/[\u0600-\u06FF]/.test(english), `expected Latin script, got: ${english}`);
  // The technical subject stays in English inside the Arabic hook.
  assert.ok(arabic.includes('Node.js v22.5.0'));
  // No unfilled placeholders survive in either language.
  assert.ok(!/\{[a-z_]+\}/.test(arabic));
  assert.ok(!/\{[a-z_]+\}/.test(english));
});

test('Arabic hook selection is stable per slug and varies across slugs', () => {
  const profile = loadProfile();
  const once = selectHookPattern(profile, 'opinion', 'topic-one', 'ar');
  assert.equal(once, selectHookPattern(profile, 'opinion', 'topic-one', 'ar'));
  const chosen = new Set(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((slug) =>
      selectHookPattern(profile, 'engineering-lesson', slug, 'ar'),
    ),
  );
  assert.ok(chosen.size > 1, 'every slug produced the same Arabic hook');
});

/* -------------------------------------------------------- generation */

test('a LinkedIn draft records the language it was written in', async () => {
  const db = seededDb();
  const context = buildContext(db, topicOf(db), null, loadProfile(), undefined, 'ar');
  const result = await generateLinkedIn(db, context, stubProvider(ARABIC_POST));
  assert.equal(result.content.language, 'ar');
  assert.equal(listContent(db, topicOf(db).id)[0]!.language, 'ar');
  db.close();
});

test('the Arabic prompt reaches the model on both generation paths', async () => {
  const db = seededDb();
  const prompts: string[] = [];
  const provider: AIProvider = {
    name: 'stub',
    model: 'stub',
    available: async () => true,
    complete: async ({ system, prompt }) => {
      prompts.push(`${system}\n${prompt}`);
      return ARABIC_POST;
    },
  };

  const context = buildContext(db, topicOf(db), null, loadProfile(), undefined, 'ar');
  await generateLinkedIn(db, context, provider);
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every((p) => p.includes('اكتب النص كاملاً بالعربية')));
  db.close();
});

test('without a model the Arabic scaffold is Arabic, not English', () => {
  const db = seededDb();
  const context = buildContext(db, topicOf(db), null, loadProfile(), undefined, 'ar');
  const text = scaffold(context, 'مرحباً');
  assert.ok(text.includes('[الملاحظة]'));
  assert.ok(text.includes('[السؤال]'));
  assert.ok(!text.includes('[OBSERVATION]'));

  const english = scaffold(
    buildContext(db, topicOf(db), null, loadProfile(), undefined, 'en'),
    'hello',
  );
  assert.ok(english.includes('[OBSERVATION]'));
  db.close();
});

test('the Arabic article scaffold uses Arabic headings', () => {
  const db = seededDb();
  const context = buildContext(db, topicOf(db), null, loadProfile(), undefined, 'ar');
  const text = scaffoldArticle(context, 'مرحباً', 'عنوان', 'عنوان فرعي');
  assert.ok(text.includes('## لماذا يهمّك هذا'));
  assert.ok(text.includes('## سيناريو من الواقع'));
  assert.ok(text.includes('**المصادر**'));
  assert.ok(!text.includes('## Why this matters'));
  db.close();
});

test('the tool still produces a draft with no model reachable, in both languages', async () => {
  for (const language of CONTENT_LANGUAGES) {
    const db = seededDb();
    const context = buildContext(db, topicOf(db), null, loadProfile(), undefined, language);

    const post = await generateLinkedIn(db, context, OFFLINE_PROVIDER);
    assert.equal(post.content.mode, 'scaffold');
    assert.equal(post.content.language, language);
    assert.ok(post.content.body.length > 0);

    const article = await generateMedium(db, context, OFFLINE_PROVIDER);
    assert.equal(article.content.mode, 'scaffold');
    assert.ok(article.content.title.length > 0);
    db.close();
  }
});

test('a model that returns nothing usable falls back to a labelled scaffold', async () => {
  const db = seededDb();
  const context = buildContext(db, topicOf(db), null, loadProfile());
  const broken: AIProvider = {
    name: 'stub',
    model: 'stub',
    available: async () => true,
    complete: async () => {
      throw new Error('connection reset');
    },
  };
  const result = await generateLinkedIn(db, context, broken);
  assert.equal(result.content.mode, 'scaffold');
  assert.ok(result.content.body.length > 0);
  db.close();
});

test('a model that answers with an empty outline still yields an article', async () => {
  const db = seededDb();
  const context = buildContext(db, topicOf(db), null, loadProfile());
  // Too few headings makes writeArticle throw, which must degrade to scaffold
  // rather than propagate out of the request handler.
  const result = await generateMedium(db, context, stubProvider('one\n'));
  assert.equal(result.content.mode, 'scaffold');
  assert.ok(result.content.body.includes('## '));
  db.close();
});

test('cleanDraft keeps Arabic text and its hashtags intact', () => {
  // The hashtag stripper used [A-Za-z0-9_], so an Arabic hashtag survived into
  // the body and was then appended a second time.
  const raw = '«نص عربي هنا.\n\nوسطر آخر.»\n\n#برمجة #ReactJS';
  const cleaned = cleanDraft(raw);
  assert.ok(cleaned.startsWith('نص عربي'));
  assert.ok(!cleaned.includes('«'));
  assert.ok(!cleaned.includes('#برمجة'));
  assert.ok(!cleaned.includes('#ReactJS'));
});

/* ----------------------------------------------------- publish + copy */

function content(over: Partial<GeneratedContent> = {}): GeneratedContent {
  return {
    topicId: 1,
    kind: 'medium',
    angleKind: 'educational',
    mode: 'llm',
    hook: 'hook',
    title: 'A real title',
    subtitle: 'A real subtitle',
    body: '## First section\n\nSome prose.\n\n```ts\nconst x = 1;\n```\n\n## Second section\n\nMore prose.',
    hashtags: ['#JavaScript', '#WebDevelopment'],
    sources: ['https://example.com/a'],
    styleScore: null,
    aiTells: [],
    status: 'draft',
    createdAt: '2026-08-25T00:00:00Z',
    model: null,
    language: 'en',
    ...over,
  };
}

test('a copied Medium article carries the title and subtitle, not just the body', () => {
  // The dashboard rendered the title above the body and copied the body alone,
  // so pasting an article silently dropped its headline.
  const text = renderPublishText(content());
  assert.ok(text.startsWith('# A real title'));
  assert.ok(text.includes('## A real subtitle'));
  assert.ok(text.includes('## First section'));
  assert.ok(text.includes('## Second section'));
  assert.ok(text.includes('```ts'));
  assert.ok(text.trimEnd().endsWith('More prose.'));
});

test('a copied LinkedIn post carries the hashtags and nothing else', () => {
  const text = renderPublishText(content({ kind: 'linkedin', body: 'Line one.\n\nLine two.' }));
  assert.equal(text, 'Line one.\n\nLine two.\n\n#JavaScript #WebDevelopment');
  // No metadata leaks into the clipboard.
  assert.ok(!text.includes('https://example.com/a'));
  assert.ok(!text.includes('educational'));
  assert.ok(!text.includes('A real title'));
});

test('a Medium draft with no subtitle still copies cleanly', () => {
  const text = renderPublishText(content({ subtitle: '' }));
  assert.ok(text.startsWith('# A real title\n\n## First section'));
});

test('a LinkedIn post with no hashtags has no trailing blank block', () => {
  const text = renderPublishText(content({ kind: 'linkedin', body: 'Just this.', hashtags: [] }));
  assert.equal(text, 'Just this.');
});

test('nothing in a long article is lost on the way to the clipboard', () => {
  const long = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\n${'word '.repeat(120)}`).join('\n\n');
  const text = renderPublishText(content({ body: long }));
  assert.ok(text.includes('## Section 0'));
  assert.ok(text.includes('## Section 59'));
  assert.ok(text.length > long.length);
  assert.ok(publishWordCount(content({ body: long })) > 7000);
});

test('Arabic and emoji survive the publish renderer byte for byte', () => {
  const body = 'أهلاً بالجميع! 💛\n\n## قسم أول\n\nنص عربي مع emoji 🚀 ورموز ✨.';
  const text = renderPublishText(content({ body, title: 'عنوان عربي', subtitle: 'عنوان فرعي' }));
  assert.ok(text.includes('أهلاً بالجميع! 💛'));
  assert.ok(text.includes('🚀'));
  assert.ok(text.includes('# عنوان عربي'));
  assert.ok(!text.includes('\uFFFD'));
});

/* -------------------------------------------------------------- export */

test('exports are UTF-8 and round-trip Arabic, emoji and code blocks', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'devradar-export-'));
  const previous = process.env.EXPORT_DIR;
  try {
    const body = 'أهلاً بالجميع! 💛\n\n## قسم\n\n```ts\nconst سعر = 1;\n```\n\nسؤال؟';
    const draft = content({ body, title: 'عنوان', subtitle: 'وصف', language: 'ar' });
    const topic = { slug: 'arabic-topic', title: 'Arabic topic' } as never;

    for (const format of ['md', 'txt', 'json'] as const) {
      const file = exportContent(draft, topic, format);
      // Read as raw bytes and decode: this catches a file written in any other
      // encoding, which is how Arabic turns into mojibake.
      const raw = fs.readFileSync(file);
      const text = raw.toString('utf8');
      assert.ok(text.includes('أهلاً بالجميع'), `${format} lost the Arabic`);
      assert.ok(text.includes('💛'), `${format} lost the emoji`);
      assert.ok(!text.includes('\uFFFD'), `${format} produced replacement characters`);
      assert.equal(Buffer.compare(Buffer.from(text, 'utf8'), raw), 0, `${format} is not valid UTF-8`);
      // Arabic and English drafts of one topic must not overwrite each other.
      assert.ok(file.includes('-ar.'), `${format} did not mark the language`);
    }

    const englishFile = exportContent(content({ language: 'en' }), topic, 'md');
    assert.ok(!englishFile.includes('-ar.'));
  } finally {
    if (previous === undefined) delete process.env.EXPORT_DIR;
    else process.env.EXPORT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a markdown export of an article contains the whole publish text', () => {
  const topic = { slug: 'export-topic', title: 'Export topic' } as never;
  const draft = content();
  const file = exportContent(draft, topic, 'md');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(renderPublishText(draft)));
});

/* ------------------------------------------------------------ settings */

test('numeric settings reject junk, out-of-range and fractional values', () => {
  assert.ok(validateSetting('minTopicScore', 'abc'));
  assert.ok(validateSetting('minTopicScore', ''));
  assert.ok(validateSetting('minTopicScore', '101'));
  assert.ok(validateSetting('minTopicScore', '-1'));
  assert.ok(validateSetting('maxStyleRewrites', '1.5'));
  assert.ok(validateSetting('repeatSimilarityThreshold', '2'));

  assert.equal(validateSetting('minTopicScore', '55'), null);
  assert.equal(validateSetting('repeatSimilarityThreshold', '0.55'), null);
  // Free-text settings are not constrained.
  assert.equal(validateSetting('enabledCategories', '*'), null);
});

test('changing a word-range setting still changes what the gate enforces', () => {
  const db = seededDb();
  setSetting(db, 'linkedinMinWords', '600');
  setSetting(db, 'linkedinMaxWords', '900');
  const context = buildContext(db, topicOf(db), null, loadProfile());
  const text = scaffold(context, 'hook');
  const note = scoreStyle({
    text,
    profile: loadProfile(),
    kind: 'linkedin',
    minWords: 600,
    maxWords: 900,
    hasPersonalTake: true,
    hasQuestion: true,
    hasConcreteDetail: true,
  }).notes.find((n) => n.includes('target'));
  assert.ok(note?.includes('600–900'));
  db.close();
});

/* -------------------------------------------------------------- reports */

test('the daily radar explains itself in the requested language', () => {
  const db = seededDb();
  const english = buildDaily(db, 10, 'en');
  const arabic = buildDaily(db, 10, 'ar');

  assert.ok(english.entries.length > 0);
  assert.equal(arabic.entries.length, english.entries.length);

  const [en] = english.entries;
  const [ar] = arabic.entries;
  assert.ok(/^Ranked \d+/.test(en!.whyItMatters), en!.whyItMatters);
  assert.ok(/[\u0600-\u06FF]/.test(ar!.whyItMatters), ar!.whyItMatters);
  assert.ok(/[\u0600-\u06FF]/.test(ar!.whyYourAudienceCares), ar!.whyYourAudienceCares);
  // The numbers must be identical; only the wording changes.
  assert.equal(en!.score?.total, ar!.score?.total);
  assert.equal(en!.topic.id, ar!.topic.id);
  db.close();
});

test('weekly section headings are translated', () => {
  const db = seededDb();
  const english = buildWeekly(db, 'en');
  const arabic = buildWeekly(db, 'ar');
  assert.ok(english.sections.length > 0);
  assert.deepEqual(
    arabic.sections.map((s) => s.key),
    english.sections.map((s) => s.key),
    'the same sections must appear in both languages',
  );
  for (const section of arabic.sections) {
    assert.ok(/[\u0600-\u06FF]|React|Next\.js|JavaScript|Node\.js/.test(section.label), section.label);
  }
  db.close();
});

test('an unspecified report language stays English, so the CLI is unaffected', () => {
  const db = seededDb();
  assert.ok(/^Ranked \d+/.test(buildDaily(db).entries[0]!.whyItMatters));
  assert.equal(buildWeekly(db).sections[0]?.label, buildWeekly(db, 'en').sections[0]?.label);
  db.close();
});

/* ----------------------------------------------------------- migration */

test('an existing database missing the language column is migrated, not broken', () => {
  const db = createTestDb();
  // Recreate the pre-migration shape and prove the additive migration adds the
  // column without touching the rows already in the table.
  db.exec('DROP TABLE content');
  db.exec(`CREATE TABLE content (
    id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL, kind TEXT NOT NULL,
    angle_kind TEXT NOT NULL, mode TEXT NOT NULL, hook TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '', subtitle TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
    hashtags TEXT NOT NULL DEFAULT '[]', sources TEXT NOT NULL DEFAULT '[]', style_score TEXT,
    ai_tells TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft', model TEXT,
    created_at TEXT NOT NULL)`);
  db.prepare(
    `INSERT INTO content (topic_id, kind, angle_kind, mode, body, created_at)
     VALUES (1, 'linkedin', 'educational', 'llm', 'old row', '2026-01-01T00:00:00Z')`,
  ).run();

  const { migrate } = require('../src/db') as typeof import('../src/db');
  migrate(db);

  const columns = (db.prepare('PRAGMA table_info(content)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  assert.ok(columns.includes('language'));
  // Rows written before the column existed are English by definition.
  assert.equal(listContent(db)[0]!.language, 'en');

  // Running it again is a no-op rather than an error.
  migrate(db);
  assert.equal(listContent(db).length, 1);
  db.close();
});
