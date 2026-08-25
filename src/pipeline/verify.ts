import { sentences, truncate } from '../util/text';
import { detectStability } from './signals';
import type { Fact, SourceTier, StoredItem } from '../types';

/**
 * Fact handling. Two rules, both non-negotiable:
 *
 *  1. Every claim stored here is lifted verbatim from a fetched source and
 *     carries that source's URL. Nothing is generated.
 *  2. A claim is only "verified" when it comes from a primary source or is
 *     corroborated by a second source. Everything else is labelled so the
 *     writer knows not to state it as certain.
 *
 * The writing layer is only ever allowed to assert claims that reached
 * 'verified' or 'single-source' status, and 'single-source' claims must be
 * hedged. See writing/linkedin.ts and writing/medium.ts.
 */

/** Sentences that carry checkable specifics: numbers, versions, dates, percentages. */
const SPECIFIC_RE =
  /(\bv?\d+\.\d+(\.\d+)?\b|\b\d{1,3}\s?%|\b\d{4}\b|\b\d+x\b|\b\d+\s?(ms|kb|mb|gb|seconds?|minutes?)\b|\bstage\s?[1-4]\b|\bcve-\d{4}-\d+\b)/i;

const MAX_CLAIM_LENGTH = 240;
const MAX_FACTS = 8;

export interface VerifyInput {
  topicId: number;
  lead: StoredItem;
  leadTier: SourceTier;
  /** Other items in the same cluster, with their tiers. */
  corroborators: Array<{ item: StoredItem; tier: SourceTier }>;
}

export function extractFacts(input: VerifyInput): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();

  const candidates = sentences(`${input.lead.title}. ${input.lead.summary}`);
  for (const sentence of candidates) {
    if (facts.length >= MAX_FACTS) break;
    if (sentence.length < 20 || sentence.length > MAX_CLAIM_LENGTH * 2) continue;
    if (!SPECIFIC_RE.test(sentence)) continue;

    const claim = truncate(sentence.trim(), MAX_CLAIM_LENGTH);
    const key = claim.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const corroborated = input.corroborators.some(
      (other) => other.item.id !== input.lead.id && mentionsSameSpecifics(sentence, other.item),
    );

    const status: Fact['status'] =
      input.leadTier === 'primary' || corroborated
        ? 'verified'
        : input.leadTier === 'reputable'
          ? 'single-source'
          : 'unverified';

    facts.push({
      topicId: input.topicId,
      claim,
      sourceUrl: input.lead.url,
      sourceTier: input.leadTier,
      status,
      note: buildNote(status, input.leadTier),
    });
  }

  // Stability is a fact about the feature itself and must be stated explicitly
  // whenever it is detectable, so a proposal is never written up as shipped.
  const stability = detectStability(`${input.lead.title} ${input.lead.summary}`);
  if (stability) {
    facts.unshift({
      topicId: input.topicId,
      claim: `Stability as described by the source: ${stability}.`,
      sourceUrl: input.lead.url,
      sourceTier: input.leadTier,
      status: input.leadTier === 'primary' ? 'verified' : 'single-source',
      note:
        input.leadTier === 'primary'
          ? 'Stated by the project itself.'
          : 'Inferred from the wording of a non-primary source. Confirm against the official docs before publishing.',
    });
  }

  return facts.slice(0, MAX_FACTS);
}

function buildNote(status: Fact['status'], tier: SourceTier): string {
  if (status === 'verified') {
    return tier === 'primary'
      ? 'From the project’s own announcement.'
      : 'Corroborated by a second independent source.';
  }
  if (status === 'single-source') {
    return 'Only one non-primary source. Hedge this, or open the primary link and confirm.';
  }
  return 'Not verified yet. Do not state this as fact.';
}

/** Cheap corroboration check: do the same specific tokens appear elsewhere? */
function mentionsSameSpecifics(sentence: string, other: StoredItem): boolean {
  const specifics = sentence.match(new RegExp(SPECIFIC_RE.source, 'gi'));
  if (!specifics || specifics.length === 0) return false;
  const otherText = `${other.title} ${other.summary}`.toLowerCase();
  return specifics.some((specific) => otherText.includes(specific.toLowerCase()));
}

/** Claims the writer may assert. Unverified claims never reach the draft. */
export function assertableFacts(facts: Fact[]): Fact[] {
  return facts.filter((fact) => fact.status !== 'unverified');
}

/** Renders a claim with the hedging its status requires. */
export function renderClaim(fact: Fact): string {
  if (fact.status === 'verified') return fact.claim;
  if (fact.status === 'single-source') return `Reported by one source: ${fact.claim}`;
  return `Not verified yet: ${fact.claim}`;
}
