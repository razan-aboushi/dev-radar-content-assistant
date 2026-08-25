import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { languagePack } from './languages';
import { renderPublishText } from './publish';
import type { GeneratedContent, Topic } from '../types';

/**
 * Export writes the copy-paste-ready file. The LinkedIn export is deliberately
 * plain text with no markdown, because LinkedIn does not render markdown and
 * pasting it produces literal asterisks.
 *
 * The body of every export comes from renderPublishText, so a file on disk and
 * the dashboard's clipboard hold exactly the same characters. Files are written
 * as UTF-8 explicitly, which is what keeps Arabic and emoji intact.
 */

export type ExportFormat = 'md' | 'json' | 'txt';

export function exportContent(
  content: GeneratedContent,
  topic: Topic,
  format: ExportFormat = 'md',
): string {
  fs.mkdirSync(config.exportDir, { recursive: true });
  const base = content.kind === 'linkedin' ? 'linkedin-post' : 'medium-article';
  // Arabic and English drafts of the same topic are different pieces, so they
  // get different filenames instead of one silently overwriting the other.
  const suffix = content.language === 'ar' ? '-ar' : '';
  const file = path.join(config.exportDir, `${base}-${topic.slug}${suffix}.${format}`);
  fs.writeFileSync(file, render(content, topic, format), 'utf8');
  return file;
}

function render(content: GeneratedContent, topic: Topic, format: ExportFormat): string {
  if (format === 'json') {
    return `${JSON.stringify({ topic, content, publishText: renderPublishText(content) }, null, 2)}\n`;
  }

  const publishText = renderPublishText(content);

  if (content.kind === 'linkedin') {
    if (format === 'txt') return `${publishText}\n`;
    return [
      '<!--',
      `Topic: ${topic.title}`,
      `Angle: ${content.angleKind}`,
      `Language: ${languagePack(content.language).englishName}`,
      `Mode: ${content.mode}${content.mode === 'scaffold' ? ' (outline, not publishable prose)' : ''}`,
      `Style score: ${content.styleScore?.total ?? 'n/a'}`,
      'Sources:',
      ...content.sources.map((url) => `  ${url}`),
      '-->',
      '',
      publishText,
      '',
    ].join('\n');
  }

  // publishText is markdown. For .txt the headings are flattened so the file
  // reads as prose rather than as source.
  const article = format === 'md' ? publishText : publishText.replace(/^#{1,6}\s+/gm, '');

  return [
    article,
    '',
    format === 'md' ? '---' : '',
    '',
    languagePack(content.language).scaffold.articleSources,
    ...content.sources.map((url) => (format === 'md' ? `- ${url}` : `  ${url}`)),
    '',
  ].join('\n');
}

/** Writes the daily brief as markdown for archiving. */
export function exportDaily(markdown: string, date = new Date()): string {
  fs.mkdirSync(config.exportDir, { recursive: true });
  const stamp = date.toISOString().slice(0, 10);
  const file = path.join(config.exportDir, `daily-radar-${stamp}.md`);
  fs.writeFileSync(file, markdown, 'utf8');
  return file;
}
