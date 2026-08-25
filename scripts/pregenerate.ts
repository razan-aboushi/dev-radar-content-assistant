/**
 * Writes drafts ahead of time for the topics most worth writing about.
 *
 * This is what makes the hosted site useful rather than merely readable: the
 * scheduled job runs the radar, pre-writes a LinkedIn post and a Medium
 * article for the top few topics in both languages, and commits them with the
 * snapshot. You open the site and the drafts are already there.
 *
 *   npm run pregenerate -- --count 5 --languages en,ar --kinds linkedin,medium
 *
 * With no model configured it exits cleanly rather than failing the build:
 * the radar is still worth publishing without drafts.
 */
import { getDb, type DB } from '../src/db';
import { getScore, latestContent, listScoredTopics } from '../src/db/repositories';
import { getProvider } from '../src/ai/provider';
import { createLogger } from '../src/logger';
import { buildContext } from '../src/writing/context';
import { CONTENT_LANGUAGES, type ContentLanguage } from '../src/writing/languages';
import { generateLinkedIn } from '../src/writing/linkedin';
import { generateMedium } from '../src/writing/medium';
import { loadProfile } from '../src/writing/style';
import type { ContentKind } from '../src/types';

const log = createLogger('pregenerate');

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const count = Math.max(1, Math.min(20, Number(flag('count', '5')) || 5));
const languages = flag('languages', 'en,ar')
  .split(',')
  .map((value) => value.trim())
  .filter((value): value is ContentLanguage => CONTENT_LANGUAGES.includes(value as ContentLanguage));
const kinds = flag('kinds', 'linkedin,medium')
  .split(',')
  .map((value) => value.trim())
  .filter((value): value is ContentKind => value === 'linkedin' || value === 'medium');

async function main(): Promise<void> {
  const provider = getProvider();
  if (!(await provider.available())) {
    process.stdout.write(
      `No language model reachable (AI_PROVIDER=${process.env.AI_PROVIDER ?? 'none'}).\n` +
        'Skipping pre-generation. The radar and its scores are still published.\n',
    );
    return;
  }

  const db: DB = getDb();
  const topics = listScoredTopics(db, {
    status: 'any',
    sinceDays: 14,
    limit: count * 3,
    sort: 'opportunity',
  })
    .filter((row) => row.topic.status !== 'rejected' && row.topic.status !== 'published')
    .slice(0, count);

  if (topics.length === 0) {
    process.stdout.write('Nothing on the radar to pre-generate for.\n');
    db.close();
    return;
  }

  const profile = loadProfile();
  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of topics) {
    for (const language of languages) {
      for (const kind of kinds) {
        // Never spend a model call regenerating something already published in
        // this language — the scheduled job runs daily and most topics persist.
        const existing = latestContent(db, row.topic.id, kind);
        if (existing && existing.language === language) {
          skipped += 1;
          continue;
        }

        const context = buildContext(
          db,
          row.topic,
          getScore(db, row.topic.id),
          profile,
          undefined,
          language,
        );

        try {
          const result =
            kind === 'linkedin'
              ? await generateLinkedIn(db, context, provider)
              : await generateMedium(db, context, provider);
          written += 1;
          log.info(
            `${kind}/${language} for "${row.topic.slug}" — ${result.content.mode}, style ${result.content.styleScore?.total ?? '—'}`,
          );
        } catch (error) {
          // One bad generation must not abort the whole scheduled run.
          failed += 1;
          log.warn(`${kind}/${language} for "${row.topic.slug}" failed`, error);
        }
      }
    }
  }

  process.stdout.write(
    `Pre-generated ${written} draft(s), skipped ${skipped} already written, ${failed} failed.\n`,
  );
  db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
