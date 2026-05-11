/**
 * Device compatibility detection — which web-llm models can actually
 * run on this device's WebGPU stack.
 *
 * The MLC web-llm landscape on phones is uneven enough that "do you
 * have WebGPU" is the wrong question; the right question is "does
 * your driver implement compute shaders correctly enough for ML
 * matmul to produce valid output". This module probes the adapter
 * for ground-truth GPU vendor and returns one of three tiers:
 *
 *   - `full`        — Apple / AMD / NVIDIA / Intel WebGPU is mature
 *                     enough for any model in the catalog
 *   - `small-only`  — Mali / older AMD: small fp32 models usually
 *                     work; bigger models often fail silently with
 *                     replacement-character output
 *   - `thinclient`  — Adreno: WebGPU compute is broken for ML in
 *                     late-2025/early-2026 drivers. NO local model
 *                     produces correct output. Route to remote peers.
 *   - `unknown`     — couldn't probe (no WebGPU, no UA hints).
 *                     Treat as small-only by default.
 *
 * The adapter probe (`navigator.gpu.requestAdapter().info`) is the
 * authoritative signal when available. UA-string heuristics are a
 * fallback for browsers that don't expose `info.vendor` yet (Safari
 * pre-18.3, some Firefox builds).
 */

export type DeviceCompatTier = 'full' | 'small-only' | 'thinclient' | 'unknown';

export interface DeviceCompat {
  tier: DeviceCompatTier;
  /** Human-readable reason — shown in the UI when filtering the catalog. */
  reason: string;
  /** Raw GPU vendor string if we got one (lowercased). */
  gpuVendor?: string;
  /** Raw architecture string if exposed (e.g. "adreno-740", "apple-family-9"). */
  gpuArchitecture?: string;
  /** Coarse device family inferred from UA when no GPU info is available. */
  uaFamily?: 'ios' | 'ipados' | 'mac' | 'android' | 'desktop' | 'unknown';
}

const CACHE: { value: DeviceCompat | null } = { value: null };

/**
 * Detect this device's compatibility tier. Caches the result for the
 * lifetime of the page — the answer doesn't change without a reload.
 *
 * Always resolves; never throws. Worst-case returns `unknown`.
 */
export async function detectDeviceCompat(): Promise<DeviceCompat> {
  if (CACHE.value) return CACHE.value;
  const result = await probe();
  CACHE.value = result;
  return result;
}

async function probe(): Promise<DeviceCompat> {
  // SSR / non-browser → unknown.
  if (typeof navigator === 'undefined') {
    return { tier: 'unknown', reason: 'not in a browser', uaFamily: 'unknown' };
  }

  // 1) Try WebGPU adapter.info — most reliable.
  // Use `any` for the GPU surface because lib.dom's WebGPU type is
  // present in modern targets but `adapter.info` is still flagged
  // experimental in some versions of TS. Runtime-safe — we guard.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gpu = (navigator as any).gpu;
  if (gpu) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = (await gpu.requestAdapter()) as any;
      if (adapter && adapter.info) {
        const vendor = (adapter.info.vendor ?? '').toString().toLowerCase();
        const arch = (adapter.info.architecture ?? '').toString().toLowerCase();
        const description = (adapter.info.description ?? '').toString().toLowerCase();
        const tier = classifyByGpuVendor(vendor, arch, description);
        return {
          ...tier,
          gpuVendor: vendor || undefined,
          gpuArchitecture: arch || undefined,
          uaFamily: inferUaFamily(navigator.userAgent),
        };
      }
    } catch {
      /* fall through to UA heuristics */
    }
  }

  // 2) No WebGPU → unknown (treat as thin client for the LLM panel).
  // @ts-expect-error
  if (!navigator.gpu) {
    return {
      tier: 'thinclient',
      reason: 'this browser does not expose WebGPU. Use a recent Chrome or Safari, or join as a thin client.',
      uaFamily: inferUaFamily(navigator.userAgent),
    };
  }

  // 3) WebGPU present but no adapter.info — UA heuristics.
  return classifyByUserAgent(navigator.userAgent);
}

