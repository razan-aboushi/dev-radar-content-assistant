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
- [What it actually does](#what-it-actually-does)
- [Every command](#every-command)
- [The dashboard](#the-dashboard)
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
| `npm run generate:medium -- <slug> --format json` | Export as `md` (default), `json` or `txt` |
| `npm run sources` | List sources with status and last fetch |
| `npm run sources -- --check` | Probe every enabled source end to end and report what works |
| `npm run sources -- --disable hn-frontend` | Turn a source off (or `--enable`) |
| `npm run history` | Past runs, drafts and published pieces |
| `npm run settings` | Show current settings |
| `npm run style:learn` | Measure your voice from `style/corpus/` |
| `npm run dashboard` | Web UI on http://127.0.0.1:4311 |
| `npm run dev` | Alias for `dashboard` |
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
detail panel with the full score breakdown, verified facts, selectable angles
and the generate buttons.

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

`config/sources.json` holds 27 sources. Each one:

```json
{
  "key": "nodejs-blog",
  "name": "Node.js Blog",
  "url": "https://nodejs.org/en/feed/blog.xml",
  "kind": "rss",
  "tier": "primary",
  "category": "nodejs",
  "enabled": true,
  "weight": 1.4
}
```

**`kind`** — `rss`, `atom`, `github-releases`, `github-search`, `hackernews`.

**`tier`** — this is the important one. It drives fact verification:

| Tier | Meaning | Can it be cited as fact alone? |
|---|---|---|
| `primary` | The project itself (Node.js blog, React blog, GitHub releases) | Yes |
| `reputable` | Established editorial (MDN, web.dev, Smashing) | Yes, hedged |
| `community` | Hacker News, trending repos | **No** — discovery only |

Community sources surface topics but their claims are never asserted unless a
higher tier corroborates them.

**`weight`** — nudges relevance scoring. Around 1.0 is neutral.

Changes take effect on the next `npm run radar`. Sources are synced into the
database by key, so toggling one in the dashboard doesn't get overwritten.

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
| `minTopicScore` | 55 | Score needed to be shortlisted automatically |
| `dailyTopicCount` | 10 | How many topics the daily radar shows |
| `linkedinMinWords` / `MaxWords` | 150 / 300 | LinkedIn length target |
| `mediumMinWords` / `MaxWords` | 1000 / 1800 | Medium length target |
| `minStyleScore` | 85 | Below this, a draft is rewritten |
| `maxStyleRewrites` | 2 | Rewrite attempts before giving you the best one |
| `repeatSimilarityThreshold` | 0.55 | Above this vs. past work, a topic is rejected as a repeat |
| `clusterSimilarityThreshold` | 0.62 | Above this, two items are the same story |
| `lookbackDays` | 21 | How far back items stay eligible |
| `enabledCategories` | `*` | Restrict to specific categories |

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
    style.ts          Style profile, corpus measurement, system prompts
    evaluate.ts       AI-tell detection and the nine-dimension style score
    hooks.ts          Hook pattern selection
    context.ts        Assembles everything a generator needs
    linkedin.ts       LinkedIn generation and the rewrite loop
    medium.ts         Medium generation (two-pass)
    export.ts         Writing drafts to md/json/txt

  reports.ts          Daily and weekly reports, shared by CLI and dashboard
  cli/index.ts        Command parsing and terminal rendering
  server/             Dashboard: api.ts, server.ts, public/
```

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
npm test
```

97 tests using Node's built-in test runner — no test framework dependency.
They cover text utilities, RSS/Atom/GitHub/HN adapter normalisation against
fixture payloads, clustering and repeat detection, scoring (range, determinism,
weight sum, decay behaviour), fact extraction and status rules, AI-tell
detection, style measurement, hook selection, the AI provider wire protocol
against a stub server, HTTP failure messaging (including telling rate limiting
apart from a genuine 403), source liveness checks across every adapter kind, and
full pipeline round trips through an in-memory database.

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

**Prose generation was never run against a real model.** The provider layer is
tested against a stub that speaks the Ollama and OpenAI-compatible wire
protocols, so the request shape, response parsing, and error handling are
verified. Actual output quality from an actual model is not — no model was
reachable during the build. The scaffold path *was* run end to end and works.

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
