import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { renderForPublishing } from './linkedin';
import type { GeneratedContent, Topic } from '../types';

/**
 * Export writes the copy-paste-ready file. The LinkedIn export is deliberately
 * plain text with no markdown, because LinkedIn does not render markdown and
 * pasting it produces literal asterisks.
 */

export type ExportFormat = 'md' | 'json' | 'txt';

export function exportContent(
  content: GeneratedContent,
  topic: Topic,
  format: ExportFormat = 'md',
): string {
  fs.mkdirSync(config.exportDir, { recursive: true });
  const base = content.kind === 'linkedin' ? 'linkedin-post' : 'medium-article';
  const file = path.join(config.exportDir, `${base}-${topic.slug}.${format}`);
  fs.writeFileSync(file, render(content, topic, format), 'utf8');
  return file;
}

function render(content: GeneratedContent, topic: Topic, format: ExportFormat): string {
  if (format === 'json') {
    return `${JSON.stringify({ topic, content }, null, 2)}\n`;
  }

  if (content.kind === 'linkedin') {
    const post = renderForPublishing(content);
    if (format === 'txt') return `${post}\n`;
    return [
      '<!--',
      `Topic: ${topic.title}`,
      `Angle: ${content.angleKind}`,
      `Mode: ${content.mode}${content.mode === 'scaffold' ? ' (outline, not publishable prose)' : ''}`,
      `Style score: ${content.styleScore?.total ?? 'n/a'}`,
      'Sources:',
      ...content.sources.map((url) => `  ${url}`),
      '-->',
      '',
      post,
      '',
    ].join('\n');
  }

  const header =
    format === 'md'
      ? [`# ${content.title}`, '', `*${content.subtitle}*`, ''].join('\n')
      : [content.title, content.subtitle, ''].join('\n');

  return [
    header,
    content.body.trim(),
    '',
    format === 'md' ? '---' : '',
    '',
    'Sources',
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
