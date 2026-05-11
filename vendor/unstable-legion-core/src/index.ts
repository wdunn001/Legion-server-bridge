/**
 * @unstable-legion/core — peer-to-peer browser-AI mesh.
 *
 * The wire format is just Codec msgpack frames (see `@codecai/web`). We
 * already ship Codec frames over WebRTC for the latent modality
 * (ComfyUI / diffusers forks); this package extends the same pattern
 * to the text-token modality. A peer's local LLM emits Codec frames
 * via `@codecai/web-llm`, the Trystero data channel ships those frame
 * bytes verbatim, the receiving peer's `@codecai/web` decoder reads
 * them — byte-identical to consuming from an HTTP-served vLLM.
 *
 * What this package owns:
 *
 *   1. Trystero room lifecycle + cap announcement + roster
 *   2. Four named actions (cap / cm / cf / tc) wired with type-guards
 *   3. Outbound prefilter glue (`@codecai/web-safety`)
 *
 * What this package DOESN'T own (consumers wire these):
 *
 *   - The Trystero strategy (consumer imports `trystero/torrent`,
 *     `trystero/ipfs`, `trystero/nostr`, or `trystero/mqtt`)
 *   - The local LLM engine (consumer constructs an `@mlc-ai/web-llm`
 *     engine, wraps it with `@codecai/web-llm`, and feeds the resulting
 *     Codec frames into `peer.sendFrame`)
 *   - The UI (React / Vue / vanilla — see `@unstable-legion/react`)
 *
 * For an advanced path (HELLO/READY/END handshake, stream-id
 * multiplexing, MTU chunking) the optional `webrtc-codec` helpers are
 * available — most consumers don't need them.
 */

// ── Wire types ──────────────────────────────────────────────────────
export {
  MESH_PROTOCOL_VERSION,
  type MeshChatMessage,
  type MeshPeerCap,
  type MeshRosterEntry,
  type MeshToolCall,
  type MeshToolDescriptor,
  type MeshToolFrame,
  type MeshToolResult,
} from './types.js';

export {
  isMeshChatMessage,
  isMeshPeerCap,
  isMeshToolCall,
  isMeshToolFrame,
  isMeshToolResult,
} from './guards.js';

// ── Trystero peer + roster ──────────────────────────────────────────
export { joinMesh, type Peer, type PeerOptions, type JoinRoomFn, type TrysteroRoom } from './peer.js';
export { Roster, type RosterOptions } from './roster.js';

// ── Codec frame plumbing (the primary path — Codec frames over WebRTC) ──
export {
  encodeFrameBytes,
  decodeFrameBytes,
  makeOutboundEncoder,
  makeInboundAssembler,
  renderFrameForHuman,
  type CodecMsgpackFrame,
  type OutboundEncoder,
  type InboundAssembler,
  type InboundAssemblerOptions,
  type TokenizerMap,
  type Detokenizer,
} from './wire.js';

// ── Safety prefilter glue ───────────────────────────────────────────
export {
  prefilterOutbound,
  applyRedaction,
  attachSafetyVerdict,
  type OutboundDecision,
  type OutboundSafetyOptions,
  type PrefilterMatch,
  type PrefilterCategory,
} from './safety.js';

// ── Tool registry + dispatch ────────────────────────────────────────
export {
  ToolRegistry,
  PendingToolCallTracker,
  registerBuiltinTools,
  registerRouteSkillTool,
  newCallId,
  type ToolRegistration,
  type ToolHandler,
  type ToolArgValidator,
  type ToolHandlerResult,
  type RegisterRouteSkillToolOptions,
} from './tools.js';

// ── Hierarchical skill resolver (Layer 4) ──────────────────────────
export {
  routeBySkill,
  SkillCache,
  RESOLVER_HOPS_KEY,
  RESOLVER_ORIGIN_KEY,
  RESOLVER_SKILL_KEY,
  type SkillResolveOptions,
  type RouteBySkillContext,
} from './skillResolver.js';

// ── MCP Streamable-HTTP client ──────────────────────────────────────
export {
  discoverMcpEndpoint,
  callMcpTool,
  detachMcpEndpoint,
  type McpAttachment,
  type McpError,
} from './mcp.js';

// ── Public MCP server registry (same-origin snapshot) ───────────────
export {
  fetchMcpRegistry,
  type McpRegistry,
  type McpRegistryEntry,
  type FetchMcpRegistryOptions,
} from './mcp-registry.js';

// ── Persona persistence ─────────────────────────────────────────────
export {
  DEFAULT_PERSONA,
  loadPersona,
  savePersona,
  type BootMode,
  type MeshPersona,
} from './persona.js';

// ── Strategy-agnostic helpers ───────────────────────────────────────
export {
  mergeRelayUrls,
  type MergeRelayUrlsOptions,
} from './relays.js';
export {
  isMirroredModelId,
  mirroredModelUrl,
  type MirroredModelConfig,
} from './mirrored-models.js';
export {
  detectDeviceCompat,
  type DeviceCompat,
  type DeviceCompatTier,
} from './deviceCompat.js';

// ── Routing + fan-out primitives (Layer 1 of the director plan) ────
export {
  findPeersBySkill,
  findPeersByTool,
  findPeersByModelFamily,
  findDelegatingPeers,
  pickBestPeer,
  type FindPeersOptions,
} from './routing.js';
export {
  callToolFanOut,
  ensemble,
  mapReduce,
  type FanOutOptions,
  type FanOutEntry,
  type MapReduceMapTool,
} from './fanOut.js';
export {
  majorityVote,
  concatJoin,
  llmSummarize,
  type LlmSummarizeOptions,
} from './aggregators.js';

// ── Optional: Codec-over-WebRTC advanced path ──────────────────────
//
// HELLO/READY handshake + stream-id multiplexing + MTU chunking, for
// consumers that need more than the "fire frame bytes through the
// data channel" path the rest of this module supports out of the box.
//
// Most mesh participants get by without these — they're useful when:
//   - multiple concurrent LLM streams between the same two peers need
//     to interleave
//   - per-stream compression negotiation matters
//   - bulk-token-id uploads exceed the WebRTC ~64 KB per-message MTU
export {
  ENVELOPE_KIND,
  WEBRTC_MTU_BYTES,
  encodeEnvelope,
  decodeEnvelope,
  makeHelloEnvelope,
  makeReadyEnvelope,
  makeEndEnvelope,
  makeDataEnvelope,
  chunkFrameForWire,
  chunkFrameIter,
  makeReassembler,
  newStreamId,
  type EnvelopeKind,
  type WebRtcEnvelope,
  type WebRtcHello,
  type WebRtcReady,
  type WebRtcEnd,
  type Reassembler,
  type ReassemblerOptions,
} from './webrtc-codec.js';
