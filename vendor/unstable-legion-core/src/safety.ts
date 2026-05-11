/**
 * Safety glue between `@codecai/web-safety` and the mesh.
 *
 * Every outbound text from a peer runs through the prefilter before
 * it gets tokenized and shipped. Hosts plug in additional
 * blocked-action patterns and an optional inbound classifier.
 */
import {
  scanText,
  redactMatches,
  type PrefilterCategory,
  type PrefilterMatch,
  type PrefilterOptions,
} from '@codecai/web-safety';

import type { CodecMsgpackFrame } from './wire.js';

export interface OutboundSafetyOptions extends PrefilterOptions {
  /**
   * What to do when a `dangerous_action` or `blocked_action` match
   * fires. Default: 'block' — caller sees `decision.kind === 'blocked'`
   * and must explicitly pass to send (with redaction) or cancel.
   *
   * 'redact-auto' silently replaces matched spans with
   * `[REDACTED:<rule>]` and proceeds. Use sparingly — silent
   * redaction is confusing to end users and shouldn't be the default.
   */
  policy?: 'block' | 'redact-auto';
}

export type OutboundDecision =
  | {
      kind: 'clean';
      text: string;
      verdict: { source: 'prefilter'; category?: undefined; confidence?: undefined };
    }
  | {
      kind: 'blocked';
      text: string;
      matches: PrefilterMatch[];
      categories: readonly PrefilterCategory[];
    }
  | {
      kind: 'redacted';
      text: string;
      matches: PrefilterMatch[];
      categories: readonly PrefilterCategory[];
    };

/**
 * Run the prefilter against the outbound text. Returns:
 *
 *   - `clean` — nothing fired; text is unchanged, safe to encode + send.
 *   - `blocked` — at least one match. Caller surfaces the matches in a
 *     dialog (redact / send-anyway / cancel) and decides what to do.
 *     `text` is the ORIGINAL, not yet redacted.
 *   - `redacted` — only when `policy: 'redact-auto'`. Text is the
 *     redacted form ready to encode + send. Use with care.
 */
export function prefilterOutbound(
  text: string,
  opts: OutboundSafetyOptions = {},
): OutboundDecision {
  const matches = scanText(text, opts);
  if (matches.length === 0) {
    return { kind: 'clean', text, verdict: { source: 'prefilter' } };
  }
  const categories = uniqueCategories(matches);
  if (opts.policy === 'redact-auto') {
    const { redacted } = redactMatches(text, matches);
    return { kind: 'redacted', text: redacted, matches, categories };
  }
  return { kind: 'blocked', text, matches, categories };
}

/**
 * Apply a redaction after a 'blocked' decision (host called the
 * decision dialog and the user picked "redact + send").
 */
export function applyRedaction(decision: Extract<OutboundDecision, { kind: 'blocked' }>): string {
  return redactMatches(decision.text, decision.matches).redacted;
}

/**
 * Build the optional `safety` block to attach to an outbound Codec
 * frame so the receiver can render a "this was prefilter-clean / -hit"
 * badge without re-running the scan.
 *
 * Receivers MAY trust this for UX badges but SHOULD re-classify
 * inbound text under their own policy — the sender's prefilter ran
 * under the sender's rules, not the receiver's.
 */
export function attachSafetyVerdict(
  frame: CodecMsgpackFrame,
  decision: OutboundDecision,
): CodecMsgpackFrame {
  if (decision.kind === 'clean') {
    return { ...frame, safety: { source: 'prefilter' } };
  }
  // Pick the highest-confidence category from the match set as the
  // headline label. Categories from PrefilterMatch are typed.
  let best: PrefilterMatch | undefined;
  for (const m of decision.matches) {
    if (!best || m.confidence > best.confidence) best = m;
  }
  return {
    ...frame,
    safety: {
      source: 'prefilter',
      category: best?.category,
      confidence: best?.confidence,
    },
  };
}

function uniqueCategories(matches: PrefilterMatch[]): readonly PrefilterCategory[] {
  const seen = new Set<PrefilterCategory>();
  for (const m of matches) seen.add(m.category);
  return [...seen];
}

export type { PrefilterMatch, PrefilterCategory } from '@codecai/web-safety';
