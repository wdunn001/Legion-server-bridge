/**
 * MCP Streamable-HTTP client glue for the mesh.
 *
 * Operators attach one or more public MCP endpoints (e.g.
 * `https://tandem.ac/mcp`) to their persona. At attach time we run the
 * JSON-RPC initialize + `tools/list` handshake, register each
 * discovered tool in the local `ToolRegistry` under a
 * `mcp:<host>/<name>` namespace, and (when the operator opts them in)
 * advertise them alongside the built-ins in `cap.tools[]`. Calls route
 * through `tools/call`, supporting both `application/json` and
 * `text/event-stream` Streamable-HTTP response shapes.
 *
 * Wire-compatible with leet's `leetMeshMcp.ts` so a legion peer and a
 * leet peer using overlapping endpoints address the same MCP tools by
 * the same mesh-namespaced name.
 *
 * CORS caveat: many public MCP endpoints serve desktop clients and
 * don't include CORS headers — the browser fetch fails with an opaque
 * `TypeError: Failed to fetch`. `discoverMcpEndpoint` tags the error
 * `kind: "cors"` so the UI can show "needs proxy" instead of generic
 * failure. The standard mitigation is a CORS-permissive same-origin
 * proxy.
 */
import type { MeshToolDescriptor } from './types.js';
import type { ToolRegistry } from './tools.js';

/** MCP protocol version we negotiate. Streamable-HTTP transport landed 2025-03-26. */
const MCP_PROTOCOL_VERSION = '2025-03-26';

/** Header MCP servers use to bind subsequent requests to a session. */
const MCP_SESSION_HEADER = 'mcp-session-id';

/** How long to wait for an MCP request before aborting. */
const MCP_REQUEST_TIMEOUT_MS = 15_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpToolsListResult {
  tools: McpToolDefinition[];
}

interface McpToolCallContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface McpToolCallResult {
  content?: McpToolCallContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** Live attachment record — kept per-endpoint so detach can clean up. */
export interface McpAttachment {
  url: string;
  /** MCP-server's own session id, if it issued one. */
  sessionId: string | null;
  /** Mesh-namespaced descriptors derived from the server's tools/list. */
  descriptors: readonly MeshToolDescriptor[];
  /** Mesh-namespaced names registered into the local `ToolRegistry`. */
  registeredNames: readonly string[];
}

/** Discovery error kinds; UI can branch on `kind` to pick a message. */
export type McpError =
  | { kind: 'cors'; url: string; detail: string }
  | { kind: 'network'; url: string; detail: string }
  | { kind: 'protocol'; url: string; detail: string }
  | { kind: 'timeout'; url: string };

/** Mesh-namespace a tool name so multiple endpoints can advertise the same upstream tool. */
function meshToolName(endpointUrl: string, toolName: string): string {
  let host: string;
  try {
    host = new URL(endpointUrl).hostname;
  } catch {
    host = endpointUrl.replace(/^https?:\/\//, '').split('/')[0] ?? 'mcp';
  }
  return `mcp:${host}/${toolName}`;
}

async function mcpFetch(
  url: string,
  init: RequestInit & { sessionId?: string | null },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) {
    headers.set('accept', 'application/json, text/event-stream');
  }
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (init.sessionId) {
    headers.set(MCP_SESSION_HEADER, init.sessionId);
  }
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a JSON-RPC response from a Streamable-HTTP body. Servers may
 * answer with `application/json` (single or batch) or `text/event-stream`.
 */
async function readJsonRpcResponse(response: Response, id: number): Promise<JsonRpcResponse> {
  const ct = (response.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) {
    const text = await response.text();
    for (const block of text.split(/\n\n+/)) {
      const dataLines = block.split('\n').filter((l) => l.startsWith('data:'));
      if (dataLines.length === 0) continue;
      const payload = dataLines.map((l) => l.slice(5).trim()).join('');
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as JsonRpcResponse | JsonRpcResponse[];
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of arr) {
          if (msg && typeof msg === 'object' && msg.id === id) return msg;
        }
      } catch {
        /* skip malformed event */
      }
    }
    throw new Error(`SSE response had no message with id=${id}`);
  }
  const parsed = (await response.json()) as JsonRpcResponse | JsonRpcResponse[];
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const match = arr.find((m) => m && typeof m === 'object' && m.id === id);
  if (!match) throw new Error(`JSON response had no message with id=${id}`);
  return match;
}

/**
 * Initialize an MCP session and register every advertised tool in the
 * supplied `ToolRegistry` under `mcp:<host>/<name>`. Idempotent — re-
 * calling with the same URL overwrites previous registrations.
 *
 * Returns the live attachment record on success; throws an `McpError`
 * (typed `kind`) on failure so callers can show useful errors.
 */
