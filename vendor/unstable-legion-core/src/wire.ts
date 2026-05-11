/**
 * Codec wire framing for peer-to-peer streams.
 *
 * Bandwidth context: a Trystero data channel over BitTorrent / IPFS /
 * Nostr / MQTT relays has very limited sustained throughput — often
 * <100 KB/s per peer for the discovery-and-bootstrap relays. A
 * 500-token LLM completion in JSON-SSE is ~75 KB; in Codec msgpack
 * is ~5 KB; in Codec msgpack + dict-zstd is ~500 B. Codec on the
 * wire is the difference between a usable mesh and a constantly-
 * stalling one.
 *
 * Three send/receive paths:
 *
 *  1. **Chat metadata** (`cm`) — JSON, small. Human typed a message.
 *     Codec doesn't help here; the message is bytes, not tokens.
 *  2. **Streaming completion frames** (`cf`) — binary Codec msgpack
 *     frame per generated chunk. The bandwidth-critical path: a
 *     peer's local LLM streams 500 tokens to another peer as
 *     ~500 bytes of compressed frames instead of ~75 KB of
 *     JSON-SSE text.
 *  3. **Tool calls** (`tc`) — JSON, small.
 *
 * Pass-through property: a receiving peer that wants to FORWARD a
 * Codec frame to a third peer doesn't detokenize. The frame bytes
 * traverse the mesh as-is, only detokenized at the edge that needs
 * UTF-8 for human display.
 */
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { Detokenizer, TokenizerMap } from '@codecai/web';

// ── Codec frame shape (matches @codecai/web's `CodecFrame`) ────────────────

/**
 * One Codec msgpack frame as emitted by `@codecai/web`'s
 * `encodeMsgpackFrame` and consumed by `decodeMsgpackStream`.
 * Re-exported here so consumers of `@unstable-legion/core` don't have
 * to import `@codecai/web` directly for the simple
 * binary-payload-on-the-wire path.
 */
export interface CodecMsgpackFrame {
  ids: number[];
  done: boolean;
  finish_reason?: string;
  /** Optional safety verdict from the sending peer's local classifier. */
  safety?: {
    category?: string;
    confidence?: number;
    source: 'prefilter' | 'classifier' | 'clean';
  };
}

// ── Encode / decode ────────────────────────────────────────────────────────

/**
 * Encode a Codec frame to bytes ready for the Trystero `cf` action.
 * The Uint8Array travels the data channel as a binary message — no
 * base64, no JSON wrapping.
 */
export function encodeFrameBytes(frame: CodecMsgpackFrame): Uint8Array {
  return msgpackEncode(frame);
}

/**
 * Decode incoming `cf` bytes from a peer back into a Codec frame.
 * The bytes are typed as `unknown` at the wire boundary; this fn
 * validates the shape.
 */
export function decodeFrameBytes(bytes: unknown): CodecMsgpackFrame | null {
  if (!(bytes instanceof Uint8Array)) return null;
  let raw: unknown;
  try {
    raw = msgpackDecode(bytes);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.ids)) return null;
  if (!r.ids.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)) return null;
  if (typeof r.done !== 'boolean') return null;
  return raw as CodecMsgpackFrame;
}

// ── Detokenize at the edge (only when rendering for a human) ───────────────

/**
 * Convenience helper for a receiving peer that wants the frame rendered
 * as UTF-8 for display. Pass a `Detokenizer` instance bound to the
 * sender's tokenizer map (negotiate the map id via the `cap` block's
 * `modelId` + `@codecai/web`'s `discoverMap` / `loadMap`).
 *
 * For agent-to-agent relay paths, DON'T call this — forward the bytes
 * verbatim. That's the whole point.
 */
export function renderFrameForHuman(
  frame: CodecMsgpackFrame,
  detok: Detokenizer,
  partial: boolean,
): string {
  return detok.render(frame.ids, { partial });
}

// ── Streaming encoder for outbound LLM output ──────────────────────────────

/**
 * Convert a peer's local-LLM output stream into a series of Codec frame
 * bytes. The local LLM emits text (most browser LLM libs surface
 * decoded text, not raw ids); we tokenize on the way out so the wire
 * stays binary.
 *
 * Pass the consumer's chosen `TokenizerMap` (loaded via
 * `@codecai/web`'s `loadMap`). The map id is also broadcast in
 * the sending peer's `cap` so receivers know which detokenizer to
 * build.
 */
export interface OutboundEncoder {
  /**
   * Feed a chunk of text from the LLM stream. Returns the framed bytes
   * to send via Trystero. Caller writes them on the `cf` action.
   */
  feed(text: string, opts: { done: boolean; finishReason?: string }): Uint8Array;
  /** Reset internal partial-utf8 buffer between conversations. */
  reset(): void;
}

export function makeOutboundEncoder(
  tokenize: (text: string) => number[],
): OutboundEncoder {
  return {
    feed(text, opts) {
      const ids = tokenize(text);
      return encodeFrameBytes({
        ids,
        done: opts.done,
        ...(opts.finishReason !== undefined ? { finish_reason: opts.finishReason } : {}),
      });
    },
    reset() {
      // Reserved for future stateful tokenizers; current path is stateless.
    },
  };
}

// ── Inbound stream assembler ───────────────────────────────────────────────

/**
 * Stitch incoming `cf` frames from one peer into a continuous string
 * for display. Calls `onText` per chunk; `onDone` once when the
 * terminal frame arrives.
 *
 * The detokenizer is provided by the caller because it owns the map
 * loading lifecycle (and may share a single detokenizer instance
 * across multiple senders if they share a map).
 */
export interface InboundAssembler {
  /** Push a Codec frame received over the `cf` action. */
  push(frame: CodecMsgpackFrame): void;
  /** Reset partial-utf8 buffer for a new conversation. */
  reset(): void;
}

export interface InboundAssemblerOptions {
  /** Called with the decoded text chunk for each non-empty frame. */
  onText: (chunk: string) => void;
  /** Called once when the terminal frame (`done: true`) arrives. */
  onDone?: (frame: CodecMsgpackFrame) => void;
  /** Called with the frame's safety verdict if present. */
  onSafety?: (verdict: NonNullable<CodecMsgpackFrame['safety']>) => void;
}

export function makeInboundAssembler(
  detok: Detokenizer,
  opts: InboundAssemblerOptions,
): InboundAssembler {
  return {
    push(frame) {
      if (frame.safety && opts.onSafety) opts.onSafety(frame.safety);
      if (frame.ids.length > 0) {
        const chunk = detok.render(frame.ids, { partial: !frame.done });
        if (chunk.length > 0) opts.onText(chunk);
      }
      if (frame.done && opts.onDone) opts.onDone(frame);
    },
    reset() {
      detok.reset();
    },
  };
}

// Re-export the `TokenizerMap` type so consumers don't have to depend on
// `@codecai/web` directly for type annotations.
export type { TokenizerMap, Detokenizer };
