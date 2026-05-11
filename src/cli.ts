#!/usr/bin/env node
/**
 * legion-bridge — zero-code CLI for hooking a Codec-aware HTTP server
 * (sglang / vLLM / llama.cpp) into an Unstable Legion mesh.
 *
 * Usage:
 *
 *   legion-bridge \
 *     --app-id=unstable-legion-demo-v0 \
 *     --room-id=legion-demo \
 *     --nick=sglang-gw \
 *     --model-id=Qwen/Qwen2.5-7B-Instruct \
 *     --map-id=qwen/qwen2 \
 *     --codec-url=http://localhost:30000
 *
 * All flags can also be set via env vars: `LEGION_APP_ID`,
 * `LEGION_ROOM_ID`, `LEGION_NICK`, `LEGION_MODEL_ID`, `LEGION_MAP_ID`,
 * `LEGION_CODEC_URL`. Flags win over env.
 *
 * The CLI joins the room, advertises the cap with `engine_run`, opts
 * the tool in, and starts proxying. Press Ctrl-C to leave cleanly.
 */
import { joinRoom, selfId, defaultRelayUrls } from '@trystero-p2p/mqtt';
import {
  ToolRegistry,
  registerBuiltinTools,
  mergeRelayUrls,
} from '@unstable-legion/core';
import { joinServerMesh } from './peer.js';
import { createCodecHttpBridge } from './bridge.js';

interface CliConfig {
  appId: string;
  roomId: string;
  nick: string;
  modelId: string;
  mapId: string;
  codecUrl: string;
  systemPrompt: string;
  relayUrlsRaw: string | undefined;
  skills: string[];
}

