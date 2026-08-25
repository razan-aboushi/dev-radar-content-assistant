/**
 * Everything that differs between an English draft and an Arabic one.
 *
 * The language a draft is *written in* is independent of the language the
 * dashboard is *displayed in*: an Arabic UI writing an English post is a normal
 * thing to want, and so is the reverse. Nothing here knows about the UI.
 *
 * The style scorer in evaluate.ts is a pile of English regexes — contractions,
 * "you", "I", a list of English verbs. Run against Arabic they all read zero,
 * every draft fails the gate, and the rewrite loop burns three model calls to
 * arrive at the same score. So each language brings its own patterns.
 *
 * Arabic word boundaries are the trap here. JavaScript's `\b` is defined
 * against `[A-Za-z0-9_]`, so it never fires between a space and an Arabic
 * letter and `/\bأنت\b/` matches nothing at all. Arabic also attaches its
 * prefixes (و، ف، ال، ب، ك) directly to the word, so plain substring
 * alternation is both the working choice and the linguistically right one.
 */

import type { Language } from '../types';

/** The language a draft is written in. Never the language the UI is shown in. */
export type ContentLanguage = Language;

export const CONTENT_LANGUAGES: readonly ContentLanguage[] = ['en', 'ar'];

/** Anything unrecognised falls back to English rather than throwing. */
export function toContentLanguage(value: unknown): ContentLanguage {
  return value === 'ar' ? 'ar' : 'en';
}

export interface StyleRules {
  /** Informality markers: contractions in English, spoken connectors in Arabic. */
  informal: RegExp;
  secondPerson: RegExp;
  firstPerson: RegExp;
  /** Verbs that hand the reader something to do. */
  actionable: RegExp;
  vague: RegExp;
  opinionated: RegExp;
  /** Words in a first line that pull a reader in. */
  hookPronouns: RegExp;
  /** Openers that signal a generic essay. */
  weakOpener: RegExp;
  aiPatterns: ReadonlyArray<{ re: RegExp; label: string }>;
  /** Added to the profile's own banned list when writing in this language. */
  bannedPhrases: readonly string[];
}

export interface ScaffoldStrings {
  noClaims: string;
  observation: string;
  example: string;
  whyItMatters: string;
  yourTake: (subject: string) => string;
  question: string;
  articleWhyThisMatters: string;
  articleWhatItIs: string;
  articleVerifiedFacts: string;
  articleHowItWorks: string;
  articleScenarioHeading: string;
  articleScenario: (subject: string) => string;
  articleMistakes: string;
  articleBestPractices: string;
  articleTakeaway: string;
  articleRemember: string;
  articleSources: string;
  articleOutlineFor: (title: string) => string;
  articleNoClaims: string;
  articleCodePlaceholder: string;
}

export interface ContentLanguagePack {
  code: ContentLanguage;
  /** BCP-47 tag, written into markdown exports. */
  tag: string;
  dir: 'ltr' | 'rtl';
  englishName: string;
  nativeName: string;
  greeting: string;
  hookPatterns: readonly string[];
  /** Placeholder fills for the hook patterns. */
  hookFills: { commonAction: string; complication: (s: string) => string; belief: (s: string) => string; quality: string };
  /** Appended to the system prompt so the model knows how to sound. */
  voiceRules: readonly string[];
  /** Repeated in every generation prompt. Models drift back to English without it. */
  outputRule: readonly string[];
  scaffold: ScaffoldStrings;
  style: StyleRules;
}

/* ------------------------------------------------------------------ English */

