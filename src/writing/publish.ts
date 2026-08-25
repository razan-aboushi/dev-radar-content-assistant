import { wordCount } from '../util/text';
import type { GeneratedContent } from '../types';

/**
 * The single definition of "the finished piece".
 *
 * Everything that hands a draft to a human — the dashboard's copy button, the
 * `<pre>` it renders, the CLI's stdout and the file exporter — goes through
 * here, so what you read on screen is byte-for-byte what lands on your
 * clipboard and in `out/`.
 *
 * The dashboard used to copy `content.body` for a Medium draft while rendering
 * the title and subtitle above it as separate elements, so pasting an article
 * silently dropped its headline.
 *
 * LinkedIn is plain text: LinkedIn's composer renders no markdown, and pasting
 * `**bold**` produces literal asterisks. Medium is canonical markdown, which is
 * how the body is already stored and what Medium's importer understands.
 */
export function renderPublishText(content: GeneratedContent): string {
  return content.kind === 'linkedin' ? renderLinkedIn(content) : renderMedium(content);
}

function renderLinkedIn(content: GeneratedContent): string {
  const parts = [content.body.trim()];
  if (content.hashtags.length > 0) parts.push(content.hashtags.join(' '));
  return parts.join('\n\n');
}

function renderMedium(content: GeneratedContent): string {
  const parts: string[] = [];
  if (content.title.trim()) parts.push(`# ${content.title.trim()}`);
  if (content.subtitle.trim()) parts.push(`## ${content.subtitle.trim()}`);
  parts.push(content.body.trim());
  return parts.join('\n\n');
}

/** Words in the finished piece, hashtags excluded. Shown next to every draft. */
export function publishWordCount(content: GeneratedContent): number {
  return content.kind === 'linkedin'
    ? wordCount(content.body)
    : wordCount(renderMedium(content));
}
