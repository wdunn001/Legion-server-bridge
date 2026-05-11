/**
 * Multi-peer fan-out helpers.
 *
 * Built on top of `PendingToolCallTracker` from `./tools.js` — same
 * call-id correlation, same timeout semantics, just batched across
 * multiple targets. Each helper sends `tc` `kind: 'call'` frames out
 * concurrently and awaits the matching `kind: 'result'` echoes; the
 * receiver (mesh-react's `useMeshTools` or the consumer's own
 * `peer.onTool` handler) is responsible for `tracker.settle(result)`
 * on inbound `kind: 'result'`.
 */
import { PendingToolCallTracker, newCallId } from './tools.js';
import type {
  MeshToolCall,
  MeshToolResult,
  MeshToolFrame,
} from './types.js';
import type { Peer } from './peer.js';

export interface FanOutOptions {
  /** Per-peer timeout (ms). Default 30_000. */
  timeoutMs?: number;
  /**
   * If true, the first error rejects the whole batch and aborts
   * pending awaits. Default false (collect all results, including
   * errors, into the returned array).
   */
  failFast?: boolean;
}

export interface FanOutEntry {
  peerId: string;
  /** Either a settled MeshToolResult or an Error if dispatch/await failed. */
  result: MeshToolResult | Error;
}

/**
 * Internal: wire a tracker to the peer's `onTool` so we can pump
 * results into pending promises. Returns an unsubscribe fn the caller
 * MUST invoke when done — otherwise the tracker leaks the listener.
 */
function attachTrackerToPeer(
  peer: Peer,
  tracker: PendingToolCallTracker,
): () => void {
  return peer.onTool((frame: MeshToolFrame) => {
    if (frame.kind === 'result') {
      tracker.settle(frame);
    }
  });
}

/**
 * Send the same tool call to every peer in `peerIds` and await all
 * results (or per-peer timeouts). The returned array is in the same
 * order as `peerIds`. Each entry is either a `MeshToolResult` (any
 * status) or an `Error` (transport / timeout).
 */
export async function callToolFanOut(
  peer: Peer,
  peerIds: readonly string[],
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  opts: FanOutOptions = {},
): Promise<readonly FanOutEntry[]> {
  if (peerIds.length === 0) return [];
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const tracker = new PendingToolCallTracker();
  const detach = attachTrackerToPeer(peer, tracker);

  try {
    const promises = peerIds.map(async (peerId): Promise<FanOutEntry> => {
      const callId = newCallId();
      const waiter = tracker.expect(callId, timeoutMs);
      const call: MeshToolCall = {
        v: 1 as const,
        ts: Date.now(),
        callId,
        toolName,
        args,
      };
      try {
        await peer.sendTool({ kind: 'call', ...call }, peerId);
        const result = await waiter;
        return { peerId, result };
      } catch (err) {
        return { peerId, result: err instanceof Error ? err : new Error(String(err)) };
      }
    });

    if (opts.failFast) {
      const settled = await Promise.race([
        Promise.all(promises),
        (async (): Promise<readonly FanOutEntry[]> => {
          // Reject as soon as any one rejects (in the entry sense — Error).
          // Promise.race with the original promises doesn't reject because
          // each promise resolves with Error; instead, watch for the first
          // entry whose `result` is an Error.
          const first = await Promise.any(
            promises.map(async (p) => {
              const entry = await p;
              if (entry.result instanceof Error) return entry.result;
              throw new Error('not-an-error'); // makes Promise.any keep waiting
            }),
          ).catch(() => null);
          if (first instanceof Error) throw first;
          return [];
        })(),
      ]);
      return settled;
    }
    return await Promise.all(promises);
  } finally {
    detach();
    tracker.abortAll('fan-out done');
  }
}

/**
 * Send the same prompt to N peers running `engine_run`, then aggregate
 * the text responses. Failing peers are dropped from the input to
 * `aggregator` and surfaced in the `failures` array.
 */
export async function ensemble<T = string>(
  peer: Peer,
  peerIds: readonly string[],
  prompt: string,
  aggregator: (responses: readonly string[]) => T | Promise<T>,
  opts: FanOutOptions = {},
): Promise<{ result: T; samples: readonly string[]; failures: readonly Error[] }> {
  const fanned = await callToolFanOut(
    peer,
    peerIds,
    'engine_run',
    { user: prompt },
    opts,
  );
  const samples: string[] = [];
  const failures: Error[] = [];
  for (const entry of fanned) {
    if (entry.result instanceof Error) {
      failures.push(entry.result);
      continue;
    }
    if (entry.result.status !== 'ok') {
      failures.push(new Error(`peer ${entry.peerId}: ${entry.result.error ?? 'unknown'}`));
      continue;
    }
    const content =
      (entry.result.result as { content?: unknown } | undefined)?.content ??
      entry.result.result;
    const text =
      typeof content === 'string'
        ? content
        : typeof (content as { text?: unknown } | undefined)?.text === 'string'
          ? ((content as { text: string }).text)
          : JSON.stringify(content);
    samples.push(text);
  }
  const result = await aggregator(samples);
  return { result, samples, failures };
}

export interface MapReduceMapTool<I> {
  name: string;
  argsFor: (item: I, index: number) => Readonly<Record<string, unknown>>;
}

/**
 * Split `items` across `peerIds` (round-robin), call `mapTool` on each
 * with `argsFor(item)`, and reduce the per-item results into a single
 * value via `reducer`. Failing items propagate as `Error` in the
 * mapped array — the reducer can decide how to handle them.
 *
 * Useful for "summarize each of these N URLs" / "transcribe each
 * audio chunk in parallel across the mesh" style workloads.
 */
export async function mapReduce<I, M, R>(
  peer: Peer,
  peerIds: readonly string[],
  items: readonly I[],
  mapTool: MapReduceMapTool<I>,
  reducer: (mapped: ReadonlyArray<M | Error>) => R | Promise<R>,
  opts: FanOutOptions = {},
): Promise<R> {
  if (peerIds.length === 0) throw new Error('mapReduce: no peers');
  if (items.length === 0) return await reducer([]);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const tracker = new PendingToolCallTracker();
  const detach = attachTrackerToPeer(peer, tracker);
  try {
    const promises = items.map(async (item, index): Promise<M | Error> => {
      const peerId = peerIds[index % peerIds.length]!;
      const callId = newCallId();
      const waiter = tracker.expect(callId, timeoutMs);
      const call: MeshToolCall = {
        v: 1 as const,
        ts: Date.now(),
        callId,
        toolName: mapTool.name,
        args: mapTool.argsFor(item, index),
      };
      try {
        await peer.sendTool({ kind: 'call', ...call }, peerId);
        const r = await waiter;
        if (r.status !== 'ok') {
          return new Error(`peer ${peerId}: ${r.error ?? 'unknown'}`);
        }
        const content =
          (r.result as { content?: unknown } | undefined)?.content ?? r.result;
        return content as M;
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    });
    const mapped = await Promise.all(promises);
    return await reducer(mapped);
  } finally {
    detach();
    tracker.abortAll('mapReduce done');
  }
}
