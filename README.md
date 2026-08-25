# dev-radar

A local-first tool that finds what's worth writing about in the developer world,
ranks it, and helps you turn the good ones into a LinkedIn post or a Medium
article in your own voice.

Runs entirely on your machine. No paid APIs, no accounts, no data leaving your
laptop. If you connect a local model through [Ollama](https://ollama.com) it
writes prose; without one it still does all the research and gives you a
structured scaffold to write into.

---

## Table of contents

- [Quick start](#quick-start)
- [Put it online, free, forever](#put-it-online-free-forever)
- [What it actually does](#what-it-actually-does)
- [The three numbers](#the-three-numbers)
- [Every command](#every-command)
- [The dashboard](#the-dashboard)
- [Arabic and English](#arabic-and-english)
- [Copying a finished draft](#copying-a-finished-draft)
- [Free AI models](#free-ai-models)
- [Setting up a free local model](#setting-up-a-free-local-model)
- [Teaching it your voice](#teaching-it-your-voice)
- [Configuring sources](#configuring-sources)
- [How topic scoring works](#how-topic-scoring-works)
- [How the fact policy works](#how-the-fact-policy-works)
- [Settings](#settings)
- [Project structure](#project-structure)
- [Extending it](#extending-it)
- [Running the tests](#running-the-tests)
- [Limitations — read this one](#limitations--read-this-one)

---

## Quick start

**Requirements:** Node 18.17 or newer. Nothing else. (`better-sqlite3` compiles a
native module on install, so on Linux you need `build-essential` and `python3`;
macOS needs Xcode command line tools; Windows works through the prebuilt binary.)

```bash
cd dev-radar
npm install
cp .env.example .env      # optional — every value has a working default
```

### See it working in 30 seconds

Before touching the network, seed some fixture data:

```bash
npm run demo
npm run topics
npm run daily
npm run dashboard         # → http://127.0.0.1:4311
```

That runs the real pipeline — clustering, scoring, fact extraction, angle
selection — against seven sample items. It exists so you can confirm the tool
works before debugging feed URLs. Delete `data/radar.db` to clear it.

### Then do it for real

```bash
npm run sources -- --check    # test which feeds actually respond
npm run radar                 # fetch everything enabled
npm run daily                 # today's top topics
```

**Run `sources --check` first.** It makes one real request per source and tells
you which feeds actually respond. See [Limitations](#limitations--read-this-one)
for why this matters.

Eight sources use the GitHub API, which allows 60 requests an hour without a
token. A full check plus a research run can exhaust that, and GitHub reports an
exhausted quota as `403`. The tool now recognises this and says so explicitly
rather than reporting a bare HTTP error — if you see *"rate limited … the URL is
fine"*, nothing is broken. Add a free `GITHUB_TOKEN` to `.env` to raise the
limit to 5000/hour.

---

## Put it online, free, forever

You do not have to run this on your laptop every time you want to look at it.

```bash
npm run site            # build the static site into site/
npm run site:preview    # check it at http://127.0.0.1:4312
```

To publish it, just push. The workflow in `.github/workflows/radar.yml` enables
Pages on its first run, so there is nothing to click:

1. Push to `main`.
2. Your radar goes live at `https://<your-username>.github.io/<repo-name>/`.
3. It refreshes itself at **05:15 UTC every day**. Nothing to keep awake.

If your organisation blocks the workflow from enabling Pages, set it by hand
once: **Settings → Pages → Source → GitHub Actions**.

**This costs nothing and always will.** Actions minutes are unlimited on public
repositories and Pages is free for them. There is no server, no database host
and no cold start — the published site is a handful of JSON files behind a CDN,
so it opens instantly.

### Writing on the published site

Get a free key from [console.groq.com/keys](https://console.groq.com/keys) — no
credit card — then use it in either or both of these ways.

**In your browser**, for writing on demand: open the published site → Settings →
paste the key → Save and test. The Generate buttons then work there, for any
angle and either language. The key stays in that browser.

**As a repository secret**, so drafts are already waiting when you arrive: add
it under **Settings → Secrets and variables → Actions → New repository secret**,
named `AI_API_KEY`. The scheduled job then pre-writes a LinkedIn post and a
Medium article for the top topics in both languages. Optionally set repository
*variables* `AI_PROVIDER` (default `groq`) and `AI_MODEL` for a different free
provider or model.

Neither is required. Without a key the radar still publishes; you just get
topics and scores rather than ready drafts. See
[Free AI models](#free-ai-models).

### What the published copy can and cannot do

| | Published site | On your machine |
|---|---|---|
| Browse and rank topics | Yes | Yes |
| Interest scores and evidence | Yes | Yes |
| Read and copy pre-written drafts | Yes | Yes |
| Arabic / English, RTL | Yes | Yes |
| **Generate a LinkedIn post or Medium article** | **Yes**, with a free key | Yes |
| Style gate and rewrite loop | No | Yes |
| Run research on demand | No | Yes |
| Change settings, reject topics | No | Yes |

**The Generate buttons work on the published site too.** There is no server
there, so the browser calls a free AI API itself. Open **Settings**, pick a
provider, paste a free key, and the buttons behave exactly as they do locally —
same prompts, same angles, same two languages, same one-click copy.

The prompts are not rebuilt in JavaScript. They are assembled by the same
TypeScript the CLI uses and shipped inside each topic's JSON, so the browser
and the command line ask a model for precisely the same thing.

**Where your key goes:** into this browser's `localStorage`, and to the HTTPS
endpoint of the provider you chose. Nowhere else. It is never committed, never
in the published files, and the page's Content-Security-Policy names those four
provider origins and nothing else — so even a script that somehow ran on the
page could not post your key to an address of its choosing. "Forget key"
removes it; there is no second copy.

What the published site cannot do is run the style gate, because that needs the
scorer. A draft written in the browser says so, and is worth reading closely.
Running research and editing settings need a database, so they stay local.

---

## The three numbers

Every topic carries three, and you only need the first one to choose.

| | What it answers | Where it comes from |
|---|---|---|
| **Worth writing** | "Should I write this today?" | Fit and interest blended, 60/40 |
| **Fit for you** | "Is this for my readers?" | The seven-component TOPIC SCORE |
| **Audience interest** | "Does anyone care?" | Measured engagement, syndication, outlet size, subject demand |

**Audience interest is the one you asked for, and it is not invented.** Every
point traces to something real:

- **Upvotes and comments** on Hacker News — actual humans, log-scaled, because
  500 upvotes is about twice as meaningful as 50, not ten times.
- **GitHub stars** on the project involved.
- **How many independent outlets** carried the story. If five publications ran
  it, five editors judged it newsworthy.
- **How big those outlets are** — the `reach` field in `config/sources.json`,
  1 to 5, which you can edit.
- **How many developers work in that subject area** — the demand table in
  `src/pipeline/interest.ts`, also editable.
- **How recent it is.** Attention decays.

The evidence sits under every topic, in your language:

> **Major · 87 · ≈60k–250k** — 800 upvotes and 696 comments on Hacker News ·
> covered by 2 independent sources · ai for developers is a very widely
> followed subject area

So "87" is never something you have to take on trust. The band and the
**≈60k–250k** range are a modelled estimate with a deliberately wide error bar;
the numbers above them are measurements. Nobody can tell you how many people
will read your post, and this does not pretend to.

**Why blend them.** Sorting by fit alone surfaces a perfectly on-topic release
note nobody is discussing. Sorting by interest alone surfaces whatever is
loudest on Hacker News whether or not you have anything to say about it — on a
real run the top five by interest were all AI chatter scoring in the 30s for
fit. In the Topics view you can sort by any of the three, or by newest.

---

## What it actually does

Five stages, each independently inspectable:

**1. Fetch.** Pulls from RSS/Atom feeds, GitHub releases, GitHub code search and
the Hacker News Algolia API. All free, none require a key. Each source is fetched
in isolation — one dead feed doesn't stop the run. There's a politeness delay
between requests to the same host and a concurrency cap, so it behaves itself.

**2. Cluster.** The same story shows up in five places. Items are grouped by
title similarity and canonical URL (tracking parameters stripped), and the
highest-tier source becomes the lead. The others become corroboration, which
matters for fact verification later.

**3. Score.** Seven weighted components, each producing a written reason.
Nothing is a black box — `npm run topic -- <slug>` shows you exactly why
something ranked where it did. Details [below](#how-topic-scoring-works).

**4. Verify.** Claims are lifted verbatim from source text, never generated, and
tagged `verified`, `single-source` or `unverified`. Unverified claims never reach
a draft. Details [below](#how-the-fact-policy-works).

**5. Write.** Three angles per topic (educational / opinion / engineering
lesson), one recommended based on the score shape. Then a LinkedIn post
(150–300 words) or a Medium article (1000–1800 words), checked against a style
profile and rewritten if it scores below your threshold.

Nothing is published automatically. Ever. Drafts land in `out/` and you copy them
yourself.

---

## Every command

| Command | What it does |
|---|---|
| `npm run demo` | Seed fixture data so you can see the pipeline work offline |
| `npm run radar` | Fetch every enabled source, cluster, score |
| `npm run radar -- --offline` | Re-score what's already stored, no network |
| `npm run radar -- --source nodejs-blog` | Fetch one source only |
| `npm run topics` | All topics, ranked, with score bars |
| `npm run topics -- --min 60 --status shortlisted` | Filter the list |
| `npm run topic -- <slug>` | Full breakdown: score reasoning, facts, angles |
| `npm run daily` | Top 10 today plus one clear recommendation |
| `npm run daily -- --export` | Same, written to `out/` |
| `npm run weekly` | Seven-day view by category, plus underrated and controversial picks |
| `npm run generate:linkedin -- <slug>` | Write a LinkedIn post |
| `npm run generate:medium -- <slug>` | Write a Medium article |
| `npm run generate:linkedin -- <slug> --angle opinion` | Force a specific angle |
| `npm run generate:linkedin -- <slug> --language ar` | Write it in Arabic (`en` is the default) |
| `npm run generate:medium -- <slug> --format json` | Export as `md` (default), `json` or `txt` |
| `npm run sources` | List sources with status and last fetch |
| `npm run sources -- --check` | Probe every enabled source end to end and report what works |
| `npm run sources -- --disable hn-frontend` | Turn a source off (or `--enable`) |
| `npm run history` | Past runs, drafts and published pieces |
| `npm run settings` | Show current settings |
| `npm run style:learn` | Measure your voice from `style/corpus/` |
| `npm run dashboard` | Web UI on http://127.0.0.1:4311 |
| `npm run dev` | Alias for `dashboard` |
| `npm run site` | Build the static site into `site/` for GitHub Pages |
| `npm run site:preview` | Build it and serve it at http://127.0.0.1:4312 |
| `npm run pregenerate -- --count 5` | Write drafts ahead of time for the top topics |
| `npm test` | Build and run the test suite |
| `npm run typecheck` | Type check without emitting |
| `npm run build` | Compile to `dist/` |

Note the `--` before flags. That's npm passing arguments through to the script,
not a quirk of this tool.

---

## The dashboard

```bash
npm run dashboard
```

Six views: **Radar** (today's picks), **Topics** (everything, filterable),
**Weekly**, **History**, **Sources**, **Settings**. Clicking a topic opens a
detail panel with the full score breakdown, verified facts, selectable angles,
the content-language choice and the generate buttons.

It's in English or Arabic — see [Arabic and English](#arabic-and-english) — and
every generated draft has a one-click copy that gives you the whole thing, which
is [its own section](#copying-a-finished-draft).

The signature element is a **seven-segment score meter** on every topic row — one
bar per score component, always in the same order. It's there so you can tell at
a glance the difference between *fresh but everyone's covering it* and *quiet
evergreen explainer nobody has written well*, which a single number hides.

It binds to `127.0.0.1` and has **no authentication**, deliberately: it's a
single-user local tool and adding a login to something only reachable from your
own machine is theatre. Don't expose the port.

**Note on the stack:** the dashboard is plain HTML, CSS and JavaScript served by
Node's built-in `http` module. No React, no Next.js, no build step. For a
read-mostly UI with six screens, a framework would have added hundreds of
megabytes and a compile cycle for no benefit. The core is fully decoupled from
the server layer, so if you'd rather have Next.js the swap is contained to
`src/server/`.

---

## Arabic and English

The dashboard speaks both. The switch is at the top of the sidebar:

```
EN | العربية
```

Two things are being chosen here, and they are **deliberately independent**:

| | What it controls | Where you set it |
|---|---|---|
| **Interface language** | The dashboard's own labels, buttons and messages | `EN \| العربية` in the sidebar |
| **Content language** | The language a generated post or article is written in | Next to the Generate buttons, and in Settings |

An Arabic interface writing English posts is a normal thing to want, and so is
the reverse. Neither setting moves the other, and both survive a refresh —
they're kept in `localStorage` under `dev-radar.uiLanguage` and
`dev-radar.contentLanguage`. On a first visit the interface follows your
browser's language.

### RTL

Choosing Arabic sets `dir="rtl"` and `lang="ar"` on `<html>`, and the whole
layout mirrors: sidebar, cards, tables, forms, the detail panel, everything.
That works because the stylesheet uses CSS logical properties throughout
(`padding-inline-start` rather than `padding-left`), so there is no second
right-to-left stylesheet to keep in sync. A test fails the build if a physical
`left`/`right` property creeps back in.

Two things deliberately **do not** mirror:

- **The seven-segment score meter.** It's a chart. Its components are always in
  the documented order so you can compare two rows at a glance, and the initials
  under it are rendered one per bar so they line up in either language.
- **Latin-script text.** Topic titles, URLs, source keys and code identifiers
  keep their own direction inside Arabic prose, and Arabic drafts read
  right-to-left inside an English interface. Direction is decided per string,
  not per page.

### What is and isn't translated

Translated: all dashboard chrome — navigation, headings, buttons, filters,
settings, source statuses, errors, empty states, loading states, score
component names, the weekly section headings, and the sentence explaining why a
topic ranked where it did.

Left alone on purpose: source names, URLs, category slugs (`web-platform`,
`ai-for-developers` — the taxonomy the tool is configured with, and the words
developers use anyway), fact claims quoted verbatim from a source, and generated
draft text, which is in whatever content language you asked for.

Translations live in `src/server/public/i18n/en.js` and `ar.js`, one file per
language, with the service in `i18n/index.js`. A test walks both files and fails
if either has a key the other does not.

### Arabic content quality

Arabic drafts are written from scratch in Arabic, not translated from an
English draft. The model is given explicit rules: Modern Standard Arabic with a
conversational tone, no literal translation from English, and technical terms
left in English the way developers actually say them — `JavaScript`, `React`,
`Node.js`, `Next.js`, `API`, `SEO`, `frontend`, `backend`.

The style gate has its own Arabic pattern set. This matters more than it
sounds: the English scorer looks for contractions, `you` and `I`, so run against
Arabic every dimension read zero, every draft failed the gate, and the rewrite
loop burned three model calls to arrive at the same number. Arabic also ends a
question with `؟`, which the sentence splitter now knows about.

Arabic quality is bounded by your model. `llama3.1:8b` writes serviceable but
uneven Arabic; a larger model is noticeably better. The style score is reported
honestly either way — see [Limitations](#limitations--read-this-one).

---

## Copying a finished draft

Every generated draft has one button that puts the **entire** piece on your
clipboard:

- **Copy post** — the LinkedIn post: every paragraph, line break, emoji and
  hashtag, as plain text. LinkedIn renders no markdown, so none is emitted.
- **Copy article** — the Medium article as canonical Markdown: the title, the
  subtitle, every heading, every paragraph, bullet and numbered list, and every
  fenced code block. Markdown is what Medium's import understands, and it is how
  the body is stored, so nothing is converted on the way out.

What lands on the clipboard is exactly the text rendered above the button —
both come from the same `renderPublishText()` — so what you read is what you
paste. Scores, sources, style notes and every other piece of interface furniture
stay out of it.

Drafts are never collapsed, clipped or hidden behind a "show more". A long
article is shown in full.

**If copying fails, it says so.** `navigator.clipboard` is not something you can
assume: it is undefined outside a secure context, and reaching this dashboard
from your phone at `http://192.168.1.x:4311` is not one, even though
`http://127.0.0.1` is. So the button tries the modern API, falls back to a
selected textarea and `execCommand`, and only then reports which step failed and
why. It never reports success it did not achieve.

The button is a real `<button>` with an `aria-label`, so it is reachable and
operable from the keyboard, and it confirms with `Copied ✓` before returning to
its normal label.

---

## Free AI models

Every option here is genuinely free and needs no credit card. Set one in
`.env` and it works both locally and in the scheduled job.

| Provider | `AI_PROVIDER` | Free limits | Trains on your input? | Get a key |
|---|---|---|---|---|
| **Groq** *(recommended)* | `groq` | 30 req/min, 1,000/day | **No** | [console.groq.com/keys](https://console.groq.com/keys) |
| Google Gemini | `gemini` | Flash models free, limits in AI Studio | **Yes**, on the free tier | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| OpenRouter | `openrouter` | 20 req/min, 50/day | No | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Cerebras | `cerebras` | 30 req/min | No | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| Ollama *(local)* | `ollama` | Unlimited, your hardware | No — never leaves your machine | — |

```ini
AI_PROVIDER=groq
OPENAI_API_KEY=gsk_your_key_here
# OPENAI_MODEL=llama-3.3-70b-versatile   # optional, this is the default
```

**Groq is the default recommendation** because it does not train on what you
send it, publishes its limits so you can plan against them, and runs a 70B
model — a real step up from an 8B model on your laptop. Gemini's free tier is
excellent and has a much larger context window, but Google may use free-tier
inputs to improve its products; that matters more for a private draft than for
a post you are about to publish anyway, so pick knowingly.

All four speak the OpenAI chat protocol, so they share one code path. Model
names change — override with `OPENAI_MODEL` and check the provider's model list
if a call starts failing.

Nothing here requires payment, and nothing degrades to a paid tier silently: if
a provider is unreachable or out of quota, the tool falls back to the labelled
research scaffold and says so.

---

## Setting up a free local model

Everything works without one. A model only affects whether you get finished
prose or a scaffold. If you want prose:

```bash
# 1. Install Ollama — https://ollama.com/download
# 2. Pull a model
ollama pull llama3.1:8b
# 3. Point dev-radar at it (this is already the default)
```

`.env`:

```ini
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1:8b
```

Any model works. `llama3.1:8b` needs roughly 8GB of RAM; `qwen2.5:14b` writes
noticeably better if you have 16GB; `llama3.2:3b` runs on modest hardware and is
still a real improvement over the scaffold.

The dashboard shows whether a model is connected, and `npm run topics` says so
too. If Ollama isn't running, the tool says so plainly and falls back — it never
silently degrades.

### Other local servers

Anything exposing an OpenAI-compatible `/v1/chat/completions` endpoint works —
llama.cpp's server, LM Studio, vLLM, text-generation-webui:

```ini
AI_PROVIDER=openai-compatible
OPENAI_BASE_URL=http://127.0.0.1:8080/v1
OPENAI_MODEL=local-model
OPENAI_API_KEY=            # leave empty for local servers
```

This can point at a paid hosted API too, but nothing here requires it and
nothing here assumes it.

---

## Teaching it your voice

```bash
# put 10-15 of your own published posts in style/corpus/ as .md or .txt
npm run style:learn
```

This measures **statistics only** — sentence length, paragraph shape, question
rate, first-person rate, emoji rate — and writes them into
`style/style-profile.json`. Your posts are never copied into a draft and never
leave your machine.

`style/style-profile.json` also holds things you edit by hand: greetings,
signature phrases, hook patterns, preferred hashtags, and a **banned phrase list**
that every draft is checked against. That list is where you put the corporate
filler you never want to see — it ships with about 33 entries and you should add
to it as you spot more.

There is deliberately **no LinkedIn scraper**. LinkedIn blocks automated access
and scraping it risks your account. Ten minutes of copy-paste is not worth that.

### The style score

Every draft gets a 0–100 score across nine dimensions (simplicity,
conversational tone, technical clarity, personality, usefulness, originality,
hook strength, naturalness, discussion potential). Below your threshold —
85 by default — it's rewritten, up to `maxStyleRewrites` times, with the specific
failures fed back as fix instructions.

Treat this as a smoke alarm, not a verdict. It reliably catches LLM tells,
banned phrases, missing first-person voice, and unnaturally uniform sentence
rhythm. It cannot tell you whether an idea is any good.

---

## Configuring sources

`config/sources.json` holds **45 sources**, all verified live. Coverage spans
JavaScript and TypeScript, React, Next.js, Vue, Svelte and Astro, Node, Deno
and Bun, the web platform, CSS, performance and SEO, **AI for developers**
(OpenAI, Hugging Face, Stack Overflow, Simon Willison, Hacker News),
**backend and infrastructure** (Cloudflare, Go, Rust, Kubernetes, Netflix),
databases, security, and testing.

Each one:

```json
{
  "key": "nodejs-blog",
  "name": "Node.js Blog",
  "url": "https://nodejs.org/en/feed/blog.xml",
  "kind": "rss",
  "tier": "primary",
  "category": "nodejs",
  "enabled": true,
  "weight": 1.4,
  "reach": 5
}
```

**`weight`** (0.5–1.5) is how well the outlet matches *your* subjects; it
multiplies relevance. **`reach`** (1–5) is how large the outlet's audience is;
it feeds audience interest. They are separate on purpose — a niche newsletter
can be highly relevant to you and still small.

**`kind`** — `rss`, `atom`, `github-releases`, `github-search`, `hackernews`.

**`tier`** — this is the important one. It drives fact verification:

| Tier | Meaning | Can it be cited as fact alone? |
|---|---|---|
| `primary` | The project itself (Node.js blog, React blog, GitHub releases) | Yes |
| `reputable` | Established editorial (MDN, web.dev, Smashing) | Yes, hedged |
| `community` | Hacker News, trending repos | **No** — discovery only |

Community sources surface topics but their claims are never asserted unless a
higher tier corroborates them.

Changes take effect on the next `npm run radar`. Sources are synced into the
database by key, and a source you switch off in the dashboard stays off — the
sync no longer overwrites `enabled` from the file, which it used to do on every
process start.

---

## How topic scoring works

Seven components, weights summing to 1.0:

| Component | Weight | What it measures |
|---|---|---|
| Audience fit | 0.22 | Overlap with the subjects your readers follow you for |
| Relevance | 0.18 | Focus-keyword density, source tier, minus marketing noise |
| Practical value | 0.15 | Can a developer do something with this on Monday? |
| Freshness | 0.12 | Age, on a 7-day half-life. Undated items get a neutral 50, not zero. |
| Educational value | 0.12 | Depth signals and summary substance |
| Originality | 0.11 | Falls as cluster size grows and as overlap with your past work grows |
| Discussion potential | 0.10 | Debate signals — the things that make people reply |

**Audience fit and relevance carry 40% between them, deliberately.** An earlier
split gave them 25% and let freshness decide the order: on a live run an Apple
silicon launch came first and a sponsored listicle third, above every
on-topic item. Originality was worth 14% while reading 95 for all twelve of the
top topics — it only moves when several sources carry the same story, which is
rare once clustering has merged the duplicates.

Focus keywords come in two tiers, in `src/pipeline/signals.ts`. **Core** terms
(`react`, `hydration`, `core web vitals`, `tsconfig`, `npm`…) are specific to
web work and count for 20 points each. **Broad** terms (`performance`, `ai`,
`api`, `production`…) are real focus areas that any technical article also
matches, and count for 7. Add your own terms to whichever tier fits — this is
the first place to look if the radar keeps surfacing the wrong subjects.

Plus three derived figures: **LinkedIn score** (weights discussion and audience
fit), **Medium score** (weights educational and practical value), and
**controversy**.

And **confidence** separately, based on metadata completeness and source tier. A
high score with low confidence means *this looks interesting but I'm not certain
about it* — the dashboard flags those explicitly rather than burying it.

Every component records its reason. `npm run topic -- <slug>` prints them:

```
Freshness 91: published 1 day(s) ago
Relevance 85: 2 focus keyword(s), primary source
Originality 79: covered by 2 source(s), 0% overlap with prior work
Audience fit 55: node.js (plus 1 broad term(s))
```

Tune the thresholds in Settings; tune the weights in `src/pipeline/score.ts`.

---

## How the fact policy works

The rule this is built around: **never invent a fact.**

Claims are extracted verbatim from source text — sentences containing something
checkable (a version number, a percentage, a date, a named API). They're never
paraphrased by a model, because paraphrasing is where numbers drift.

Each claim gets a status:

- **`verified`** — stated by a primary source, or corroborated across two
  independent sources.
- **`single-source`** — one reputable source only. Rendered with an explicit
  hedge ("one source reports…").
- **`unverified`** — community tier, uncorroborated. **Never reaches a draft.**

Release stability (`stable` / `experimental` / `proposal` / `deprecated`) is
extracted as its own explicit fact, because "X ships Y" and "X proposes Y" are
very different posts and getting that wrong in public is embarrassing.

Where the tool genuinely doesn't know, drafts say **"Not verified yet."** rather
than guessing.

---

## Settings

Adjust in the dashboard or with `npm run settings`:

| Setting | Default | Effect |
|---|---|---|
| `minTopicScore` | 55 | Minimum **worth-writing** score to be shortlisted or shown on the daily radar |
| `dailyTopicCount` | 10 | How many topics the daily radar shows |
| `linkedinMinWords` / `MaxWords` | 150 / 300 | LinkedIn length target |
| `mediumMinWords` / `MaxWords` | 1000 / 1800 | Medium length target |
| `minStyleScore` | 85 | Below this, a draft is rewritten |
| `maxStyleRewrites` | 2 | Rewrite attempts before giving you the best one |
| `repeatSimilarityThreshold` | 0.55 | Above this vs. past work, a topic is rejected as a repeat |
| `clusterSimilarityThreshold` | 0.62 | Above this, two items are the same story |
| `lookbackDays` | 21 | How far back items stay eligible |
| `enabledCategories` | `*` | **Not implemented.** Every category is always considered. |

Numeric settings are validated on save — a value that is not a number, or is
outside its range, is rejected with a message rather than stored and silently
ignored. `enabledCategories` is shown struck through in the dashboard with a
note saying it does nothing, because a setting that looks live and isn't is
worse than one that is honestly labelled.

The interface and content languages are not in this table: they are per-browser
preferences, not database settings, so switching machines does not carry them
over. See [Arabic and English](#arabic-and-english).

---

## Project structure

```
src/
  types.ts            Every shared type. Start here.
  config.ts           Environment, paths, style profile loading
  logger.ts           Levelled logging to stderr

  db/
    schema.sql        Tables, indexes, foreign keys
    index.ts          Connection, source sync, settings
    repositories.ts   All SQL. Nothing else touches the database directly.

  sources/
    adapters.ts       One adapter per source kind: fetch → normalize → validate

  pipeline/
    signals.ts        Keyword tables for categories and scoring signals
    dedupe.ts         Clustering and repeat detection against past work
    score.ts          The seven scorers and their weights
    verify.ts         Fact extraction and verification status
    angles.ts         Angle generation and recommendation
    run.ts            Orchestration

  ai/provider.ts      Provider interface, Ollama, OpenAI-compatible, Null

  writing/
    languages.ts      Per-language voice rules, hooks, scaffolds, style patterns
    style.ts          Style profile, corpus measurement, system prompts
    evaluate.ts       AI-tell detection and the nine-dimension style score
    hooks.ts          Hook pattern selection
    context.ts        Assembles everything a generator needs
    linkedin.ts       LinkedIn generation and the rewrite loop
    medium.ts         Medium generation (two-pass)
    publish.ts        The one definition of "the finished piece"
    export.ts         Writing drafts to md/json/txt

  reports.ts          Daily and weekly reports, shared by CLI and dashboard
  cli/index.ts        Command parsing and terminal rendering
  server/
    api.ts            JSON handlers
    server.ts         Static files and routing
    public/
      index.html      The whole page
      app.js          Dashboard client
      styles.css      One stylesheet, logical properties, no RTL variant
      clipboard.js    Copy with a fallback chain
      i18n/           en.js, ar.js, and the language service
```

Two of these are load-bearing in a way the names hide.

`writing/publish.ts` holds `renderPublishText()`, the single definition of what
a finished draft is. The dashboard's `<pre>`, its copy button, the CLI's stdout
and every file in `out/` all call it, which is what makes "what you see is what
you paste" true rather than aspirational.

`writing/languages.ts` holds everything that differs between an English draft
and an Arabic one — prompt rules, hook patterns, scaffold headings, and the
style-scoring patterns. Nothing in it knows about the dashboard's language.

A modular monolith on purpose. One process, one SQLite file, no queues, no
containers, no services. It's a personal tool.

`reports.ts` is shared by the CLI and the dashboard specifically so the two can
never disagree about what today's top topic is.

---

## Extending it

### Add a source

If it's an RSS or Atom feed, just add an entry to `config/sources.json`. No code.

For a new *kind* of source, implement the `SourceAdapter` interface in
`src/sources/adapters.ts`:

```ts
export const myAdapter: SourceAdapter = {
  kind: 'my-kind',
  async fetch(source) { /* return raw text */ },
  normalize(raw, source) { /* return NormalizedItem[] */ },
  validate: defaultValidate,   // dedupes, drops junk titles and bad URLs
};
```

Register it in `getAdapter()`, add `'my-kind'` to `SourceKind` in `types.ts`,
then add your JSON entry.

### Add an AI provider

Implement `AIProvider` in `src/ai/provider.ts` — `available()` and `complete()`
— and add a branch to `getProvider()`. `available()` must return `false` rather
than throw when the service is unreachable; the fallback path depends on it.

### Change the scoring

Weights and scorers are all in `src/pipeline/score.ts`. Every scorer returns a
`{ value, reason }` pair — if you add one, give it a real reason string, because
the CLI and dashboard both display them and an empty reason is worse than no
component.

---

## Running the tests

```bash
npm test          # builds, then runs everything
npm run typecheck
npm run build
```

234 tests using Node's built-in test runner — no test framework dependency.
They cover text utilities, RSS/Atom/GitHub/HN adapter normalisation against
fixture payloads, clustering and repeat detection, scoring (range, determinism,
weight sum, decay behaviour), fact extraction and status rules, AI-tell
detection, style measurement, hook selection, the AI provider wire protocol
against a stub server, HTTP failure messaging (including telling rate limiting
apart from a genuine 403), source liveness checks across every adapter kind, and
full pipeline round trips through an in-memory database.

`tests/languages.test.ts` covers the content-language side: Arabic prompts,
hooks and scaffolds, the Arabic style patterns, Arabic sentence splitting,
UTF-8 export round trips, the publish renderer, settings validation, and the
additive database migration.

`tests/dashboard.test.ts` covers the browser modules without a browser. There is
no build step in the dashboard, so `i18n`, `clipboard` and the data layer are
plain scripts that attach one object to `window` — which means they load into a
`vm` context with a hand-built fake window. That is enough to test dictionary
coverage, preference persistence, the storage-throws case, and the full
clipboard fallback chain, and it adds no dependency. It also asserts that the
stylesheet contains no physical `left`/`right` properties, so RTL cannot
silently regress.

`tests/interest.test.ts` pins down audience interest: score ranges,
determinism, that engagement saturates rather than scaling linearly, that
evidence never claims a number it did not measure, and that the three sort
orders genuinely differ.

`tests/snapshot.test.ts` covers the published build — that the snapshot has
every file the dashboard reads, that it contains no secrets or absolute paths,
that static filtering and sorting produce the same answers as the SQL, and that
browser-side generation sends the key to the chosen provider and nowhere else.
It also pins the pieces that necessarily exist twice: the draft cleaner, the
publish renderer and the article titles are run through both the TypeScript and
the JavaScript copy over the same fixtures, so the published site cannot
quietly start producing different text from the CLI.

`tests/security.test.ts` pins the security properties: the CSP allows no inline
or remote code, cross-origin POSTs are refused, the client uses no HTML sink,
every `href` goes through the protocol allowlist, and the publishing workflow
cannot write to the repository or see the AI key outside the one step that
needs it.

The database tests use `createTestDb()`, an in-memory SQLite instance, so they
don't touch `data/radar.db`.

---

## Limitations — read this one

I'd rather you know these up front than discover them.

**All 27 feed URLs are verified.** Every source in `config/sources.json` has been
run against the live internet through the real fetch → normalize → validate
chain, and all 27 return usable items. A full `npm run radar` collected roughly
3,300 items across every adapter kind. Feeds still rot, though — run
`npm run sources -- --check` when something looks quiet, and disable whatever
fails; fixing one is a one-line JSON edit.

**Prose generation has now been run against a real model** — `llama3.1:8b`
through Ollama — in English and in Arabic, for both LinkedIn posts and Medium
articles. The pipeline works end to end. Output quality is a different question:
see the two entries below.

**Arabic quality depends heavily on the model.** `llama3.1:8b` produces
serviceable Arabic that still needs an editor. It occasionally translates a
technical term that should have stayed in English — one draft rendered
"hydration boundary" as "حدود الحقن", which is literal and not what an Arabic
speaker would say. The prompt tells it not to; an 8B model does not always
listen. A larger model is a real improvement here. Read your drafts.

**The angle titles and score reasons in the topic panel stay English.** They are
generated by the scorer and stored per topic at scoring time, so translating
them would mean either re-scoring the database on every language switch or
restructuring the scorer to emit keys instead of sentences. The daily and weekly
prose *is* translated, because it is built on read.

**Without a model you get a scaffold, not a post.** It's clearly labelled
`mode: scaffold — outline, not publishable prose` in both the CLI and the
dashboard. Research, scoring, clustering, fact verification and angle selection
all work fully without a model. The prose doesn't, and no template will make it.

**The style score is a heuristic.** Nine dimensions of pattern matching. It
catches LLM tells and banned phrases reliably. It cannot judge whether an idea is
worth publishing. Read your drafts.

**Local 7–8B models drift on long output.** Medium articles are generated in
three passes (outline, then two halves) specifically because of this. Even so,
a 1500-word article from an 8B model needs editing. Expect to rewrite.

**Hacker News and GitHub trending are discovery only.** They tell you what people
are talking about. They are never cited as fact without corroboration, by design.

**Fact extraction is sentence-level pattern matching**, not comprehension. It
picks sentences with checkable specifics and preserves them verbatim with their
source URL. It will occasionally pick a dull sentence. It will not fabricate one.

**No scheduling.** There's no cron, daemon or background job — run `npm run radar`
when you want it. Wire it to your own cron if you want it daily.

---

## License

[MIT](LICENSE) © [Razan Aboushi](https://github.com/razan-aboushi)
