/**
 * Aggregators for ensemble responses.
 *
 * Each aggregator takes an array of N response strings (from N peers
 * running the same prompt through `engine_run`) and returns a single
 * combined value. Plug into `ensemble(..., aggregator)`.
 *
 * `majorityVote` and `concatJoin` are pure / sync. `llmSummarize`
 * delegates the synthesis itself to another peer (typically a strong
 * model) — so the ensemble is "N specialists draft, 1 director
 * synthesizes" rather than "blind concatenation".
 */
import type { Peer } from './peer.js';
import { newCallId, PendingToolCallTracker } from './tools.js';
import type { MeshToolCall, MeshToolFrame } from './types.js';

/**
 * Pick the response that's most common (string-equality on trimmed
 * lower-cased form). Useful for short-answer ensembles (single-word,
 * single-sentence). Falls back to the first sample on ties — caller
 * may pre-sort if they want a different tiebreak.
 */
export function majorityVote(responses: readonly string[]): string {
  if (responses.length === 0) return '';
  const counts = new Map<string, { canonical: string; count: number; firstIndex: number }>();
  responses.forEach((raw, i) => {
    const key = raw.trim().toLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { canonical: raw, count: 1, firstIndex: i });
    }
  });
  let bestKey = '';
  let bestCount = -1;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const [key, info] of counts) {
    if (info.count > bestCount || (info.count === bestCount && info.firstIndex < bestIndex)) {
      bestKey = key;
      bestCount = info.count;
      bestIndex = info.firstIndex;
    }
  }
  return counts.get(bestKey)!.canonical;
}

/**
 * Join responses with a separator. Useful when the ensemble is "give
 * me variations" and the consumer wants to surface all of them.
 */
export function concatJoin(separator = '\n\n— — —\n\n'): (responses: readonly string[]) => string {
  return (responses) => responses.join(separator);
}

/**
 * Ask one peer (the "director" / synthesizer) to combine the
 * ensemble's responses into a single answer. The synthesizer should
 * have a model good at instruction-following — Hermes / Mistral /
 * Phi-3.5 are reasonable picks.
 *
 * The prompt template is intentionally minimal — consumers can pass
 * their own via `promptTemplate`.
 */
export interface LlmSummarizeOptions {
  /**
   * Custom prompt builder. Default: a numbered list of responses with
   * a request to consolidate.
   */
  promptTemplate?: (responses: readonly string[]) => string;
  /** Per-call timeout (ms). Default 30_000. */
  timeoutMs?: number;
}

export function llmSummarize(
  peer: Peer,
  viaPeerId: string,
  opts: LlmSummarizeOptions = {},
): (responses: readonly string[]) => Promise<string> {
  return async (responses) => {
    if (responses.length === 0) return '';
    if (responses.length === 1) return responses[0]!;
    const buildPrompt =
      opts.promptTemplate ??
      ((rs) =>
        `You are a synthesizer. Several specialists answered the same question. Combine their answers into one consolidated, accurate response. If they disagree, prefer the most coherent + best-supported. Output only the consolidated answer, no preamble.\n\n${rs
          .map((r, i) => `Answer ${i + 1}:\n${r}`)
          .join('\n\n---\n\n')}`);
    const prompt = buildPrompt(responses);

    const tracker = new PendingToolCallTracker();
    const unsub = peer.onTool((frame: MeshToolFrame) => {
      if (frame.kind === 'result') tracker.settle(frame);
    });
    try {
      const callId = newCallId();
      const waiter = tracker.expect(callId, opts.timeoutMs ?? 30_000);
      const call: MeshToolCall = {
        v: 1 as const,
        ts: Date.now(),
        callId,
        toolName: 'engine_run',
        args: { user: prompt },
      };
      await peer.sendTool({ kind: 'call', ...call }, viaPeerId);
      const result = await waiter;
      if (result.status !== 'ok') {
        throw new Error(`synthesizer ${viaPeerId}: ${result.error ?? 'unknown'}`);
      }
      const content =
        (result.result as { content?: unknown } | undefined)?.content ?? result.result;
      if (typeof content === 'string') return content;
      const text = (content as { text?: unknown } | undefined)?.text;
      if (typeof text === 'string') return text;
      return JSON.stringify(content);
    } finally {
      unsub();
      tracker.abortAll('llmSummarize done');
    }
  };
}
