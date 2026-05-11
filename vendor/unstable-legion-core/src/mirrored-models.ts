/**
 * Mirrored-model URL swap for web-llm engines.
 *
 * When the deploy self-hosts MLC weights at `<origin>/<base>/<model_id>/`,
 * `prebuiltAppConfig.model_list[].model` can be re-pointed at the mirror
 * before passing the config into `CreateMLCEngine`. Web-llm appends
 * `/resolve/main/<shard>` either way, so the swap is transparent.
 *
 * The list of mirrored model ids and the base path are app-config —
 * mesh-core just provides the lookup + URL builder. Apps wire their
 * own allow-list (typically driven by `scripts/mirror-webllm-models.sh`
 * or similar).
 */

export interface MirroredModelConfig {
  /** Allow-list of model_ids whose weights are mirrored. Empty = no mirror. */
  modelIds: readonly string[];
  /**
   * Base URL the mirror is served from. Trailing `/` ok. Typically
   * `<window.location.origin>/webllm` for same-origin mirrors. Pass
   * the absolute or relative URL — callers control where it points.
   */
  baseUrl: string;
}

export function isMirroredModelId(cfg: MirroredModelConfig, modelId: string): boolean {
  return cfg.modelIds.includes(modelId);
}

/**
 * If `modelId` is mirrored under `cfg`, return the URL prefix web-llm
 * should treat as the model's `model` field (the base to append
 * `/resolve/main/<file>` onto). Returns null otherwise — caller leaves
 * the original Hugging Face URL in place.
 */
export function mirroredModelUrl(cfg: MirroredModelConfig, modelId: string): string | null {
  if (!isMirroredModelId(cfg, modelId)) return null;
  const trimmed = cfg.baseUrl.replace(/\/$/, '');
  return `${trimmed}/${modelId}`;
}
