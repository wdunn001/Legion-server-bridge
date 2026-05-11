# @unstable-legion/server-bridge

Headless Node bridge that joins an [Unstable Legion](https://github.com/wdunn001/unstable-legion) mesh as a peer and proxies `engine_run` tool calls to a Codec-aware HTTP server (sglang / vLLM / llama.cpp running the [wdunn001 Codec patches](https://github.com/wdunn001/Codec)).

From the mesh's perspective, an sglang-backed peer and a browser-LLM peer are interchangeable — same `cap` shape, same `tc` tool-call action, same `cf` Codec frame stream. Browser peers can call `engine_run` on this peer the same way they'd call it on another browser peer, and get raw Codec frames back from the much bigger server-side model.

## Why

Browser peers are constrained to small WebGPU models (0.5B–3B). For real agentic workloads you want to keep the mesh's properties (decentralized rooms, raw-Codec wire, tool calls) but route inference to a server with a full-sized model and proper hardware. This bridge is that pivot.

## Install

```bash
npm install -g @unstable-legion/server-bridge
```

`node-datachannel` is a native dep — it has prebuilt binaries for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `win32-x64`. No build toolchain needed on those.

## Use (CLI)

Point it at any Codec-aware HTTP server:

```bash
legion-bridge \
  --app-id=unstable-legion-demo-v0 \
  --room-id=legion-demo \
  --nick=sglang-gw \
  --model-id=Qwen/Qwen2.5-7B-Instruct \
  --map-id=qwen/qwen2 \
  --codec-url=http://localhost:30000 \
  --skills=chat,agent
```

All flags accept env vars too: `LEGION_APP_ID`, `LEGION_ROOM_ID`, `LEGION_NICK`, `LEGION_MODEL_ID`, `LEGION_MAP_ID`, `LEGION_CODEC_URL`, `LEGION_SYSTEM_PROMPT`, `LEGION_RELAY_URLS`, `LEGION_SKILLS`.

The bridge:

1. Joins the room over MQTT/WebRTC like any other peer.
2. Advertises a cap with `engine_run` + `ping` tools.
3. On incoming `tc` call → forwards to `<codec-url>/v1/completions` with `stream_format: "msgpack"`.
4. Streams the resulting Codec frames back to the asker via `peer.sendFrame` — **no detokenization on the server side**. The browser asker detokenizes at the edge.

## Use (programmatic)

```ts
import { joinRoom, selfId, defaultRelayUrls } from '@trystero-p2p/mqtt';
import {
  joinServerMesh,
  createCodecHttpBridge,
  ToolRegistry,
  registerBuiltinTools,
  mergeRelayUrls,
} from '@unstable-legion/server-bridge';

const registry = new ToolRegistry();
registerBuiltinTools(registry);

const peer = await joinServerMesh({
  joinRoom,
  selfId,
  trysteroConfig: {
    appId: 'my-mesh',
    relayConfig: {
      urls: mergeRelayUrls({
        defaults: defaultRelayUrls,
        blockedHosts: ['test.mosquitto.org'],
      }),
    },
  },
  roomId: 'my-room',
  cap: {
    v: 1, ts: Date.now(),
    nick: 'sglang-gw',
    modelId: 'Qwen/Qwen2.5-7B-Instruct',
    available: true,
    skills: ['chat', 'agent'],
    systemPromptSummary: 'sglang gateway',
    tools: [],            // populated after bridge registers engine_run
  },
});

createCodecHttpBridge({
  peer,
  registry,
  baseUrl: 'http://localhost:30000',
  modelId: 'Qwen/Qwen2.5-7B-Instruct',
});

peer.setCap({
  // ...same cap, but now with engine_run in the tools list
  tools: registry.descriptorsFor(['engine_run', 'ping']),
});

// Dispatch incoming tool calls.
peer.onTool(async (frame, peerId) => {
  if (frame.kind !== 'call') return;
  const result = await registry.dispatch(frame, ['engine_run', 'ping']);
  await peer.sendTool({ kind: 'result', ...result }, peerId);
});
```

## Wire contract

The Codec HTTP server is expected to:

- accept `POST <baseUrl>/v1/completions`
- with OpenAI-shaped body (`model`, `prompt`, `stream: true`, `stream_format: "msgpack"`, optional `max_tokens`/`temperature`/`top_p`)
- return a `Content-Type: application/octet-stream` body with a sequence of self-delimited msgpack frames matching the `CodecFrame` shape:

```ts
{
  ids: number[];        // token IDs from this chunk
  done: boolean;        // true on the terminal frame
  finish_reason?: string;
}
```

That's what the [wdunn001/sglang](https://github.com/wdunn001/sglang) and [wdunn001/vllm](https://github.com/wdunn001/vllm) Codec patches ship. Upstream JSON-SSE servers are NOT supported.

## License

[BSL-1.1](LICENSE) — source-available, free for non-production use, commercial license required for production beyond the additional-use grant.
