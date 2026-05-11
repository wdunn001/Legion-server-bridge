/**
 * Routing helpers — pick the right peer(s) for a given capability.
 *
 * All functions are pure: they take a roster snapshot (the array
 * returned by `Roster.snapshot()` or `useMeshRoster()`) and return a
 * filtered/scored sub-list. No side effects, no async — the actual
 * `tc` dispatch is the caller's job (`peer.sendTool` or one of the
 * fan-out helpers in `./fanOut.ts`).
 *
 * Skill matching supports the dotted hierarchy used by the
 * Layer-4 DNS-style resolver (see `./skillResolver.ts`):
 *
 *   `coding.python.optimize` matches:
 *     - exact: a peer advertising `coding.python.optimize`
 *     - prefix (when `matchPrefixes: true`): a peer advertising
 *       `coding.python` or `coding` (broader → less specific)
 *
 * Hierarchical paths are NOT a wire-protocol concept; they're just
 * strings. Peers that don't use dots get flat-skill behavior.
 */
import type { MeshRosterEntry } from './types.js';

export interface FindPeersOptions {
  /** Skip peers whose cap says `available: false`. Default true. */
  availableOnly?: boolean;
  /** Skip this peerId (typically the caller's own selfId). */
  excludePeerId?: string;
  /**
   * Skill-only: also match peers whose advertised skill is a *prefix*
   * of the query. e.g. `coding.python.optimize` matches a peer
   * advertising `coding.python`. Default false.
   */
  matchPrefixes?: boolean;
}

/** True if `advertised` matches `query` exactly, or is a dotted prefix of it. */
function skillMatches(advertised: string, query: string, allowPrefix: boolean): boolean {
  if (advertised === query) return true;
  if (!allowPrefix) return false;
  return query.startsWith(advertised + '.');
}

/**
 * Find peers that advertise a given skill. `skills[]` (the existing
 * cap field) is treated as the authoritative-leaf list; the Layer-4
 * `authoritative[]` field — when present — is merged in (a peer might
 * have set one and not the other; both are honored).
 */
export function findPeersBySkill(
  roster: readonly MeshRosterEntry[],
  skill: string,
  opts: FindPeersOptions = {},
): MeshRosterEntry[] {
  const availableOnly = opts.availableOnly ?? true;
  const allowPrefix = opts.matchPrefixes ?? false;
  return roster.filter((p) => {
    if (availableOnly && !p.available) return false;
    if (opts.excludePeerId && p.peerId === opts.excludePeerId) return false;
    const authoritative = [
      ...(p.skills ?? []),
      ...((p as MeshRosterEntry & { authoritative?: readonly string[] }).authoritative ?? []),
    ];
    return authoritative.some((s) => skillMatches(s, skill, allowPrefix));
  });
}

/**
 * Find peers that have a named tool in their cap.tools[].
 *
 * Tools are matched by exact name. Mesh-namespaced names (e.g.
 * `mcp:tandem.ac/search`) are matched the same way — pass the full
 * namespaced name in.
 */
export function findPeersByTool(
  roster: readonly MeshRosterEntry[],
  toolName: string,
  opts: FindPeersOptions = {},
): MeshRosterEntry[] {
  const availableOnly = opts.availableOnly ?? true;
  return roster.filter((p) => {
    if (availableOnly && !p.available) return false;
    if (opts.excludePeerId && p.peerId === opts.excludePeerId) return false;
    return p.tools.some((t) => t.name === toolName);
  });
}

/**
 * Find peers running a model in the given codec-maps family.
 * Family is matched by mapping `cap.modelId` through the same regex
 * table mesh-react's `useCodecMapResolver` uses; for portability we
 * accept the family id directly (e.g. `qwen/qwen2`) AND a coarser
 * substring match against the modelId for ad-hoc cases.
 */
export function findPeersByModelFamily(
  roster: readonly MeshRosterEntry[],
  family: string,
  opts: FindPeersOptions = {},
): MeshRosterEntry[] {
  const availableOnly = opts.availableOnly ?? true;
  const fam = family.toLowerCase();
  return roster.filter((p) => {
    if (availableOnly && !p.available) return false;
    if (opts.excludePeerId && p.peerId === opts.excludePeerId) return false;
    const mid = p.modelId.toLowerCase();
    // Direct family-id match via the modelId substring (e.g.
    // `qwen/qwen2` ↔ `Qwen2.5-0.5B-Instruct-q4f16_1-MLC`):
    const famTail = fam.includes('/') ? fam.split('/').pop()! : fam;
    return mid.includes(famTail);
  });
}

/**
 * Find peers advertising a delegating zone that's a prefix of `skill`.
 * Used by the Layer-4 DNS-style resolver: when no peer is authoritative,
 * walk to a delegator. Sorted by zone length descending (longest-prefix
 * wins, exactly like DNS).
 */
export function findDelegatingPeers(
  roster: readonly MeshRosterEntry[],
  skill: string,
  opts: FindPeersOptions = {},
): MeshRosterEntry[] {
  const availableOnly = opts.availableOnly ?? true;
  const matches: Array<{ peer: MeshRosterEntry; zoneLength: number }> = [];
  for (const p of roster) {
    if (availableOnly && !p.available) continue;
    if (opts.excludePeerId && p.peerId === opts.excludePeerId) continue;
    const delegating = (p as MeshRosterEntry & { delegating?: readonly string[] })
      .delegating ?? [];
    for (const zone of delegating) {
      if (skill === zone || skill.startsWith(zone + '.')) {
        matches.push({ peer: p, zoneLength: zone.length });
        break; // one match per peer is enough
      }
    }
  }
  matches.sort((a, b) => b.zoneLength - a.zoneLength);
  return matches.map((m) => m.peer);
}

/**
 * Pick the "best" peer out of a candidate list. Default scoring:
 * freshest `lastSeen` wins (a peer that re-announced their cap
 * recently is more likely to still be online). Returns null on
 * empty input.
 *
 * Pass `scoring` for custom strategies (e.g. prefer specific models,
 * prefer specific nicks, prefer specific networks).
 */
export function pickBestPeer(
  candidates: readonly MeshRosterEntry[],
  scoring?: (p: MeshRosterEntry) => number,
): MeshRosterEntry | null {
  if (candidates.length === 0) return null;
  const score = scoring ?? ((p: MeshRosterEntry) => p.lastSeen);
  let best = candidates[0]!;
  let bestScore = score(best);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const s = score(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}