export async function discoverMcpEndpoint(
  url: string,
  registry: ToolRegistry,
): Promise<McpAttachment> {
  // Step 1: initialize.
  let initResponse: Response;
  try {
    initResponse = await mcpFetch(url, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'unstable-legion', version: '0.0.1' },
        },
      }),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw { kind: 'timeout', url } as McpError;
    }
    if (detail.toLowerCase().includes('cors') || detail.toLowerCase().includes('failed to fetch')) {
      throw { kind: 'cors', url, detail } as McpError;
    }
    throw { kind: 'network', url, detail } as McpError;
  }
  if (!initResponse.ok) {
    throw { kind: 'protocol', url, detail: `initialize HTTP ${initResponse.status}` } as McpError;
  }
  const sessionId = initResponse.headers.get(MCP_SESSION_HEADER);
  let initBody: JsonRpcResponse;
  try {
    initBody = await readJsonRpcResponse(initResponse, 1);
  } catch (e) {
    throw {
      kind: 'protocol',
      url,
      detail: e instanceof Error ? e.message : String(e),
    } as McpError;
  }
  if (initBody.error) {
    throw {
      kind: 'protocol',
      url,
      detail: `initialize error: ${initBody.error.message}`,
    } as McpError;
  }

  // Step 2: notifications/initialized — fire-and-forget per MCP spec.
  try {
    await mcpFetch(url, {
      method: 'POST',
      sessionId,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  } catch {
    /* not all servers require it; best-effort */
  }

  // Step 3: tools/list.
  let listResponse: Response;
  try {
    listResponse = await mcpFetch(url, {
      method: 'POST',
      sessionId,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
  } catch (e) {
    throw {
      kind: 'network',
      url,
      detail: e instanceof Error ? e.message : String(e),
    } as McpError;
  }
  if (!listResponse.ok) {
    throw {
      kind: 'protocol',
      url,
      detail: `tools/list HTTP ${listResponse.status}`,
    } as McpError;
  }
  const listBody = await readJsonRpcResponse(listResponse, 2);
  if (listBody.error) {
    throw {
      kind: 'protocol',
      url,
      detail: `tools/list error: ${listBody.error.message}`,
    } as McpError;
  }
  const result = (listBody.result ?? {}) as McpToolsListResult;
  const upstreamTools = Array.isArray(result.tools) ? result.tools : [];

  // Step 4: register each tool locally.
  const descriptors: MeshToolDescriptor[] = [];
  const registeredNames: string[] = [];
  for (const t of upstreamTools) {
    if (typeof t.name !== 'string' || !t.name) continue;
    const meshName = meshToolName(url, t.name);
    const descriptor: MeshToolDescriptor = {
      name: meshName,
      description: t.description ?? `(MCP) ${t.name}`,
      inputSchema:
        t.inputSchema && typeof t.inputSchema === 'object'
          ? (t.inputSchema as Record<string, unknown>)
          : {},
    };
    descriptors.push(descriptor);
    registeredNames.push(meshName);
    registry.register({
      descriptor,
      // Upstream MCP server is the schema authority — no client-side validation here.
      validate: () => null,
      handler: async (args) => {
        const r = await callMcpTool(url, sessionId, t.name, args);
        if (!r.ok) throw new Error(r.error);
        return { content: r.content };
      },
    });
  }
  return { url, sessionId, descriptors, registeredNames };
}

/**
 * Invoke an MCP tool via Streamable-HTTP. Used by the registered
 * handler from `discoverMcpEndpoint`.
 */
export async function callMcpTool(
  endpointUrl: string,
  sessionId: string | null,
  upstreamToolName: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ ok: true; content: unknown } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await mcpFetch(endpointUrl, {
      method: 'POST',
      sessionId,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: upstreamToolName, arguments: args },
      }),
    });
  } catch (e) {
    return { ok: false, error: `mcp transport: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!response.ok) {
    return { ok: false, error: `mcp HTTP ${response.status}` };
  }
  let body: JsonRpcResponse;
  try {
    body = await readJsonRpcResponse(response, 1);
  } catch (e) {
    return { ok: false, error: `mcp response parse: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (body.error) {
    return { ok: false, error: `mcp error: ${body.error.message}` };
  }
  const callResult = (body.result ?? {}) as McpToolCallResult;
  if (callResult.isError) {
    const txt =
      callResult.content?.find((c) => c.type === 'text')?.text ?? 'tool reported error';
    return { ok: false, error: txt };
  }
  return { ok: true, content: callResult.content ?? callResult.structuredContent ?? null };
}

/** Detach an MCP endpoint — removes registry entries created at attach. */
export function detachMcpEndpoint(att: McpAttachment, registry: ToolRegistry): void {
  for (const name of att.registeredNames) registry.unregister(name);
}
