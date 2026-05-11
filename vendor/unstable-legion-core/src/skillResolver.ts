/**
 * DNS-style hierarchical skill resolver.
 *
 * Resolution strategy for a query like `coding.python.optimize`:
 *
 *   1. Find an AUTHORITATIVE peer matching the query exactly. If
 *      found, pick the freshest and call its `engine_run` (or a
 *      named tool, if the skill is itself a tool name).
 *   2. If none, find an authoritative peer whose advertised skill
 *      is a dotted PREFIX of the query (`coding.python` covers
 *      `coding.python.optimize`). Pick the most specific (longest
 *      prefix) and call it.
 *   3. If none, find a DELEGATING peer whose zone is a prefix of
 *      the query (`coding` covers `coding.python.optimize`). Pick
 *      longest-prefix and ask it to resolve via its `route_skill`
 *      tool. The delegator runs ITS OWN resolver on ITS roster and
 *      returns the final result up the chain — recursion happens
 *      at each level, not in the asker.
 *   4. If nothing matches → error result.
 *
 * Loop / amplification guards:
 *   - Per-call `_hops` counter, bounded by `maxDepth` (default 4)
 *   - `_originPeerId` carried through to prevent A → B → A loops
 *   - Per-skill cache (TTL-bounded) so repeated queries skip the walk
 */
import {
  findDelegatingPeers,
  findPeersBySkill,
  pickBestPeer,
} from './routing.js';
import {
  PendingToolCallTracker,
  newCallId,
} from './tools.js';
import type {
  MeshRosterEntry,
  MeshToolCall,
  MeshToolFrame,
  MeshToolResult,
} from './types.js';
import type { Peer } from './peer.js';

export interface SkillResolveOptions {
  /** Hard cap on tree depth. Default 4. */
  maxDepth?: number;
  /** Per-hop timeout (ms). Default 30_000. */
  timeoutMs?: number;
  /**
   * When the resolved peer should be called: usually `engine_run` (a
   * generic LLM call), but a caller can override to invoke a named
   * tool with structured args. Default: `engine_run` with `{user: <args.user>}`.
   */
  toolName?: string;
}

/**
 * Reserved arg keys used for loop guards. Resolver injects these
 * automatically; callers don't set them.
 */
export const RESOLVER_HOPS_KEY = '_hops' as const;
export const RESOLVER_ORIGIN_KEY = '_originPeerId' as const;
export const RESOLVER_SKILL_KEY = '_resolvedSkill' as const;

/**
 * Per-mesh-peer skill-resolution cache. Maps `skill → { peerId,
 * resolvedVia, expiresAt }`. Cache is updated on each successful
 * resolution; entries expire on TTL or when the cached peer leaves
 * the room (caller invalidates via `invalidate(peerId)`).
 */
export class SkillCache {
  private entries = new Map<
    string,
    { peerId: string; resolvedVia: 'authoritative' | 'delegating'; expiresAt: number }
  >();
  /** Default TTL: 60s. Caller can bump per-entry on set(). */
  constructor(public readonly defaultTtlMs = 60_000) {}

