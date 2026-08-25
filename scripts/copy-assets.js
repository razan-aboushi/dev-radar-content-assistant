/* Copies non-TypeScript assets into dist so the built output can run standalone. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pairs = [
  ['src/db/schema.sql', 'dist/src/db/schema.sql'],
  ['src/server/public', 'dist/src/server/public'],
];

for (const [from, to] of pairs) {
  const source = path.join(root, from);
  const target = path.join(root, to);
  if (!fs.existsSync(source)) continue;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}