const ENGLISH_AI_PATTERNS: StyleRules['aiPatterns'] = [
  { re: /\bnot only\b[^.]{0,80}\bbut also\b/i, label: '"not only … but also" construction' },
  { re: /\bit'?s (?:not|no longer) (?:just|merely) about\b/i, label: '"it\'s not just about X" construction' },
  { re: /\bwhether you'?re a\b[^.]{0,60}\bor a\b/i, label: '"whether you\'re a X or a Y" audience sweep' },
  { re: /^\s*(?:in conclusion|to sum up|to summarize|in summary)\b/im, label: 'essay-style summary marker' },
  { re: /\bthe key (?:takeaway|is to)\b/i, label: '"the key takeaway" wrap-up' },
  { re: /\bby (?:understanding|leveraging|embracing)\b[^.]{0,60}\byou can\b/i, label: '"by X-ing you can Y" payoff sentence' },
  { re: /\b(?:crucial|essential|vital|pivotal|paramount)\b/i, label: 'inflated importance adjective' },
  { re: /\bplays a (?:crucial|key|vital|significant) role\b/i, label: '"plays a crucial role"' },
  { re: /\bin the world of\b|\bin the realm of\b/i, label: '"in the world/realm of" opener' },
  { re: /—[^—]{10,}—/, label: 'em-dash aside (common LLM rhythm; fine occasionally, suspicious if repeated)' },
  { re: /\bremember(?:,| that)\b[^.]{0,60}\bis (?:a )?journey\b/i, label: '"it\'s a journey" platitude' },
  { re: /\bhappy coding\b/i, label: '"happy coding" sign-off' },
];

const ENGLISH: ContentLanguagePack = {
  code: 'en',
  tag: 'en',
  dir: 'ltr',
  englishName: 'English',
  nativeName: 'English',
  greeting: 'Hello Everyone! 💛',
  hookPatterns: [],
  hookFills: {
    commonAction: 'reach for the default',
    complication: () => 'the default stops being the right answer once the app is real',
    belief: (subject) => `${subject} was mostly a detail`,
    quality: 'being correct',
  },
  voiceRules: [],
  outputRule: ['- Write the whole post in English.'],
  scaffold: {
    noClaims: '(No verifiable claim was extracted. Open the source link before writing anything factual.)',
    observation: '[OBSERVATION] Say plainly what changed or what people get wrong. Two sentences.',
    example: '[EXAMPLE] The concrete case a developer would recognise. Use one of these verified facts:',
    whyItMatters: '[WHY IT MATTERS] The part most people skip past. Two sentences.',
    yourTake: (subject) => `[YOUR TAKE] First person. What you would actually do about ${subject}, and why.`,
    question: '[QUESTION] One question people can answer from their own experience.',
    articleWhyThisMatters: 'Why this matters',
    articleWhatItIs: 'What it actually is',
    articleVerifiedFacts: 'Verified facts you can use',
    articleHowItWorks: 'How it works',
    articleScenarioHeading: 'A real-world scenario',
    articleScenario: (subject) =>
      `[Where you hit ${subject} in something you actually shipped. This section is the reason someone reads your version instead of the docs.]`,
    articleMistakes: 'Common mistakes',
    articleBestPractices: 'Best practices',
    articleTakeaway: 'My takeaway',
    articleRemember: 'Things to remember',
    articleSources: 'Sources',
    articleOutlineFor: (title) => `*Draft outline for: ${title}*`,
    articleNoClaims: '- (Nothing verifiable was extracted. Read the source before writing any factual statement.)',
    articleCodePlaceholder: '// Replace with a real, verified example. Do not ship untested code.',
  },
  style: {
    informal: /\b\w+'(?:s|re|t|ve|ll|d|m)\b/gi,
    secondPerson: /\byou(?:r|'re)?\b/gi,
    firstPerson: /\b(?:I|I'm|I've|my|me)\b/g,
    actionable: /\b(?:check|use|avoid|replace|move|measure|test|profile|set|add|remove|verify)\b/gi,
    vague: /\b(?:things|stuff|various|several|many aspects|a lot of)\b/gi,
    opinionated: /\b(?:I think|I'd|I would|honestly|in my experience|I disagree|my take)\b/i,
    hookPronouns: /\b(?:I|you|your|nobody|most|many)\b/i,
    weakOpener: /^(?:in|as|the world|today)/i,
    aiPatterns: ENGLISH_AI_PATTERNS,
    bannedPhrases: [],
  },
};

/* ------------------------------------------------------------------- Arabic */

/**
 * The Arabic equivalents of the English tells. These are the phrases that make
 * Arabic technical writing read as machine-translated: the ceremonial openers,
 * the academic wrap-ups, and the literal renderings of English idiom that no
 * Arabic-speaking developer would say out loud.
 */
const ARABIC_AI_PATTERNS: StyleRules['aiPatterns'] = [
  { re: /في عالم (?:التكنولوجيا|البرمجة|التقنية|تطوير)/, label: 'افتتاحية "في عالم التكنولوجيا"' },
  { re: /في (?:ظل|عصر) (?:التطور|التقدم|الثورة)/, label: 'افتتاحية إنشائية عن التطور' },
  { re: /(?:في الختام|في النهاية|خلاصة القول|وفي نهاية المطاف)/, label: 'خاتمة على طريقة مقالات المدرسة' },
  { re: /يلعب دور[اًٍ]? (?:حاسم|مهم|محوري|أساسي)/, label: '"يلعب دوراً حاسماً"' },
  { re: /(?:من الجدير بالذكر|تجدر الإشارة إلى|من المهم أن نلاحظ)/, label: 'حشو "من الجدير بالذكر"' },
  { re: /لا يقتصر الأمر على/, label: 'ترجمة حرفية لـ "it\'s not just about"' },
  { re: /(?:مما لا شك فيه|لا شك أن)/, label: 'تأكيد إنشائي فارغ' },
  { re: /(?:ثورة حقيقية|نقلة نوعية|قفزة نوعية)/, label: 'مبالغة تسويقية' },
  { re: /سواء كنت مطور[اً]? .{0,40}أو /, label: 'مسح الجمهور "سواء كنت … أو …"' },
  { re: /(?:برمجة ممتعة|حظ[اً]? موفق[اً]? في البرمجة)/, label: 'توقيع "برمجة ممتعة"' },
];

const ARABIC: ContentLanguagePack = {
  code: 'ar',
  tag: 'ar',
  dir: 'rtl',
  englishName: 'Arabic',
  nativeName: 'العربية',
  greeting: 'أهلاً بالجميع! 💛',
  // Same order as the English patterns in style-profile.json, because
  // hooks.ts picks a pattern by index per angle.
  hookPatterns: [
    '{subject} ليس كما تتخيل...',
    'كثير من المطورين {common_action}. لكن {complication}.',
    'كنت أظن أن {belief}. وكنت مخطئة.',
    'تغيير صغير مثل هذا يفتح مشكلة أكبر بكثير.',
    '{subject} يبدو بسيطاً، إلى أن تشتغل عليه في نظام حقيقي على الإنتاج.',
    'لا أحد يخبرك بهذا وأنت تبدأ تعلّم {subject}.',
    'الكود يشتغل. لكن هذا ليس نفس {quality}.',
    'شيء تعلمته من تتبّع الأخطاء على الإنتاج:',
    'الجزء الأصعب لم يكن كتابة الكود.',
    '{subject} تغيّر للتو. وهذا ما يعنيه فعلياً لتطبيقك.',
  ],
  hookFills: {
    commonAction: 'يمشون على الإعداد الافتراضي',
    complication: () => 'الإعداد الافتراضي يتوقف عن كونه الجواب الصحيح أول ما يكبر التطبيق',
    belief: (subject) => `${subject} مجرد تفصيل صغير`,
    quality: 'أن يكون صحيحاً',
  },
  voiceRules: [
    'الكتابة بالعربية الفصحى الحديثة، بنبرة محادثة طبيعية كما يتحدث مطوّر إلى مطوّر.',
    'ممنوع منعاً باتاً الترجمة الحرفية من الإنجليزية. اكتب الفكرة بالعربية من الصفر.',
    'تجنّب العربية الأكاديمية المتقعّرة والسجع والجمل الطويلة المتشعبة.',
    'اترك المصطلحات التقنية بالإنجليزية كما ينطقها المطورون فعلاً: JavaScript، React، Node.js، Next.js، API، SEO، frontend، backend، hydration، build، deploy، bug.',
    'لا تخترع تعريباً غريباً لمصطلح شائع. "الواجهة البرمجية" مقبولة، أما "مُبرمِج التطبيقات البينية" فلا.',
    'جمل قصيرة. فقرات من سطر أو سطرين. كلمات بسيطة بدل الكلمات الفخمة.',
    'استخدم صيغة المتكلّم المفرد المؤنث عند الحديث عن تجربتك الشخصية (لاحظت، واجهت، تعلّمت).',
  ],
  outputRule: [
    '- اكتب النص كاملاً بالعربية. لا تكتب أي جزء منه بالإنجليزية عدا المصطلحات التقنية وأسماء المكتبات وأمثلة الكود.',
    '- لا تكتب ترجمة إنجليزية بجانب النص العربي، ولا تشرح ما فعلته.',
  ],
  scaffold: {
    noClaims: '(لم تُستخرج أي معلومة قابلة للتحقق. افتح رابط المصدر قبل كتابة أي شيء كحقيقة.)',
    observation: '[الملاحظة] قل بوضوح ما الذي تغيّر أو ما الذي يفهمه الناس خطأ. جملتان.',
    example: '[المثال] الحالة الملموسة التي سيتعرّف عليها أي مطوّر. استخدم إحدى هذه الحقائق المتحقَّق منها:',
    whyItMatters: '[لماذا يهم] الجزء الذي يقفز عنه معظم الناس. جملتان.',
    yourTake: (subject) => `[رأيك] بصيغة المتكلّم. ما الذي ستفعلينه فعلياً تجاه ${subject}، ولماذا.`,
    question: '[السؤال] سؤال واحد يستطيع الناس الإجابة عنه من تجربتهم.',
    articleWhyThisMatters: 'لماذا يهمّك هذا',
    articleWhatItIs: 'ما هو فعلياً',
    articleVerifiedFacts: 'حقائق متحقَّق منها يمكنك استخدامها',
    articleHowItWorks: 'كيف يعمل',
    articleScenarioHeading: 'سيناريو من الواقع',
    articleScenario: (subject) =>
      `[أين اصطدمت بـ ${subject} في شيء شحنته فعلاً. هذا القسم هو سبب قراءة أحدهم لنسختك بدل التوثيق الرسمي.]`,
    articleMistakes: 'أخطاء شائعة',
    articleBestPractices: 'ممارسات أفضل',
    articleTakeaway: 'خلاصتي',
    articleRemember: 'أشياء تستحق التذكّر',
    articleSources: 'المصادر',
    articleOutlineFor: (title) => `*مسودّة هيكلية لـ: ${title}*`,
    articleNoClaims: '- (لم يُستخرج أي شيء قابل للتحقق. اقرأ المصدر قبل كتابة أي جملة كحقيقة.)',
    articleCodePlaceholder: '// استبدل هذا بمثال حقيقي مُجرَّب. لا تنشر كوداً لم تختبره.',
  },
  style: {
    // Spoken connectors are Arabic's equivalent of an English contraction:
    // they are what separates a person talking from a press release.
    informal: /(?:بصراحة|طيب|يعني|ببساطة|المهم|فعلاً|أصلاً|تخيّل|خلّينا|صار|بس )/g,
    secondPerson: /(?:أنت|أنتم|لديك|عندك|يمكنك|تستطيع|تحتاج|كودك|مشروعك|تطبيقك|فريقك|جرّب|انظر)/g,
    firstPerson: /(?:أنا |تجربتي|بالنسبة لي|شخصياً|رأيي|واجهت|تعلّمت|تعلمت|اكتشفت|لاحظت|كنت أظن|صرت|شحنت)/g,
    actionable: /(?:تحقق|استخدم|تجنّب|تجنب|استبدل|انقل|قِس|قيس|اختبر|أضف|احذف|تأكد|جرّب|جرب|راجع|فعّل|عطّل|افحص)/g,
    vague: /(?:أشياء كثيرة|أمور كثيرة|بعض الأشياء|جوانب عديدة|الكثير من الأمور|بشكل عام)/g,
    opinionated: /(?:برأيي|في رأيي|بصراحة|من تجربتي|لا أتفق|أعتقد|أظن|وجهة نظري|أفضّل)/,
    hookPronouns: /(?:أنت|أنا |معظم|لا أحد|كثير من|أغلب|كودك|مشروعك)/,
    weakOpener: /^(?:في عالم|في ظل|مع التطور|في الوقت الحالي|في عصرنا|إن |لا شك)/,
    aiPatterns: ARABIC_AI_PATTERNS,
    bannedPhrases: [
      'في عالم التكنولوجيا',
      'في ظل التطور السريع',
      'ثورة حقيقية',
      'نقلة نوعية',
      'من الجدير بالذكر',
      'في الختام',
      'خلاصة القول',
      'مما لا شك فيه',
      'يلعب دوراً حاسماً',
      'لا يقتصر الأمر على',
      'أتمنى أن يكون هذا مفيداً',
      'برمجة ممتعة',
      'دعونا نغوص في',
      'أطلق العنان',
    ],
  },
};

const PACKS: Record<ContentLanguage, ContentLanguagePack> = { en: ENGLISH, ar: ARABIC };

export function languagePack(language: ContentLanguage): ContentLanguagePack {
  return PACKS[language] ?? ENGLISH;
}

/**
 * Both question marks. Arabic ends a question with ؟ (U+061F), so an Arabic
 * draft scored zero on discussion potential and was told "no closing question"
 * however many it actually asked.
 */
export const QUESTION_MARK = /[?؟]/;
export const QUESTION_MARK_AT_END = /[?؟]\s*$/;
