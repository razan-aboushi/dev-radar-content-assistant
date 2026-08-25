/**
 * Assembles the static site that GitHub Pages serves.
 *
 *   site/
 *     index.html, app.js, styles.css, clipboard.js, i18n/   (copied verbatim)
 *     data/*.json                                            (the snapshot)
 *     .nojekyll                                              (see below)
 *
 * The dashboard files are the same ones the local server serves. There is no
 * separate build of the UI and no framework — the client asks the data layer
 * for topics, and the data layer reads either the live API or these files.
 *
 *   npm run site
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import { getDb } from '../src/db';
import { buildSnapshot } from '../src/snapshot';

const siteDir = path.join(config.root, 'site');
const publicDir = path.join(config.root, 'src/server/public');

fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(siteDir, { recursive: true });
fs.cpSync(publicDir, siteDir, { recursive: true });

/**
 * Without this, GitHub Pages runs the output through Jekyll, which silently
 * drops any file or directory whose name starts with an underscore.
 */
fs.writeFileSync(path.join(siteDir, '.nojekyll'), '', 'utf8');

const db = getDb();
const manifest = buildSnapshot(db, { outDir: path.join(siteDir, 'data') });
db.close();

/**
 * A marker file, not a code change: the same app.js runs locally and on Pages,
 * and looks for this to decide whether a backend exists. Shipping one bundle
 * for both is what keeps the two from drifting apart.
 */
fs.writeFileSync(
  path.join(siteDir, 'data', 'mode.json'),
  `${JSON.stringify({ mode: 'static' })}\n`,
  'utf8',
);

const files = countFiles(siteDir);
process.stdout.write(
  `Static site written to ${siteDir.replace(config.root, '.')}\n` +
    `  ${manifest.topicCount} topic(s), ${manifest.draftCount} ready draft(s), ${files} file(s)\n` +
    `  Preview it with:  npx serve site\n`,
);

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return total;
}
