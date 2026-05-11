/**
 * Public MCP server registry — same-origin snapshot fetch + cache.
 *
 * The upstream registry at `registry.modelcontextprotocol.io` has no
 * CORS headers, so a browser can't fetch it directly. The deploy
 * publishes a snapshot at `/.well-known/mcp/registry.json` (generated
 * at image-build time by a `prebuild` script — see
 * `apps/demo/scripts/snapshot-mcp-registry.mjs` for an example).
 *
 * Layered caching:
 *   1. The HTTP layer (nginx) serves the snapshot with a long-ish
 *      cache TTL — repeat fetches hit the browser HTTP cache.
 *   2. We additionally store the parsed registry under a versioned
 *      `localStorage` key so a cold render doesn't have to await the
 *      network at all.
 */

export interface McpRegistryEntry {
  /** Canonical server identifier from the upstream registry. */
  readonly name: string;
  /** Operator-facing label. Falls back to `name` if the upstream omits. */
  readonly title: string;
  /** Long-form description from the upstream registry — may be empty. */
  readonly description: string;
  /** Version string from the upstream entry, or null. */
  readonly version: string | null;
  /** Streamable-HTTP URLs the server advertises. At least one. */
  readonly urls: readonly string[];
}

export interface McpRegistry {
  readonly updatedAt: string;
  readonly source: string;
  /** Set when the build-time fetch failed; `entries[]` is empty. */
  readonly error?: string;
  readonly entries: readonly McpRegistryEntry[];
}

interface CachedRegistry {
  readonly fetchedAt: number;
  readonly registry: McpRegistry;
}

export interface FetchMcpRegistryOptions {
  /** Same-origin URL the snapshot is served from. */
  url?: string;
  /** localStorage key (bump on shape change). */
  cacheKey?: string;
  /** TTL before going to network for a freshness check. */
  ttlMs?: number;
}

const DEFAULT_URL = '/.well-known/mcp/registry.json';
const DEFAULT_CACHE_KEY = 'unstable-legion-mcp-registry-cache-v1';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function readCache(cacheKey: string): CachedRegistry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedRegistry;
    if (
      typeof parsed.fetchedAt !== 'number' ||
      typeof parsed.registry !== 'object' ||
      !Array.isArray(parsed.registry?.entries)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cacheKey: string, registry: McpRegistry): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      cacheKey,
      JSON.stringify({ fetchedAt: Date.now(), registry } satisfies CachedRegistry),
    );
  } catch {
    /* quota / privacy mode — silent */
  }
}

let inflight: Promise<McpRegistry> | null = null;

/**
 * Fetch the registry snapshot. Concurrent calls share a single in-
 * flight promise. On network failure with a stale cached copy
 * available, returns the stale copy rather than throwing.
 */
export function fetchMcpRegistry(opts: FetchMcpRegistryOptions = {}): Promise<McpRegistry> {
  const url = opts.url ?? DEFAULT_URL;
  const cacheKey = opts.cacheKey ?? DEFAULT_CACHE_KEY;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (inflight) return inflight;
  const cached = readCache(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return Promise.resolve(cached.registry);
  }
  inflight = (async () => {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`registry HTTP ${r.status}`);
      const registry = (await r.json()) as McpRegistry;
      writeCache(cacheKey, registry);
      return registry;
    } catch (err) {
      if (cached) {
        // eslint-disable-next-line no-console
        console.warn('[mesh] mcp registry refresh failed; using stale cache:', err);
        return cached.registry;
      }
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
