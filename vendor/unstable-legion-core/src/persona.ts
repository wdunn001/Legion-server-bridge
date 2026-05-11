/**
 * Persona persistence — operator's nick, skills, system prompt,
 * available flag, opted-in tool names, and attached MCP endpoint URLs.
 *
 * Persisted to `localStorage` so a refresh keeps the same identity
 * (and the same MCP attachments) in the mesh roster — without it
 * every reload churns through a new selfId-prefix nick and re-prompts
 * for tool opt-ins.
 *
 * Environment-aware: when `localStorage` isn't available (SSR, web
 * workers, service workers) the accessors silently return the default
 * persona instead of throwing.
 */

/**
 * Boot mode — selects which model catalog the operator picks from in
 * the persona form.
 *
 *   - `auto`  — UA-detects mobile, picks fp32 catalog there, fp16 elsewhere
 *   - `fp16`  — force the default fp16 catalog (faster but needs shader-f16)
 *   - `fp32`  — force the fp32 catalog (mobile-safe, ~2× download)
 */
export type BootMode = 'auto' | 'fp16' | 'fp32';

export interface MeshPersona {
  nick: string;
  modelId: string;
  available: boolean;
  skills: readonly string[];
  /**
   * Layer-4 hierarchical-routing field — skills this peer EXECUTES.
   * Optional; the `skills[]` field continues to work as a fallback for
   * back-compat. When both are set, they're unioned in the cap.
   */
  authoritative?: readonly string[];
  /**
   * Layer-4 hierarchical-routing field — skill zones this peer ROUTES
   * for via its `route_skill` tool (DNS NS-record analog). Empty = peer
   * is a leaf-only specialist.
   */
  delegating?: readonly string[];
  systemPrompt: string;
  /** Names of locally-registered tools the operator advertises in `cap.tools[]`. */
  availableTools: readonly string[];
  /** Streamable-HTTP MCP endpoint URLs to attach + advertise. */
  mcpEndpoints: readonly string[];
  /** Catalog selection mode. Default `auto`. */
  bootMode: BootMode;
}

const DEFAULT_KEY = 'unstable-legion-persona-v1';

export const DEFAULT_PERSONA: MeshPersona = Object.freeze({
  nick: '',
  modelId: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
  available: true,
  skills: ['demo'],
  authoritative: [],
  delegating: [],
  systemPrompt: 'You are a helpful assistant.',
  availableTools: ['current_time', 'ping'],
  mcpEndpoints: [],
  bootMode: 'auto',
});

export function loadPersona(storageKey: string = DEFAULT_KEY): MeshPersona {
  if (typeof localStorage === 'undefined') return DEFAULT_PERSONA;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return DEFAULT_PERSONA;
    const parsed = JSON.parse(raw) as Partial<MeshPersona>;
    return {
      nick: typeof parsed.nick === 'string' ? parsed.nick : DEFAULT_PERSONA.nick,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : DEFAULT_PERSONA.modelId,
      available: typeof parsed.available === 'boolean' ? parsed.available : DEFAULT_PERSONA.available,
      skills:
        Array.isArray(parsed.skills) && parsed.skills.every((s) => typeof s === 'string')
          ? (parsed.skills as string[])
          : DEFAULT_PERSONA.skills,
      systemPrompt:
        typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : DEFAULT_PERSONA.systemPrompt,
      availableTools:
        Array.isArray(parsed.availableTools) &&
        parsed.availableTools.every((s) => typeof s === 'string')
          ? (parsed.availableTools as string[])
          : DEFAULT_PERSONA.availableTools,
      authoritative:
        Array.isArray(parsed.authoritative) &&
        parsed.authoritative.every((s) => typeof s === 'string')
          ? (parsed.authoritative as string[])
          : DEFAULT_PERSONA.authoritative,
      delegating:
        Array.isArray(parsed.delegating) &&
        parsed.delegating.every((s) => typeof s === 'string')
          ? (parsed.delegating as string[])
          : DEFAULT_PERSONA.delegating,
      mcpEndpoints:
        Array.isArray(parsed.mcpEndpoints) &&
        parsed.mcpEndpoints.every((s) => typeof s === 'string')
          ? (parsed.mcpEndpoints as string[])
          : DEFAULT_PERSONA.mcpEndpoints,
      bootMode:
        parsed.bootMode === 'fp16' ||
        parsed.bootMode === 'fp32' ||
        parsed.bootMode === 'auto'
          ? parsed.bootMode
          : DEFAULT_PERSONA.bootMode,
    };
  } catch {
    return DEFAULT_PERSONA;
  }
}

export function savePersona(p: MeshPersona, storageKey: string = DEFAULT_KEY): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(p));
  } catch {
    /* quota / privacy — silent */
  }
}
