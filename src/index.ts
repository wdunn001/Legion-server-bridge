/**
 * @unstable-legion/server-bridge — headless Node integration that
 * joins an Unstable Legion mesh as a peer and proxies engine calls
 * to a Codec-aware HTTP server.
 *
 * Public surface:
 *
 *   - joinServerMesh: Trystero room join + Node WebRTC polyfill.
 *   - createCodecHttpBridge: register the `engine_run` tool that
 *     forwards calls to sglang / vLLM / llama.cpp.
 *
 * Pair with `@unstable-legion/core`'s `ToolRegistry` +
 * `registerBuiltinTools` for full parity with a browser-side peer.
 */
export {
  joinServerMesh,
  installWebRtcPolyfill,
  type ServerMeshOptions,
} from './peer.js';

export {
  createCodecHttpBridge,
  type CodecHttpBridgeOptions,
} from './bridge.js';

// Re-export the core wire types for ergonomics.
export type {
  MeshPeerCap,
  MeshRosterEntry,
  MeshToolDescriptor,
  MeshToolCall,
  MeshToolResult,
  Peer,
} from '@unstable-legion/core';
export {
  ToolRegistry,
  registerBuiltinTools,
  newCallId,
  mergeRelayUrls,
} from '@unstable-legion/core';
