/**
 * Codec-over-WebRTC — adaptation of the Codec binary transport protocol
 * for browser-to-browser WebRTC data channels.
 *
 * ## Why
 *
 * Codec proper is defined over HTTP streaming responses
 * (spec/PROTOCOL.md) — Accept-Encoding for compression negotiation,
 * Content-Type for format selection, body chunks as the framing
 * envelope. WebRTC data channels have none of that:
 *
 *   - no HTTP headers (no Accept-Encoding, no Content-Type)
 *   - message-oriented (each `send()` is one discrete message,
 *     not a continuous byte stream)
 *   - per-message MTU around 64 KB on most implementations
 *   - one channel = one stream, so multiplexing concurrent
 *     conversations needs an in-band stream-id concept
 *   - back-pressure via `bufferedAmount`, not HTTP/2 flow control
 *
 * This module adapts Codec's wire format (msgpack frames of token
 * IDs) to that environment without altering the on-wire frame shape
 * `@codecai/web` already encodes/decodes. A Codec frame produced by
 * a sglang/vLLM/llama.cpp container is byte-identical to one
 * produced by a peer's local LLM and forwarded across the mesh — a
 * relay can pass it through without detokenization, exactly as in
 * the HTTP case.
 *
 * ## Envelope
 *
 * Every message on the WebRTC data channel is a tagged-union
 * msgpack-encoded object:
 *
 *   {
 *     k: 0 | 1 | 2 | 3,      // kind: hello / ready / data / end
 *     s: string,             // stream id (ULID-shaped)
 *     n: number,             // monotonic seq within the stream
 *     b: Uint8Array | object // body (Uint8Array for data, JSON for others)
 *   }
 *
 * Kinds:
 *   - `0 = hello` — initiator opens a stream. Body: capabilities.
 *   - `1 = ready` — responder accepts (or aborts). Body: chosen format
 *                    + map id.
 *   - `2 = data`  — Codec msgpack frame (the `@codecai/web` CodecMsgpackFrame
 *                    shape). Body bytes pass through `@codecai/web`'s
 *                    `decodeMsgpackStream` after stripping the envelope.
 *   - `3 = end`   — sender done with the stream. Body: finish_reason,
 *                    final stats.
 *
 * ## Chunking
 *
 * If a Codec data frame exceeds 60 KB (leaving headroom for the
 * envelope + the WebRTC implementation's MTU), the sender splits it
 * into N data messages with `n = base, base+1, ..., base+N-1` and
 * sets a final `end` after the last data chunk. Receivers concatenate
 * by `seq` within `streamId`. Most token-stream payloads are far
 * under MTU; chunking matters mainly for the bulk-token-id prompt
 * upload case.
 *
 * ## Compression
 *
 * WebRTC has no `Content-Encoding`; compression is per-message and
 * negotiated in the `hello`/`ready` exchange. If both peers
 * advertise `zstd`, the `data` body is zstd-compressed (peer-side
 * pre-trained dict supported). Default is identity. Optional
 * compression is the bandwidth-critical bit: a 500-token completion
 * is ~5 KB without compression, ~500 B with zstd. On a BitTorrent
 * relay with sustained 50 KB/s budget that's the difference between
 * 10× and 100× concurrent streams.
 *
 * ## Reliability + ordering
 *
 * Streams are reliable + ordered (Trystero default; can be tuned).
 * Lost messages are caller-detectable via gaps in `n` but the data
 * channel itself doesn't drop in reliable mode.
 *
 * ## Multiplexing
 *
 * One `data-channel = one TCP-like pipe`. Multiple concurrent streams
 * between the same two peers interleave via `streamId`. Each
 * conversation gets its own ULID at the `hello` step; data messages
 * carry it through.
 */
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

import type { CodecMsgpackFrame } from './wire.js';

// ── Envelope kinds ─────────────────────────────────────────────────────────

export const ENVELOPE_KIND = {
  HELLO: 0,
  READY: 1,
  DATA: 2,
  END: 3,
} as const;
export type EnvelopeKind = (typeof ENVELOPE_KIND)[keyof typeof ENVELOPE_KIND];

// ── HELLO ──────────────────────────────────────────────────────────────────

/**
 * Sent by the stream initiator. Mirrors Codec proper's HELLO except
 * the optional fields specific to HTTP (e.g. `Accept-Encoding` is
 * folded into `accept_compression` here since there's no HTTP header
 * channel).
 */
export interface WebRtcHello {
  /** Protocol-version axis, mirrors HTTP-Codec's spec/PROTOCOL.md HELLO. */
  codec_version: 1;
  /** Per-stream tokenizer map id (sender's view; receiver may reject). */
  map_id?: string;
  /** Sender accepts which msgpack-frame compressors. Default: ['identity']. */
  accept_compression: readonly ('identity' | 'gzip' | 'zstd' | 'dict-zstd')[];
  /**
   * Sender's safety-policy stance — mirrors v0.4 safety-policy
   * negotiation. `*` = "any policy is fine, just tell me what you're
   * enforcing"; specific id = "only proceed if you can enforce one of
   * these".
   */
  accept_safety_policies: readonly string[];
  /** Free-form hint for the responder. */
  intent?: 'chat' | 'tool' | 'forward';
}

