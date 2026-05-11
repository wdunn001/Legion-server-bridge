/**
 * Trystero peer wrapper — joins a Trystero room and exposes the four
 * mesh actions (cap, cm, cf, tc) as typed send/receive methods.
 *
 * Codec frame transport (`cf`) goes over a separate Trystero action
 * with binary payloads — bytes pass through the WebRTC data channel
 * as-is, no JSON wrapping, no base64. That's the bandwidth-critical
 * path for cross-peer LLM streaming.
 */
import { decodeFrameBytes, encodeFrameBytes, type CodecMsgpackFrame } from './wire.js';
import {
  decodeEnvelope,
  encodeEnvelope,
  type WebRtcEnvelope,
} from './webrtc-codec.js';
import {
  isMeshChatMessage,
  isMeshPeerCap,
  isMeshToolFrame,
} from './guards.js';
import { Roster } from './roster.js';
import {
  type MeshChatMessage,
  type MeshPeerCap,
  type MeshToolFrame,
  type MeshRosterEntry,
} from './types.js';

// ── Trystero shape (kept as a structural type so we don't bind to a
//    specific Trystero strategy at build time — joinRoom comes from
//    '@trystero-p2p/mqtt', '@trystero-p2p/nostr', '@trystero-p2p/ipfs',
//    or upstream `trystero/torrent` etc. The consumer picks). ─────────

