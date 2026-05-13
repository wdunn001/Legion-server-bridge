/**
 * Codec HTTP → mesh bridge.
 *
 * Registers an `engine_run` tool on a `Peer` that, when called by a
 * mesh peer, proxies the prompt to a Codec-aware HTTP server (sglang,
 * vLLM, or llama.cpp running the wdunn001 Codec patches) and streams
 * the resulting Codec msgpack frames back to the caller via
 * `peer.sendFrame`.
 *
 * The HTTP server is expected to:
 *   - accept POST `<baseUrl>/v1/completions` with OpenAI-shaped body
 *   - honor `stream_format: "msgpack"` to emit length-prefix-less
 *     msgpack frames in the response body
 *
 * That's the contract the wdunn001/{sglang,vllm,llama.cpp} forks ship.
 * Upstream OpenAI-compatible JSON-SSE servers are NOT supported by
 * this bridge — use those by pointing a different bridge at them and
 * paying the detokenize tax.
 *
 * The bridge does NO detokenization on the server side. The Codec
 * frames pass through verbatim from HTTP body → `peer.sendFrame`,
 * preserving the wire-binary property end-to-end. The asking peer
 * detokenizes at the edge.
 */
import {
  decode as msgpackDecode,
} from '@msgpack/msgpack';
import type {
  CodecMsgpackFrame,
  MeshToolCall,
  Peer,
  ToolRegistry,
} from '@unstable-legion/core';

export interface CodecHttpBridgeOptions {
  /** The local mesh peer this bridge attaches its tool to. */
  peer: Peer;
  /**
   * The peer's tool registry. The bridge registers `engine_run` here.
   * The operator must also include `'engine_run'` in `optedIn` so the
   * dispatcher will execute the tool (see `useMeshTools.optedIn`).
   */
  registry: ToolRegistry;
  /**
   * Codec-aware HTTP server base URL, e.g. `http://localhost:30000`
   * for a local sglang. The bridge appends `/v1/completions`.
   */
  baseUrl: string;
  /**
   * Model id the HTTP server expects in the completions request body.
   * For sglang+vLLM this is the loaded model name (e.g.
   * `Qwen/Qwen2.5-7B-Instruct`).
   */
  modelId: string;
  /**
   * Default sampling parameters layered under whatever the asker
   * passes in the `engine_run` args. Args win on conflict.
   */
  defaults?: {
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
  };
}

interface CodecCompletionsBody {
  model: string;
  prompt: string;
  stream: true;
  stream_format: 'msgpack';
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  // system prompts in OpenAI's /v1/completions live in `prompt` —
  // the bridge concatenates: `<system>\n\n<user>`.
}

/**
 * Wire `engine_run` on this peer to proxy to the HTTP Codec server.
 * Returns a `dispose()` function that unregisters the tool.
 */
