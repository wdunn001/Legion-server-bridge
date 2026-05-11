/**
 * Headless Trystero peer for Node.
 *
 * Wraps `@unstable-legion/core`'s `joinMesh` with the Node WebRTC
 * polyfill setup needed for Trystero to function outside a browser.
 *
 * Why this isn't just direct `joinMesh`: Trystero's MQTT strategy
 * needs `RTCPeerConnection` + `RTCDataChannel` available globally,
 * which Node doesn't ship. `node-datachannel/polyfill` registers
 * libdatachannel-backed implementations on `globalThis` and that's
 * all Trystero needs.
 *
 * Consumer pattern:
 *
 *   import { joinRoom, selfId } from '@trystero-p2p/mqtt';
 *   import { joinServerMesh } from '@unstable-legion/server-bridge/peer';
 *
 *   const peer = await joinServerMesh({
 *     joinRoom, selfId,
 *     trysteroConfig: { appId: 'my-app', relayConfig: { urls: [...] } },
 *     roomId: 'my-room',
 *     cap: { v: 1, nick: 'sglang-gateway', modelId: '...', ... },
 *   });
 */
import {
  joinMesh,
  type Peer,
  type PeerOptions,
} from '@unstable-legion/core';

/** Has the WebRTC polyfill been installed? Idempotent. */
let polyfillInstalled = false;

/**
 * Install Trystero's required globals (`RTCPeerConnection`, etc.) via
 * `node-datachannel/polyfill`. Idempotent — safe to call multiple
 * times. Throws if `node-datachannel` isn't installed.
 *
 * node-datachannel's polyfill module EXPORTS the classes but doesn't
 * always auto-assign them to `globalThis` (varies by version). We
 * read the named exports and set the globals explicitly so Trystero's
 * `new RTCPeerConnection(...)` finds them.
 */
export async function installWebRtcPolyfill(): Promise<void> {
  if (polyfillInstalled) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import('node-datachannel/polyfill')) as any;
  const g = globalThis as Record<string, unknown>;
  const names = [
    'RTCPeerConnection',
    'RTCDataChannel',
    'RTCSessionDescription',
    'RTCIceCandidate',
    'RTCCertificate',
    'RTCSctpTransport',
    'RTCDtlsTransport',
    'RTCIceTransport',
  ];
  for (const name of names) {
    const exported = mod[name] ?? mod.default?.[name];
    if (exported && g[name] === undefined) {
      g[name] = exported;
    }
  }
  // Some polyfills also expose a `polyfillWebRTC()` helper — call it
  // if present, for any auto-wiring it does beyond the named classes.
  if (typeof mod.polyfillWebRTC === 'function') {
    try {
      mod.polyfillWebRTC();
    } catch {
      /* best-effort */
    }
  }
  if (typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection !== 'function') {
    throw new Error(
      'node-datachannel polyfill loaded but RTCPeerConnection is not on globalThis. Check node-datachannel version (^0.27 expected).',
    );
  }
  polyfillInstalled = true;
}

export interface ServerMeshOptions extends PeerOptions {
  /**
   * Skip the WebRTC polyfill install (caller manages it themselves,
   * or is running on a platform that already exposes the globals).
   */
  skipPolyfill?: boolean;
}

/**
 * Join a Trystero room from Node. Returns the same `Peer` shape the
 * browser-side `joinMesh` does, ready to wire tool registrations,
 * chat handlers, and Codec frame senders.
 */
export async function joinServerMesh(opts: ServerMeshOptions): Promise<Peer> {
  if (!opts.skipPolyfill) {
    await installWebRtcPolyfill();
  }
  // Strip the local extension before forwarding to mesh-core's joinMesh,
  // which doesn't know about `skipPolyfill`.
  const { skipPolyfill: _, ...meshOpts } = opts;
  void _;
  return joinMesh(meshOpts);
}