export interface TrysteroRoom {
  makeAction<T = unknown>(
    name: string,
  ): [
    (payload: T, peers?: string | string[]) => Promise<unknown>,
    (cb: (payload: T, peerId: string) => void) => void,
    (cb: (progress: number, peerId: string) => void) => void,
  ];
  onPeerJoin(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  leave(): void;
}

export type JoinRoomFn = (
  config: Record<string, unknown>,
  roomId: string,
  callbacks?: {
    onJoinError?: (data: { error: string; appId: string; roomId: string }) => void;
  },
) => TrysteroRoom;

// ── Peer options ──────────────────────────────────────────────────────────

export interface PeerOptions {
  /** Trystero `joinRoom` function — caller imports from their chosen strategy. */
  joinRoom: JoinRoomFn;
  /**
   * The Trystero `selfId` for this tab. In `@trystero-p2p/*` 0.24+ this
   * is a module-level export (e.g. `import { selfId } from
   * '@trystero-p2p/mqtt'`), NOT a property of the room. Consumers pass
   * it through so mesh-core can attribute outbound messages without
   * binding to any specific strategy at build time.
   */
  selfId: string;
  /**
   * Trystero strategy config object (appId, optional relayConfig.urls,
   * password, etc.). Shape is per-strategy.
   */
  trysteroConfig: Record<string, unknown>;
  /** Room id (per-room key passed to Trystero). */
  roomId: string;
  /** Initial capability advertisement. */
  cap: MeshPeerCap;
  /** Heartbeat interval (ms) for re-announcing the cap. Default 30_000. */
  heartbeatMs?: number;
}

// ── Peer handle ───────────────────────────────────────────────────────────

export interface Peer {
  selfId: string;
  roster: Roster;
  /** Update local cap and immediately re-broadcast. */
  setCap(cap: MeshPeerCap): void;
  /** Send a chat message; empty `to` = broadcast. */
  sendChat(msg: Omit<MeshChatMessage, 'v' | 'ts' | 'from'>, peers?: string | string[]): Promise<void>;
  /** Subscribe to inbound chat. Unsub fn returned. */
  onChat(cb: (msg: MeshChatMessage, peerId: string) => void): () => void;
  /** Send a Codec frame (binary) to one or more peers. */
  sendFrame(frame: CodecMsgpackFrame, peers?: string | string[]): Promise<void>;
  /** Subscribe to inbound Codec frames. */
  onFrame(cb: (frame: CodecMsgpackFrame, peerId: string) => void): () => void;
  /** Send a raw Codec-over-WebRTC envelope (HELLO / READY / DATA / END). */
  sendEnvelope(env: WebRtcEnvelope, peers?: string | string[]): Promise<void>;
  /** Subscribe to inbound envelopes — wraps the same `cf` action. */
  onEnvelope(cb: (env: WebRtcEnvelope, peerId: string) => void): () => void;
  /** Send a tool-call or tool-result. */
  sendTool(frame: MeshToolFrame, peers?: string | string[]): Promise<void>;
  /** Subscribe to inbound tool frames. */
  onTool(cb: (frame: MeshToolFrame, peerId: string) => void): () => void;
  /** Leave the room and stop the heartbeat. */
  leave(): void;
}

// ── joinMesh ──────────────────────────────────────────────────────────────

/**
 * Connect to a Trystero room with the four mesh actions wired up.
 * Returns the `Peer` handle the consumer interacts with.
 *
 * Action mapping:
 *
 *   cap  →  MeshPeerCap (JSON, small; broadcast on join + heartbeat)
 *   cm   →  MeshChatMessage (JSON; small chat metadata + body)
 *   cf   →  Uint8Array — either a raw Codec msgpack frame OR a full
 *           WebRtcEnvelope-encoded message. Receivers try
 *           `decodeEnvelope` first; on miss, fall back to
 *           `decodeFrameBytes` for backward-compat with pre-envelope
 *           peers. New peers should always emit envelopes.
 *   tc   →  MeshToolFrame ({kind: 'call' | 'result'})
 */
export function joinMesh(opts: PeerOptions): Peer {
  const { joinRoom, selfId, trysteroConfig, roomId, cap: initialCap } = opts;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;

  const room = joinRoom(trysteroConfig, roomId, {
    onJoinError: (d) => {
      // eslint-disable-next-line no-console
      console.error('[legion-mesh] joinRoom error:', d);
    },
  });
  const roster = new Roster();
  let currentCap: MeshPeerCap = initialCap;

  // ── Actions ──────────────────────────────────────────────────────────
  const [sendCap, onCap] = room.makeAction<MeshPeerCap>('cap');
  const [sendChat, onChat] = room.makeAction<MeshChatMessage>('cm');
  const [sendFrameBytes, onFrameBytes] = room.makeAction<Uint8Array>('cf');
  const [sendTool, onTool] = room.makeAction<MeshToolFrame>('tc');

  // ── Local listener registries ────────────────────────────────────────
  const chatListeners = new Set<(msg: MeshChatMessage, peerId: string) => void>();
  const frameListeners = new Set<(frame: CodecMsgpackFrame, peerId: string) => void>();
  const envelopeListeners = new Set<(env: WebRtcEnvelope, peerId: string) => void>();
  const toolListeners = new Set<(frame: MeshToolFrame, peerId: string) => void>();

  // ── Debug logging — ON by default while we diagnose roster /
  //    chat-doesn't-work reports. To silence:
  //      window.__legion_debug = false
  //    To re-enable mid-session:
  //      window.__legion_debug = true
  //    (Default true; explicit false silences. We'll flip the default
  //    once mesh is stable.)
  const debug = (...args: unknown[]): void => {
    try {
      const flag = (globalThis as { __legion_debug?: unknown }).__legion_debug;
      if (flag === false) return;
      // eslint-disable-next-line no-console
      console.info('[legion-mesh]', ...args);
    } catch {
      /* ignore */
    }
  };

  // ── Inbound wiring ───────────────────────────────────────────────────
  onCap((raw, peerId) => {
    if (!isMeshPeerCap(raw)) {
      debug('cap REJECTED from', peerId, '— guard failed; raw:', raw);
      return;
    }
    debug('cap RECEIVED from', peerId, '· nick=', raw.nick, '· tools=', raw.tools.length);
    roster.upsert(peerId, raw);
  });

  onChat((raw, peerId) => {
    debug('chat RECEIVED from', peerId, '· text=', (raw as { text?: string })?.text);
    if (!isMeshChatMessage(raw)) {
      debug('chat REJECTED — guard failed; raw:', raw);
      return;
    }
    for (const cb of chatListeners) cb(raw, peerId);
  });

  onFrameBytes((raw, peerId) => {
    // Try envelope decode first (new format), fall back to bare-frame decode.
    const env = decodeEnvelope(raw);
    if (env) {
      for (const cb of envelopeListeners) cb(env, peerId);
      // If the envelope carries a DATA payload that's also a raw frame,
      // also surface it on the frame listener for backward-compat
      // consumers.
      if (env.k === 2 && env.b instanceof Uint8Array) {
        const frame = decodeFrameBytes(env.b);
        if (frame) {
          for (const cb of frameListeners) cb(frame, peerId);
        }
      }
      return;
    }
    // Pre-envelope peer: bare msgpack frame.
    const frame = decodeFrameBytes(raw);
    if (!frame) return;
    for (const cb of frameListeners) cb(frame, peerId);
  });

  onTool((raw, peerId) => {
    if (!isMeshToolFrame(raw)) return;
    for (const cb of toolListeners) cb(raw, peerId);
  });

  // ── Peer join/leave: cap broadcast + roster prune ────────────────────
  room.onPeerJoin((peerId) => {
    debug('peer JOINED', peerId, '— sending our cap');
    void sendCap(currentCap, peerId);
  });
  room.onPeerLeave((peerId) => {
    debug('peer LEFT', peerId);
    roster.remove(peerId);
  });

  // ── Self in roster ───────────────────────────────────────────────────
  // Trystero's makeAction sender doesn't echo back to the local
  // receiver — sending our cap only reaches REMOTE peers. So we'd
  // never see ourselves in our own roster, which means our own tools
  // never show up in the aggregated public-tools list either. Mirror
  // leet's pattern: upsert self locally whenever we broadcast our cap.
  const upsertSelf = (): void => {
    roster.upsert(selfId, currentCap);
  };
  upsertSelf();

  // ── Initial + heartbeat cap broadcast ────────────────────────────────
  debug('joined room', roomId, '· selfId=', selfId, '· nick=', currentCap.nick);
  void sendCap(currentCap);
  const heartbeat: ReturnType<typeof setInterval> | null =
    typeof setInterval !== 'undefined'
      ? setInterval(() => {
          currentCap = { ...currentCap, ts: Date.now() };
          debug('heartbeat cap broadcast');
          void sendCap(currentCap);
          upsertSelf();
        }, heartbeatMs)
      : null;

  // ── Public API ───────────────────────────────────────────────────────
  return {
    selfId,
    roster,
    setCap(next) {
      currentCap = { ...next, ts: Date.now() };
      void sendCap(currentCap);
      upsertSelf();
    },
    async sendChat(partial, peers) {
      const msg: MeshChatMessage = {
        v: 1 as const,
        ts: Date.now(),
        from: selfId,
        ...partial,
      };
      await sendChat(msg, peers);
    },
    onChat(cb) {
      chatListeners.add(cb);
      return () => chatListeners.delete(cb);
    },
    async sendFrame(frame, peers) {
      const bytes = encodeFrameBytes(frame);
      await sendFrameBytes(bytes, peers);
    },
    onFrame(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    async sendEnvelope(env, peers) {
      const bytes = encodeEnvelope(env);
      await sendFrameBytes(bytes, peers);
    },
    onEnvelope(cb) {
      envelopeListeners.add(cb);
      return () => envelopeListeners.delete(cb);
    },
    async sendTool(frame, peers) {
      await sendTool(frame, peers);
    },
    onTool(cb) {
      toolListeners.add(cb);
      return () => toolListeners.delete(cb);
    },
    leave() {
      if (heartbeat) clearInterval(heartbeat);
      roster.dispose();
      room.leave();
    },
  };
}

export type { MeshChatMessage, MeshPeerCap, MeshRosterEntry, MeshToolFrame };
