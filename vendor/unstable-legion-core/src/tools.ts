/**
 * Tool registry + dispatch for the mesh.
 *
 * Each peer maintains a local registry of tools it will execute. Tools
 * the operator has opted in to get advertised in `cap.tools[]`; askers
 * see those in the roster and send `MeshToolCall` frames over the `tc`
 * Trystero action. The receiving peer validates the call's args against
 * the tool's validator, runs the handler, and ships a `MeshToolResult`
 * back keyed by the same `callId`.
 *
 * The dispatcher is shape-compatible with the descriptors leet's AI
 * mesh emits (mass-zero-fpv-saas/apps/leet/src/leetMeshTools.ts) — same
 * JSON-Schema-ish input descriptors, same call/result frame shapes.
 * A leet peer and a legion peer should interoperate on overlapping
 * tool names.
 *
 * Builtin tools (`current_time`, `fetch_text`, `ping`) ship as opt-in
 * defaults — registered eagerly so the operator can include them in
 * `cap.tools[]` without writing any code, but NOT auto-advertised
 * unless the operator opts in.
 */
import type {
  MeshRosterEntry,
  MeshToolCall,
  MeshToolDescriptor,
  MeshToolResult,
} from './types.js';
import { routeBySkill, type RouteBySkillContext, type SkillCache } from './skillResolver.js';
import type { Peer } from './peer.js';

export interface ToolHandlerResult {
  /** Tool-defined payload; must be structured-cloneable for the wire. */
  content: unknown;
}

export type ToolHandler = (
  args: Readonly<Record<string, unknown>>,
) => Promise<ToolHandlerResult>;

/** Returns null on success; an error string on failure. */
export type ToolArgValidator = (args: Readonly<Record<string, unknown>>) => string | null;

export interface ToolRegistration {
  descriptor: MeshToolDescriptor;
  validate: ToolArgValidator;
  handler: ToolHandler;
}

/**
 * Per-peer tool registry. Tools register globally (e.g. at module init
 * for builtins), but each peer chooses which subset to advertise via
 * `cap.tools[]` — askers only see the opted-in set.
 */
export class ToolRegistry {
  private regs = new Map<string, ToolRegistration>();

  /** Add a tool to the registry. Re-registering overwrites. */
  register(reg: ToolRegistration): void {
    this.regs.set(reg.descriptor.name, reg);
  }

  /** Remove a tool by name. */
  unregister(name: string): boolean {
    return this.regs.delete(name);
  }

  /** All registered tools, in insertion order. */
  list(): ReadonlyArray<ToolRegistration> {
    return [...this.regs.values()];
  }

  /** Look up a tool by name. */
  get(name: string): ToolRegistration | undefined {
    return this.regs.get(name);
  }

  /**
   * Descriptors for the subset of registered tools whose names are in
   * `optedInNames`. Use this when minting the `cap.tools` advertisement.
   */
  descriptorsFor(optedInNames: readonly string[]): MeshToolDescriptor[] {
    const set = new Set(optedInNames);
    return [...this.regs.values()]
      .filter((r) => set.has(r.descriptor.name))
      .map((r) => r.descriptor);
  }