// ── READY ──────────────────────────────────────────────────────────────────

export interface WebRtcReady {
  codec_version: 1;
  /** Responder's chosen compression (one of HELLO's accept list). */
  compression: 'identity' | 'gzip' | 'zstd' | 'dict-zstd';
  /** Responder's chosen tokenizer map id (responder's local model). */
  map_id: string;
  /** Negotiated safety policy id (or `null` if responder enforces none). */
  safety_policy_id: string | null;
  /** sha256 of the canonical sanitized descriptor. Null when policy_id null. */
  safety_policy_hash: string | null;
  /**
   * Optional zstd dictionary content-hash, when `compression: 'dict-zstd'`.
   * Receivers fetch the dict bytes out-of-band (or panic if unknown).
   */
  zstd_dict_sha256?: string;
}

// ── END ────────────────────────────────────────────────────────────────────

export interface WebRtcEnd {
  codec_version: 1;
  finish_reason: 'stop' | 'length' | 'policy_violation' | 'error' | 'cancel';
  /** Optional human-readable reason for `error` / `policy_violation`. */
  detail?: string;
  /** Total token count emitted across all `data` messages in this stream. */
  total_tokens?: number;
}

// ── Envelope ───────────────────────────────────────────────────────────────

export interface WebRtcEnvelope {
  k: EnvelopeKind;
  s: string;
  n: number;
  /**
   * For `k: DATA`, this is the msgpack-encoded `CodecMsgpackFrame`
   * bytes (post-compression if negotiated). For other kinds, the
   * decoded JSON object per the kind's interface.
   */
  b: Uint8Array | WebRtcHello | WebRtcReady | WebRtcEnd;
}

// ── Envelope encode / decode ───────────────────────────────────────────────

/** Encode one envelope to wire bytes ready for `RTCDataChannel.send`. */
export function encodeEnvelope(env: WebRtcEnvelope): Uint8Array {
  return msgpackEncode(env);
}

/** Decode incoming bytes from the data channel. Returns null on malformed. */
export function decodeEnvelope(bytes: unknown): WebRtcEnvelope | null {
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) return null;
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let raw: unknown;
  try {
    raw = msgpackDecode(buf);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.k !== 'number' || typeof r.s !== 'string' || typeof r.n !== 'number') {
    return null;
  }
  if (r.k !== 0 && r.k !== 1 && r.k !== 2 && r.k !== 3) return null;
  return r as unknown as WebRtcEnvelope;
}

// ── Helpers per envelope kind ──────────────────────────────────────────────

export function makeHelloEnvelope(streamId: string, body: WebRtcHello): WebRtcEnvelope {
  return { k: ENVELOPE_KIND.HELLO, s: streamId, n: 0, b: body };
}

export function makeReadyEnvelope(streamId: string, body: WebRtcReady): WebRtcEnvelope {
  return { k: ENVELOPE_KIND.READY, s: streamId, n: 1, b: body };
}

export function makeEndEnvelope(streamId: string, seq: number, body: WebRtcEnd): WebRtcEnvelope {
  return { k: ENVELOPE_KIND.END, s: streamId, n: seq, b: body };
}

export function makeDataEnvelope(streamId: string, seq: number, frameBytes: Uint8Array): WebRtcEnvelope {
  return { k: ENVELOPE_KIND.DATA, s: streamId, n: seq, b: frameBytes };
}

// ── MTU + chunking ─────────────────────────────────────────────────────────

/** WebRTC's safe per-message size; trying for 60 KB leaves room for the envelope. */
export const WEBRTC_MTU_BYTES = 60 * 1024;

/**
 * Chunk a Codec msgpack frame payload that exceeds MTU into multiple
 * `data` envelopes. Most token-stream payloads are far under MTU (a
 * 500-token frame is ~5 KB); chunking matters mainly for prompt-upload
 * paths where a peer ships a long pre-tokenized history at once.
 *
 * Returns each chunk's bytes ready for `RTCDataChannel.send`.
 * Receivers concatenate `b` payloads by `s, n` until an `end` arrives.
 */
export function chunkFrameForWire(
  streamId: string,
  startSeq: number,
  frameBytes: Uint8Array,
): { bytes: Uint8Array; nextSeq: number } {
  // Frame fits in a single message (the common path).
  if (frameBytes.length <= WEBRTC_MTU_BYTES) {
    const env = makeDataEnvelope(streamId, startSeq, frameBytes);
    return { bytes: encodeEnvelope(env), nextSeq: startSeq + 1 };
  }
  // Multi-message chunking — caller should iterate and `send()` each
  // returned envelope rather than expect this single function to
  // produce an array. We return the first chunk + the next seq; the
  // helper below is the iterator form.
  return chunkFrameIter(streamId, startSeq, frameBytes).next().value as {
    bytes: Uint8Array;
    nextSeq: number;
  };
}