export function createCodecHttpBridge(opts: CodecHttpBridgeOptions): () => void {
  const { peer, registry, baseUrl, modelId, defaults } = opts;
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/completions`;

  registry.register({
    descriptor: {
      name: 'engine_run',
      description: `Forward a (system, user) prompt to ${modelId} via the Codec-HTTP server at ${baseUrl}. Returns raw token IDs in Codec frames.`,
      inputSchema: {
        type: 'object',
        required: ['user'],
        properties: {
          system: {
            type: 'string',
            description: 'Optional system prompt prepended to the user content.',
          },
          user: { type: 'string', description: 'User prompt content.' },
          max_tokens: { type: 'integer', minimum: 1, maximum: 4096 },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          top_p: { type: 'number', minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
    validate: (args) => {
      if (typeof args.user !== 'string' || !args.user) return 'user must be a non-empty string';
      if (args.system !== undefined && typeof args.system !== 'string') return 'system must be a string';
      return null;
    },
    handler: async (args) => {
      const result = await streamCodecHttp({
        endpoint,
        modelId,
        peer,
        args,
        defaults,
      });
      return { content: result };
    },
  });

  // Distributed-/ai responder. Two cases match the browser-side
  // MeshChatPanel logic exactly:
  //
  //   1. Directed (`msg.to === peer.selfId`) — the sender wrote
  //      `/ai @<our-nick> ...` and Trystero unicast it to us. Always
  //      respond, regardless of whether the sender has its own LLM.
  //   2. Broadcast (`msg.to === ''`) — only respond when the sender's
  //      cap is unavailable (they'd have run it themselves otherwise).
  //
  // The bridge strips a leading `@<nick> ` from the prompt so the
  // upstream Codec server isn't asked to literally talk to itself.
  const unsubChat = peer.onChat((msg, peerId) => {
    if (peerId === peer.selfId) return;
    if (msg.bodyKind !== 'text' || typeof msg.text !== 'string') return;
    if (!msg.text.startsWith('/ai ')) return;
    const directed = msg.to === peer.selfId;
    if (!directed) {
      const senderCap = peer.roster.get(peerId);
      if (senderCap?.available) return;
    }
    let prompt = msg.text.slice(4).trim();
    const atMatch = /^@\S+\s+(.*)$/s.exec(prompt);
    if (atMatch) prompt = atMatch[1]!;
    if (!prompt) return;
    void streamCodecHttp({
      endpoint,
      modelId,
      peer,
      args: { user: prompt },
      defaults,
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      void peer.sendChat({
        to: '',
        bodyKind: 'text',
        text: `[/ai bridge error] ${errMsg}`,
      });
    });
  });

  return () => {
    registry.unregister('engine_run');
    unsubChat();
  };
}

/**
 * Stream frames from the Codec HTTP server and forward each one to
 * the asking peer. Resolves once the terminal frame arrives.
 */
async function streamCodecHttp(opts: {
  endpoint: string;
  modelId: string;
  peer: Peer;
  args: Readonly<Record<string, unknown>>;
  defaults?: CodecHttpBridgeOptions['defaults'];
}): Promise<{ totalFrames: number; totalTokens: number; finish_reason?: string }> {
  const { endpoint, modelId, peer, args, defaults } = opts;
  const user = args.user as string;
  const system = (args.system as string | undefined) ?? '';
  const prompt = system ? `${system}\n\n${user}` : user;

  const body: CodecCompletionsBody = {
    model: modelId,
    prompt,
    stream: true,
    stream_format: 'msgpack',
    max_tokens: (args.max_tokens as number | undefined) ?? defaults?.max_tokens,
    temperature: (args.temperature as number | undefined) ?? defaults?.temperature,
    top_p: (args.top_p as number | undefined) ?? defaults?.top_p,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(
      `Codec HTTP ${res.status} ${res.statusText} — endpoint ${endpoint} did not return a streaming body`,
    );
  }

  const reader = res.body.getReader();
  let buffer = new Uint8Array(0);
  let totalFrames = 0;
  let totalTokens = 0;
  let finish_reason: string | undefined;

  // Codec msgpack streams are NOT length-prefixed at the protocol
  // layer — each msgpack object is self-delimiting. We accumulate
  // bytes and call `msgpackDecode` until it consumes a full frame,
  // then trim the consumed prefix. With @msgpack/msgpack v3 we can
  // use a Decoder for proper streaming; for the bridge's simplicity
  // here we do greedy try-decode-then-trim.
  for (;;) {
    const { value, done } = await reader.read();
    if (value && value.byteLength > 0) {
      const next = new Uint8Array(buffer.byteLength + value.byteLength);
      next.set(buffer, 0);
      next.set(value, buffer.byteLength);
      buffer = next;

      // Try to drain as many frames as the buffer holds.
      for (;;) {
        const dec = tryDecodeOne(buffer);
        if (!dec) break;
        buffer = buffer.subarray(dec.consumed);
        const frame = dec.frame;
        await peer.sendFrame(frame);
        totalFrames += 1;
        totalTokens += frame.ids?.length ?? 0;
        if (frame.done) {
          finish_reason = frame.finish_reason ?? 'stop';
        }
      }
    }
    if (done) break;
  }

  return { totalFrames, totalTokens, finish_reason };
}

function tryDecodeOne(
  buf: Uint8Array,
): { frame: CodecMsgpackFrame; consumed: number } | null {
  // msgpackDecode throws on incomplete data — we wrap to detect.
  // For a robust framer we'd use msgpack's Decoder.decodeMulti, but
  // the synchronous decode wrapped in try/catch is sufficient here.
  try {
    // The decoder doesn't return how many bytes it consumed for the
    // default `decode()` — but it throws if the buffer is incomplete.
    // We binary-search the prefix length until decode succeeds; that
    // tells us how many bytes formed one frame.
    let lo = 1;
    let hi = buf.byteLength;
    let lastOk: { frame: CodecMsgpackFrame; consumed: number } | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        const obj = msgpackDecode(buf.subarray(0, mid)) as CodecMsgpackFrame;
        // Decoded at `mid` bytes — but `mid` may include extra
        // bytes from the next frame the decoder accepted greedily.
        // Walk back to the smallest prefix that decodes.
        lastOk = { frame: obj, consumed: mid };
        hi = mid - 1;
      } catch {
        lo = mid + 1;
      }
    }
    return lastOk;
  } catch {
    return null;
  }
}
