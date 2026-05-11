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
 */
export async function installWebRtcPolyfill(): Promise<void> {
  if (polyfillInstalled) return;
  // Dynamic import so consumers building for the browser don't pay
  // the cost — and so a missing native binary throws a clear error.
  await import('node-datachannel/polyfill');
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
