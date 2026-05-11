/**
 * Runtime type-guards for wire payloads. Peers deserialize untrusted
 * data from the network; every consumer at the wire boundary runs
 * these before treating an object as a typed payload.
 *
 * The guards are strict on REQUIRED fields and tolerant on UNKNOWN
 * fields — a future protocol bump (v=2) that adds new fields stays
 * compatible because the v=1 guard only checks what v=1 needed.
 */
import {
  MESH_PROTOCOL_VERSION,
  type MeshChatMessage,
  type MeshPeerCap,
  type MeshToolCall,
  type MeshToolDescriptor,
  type MeshToolFrame,
  type MeshToolResult,
} from './types.js';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isStringArr(x: unknown): x is readonly string[] {
  return Array.isArray(x) && x.every((s) => typeof s === 'string');
}

export function isMeshToolDescriptor(x: unknown): x is MeshToolDescriptor {
  if (!isRecord(x)) return false;
  return (
    typeof x.name === 'string' &&
    typeof x.description === 'string' &&
    isRecord(x.inputSchema)
  );
}

export function isMeshPeerCap(x: unknown): x is MeshPeerCap {
  if (!isRecord(x)) return false;
  if (x.v !== MESH_PROTOCOL_VERSION) return false;
  if (typeof x.ts !== 'number') return false;
  if (typeof x.nick !== 'string') return false;
  if (typeof x.modelId !== 'string') return false;
  if (typeof x.available !== 'boolean') return false;
  if (!isStringArr(x.skills)) return false;
  if (typeof x.systemPromptSummary !== 'string') return false;
  if (!Array.isArray(x.tools)) return false;
  if (!x.tools.every(isMeshToolDescriptor)) return false;
  // Layer-4 fields are optional but, when present, MUST be string[].
  // Missing field = empty array semantically (handled in resolver).
  if (x.authoritative !== undefined && !isStringArr(x.authoritative)) return false;
  if (x.delegating !== undefined && !isStringArr(x.delegating)) return false;
  return true;
}

export function isMeshChatMessage(x: unknown): x is MeshChatMessage {
  if (!isRecord(x)) return false;
  if (x.v !== MESH_PROTOCOL_VERSION) return false;
  if (typeof x.ts !== 'number') return false;
  if (typeof x.from !== 'string') return false;
  if (typeof x.to !== 'string') return false;
  if (x.bodyKind !== 'text' && x.bodyKind !== 'tokens' && x.bodyKind !== 'frame') {
    return false;
  }
  if (x.bodyKind === 'text' && typeof x.text !== 'string') return false;
  if (x.bodyKind === 'tokens') {
    if (!Array.isArray(x.ids)) return false;
    if (!x.ids.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)) {
      return false;
    }
  }
  if (x.bodyKind === 'frame' && typeof x.frame !== 'string') return false;
  if (x.mapId !== undefined && typeof x.mapId !== 'string') return false;
  if (x.safety !== undefined && !isRecord(x.safety)) return false;
  return true;
}

export function isMeshToolCall(x: unknown): x is MeshToolCall {
  if (!isRecord(x)) return false;
  if (x.v !== MESH_PROTOCOL_VERSION) return false;
  return (
    typeof x.ts === 'number' &&
    typeof x.callId === 'string' &&
    typeof x.toolName === 'string' &&
    isRecord(x.args)
  );
}

export function isMeshToolResult(x: unknown): x is MeshToolResult {
  if (!isRecord(x)) return false;
  if (x.v !== MESH_PROTOCOL_VERSION) return false;
  if (typeof x.ts !== 'number') return false;
  if (typeof x.callId !== 'string') return false;
  return x.status === 'ok' || x.status === 'error' || x.status === 'denied';
}

export function isMeshToolFrame(x: unknown): x is MeshToolFrame {
  if (!isRecord(x)) return false;
  if (x.kind === 'call') return isMeshToolCall(x);
  if (x.kind === 'result') return isMeshToolResult(x);
  return false;
}
