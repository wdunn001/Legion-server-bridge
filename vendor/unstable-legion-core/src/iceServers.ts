/**
 * TURN config helper for Trystero — strategy-agnostic.
 *
 * Trystero's default ICE servers are public STUN only. STUN suffices
 * when at least one peer is reachable on its srflx (server-reflexive)
 * candidate, but it fails when both peers sit behind symmetric NAT —
 * common in residential ISP CGNAT, mobile carrier networks, and
 * corporate firewalls. The cure is TURN: a publicly-reachable relay
 * the WebRTC stack falls back to when direct paths fail.
 *
 * This helper returns a `turnConfig`-ready list (Trystero appends it
 * to the strategy's default STUN servers — see `BaseRoomConfig`).
 *
 * Pass via the Trystero config:
 *
 *   trysteroConfig: {
 *     appId,
 *     relayConfig: { urls: relayUrls },
 *     turnConfig: defaultTurnConfig(),
 *   }
 *
 * Production: self-host coturn and pass `extras` (or replace defaults
 * via `useDefault: false`). Long-credential TURN URLs are sensitive
 * — don't commit them. Use env / build-time injection.
 */

/** A single ICE server entry as accepted by RTCConfiguration. */
export interface IceServerEntry {
  urls: string | readonly string[];
  username?: string;
  credential?: string;
}

export interface DefaultTurnConfigOptions {
  /**
   * Operator-supplied TURN entries — the primary way to configure
   * TURN. Use this for self-hosted coturn or paid TURN.
   */
  extras?: readonly IceServerEntry[];
  /**
   * Include the bundled OpenRelay public TURN credentials. **Off by
   * default** — OpenRelay's TLS endpoint is now ECONNREFUSED and the
   * historical `openrelayproject` credentials appear deprecated.
   * Handing dead TURN URLs to the WebRTC stack actively breaks ICE
   * gathering even for the same-LAN happy path. Opt back in only if
   * you've verified OpenRelay is reachable from both sides.
   */
  useDefault?: boolean;
}

/**
 * OpenRelay (Metered.ca) public free TURN. Widely used in WebRTC
 * demos / hobby projects. Three transports (UDP/TCP on 80, TCP on
 * 443) so it traverses most firewalls. Throughput is limited and
 * Metered may rate-limit aggressive use — replace with self-hosted
 * coturn for any real workload.
 *
 * Docs: https://www.metered.ca/tools/openrelay/
 */
const OPENRELAY_TURN: readonly IceServerEntry[] = [
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

/**
 * Build a `turnConfig` array suitable for `joinRoom({ turnConfig })`.
 * Trystero appends this to its default STUN servers.
 *
 * Returns `[]` by default (STUN-only behavior) — callers pass
 * `extras` for self-hosted coturn or set `useDefault: true` to opt
 * back into the bundled OpenRelay entries.
 */
export function defaultTurnConfig(opts: DefaultTurnConfigOptions = {}): IceServerEntry[] {
  const useDefault = opts.useDefault === true;
  const out: IceServerEntry[] = [];
  for (const e of opts.extras ?? []) out.push(e);
  if (useDefault) {
    for (const e of OPENRELAY_TURN) out.push(e);
  }
  return out;
}
