/**
 * src/senses/visionConfig.ts: vision presets (the judges' blindness scale). Plain constants only.
 *
 * Each preset fills the contract's VisionMode (src/shared/contracts.ts) plus `acuity`, a render-side
 * extension (0 = no detail at all, 1 = sharp) that the shader uses to blur distant lines.
 * How the shader reads them (src/render/sonarMaterial.ts):
 *   - visibleDistance: surfaces closer than this are always visible (no ping needed);
 *   - the visible cone's half-angle is min(peripheralLimitDeg, fovDeg / 2) around the gaze;
 *   - centralLossDeg: a blind spot of that width in the middle of the view;
 *   - acuity: fine grid lines only within visibleDistance * acuity, beyond that only the coarse grid.
 * Pings (voice, footsteps, cane, ...) always reveal on top of whatever the vision shows.
 */
import type { VisionMode } from '../shared/contracts';

export interface VisionPreset extends VisionMode {
  /** 0..1 sharpness (render-side extension of VisionMode). */
  acuity: number;
  /** One line for the picker: what this is like and typical causes. */
  note: string;
}

export const VISION_PRESETS: readonly VisionPreset[] = [
  {
    id: 'blind',
    label: 'Total blindness',
    note: 'No light perception. Sound and touch only.',
    visibleDistance: 0,
    fovDeg: 0,
    centralLossDeg: 0,
    peripheralLimitDeg: 0,
    acuity: 0,
  },
  {
    id: 'light-perception',
    label: 'Light perception only',
    note: 'Can tell light from dark nearby, but no shapes or detail.',
    visibleDistance: 6,
    fovDeg: 160,
    centralLossDeg: 0,
    peripheralLimitDeg: 80,
    acuity: 0.02,
  },
  {
    id: 'tunnel',
    label: 'Severe tunnel vision',
    note: 'Under 10° of field left, e.g. advanced glaucoma or retinitis pigmentosa.',
    visibleDistance: 30,
    fovDeg: 20,
    centralLossDeg: 0,
    peripheralLimitDeg: 10,
    acuity: 0.7,
  },
  {
    id: 'central-loss',
    label: 'Central field loss',
    note: 'A blind spot where you look, blurry periphery, e.g. macular degeneration.',
    visibleDistance: 20,
    fovDeg: 160,
    centralLossDeg: 30,
    peripheralLimitDeg: 80,
    acuity: 0.3,
  },
  {
    id: 'low-acuity',
    label: 'Low acuity',
    note: 'Full field but very blurred (around 6/60), e.g. cataract or optic atrophy.',
    visibleDistance: 12,
    fovDeg: 160,
    centralLossDeg: 0,
    peripheralLimitDeg: 80,
    acuity: 0.2,
  },
];

/** The severity slider runs from this preset (0) to total blindness (100). */
export const SEVERITY_FROM_ID = 'low-acuity';
export const SEVERITY_TO_ID = 'blind';
/** Ids of slider modes look like `severity:60`. */
export const SEVERITY_PREFIX = 'severity:';

/** Mode chosen when nothing is saved. */
export const DEFAULT_VISION_ID = 'blind';
/** Remember the last mode per browser. */
export const VISION_STORAGE_KEY = 'whack.vision';