  /**
   * Dispatch an inbound `MeshToolCall` against the registry. Validates
   * the asker provided args before invoking the handler; never throws.
   * Returns a `MeshToolResult` ready to ship back over `tc`.
   */
  async dispatch(
    call: MeshToolCall,
    optedInNames: readonly string[],
  ): Promise<MeshToolResult> {
    const result: MeshToolResult = {
      v: 1 as const,
      ts: Date.now(),
      callId: call.callId,
      status: 'ok',
    };
    if (!optedInNames.includes(call.toolName)) {
      return { ...result, status: 'denied', error: `tool not exposed by this peer: ${call.toolName}` };
    }
    const reg = this.regs.get(call.toolName);
    if (!reg) {
      return { ...result, status: 'error', error: `unknown tool: ${call.toolName}` };
    }
    const validationError = reg.validate(call.args);
    if (validationError) {
      return { ...result, status: 'error', error: `invalid args: ${validationError}` };
    }
    try {
      const out = await reg.handler(call.args);
      return { ...result, status: 'ok', result: { content: out.content } };
    } catch (err) {
      return {
        ...result,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── Builtin tools — shape-compatible with leet's defaults ────────────────────

/** Hard cap on `fetch_text` response bytes — protects the peer from oversize fetches. */
const FETCH_TEXT_MAX_BYTES_HARD_CAP = 200_000;

/**
 * Register the default mesh tools (`current_time`, `fetch_text`, `ping`)
 * on a `ToolRegistry`. They're opt-in — the operator decides which to
 * advertise. Call this once during peer setup.
 */
export function registerBuiltinTools(reg: ToolRegistry): void {
  // current_time — zero-arg wall-clock probe.
  reg.register({
    descriptor: {
      name: 'current_time',
      description: "Return the peer's local wall-clock time as ISO 8601 plus timezone offset.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    validate: (args) =>
      Object.keys(args).length === 0 ? null : 'current_time takes no arguments',
    handler: async () => {
      const now = new Date();
      return {
        content: {
          iso: now.toISOString(),
          epoch_ms: now.getTime(),
          tz_offset_min: -now.getTimezoneOffset(),
        },
      };
    },
  });

  // ping — echo whatever you sent, plus the round-trip latency the
  // dispatcher saw on the receive side (helpful for measuring mesh hop
  // time over Trystero relays).
  reg.register({
    descriptor: {
      name: 'ping',
      description: 'Echo back the caller-supplied payload + receive-side timestamp.',
      inputSchema: {
        type: 'object',
        properties: {
          payload: { description: 'Anything structured-cloneable.' },
        },
        additionalProperties: false,
      },
    },
    validate: () => null, // accepts anything
    handler: async (args) => ({
      content: { payload: args.payload ?? null, received_at_ms: Date.now() },
    }),
  });

  // fetch_text — peer-relayed HTTP GET. Subject to the peer's browser
  // CORS policy — many origins block cross-origin fetches.
  reg.register({
    descriptor: {
      name: 'fetch_text',
      description:
        "HTTP GET a URL and return up to max_bytes of the response body as text. Subject to the peer's browser CORS policy.",
      inputSchema: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', format: 'uri', description: 'Absolute http(s) URL.' },
          max_bytes: {
            type: 'integer',
            minimum: 1,
            maximum: FETCH_TEXT_MAX_BYTES_HARD_CAP,
            default: 64_000,
            description: 'Hard cap on returned text length (bytes).',
          },
        },
        additionalProperties: false,
      },
    },
    validate: (args) => {
      if (typeof args.url !== 'string' || !args.url) return 'url must be a string';
      let parsed: URL;
      try {
        parsed = new URL(args.url);
      } catch {
        return 'url is not a valid URL';
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'url must be http(s)';
      }
      if (args.max_bytes !== undefined) {
        if (typeof args.max_bytes !== 'number' || !Number.isInteger(args.max_bytes)) {
          return 'max_bytes must be an integer';
        }
        if (args.max_bytes < 1 || args.max_bytes > FETCH_TEXT_MAX_BYTES_HARD_CAP) {
          return `max_bytes must be 1..${FETCH_TEXT_MAX_BYTES_HARD_CAP}`;
        }
      }
      return null;
    },
    handler: async (args) => {
      const url = args.url as string;
      const limit = (args.max_bytes as number | undefined) ?? 64_000;
      const res = await fetch(url, { method: 'GET', redirect: 'follow' });
      const text = await res.text();
      const truncated = text.length > limit;
      return {
        content: {
          url,
          status: res.status,
          ok: res.ok,
          content_type: res.headers.get('content-type'),
          text: truncated ? text.slice(0, limit) : text,
          truncated,
          original_length: text.length,
        },
      };
    },
  });
}

// ── Hierarchical skill router (Layer 4) — needs runtime context ─────────────

export interface RegisterRouteSkillToolOptions {
  /** The local mesh peer. */
  peer: Peer;
  /** Function that returns the latest roster snapshot at call time. */
  rosterSnapshot: () => readonly MeshRosterEntry[];
  /** Optional shared skill-resolution cache. */
  cache?: SkillCache;
  /** Per-hop timeout (ms). Default 30_000. */
  timeoutMs?: number;
  /** Hop limit. Default 4. */
  maxDepth?: number;
}

/**
 * Register `route_skill` on the registry so this peer participates as a
 * routing node in the DNS-style delegation tree.
 *
 * When another peer calls our `route_skill` (with `skill` + `args` +
 * hop-counter), we run `routeBySkill` against OUR roster and return
 * the final result. The asker doesn't need to know our subordinate
 * peers — only that we're authoritative for our zone.
 *
 * Peers that should be *only* leaves (don't route for others) should
 * NOT register this tool. Peers that act as both authorities AND
 * routing nodes register it and opt it in to their cap.tools[].
 */
export function registerRouteSkillTool(
  reg: ToolRegistry,
  opts: RegisterRouteSkillToolOptions,
): void {
  reg.register({
    descriptor: {
      name: 'route_skill',
      description:
        'DNS-style hierarchical skill router. Caller passes a dotted skill name + args; this peer resolves the skill against its own roster (recursively if needed) and returns the final result.',
      inputSchema: {
        type: 'object',
        required: ['skill', 'args'],
        properties: {
          skill: { type: 'string', description: 'Dotted skill path (e.g. coding.python.optimize).' },
          args: { type: 'object', description: 'Args forwarded to the resolved peer.' },
          _hops: { type: 'integer', minimum: 0, description: 'Reserved — caller MUST NOT set; routers increment on forward.' },
          _originPeerId: { type: 'string', description: 'Reserved — origin peerId carried to prevent loopback.' },
        },
        additionalProperties: false,
      },
    },
    validate: (args) => {
      if (typeof args.skill !== 'string' || !args.skill) return 'skill must be a non-empty string';
      if (typeof args.args !== 'object' || args.args === null || Array.isArray(args.args)) {
        return 'args must be a JSON object';
      }
      return null;
    },
    handler: async (args) => {
      const ctx: RouteBySkillContext = {
        peer: opts.peer,
        roster: opts.rosterSnapshot(),
        cache: opts.cache,
      };
      const innerArgs: Readonly<Record<string, unknown>> = {
        ...(args.args as Record<string, unknown>),
        // Carry forward hop counter + origin so the resolver respects bounds.
        ...(typeof args._hops === 'number' ? { _hops: args._hops } : {}),
        ...(typeof args._originPeerId === 'string'
          ? { _originPeerId: args._originPeerId }
          : {}),
      };
      const result = await routeBySkill(ctx, args.skill as string, innerArgs, {
        maxDepth: opts.maxDepth,
        timeoutMs: opts.timeoutMs,
      });
      // Pass the inner MeshToolResult's `result.content` through as our
      // own content; status/error propagates by re-throwing on error so
      // the wrapping dispatcher emits a clean result frame.
      if (result.status !== 'ok') {
        throw new Error(result.error ?? `route_skill: status=${result.status}`);
      }
      const content =
        (result.result as { content?: unknown } | undefined)?.content ?? result.result;
      return { content };
    },
  });
}

// ── Asker-side correlation helper ────────────────────────────────────────────

/**
 * Pending-call tracker for askers waiting on `MeshToolResult` echoes.
 * The asker mints `callId` → registers a resolver → calls
 * `peer.sendTool(...)` → on inbound result with matching callId, the
 * promise resolves.
 *
 * Usage:
 *
 *   const tracker = new PendingToolCallTracker();
 *   peer.onTool((frame) => {
 *     if (frame.kind === 'result') tracker.settle(frame);
 *   });
 *
 *   const callId = randomId();
 *   const resultP = tracker.expect(callId, 10_000);
 *   await peer.sendTool({ kind: 'call', v: 1, ts: Date.now(), callId, toolName, args }, peerId);
 *   const result = await resultP;
 */
export class PendingToolCallTracker {
  private pending = new Map<
    string,
    { resolve: (r: MeshToolResult) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /** Wait for a result with this callId, or reject after `timeoutMs`. */
  expect(callId: string, timeoutMs = 30_000): Promise<MeshToolResult> {
    return new Promise<MeshToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`tool-call ${callId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(callId, { resolve, reject, timer });
    });
  }

  /** Resolve a pending call with this result. No-op if no one's waiting. */
  settle(result: MeshToolResult): boolean {
    const entry = this.pending.get(result.callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(result.callId);
    entry.resolve(result);
    return true;
  }

  /** Drop all pending calls with a rejection — call on peer.leave(). */
  abortAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/**
 * Generate a short random call id. Used by askers to mint correlation
 * tokens. Not cryptographically random — collisions per-room are
 * extremely unlikely at the rates we expect.
 */
export function newCallId(): string {
  return (
    'tc-' +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}
