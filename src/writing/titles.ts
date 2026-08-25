import type { AngleKind, Language } from '../types';

/**
 * Article headlines.
 *
 * Written by the tool rather than the model, so they are stable, reviewable
 * and the same whether a draft is produced by the CLI, the scheduled job or
 * the browser. That last one is why this lives in its own module: medium.ts
 * and prompts.ts both need it and neither can import the other.
 */

/**
 * Prepares a subject for use inside a title template.
 *
 * subjectOf() caps at 70 characters and appends an ellipsis when it cuts, and
 * a headline that resists reduction comes back nearly whole. Dropping a
 * template on the end of that produced titles like
 *
 *   "Anthropic's best AI model struggles to attract users as cheaper tools…:
 *    explained properly"
 *
 * — an ellipsis in the middle of a sentence, and far too long to be a
 * headline. So the ellipsis goes, and the phrase is cut back to a clause on a
 * word boundary.
 */
export function titleSubject(subject: string, max = 52): string {
  let text = subject.replace(/\s*[…]+\s*$/, '').replace(/[.,;:!?\s]+$/, '').trim();
  if (text.length <= max) return text;

  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  text = (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
  return text.replace(/[.,;:!?\-–—]+$/, '').trim();
}

export function articleTitleFor(subject: string, angle: AngleKind, language: Language): string {
  const name = titleSubject(subject);
  const arabic = language === 'ar';
  switch (angle) {
    case 'opinion':
      return arabic ? `هل نحتاج ${name} فعلاً؟` : `Do we actually need ${name}?`;
    case 'educational':
      return arabic ? `${name}: شرح كما يجب` : `${name}, explained properly`;
    default:
      return arabic
        ? `ما الذي يغيّره ${name} في تطبيق إنتاجي حقيقي`
        : `What ${name} changes in a real production app`;
  }
}

export function articleSubtitleFor(angle: AngleKind, language: Language): string {
  const arabic = language === 'ar';
  switch (angle) {
    case 'opinion':
      return arabic
        ? 'نظرة على ما يحلّه، وما يكلّفه، ومتى يكون الخيار الخاطئ.'
        : 'A look at what it solves, what it costs, and when it is the wrong call.';
    case 'educational':
      return arabic
        ? 'ما هو، وكيف يعمل، والأجزاء التي يقفز عنها التوثيق.'
        : 'What it is, how it works, and the parts the docs skip past.';
    default:
      return arabic
        ? 'الأجزاء التي لا تظهر إلا بعد أن يصطدم بها تحميل حقيقي.'
        : 'The parts that only show up once real traffic hits it.';
  }
}