  get(skill: string): { peerId: string; resolvedVia: 'authoritative' | 'delegating' } | null {
    const e = this.entries.get(skill);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) {
      this.entries.delete(skill);
      return null;
    }
    return { peerId: e.peerId, resolvedVia: e.resolvedVia };
  }

  set(
    skill: string,
    peerId: string,
    resolvedVia: 'authoritative' | 'delegating',
    ttlMs: number = this.defaultTtlMs,
  ): void {
    this.entries.set(skill, { peerId, resolvedVia, expiresAt: Date.now() + ttlMs });
  }

  /** Drop all entries pointing at a peer that just left. */
  invalidatePeer(peerId: string): void {
    for (const [skill, entry] of this.entries) {
      if (entry.peerId === peerId) this.entries.delete(skill);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Send a tool call to `peerId` over the local `peer` and await the
 * matching `kind: 'result'` echo. Internal — used by both leaf
 * dispatch and `route_skill` delegation.
 */
async function sendAndAwait(
  peer: Peer,
  peerId: string,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  timeoutMs: number,
): Promise<MeshToolResult> {
  const tracker = new PendingToolCallTracker();
  const unsub = peer.onTool((frame: MeshToolFrame) => {
    if (frame.kind === 'result') tracker.settle(frame);
  });
  try {
    const callId = newCallId();
    const waiter = tracker.expect(callId, timeoutMs);
    const call: MeshToolCall = {
      v: 1 as const,
      ts: Date.now(),
      callId,
      toolName,
      args,
    };
    await peer.sendTool({ kind: 'call', ...call }, peerId);
    return await waiter;
  } finally {
    unsub();
    tracker.abortAll('sendAndAwait done');
  }
}

export interface RouteBySkillContext {
  peer: Peer;
  /** Current roster snapshot (caller passes; resolver doesn't subscribe). */
  roster: readonly MeshRosterEntry[];
  /** Optional cache (one per peer; reuse across calls for cache benefit). */
  cache?: SkillCache;
}

/**
 * Resolve a skill query against the mesh and return the result of
 * invoking it. See file header for algorithm.
 */
export async function routeBySkill(
  ctx: RouteBySkillContext,
  skill: string,
  args: Readonly<Record<string, unknown>>,
  opts: SkillResolveOptions = {},
): Promise<MeshToolResult> {
  const maxDepth = opts.maxDepth ?? 4;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const toolName = opts.toolName ?? 'engine_run';

  const hops = typeof args[RESOLVER_HOPS_KEY] === 'number' ? (args[RESOLVER_HOPS_KEY] as number) : 0;
  if (hops >= maxDepth) {
    return {
      v: 1 as const,
      ts: Date.now(),
      callId: 'noop',
      status: 'error',
      error: `resolver hop limit reached (maxDepth=${maxDepth})`,
    };
  }

  const originPeerId =
    typeof args[RESOLVER_ORIGIN_KEY] === 'string'
      ? (args[RESOLVER_ORIGIN_KEY] as string)
      : ctx.peer.selfId;

  // Cache hit short-circuit (only authoritative entries — delegating
  // hits would skip the recursion which we want to keep dynamic).
  const cached = ctx.cache?.get(skill);
  if (cached?.resolvedVia === 'authoritative') {
    const stripped = stripResolverKeys(args);
    return sendAndAwait(ctx.peer, cached.peerId, toolName, stripped, timeoutMs);
  }

  // Step 1: authoritative exact match.
  let candidates = findPeersBySkill(ctx.roster, skill, {
    excludePeerId: originPeerId === ctx.peer.selfId ? ctx.peer.selfId : undefined,
  });
  if (candidates.length === 0) {
    // Step 2: authoritative prefix match.
    candidates = findPeersBySkill(ctx.roster, skill, {
      matchPrefixes: true,
      excludePeerId: originPeerId === ctx.peer.selfId ? ctx.peer.selfId : undefined,
    });
  }

  if (candidates.length > 0) {
    const chosen = pickBestPeer(candidates)!;
    const stripped = stripResolverKeys(args);
    const result = await sendAndAwait(ctx.peer, chosen.peerId, toolName, stripped, timeoutMs);
    if (result.status === 'ok') {
      ctx.cache?.set(skill, chosen.peerId, 'authoritative');
    }
    return result;
  }

  // Step 3: delegating peer (DNS NS-record style).
  const delegators = findDelegatingPeers(ctx.roster, skill, {
    excludePeerId: originPeerId,
  });
  if (delegators.length > 0) {
    const chosen = delegators[0]!; // already sorted longest-prefix-first
    // Call the delegator's `route_skill` tool with bumped hop count.
    // The delegator runs its OWN resolver and returns the final result.
    const result = await sendAndAwait(
      ctx.peer,
      chosen.peerId,
      'route_skill',
      {
        skill,
        args: stripResolverKeys(args),
        [RESOLVER_HOPS_KEY]: hops + 1,
        [RESOLVER_ORIGIN_KEY]: originPeerId,
      },
      timeoutMs,
    );
    if (result.status === 'ok') {
      ctx.cache?.set(skill, chosen.peerId, 'delegating');
    }
    return result;
  }

  return {
    v: 1 as const,
    ts: Date.now(),
    callId: 'noop',
    status: 'error',
    error: `no authority for skill "${skill}"`,
  };
}

function stripResolverKeys(
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (
    !(RESOLVER_HOPS_KEY in args) &&
    !(RESOLVER_ORIGIN_KEY in args) &&
    !(RESOLVER_SKILL_KEY in args)
  ) {
    return args;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === RESOLVER_HOPS_KEY) continue;
    if (k === RESOLVER_ORIGIN_KEY) continue;
    if (k === RESOLVER_SKILL_KEY) continue;
    out[k] = v;
  }
  return out;
}
