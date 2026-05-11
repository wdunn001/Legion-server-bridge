/**
 * Trystero relay URL merge — strategy-agnostic.
 *
 * Trystero's MQTT / Nostr / IPFS strategies each ship a default broker
 * list as a runtime export. This helper merges those defaults with
 * operator-supplied extras, deduplicates, drops a configurable list of
 * blocked hostnames, and caps the total count.
 *
 * Mesh-core deliberately doesn't import the strategy module — the
 * caller passes `defaults` in. That keeps `@unstable-legion/core` free
 * of `@trystero-p2p/mqtt` (or any other strategy) as a hard dep.
 *
 * Example:
 *
 *   import { defaultRelayUrls } from '@trystero-p2p/mqtt';
 *   import { mergeRelayUrls } from '@unstable-legion/core';
 *
 *   const relays = mergeRelayUrls({
 *     defaults: defaultRelayUrls,
 *     extras: [],
 *     blockedHosts: ['test.mosquitto.org', 'broker-cn.emqx.io'],
 *     max: 6,
 *   });
 */

export interface MergeRelayUrlsOptions {
  /** Strategy's default relay list (e.g. `defaultRelayUrls` from a Trystero strategy). */
  defaults: readonly string[];
  /** Operator-supplied extra relays — prepended before defaults. */
  extras?: readonly string[];
  /** Hostnames to drop (matched against `URL(...).hostname`, lowercased). */
  blockedHosts?: readonly string[];
  /** Hard cap on the returned list size. Default 6. */
  max?: number;
}

function isBlocked(url: string, blocked: Set<string>): boolean {
  try {
    return blocked.has(new URL(url).hostname.toLowerCase());
  } catch {
    // Malformed URLs are treated as blocked — they'd just fail at connect time.
    return true;
  }
}

export function mergeRelayUrls(opts: MergeRelayUrlsOptions): string[] {
  const blocked = new Set((opts.blockedHosts ?? []).map((h) => h.toLowerCase()));
  const max = opts.max ?? 6;
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: string) => {
    if (!u || seen.has(u) || isBlocked(u, blocked)) return;
    seen.add(u);
    out.push(u);
  };
  for (const u of opts.extras ?? []) push(u);
  for (const u of opts.defaults) push(u);
  return out.slice(0, max);
}
