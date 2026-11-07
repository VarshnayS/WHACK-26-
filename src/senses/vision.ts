/**
 * src/senses/vision.ts: vision modes (world.vision / world.setVision from the contract)
 * Owner: SENSES / RENDER
 *
 * setVision(id) accepts a preset id from ./visionConfig.ts or `severity:<0..100>`, which interpolates
 * from low acuity (0) to total blindness (100). The shader reads world.vision every frame
 * (src/render/pings.ts -> sonarMaterial uniforms), so a change shows on the next frame.
 * The last choice is saved per browser.
 */
import type { World } from '../world';
import type { VisionMode } from '../shared/contracts';
import {
  DEFAULT_VISION_ID,
  SEVERITY_FROM_ID,
  SEVERITY_PREFIX,
  SEVERITY_TO_ID,
  VISION_PRESETS,
  VISION_STORAGE_KEY,
  type VisionPreset,
} from './visionConfig';

export type { VisionPreset } from './visionConfig';
export { VISION_PRESETS } from './visionConfig';

const listeners = new Set<(mode: VisionPreset) => void>();
let worldRef: World | null = null;

function preset(id: string): VisionPreset | undefined {
  return VISION_PRESETS.find((p) => p.id === id);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** A mode between low acuity (0) and total blindness (100). */
export function severityMode(severity: number): VisionPreset {
  const s = Math.round(Math.min(100, Math.max(0, severity)));
  const a = preset(SEVERITY_FROM_ID)!;
  const b = preset(SEVERITY_TO_ID)!;
  const t = s / 100;
  // distance and sharpness shrink faster than linearly, so the middle of the scale already feels severe
  const k = 1 - (1 - t) * (1 - t);
  return {
    id: `${SEVERITY_PREFIX}${s}`,
    label: `Severity ${s} / 100`,
    note: 'Between low acuity (0) and total blindness (100).',
    visibleDistance: lerp(a.visibleDistance, b.visibleDistance, k),
    fovDeg: lerp(a.fovDeg, b.fovDeg, t),
    centralLossDeg: lerp(a.centralLossDeg, b.centralLossDeg, t),
    peripheralLimitDeg: lerp(a.peripheralLimitDeg, b.peripheralLimitDeg, t),
    acuity: lerp(a.acuity, b.acuity, k),
  };
}

/** Resolve an id (preset or `severity:N`) to a mode, or null if unknown. */
export function resolveVision(id: string): VisionPreset | null {
  if (id.startsWith(SEVERITY_PREFIX)) {
    const n = Number(id.slice(SEVERITY_PREFIX.length));
    return Number.isFinite(n) ? severityMode(n) : null;
  }
  return preset(id) ?? null;
}

/** The current mode (with acuity). */
export function currentVision(): VisionPreset {
  return (worldRef?.vision as VisionPreset | undefined) ?? preset(DEFAULT_VISION_ID)!;
}

export function setVision(id: string): void {
  const w = worldRef;
  const mode = resolveVision(id);
  if (!w || !mode) {
    console.warn(`[vision] unknown mode '${id}'`);
    return;
  }
  w.vision = mode as VisionMode;
  try {
    window.localStorage.setItem(VISION_STORAGE_KEY, mode.id);
  } catch {
    /* storage blocked */
  }
  for (const fn of listeners) fn(mode);
}

/** Called after every change. Returns unsubscribe. */
export function onVisionChange(fn: (mode: VisionPreset) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initVision(world: World): void {
  if (worldRef) return;
  worldRef = world;
  world.setVision = setVision;
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(VISION_STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
  const start = (saved && resolveVision(saved)) || preset(DEFAULT_VISION_ID)!;
  world.vision = start as VisionMode;
}