/** Map a known GPU vendor → tier. Conservative defaults for unknowns. */
function classifyByGpuVendor(
  vendor: string,
  arch: string,
  description: string,
): Pick<DeviceCompat, 'tier' | 'reason'> {
  // Apple — both Mac discrete and Apple Silicon iGPU report as "apple".
  if (vendor.includes('apple')) {
    return {
      tier: 'full',
      reason: 'Apple GPU (Metal-backed WebGPU) — runs every model in the catalog.',
    };
  }
  // NVIDIA / AMD / Intel — desktop and laptop, all reliable.
  if (vendor.includes('nvidia') || vendor.includes('amd') || vendor.includes('intel')) {
    return {
      tier: 'full',
      reason: `${vendor} GPU — desktop WebGPU stack, runs every model.`,
    };
  }
  // Qualcomm Adreno — the broken case.
  if (vendor.includes('qualcomm') || arch.includes('adreno') || description.includes('adreno')) {
    return {
      tier: 'thinclient',
      reason:
        'Adreno (Qualcomm) GPU: WebGPU compute is broken for ML on current drivers — every web-llm model produces garbage output. Join as thin client and route prompts to other peers via /skill or /director.',
    };
  }
  // ARM Mali — sometimes works for small models.
  if (vendor.includes('arm') || arch.includes('mali') || description.includes('mali')) {
    return {
      tier: 'small-only',
      reason:
        'Mali (ARM) GPU: WebGPU works for small fp32 models (SmolLM2-360M, Qwen-0.5B) but larger or fp16 models often fail silently. Stick to the fp32 mobile catalog.',
    };
  }
  // Samsung Xclipse — AMD-derived, decent.
  if (vendor.includes('samsung') || arch.includes('xclipse')) {
    return {
      tier: 'small-only',
      reason: 'Samsung Xclipse (AMD-derived) GPU: usable for small fp32 models; larger models may fail.',
    };
  }
  // Imagination, Vivante, etc.
  return {
    tier: 'unknown',
    reason: `Unrecognized GPU vendor "${vendor || '(blank)'}". Treating as small-only — try a small fp32 model first; if output is replacement characters, switch to thin-client mode.`,
  };
}

/**
 * UA-only classification. Only used when adapter.info is unavailable
 * — much coarser than vendor probing.
 */
function classifyByUserAgent(ua: string): DeviceCompat {
  const uaFamily = inferUaFamily(ua);
  // iOS / iPadOS / Mac all run Apple GPUs.
  if (uaFamily === 'ios' || uaFamily === 'ipados' || uaFamily === 'mac') {
    return {
      tier: 'full',
      reason: 'Apple device (UA fallback) — Apple GPU; all models should work.',
      uaFamily,
    };
  }
  if (uaFamily === 'desktop') {
    return {
      tier: 'full',
      reason: 'Desktop (UA fallback) — assume capable WebGPU.',
      uaFamily,
    };
  }
  if (uaFamily === 'android') {
    // No GPU info — pessimistic default. Most Android flagships in US
    // are Adreno; even non-Adreno Android phones often have issues.
    return {
      tier: 'thinclient',
      reason:
        'Android device, no GPU info — assuming Adreno (broken for ML). Use thin-client mode; if your device is a Pixel 9 / Galaxy with Xclipse, override boot mode in the persona form.',
      uaFamily,
    };
  }
  return {
    tier: 'unknown',
    reason: 'Could not detect device family.',
    uaFamily: 'unknown',
  };
}

function inferUaFamily(ua: string): DeviceCompat['uaFamily'] {
  if (!ua) return 'unknown';
  if (/iPhone|iPod/.test(ua)) return 'ios';
  if (/iPad/.test(ua)) return 'ipados';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Android/.test(ua)) return 'android';
  if (/Windows|Linux/.test(ua)) return 'desktop';
  return 'unknown';
}