function parseFlags(argv: readonly string[]): Partial<CliConfig> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z][a-z0-9-]*)(?:=(.*))?$/i);
    if (!m) continue;
    const key = m[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = m[2] ?? 'true';
  }
  const skillsRaw = out.skills;
  return {
    ...(out.appId ? { appId: out.appId } : {}),
    ...(out.roomId ? { roomId: out.roomId } : {}),
    ...(out.nick ? { nick: out.nick } : {}),
    ...(out.modelId ? { modelId: out.modelId } : {}),
    ...(out.mapId ? { mapId: out.mapId } : {}),
    ...(out.codecUrl ? { codecUrl: out.codecUrl } : {}),
    ...(out.systemPrompt ? { systemPrompt: out.systemPrompt } : {}),
    ...(out.relayUrls ? { relayUrlsRaw: out.relayUrls } : {}),
    ...(skillsRaw ? { skills: skillsRaw.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  };
}

function fromEnv(): Partial<CliConfig> {
  const env = process.env;
  return {
    ...(env.LEGION_APP_ID ? { appId: env.LEGION_APP_ID } : {}),
    ...(env.LEGION_ROOM_ID ? { roomId: env.LEGION_ROOM_ID } : {}),
    ...(env.LEGION_NICK ? { nick: env.LEGION_NICK } : {}),
    ...(env.LEGION_MODEL_ID ? { modelId: env.LEGION_MODEL_ID } : {}),
    ...(env.LEGION_MAP_ID ? { mapId: env.LEGION_MAP_ID } : {}),
    ...(env.LEGION_CODEC_URL ? { codecUrl: env.LEGION_CODEC_URL } : {}),
    ...(env.LEGION_SYSTEM_PROMPT ? { systemPrompt: env.LEGION_SYSTEM_PROMPT } : {}),
    ...(env.LEGION_RELAY_URLS ? { relayUrlsRaw: env.LEGION_RELAY_URLS } : {}),
    ...(env.LEGION_SKILLS ? { skills: env.LEGION_SKILLS.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  };
}

function resolveConfig(): CliConfig {
  const args = parseFlags(process.argv.slice(2));
  const env = fromEnv();
  const cfg = {
    appId: args.appId ?? env.appId ?? 'unstable-legion-demo-v0',
    roomId: args.roomId ?? env.roomId ?? 'legion-demo',
    nick: args.nick ?? env.nick ?? `bridge-${selfId.slice(0, 6)}`,
    modelId: args.modelId ?? env.modelId,
    mapId: args.mapId ?? env.mapId,
    codecUrl: args.codecUrl ?? env.codecUrl,
    systemPrompt:
      args.systemPrompt ??
      env.systemPrompt ??
      'Headless mesh bridge — proxies engine_run to a Codec-aware HTTP server.',
    relayUrlsRaw: args.relayUrlsRaw ?? env.relayUrlsRaw,
    skills: args.skills ?? env.skills ?? ['chat', 'agent'],
  };
  const missing: string[] = [];
  if (!cfg.modelId) missing.push('--model-id (or LEGION_MODEL_ID)');
  if (!cfg.mapId) missing.push('--map-id (or LEGION_MAP_ID)');
  if (!cfg.codecUrl) missing.push('--codec-url (or LEGION_CODEC_URL)');
  if (missing.length > 0) {
    console.error('legion-bridge: missing required config:', missing.join(', '));
    process.exit(2);
  }
  return cfg as CliConfig;
}

async function main(): Promise<void> {
  const cfg = resolveConfig();
  console.log('[legion-bridge] selfId=%s nick=%s', selfId, cfg.nick);
  console.log('[legion-bridge] room=%s model=%s map=%s', cfg.roomId, cfg.modelId, cfg.mapId);
  console.log('[legion-bridge] codec endpoint=%s', cfg.codecUrl);

  // Merge default brokers with optional extras, drop the known-flaky.
  const extras = cfg.relayUrlsRaw
    ? cfg.relayUrlsRaw.split(/[\s,]+/).filter(Boolean)
    : [];
  const relayUrls = mergeRelayUrls({
    defaults: defaultRelayUrls,
    extras,
    blockedHosts: ['test.mosquitto.org', 'broker-cn.emqx.io'],
    max: 6,
  });
  console.log('[legion-bridge] relays:', relayUrls);

  // Tool registry — Node-side. Opt in to `engine_run` only (and ping
  // for liveness). We don't expose `current_time` or `fetch_text` from
  // a server context — those are operator-supplied client tools.
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);

  const advertisedTools = registry.descriptorsFor(['engine_run', 'ping']);
  // `engine_run` is registered by the bridge below — add a placeholder
  // descriptor to the cap so the cap announcement carries it.
  // (registry.descriptorsFor reads from the registry; the bridge call
  //  immediately after adds engine_run, so the descriptors at cap-mint
  //  time will already include it if we register first. Do that.)

  const peer = await joinServerMesh({
    // Trystero's JoinRoom has a stricter type than our generic JoinRoomFn;
    // the runtime shape is identical, so cast through unknown.
    joinRoom: joinRoom as unknown as Parameters<typeof joinServerMesh>[0]['joinRoom'],
    selfId,
    trysteroConfig: {
      appId: cfg.appId,
      relayConfig: { urls: relayUrls },
    },
    roomId: cfg.roomId,
    cap: {
      v: 1 as const,
      ts: Date.now(),
      nick: cfg.nick,
      modelId: cfg.modelId,
      available: true,
      skills: cfg.skills,
      systemPromptSummary: cfg.systemPrompt.slice(0, 120),
      tools: advertisedTools, // re-minted after bridge registers below
    },
  });

  // Register engine_run via the bridge; updates the registry but the
  // cap-announcement was already minted. Re-broadcast the cap with the
  // updated tool list so peers see engine_run.
  const dispose = createCodecHttpBridge({
    peer,
    registry,
    baseUrl: cfg.codecUrl,
    modelId: cfg.modelId,
    defaults: { max_tokens: 512, temperature: 0.7, top_p: 0.95 },
  });

  // Re-broadcast cap with the fully-populated tool list.
  peer.setCap({
    v: 1 as const,
    ts: Date.now(),
    nick: cfg.nick,
    modelId: cfg.modelId,
    available: true,
    skills: cfg.skills,
    systemPromptSummary: cfg.systemPrompt.slice(0, 120),
    tools: registry.descriptorsFor(['engine_run', 'ping']),
  });

  // Wire `tc` tool-call inbound → dispatch through the registry → echo
  // result back to the asker. mesh-react's useMeshTools does this in
  // browsers; we do it manually here.
  peer.onTool(async (frame, peerId) => {
    if (frame.kind !== 'call') return;
    const result = await registry.dispatch(frame, ['engine_run', 'ping']);
    await peer.sendTool({ kind: 'result', ...result }, peerId);
  });

  // Graceful shutdown on SIGINT/SIGTERM.
  const shutdown = (sig: string) => {
    console.log(`[legion-bridge] received ${sig}, leaving room…`);
    dispose();
    peer.leave();
    setTimeout(() => process.exit(0), 250);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[legion-bridge] joined room · advertising engine_run. Ctrl-C to leave.');
}

main().catch((err) => {
  console.error('[legion-bridge] fatal:', err);
  process.exit(1);
});