/**
 * Iterator form: yields one chunked-envelope's bytes at a time. Most
 * callers want this so the back-pressure path can pause between
 * `send()` calls based on `bufferedAmount`.
 */
export function* chunkFrameIter(
  streamId: string,
  startSeq: number,
  frameBytes: Uint8Array,
): Generator<{ bytes: Uint8Array; nextSeq: number }> {
  if (frameBytes.length <= WEBRTC_MTU_BYTES) {
    const env = makeDataEnvelope(streamId, startSeq, frameBytes);
    yield { bytes: encodeEnvelope(env), nextSeq: startSeq + 1 };
    return;
  }
  let offset = 0;
  let seq = startSeq;
  while (offset < frameBytes.length) {
    const slice = frameBytes.subarray(offset, Math.min(offset + WEBRTC_MTU_BYTES, frameBytes.length));
    const env = makeDataEnvelope(streamId, seq, slice);
    yield { bytes: encodeEnvelope(env), nextSeq: seq + 1 };
    offset += slice.length;
    seq += 1;
  }
}

// ── Inbound reassembler ────────────────────────────────────────────────────

/**
 * One per (peer, streamId) tuple. Collects DATA envelopes by seq order
 * and surfaces complete Codec frames to the consumer.
 *
 * Since RTCDataChannel reliable+ordered mode preserves order, the
 * reassembler trusts the seq sequence. Holes mean a peer lost the
 * stream (channel torn down mid-message) — surface as a torn-stream
 * event for the caller to abandon.
 */
export interface Reassembler {
  /** Push one incoming envelope. */
  push(env: WebRtcEnvelope): void;
  /** Inspect whether the stream has seen its `end`. */
  ended(): boolean;
  /** Final reason (post-`end`). */
  finishReason(): WebRtcEnd['finish_reason'] | null;
}

export interface ReassemblerOptions {
  /**
   * Receive callback for each fully-assembled Codec frame (one
   * `data` envelope, or N concatenated chunks). The caller hands
   * this to its `Detokenizer` or forwards verbatim to another peer.
   */
  onFrame: (frame: CodecMsgpackFrame) => void;
  /** Receive callback for the `end` envelope. */
  onEnd?: (end: WebRtcEnd) => void;
  /** Called when a seq hole is detected — caller SHOULD abandon the stream. */
  onTorn?: (info: { expectedSeq: number; gotSeq: number }) => void;
}

export function makeReassembler(opts: ReassemblerOptions): Reassembler {
  let nextSeq = 2; // 0 = hello, 1 = ready, so data starts at 2
  let chunkBuffer: Uint8Array[] = [];
  let endRecord: WebRtcEnd | null = null;
  let isEnded = false;

  return {
    push(env) {
      if (env.k === ENVELOPE_KIND.DATA) {
        if (env.n !== nextSeq && opts.onTorn) {
          opts.onTorn({ expectedSeq: nextSeq, gotSeq: env.n });
        }
        nextSeq = env.n + 1;
        if (env.b instanceof Uint8Array) {
          chunkBuffer.push(env.b);
        }
      } else if (env.k === ENVELOPE_KIND.END) {
        // Flush whatever accumulated data we have as a final frame.
        if (chunkBuffer.length > 0) {
          const full = concatUint8Arrays(chunkBuffer);
          chunkBuffer = [];
          const frame = msgpackDecode(full) as CodecMsgpackFrame;
          opts.onFrame(frame);
        }
        endRecord = env.b as WebRtcEnd;
        isEnded = true;
        if (opts.onEnd) opts.onEnd(endRecord);
        return;
      }
      // If we just received a complete single-message DATA envelope
      // (which is the common case), surface it immediately.
      if (env.k === ENVELOPE_KIND.DATA && chunkBuffer.length === 1) {
        const bytes = chunkBuffer[0]!;
        // If the next expected env is END (we don't know yet), keep the
        // single-message-decode happy: try to decode now. If decode
        // fails, the chunk was actually a prefix and we'll wait for more.
        try {
          const frame = msgpackDecode(bytes) as CodecMsgpackFrame;
          chunkBuffer = [];
          opts.onFrame(frame);
        } catch {
          // Multi-message chunk; wait for more data envelopes.
        }
      }
    },
    ended() {
      return isEnded;
    },
    finishReason() {
      return endRecord?.finish_reason ?? null;
    },
  };
}

function concatUint8Arrays(arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ── Stream id ──────────────────────────────────────────────────────────────

/**
 * Generate a ULID-shaped stream id. Stable across browsers — uses
 * `crypto.randomUUID` underneath where available, falls back to
 * `Math.random` runs on insecure-origin contexts. UUIDv4 is fine for
 * uniqueness within a single mesh-room session.
 */
export function newStreamId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for legacy contexts. Not cryptographically strong, fine here.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
