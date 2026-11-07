/**
 * src/audio/tuning.ts: live mic tuning keys, saved per browser
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 *
 *   [ / ]  sensitivity down / up (pulse size)
 *   - / =  trigger level down / up (dB above room noise needed to fire)
 *   0      back to the defaults in detector.ts (QUICK TUNING block)
 *
 * Every mic is different, so each teammate's browser keeps its own values in localStorage.
 * Storage failures (private window, blocked storage) just mean the defaults are used.
 */
import { DETECTOR_CONFIG, SENSITIVITY, TRIGGER_DB, type DetectorConfig } from './detector';

const STORAGE_KEY = 'blind-sim.audio-tuning.v1';

export const SENSITIVITY_MIN = 0.25;
export const SENSITIVITY_MAX = 4;
const SENSITIVITY_STEP = 1.15; // multiplicative
export const TRIGGER_MIN_DB = 6;
export const TRIGGER_MAX_DB = 35;
const TRIGGER_STEP_DB = 1;

interface SavedTuning {
  sensitivity: number;
  thresholdDb: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Apply saved values (if any) onto the config. Returns true if something was loaded. */
export function loadTuning(cfg: DetectorConfig = DETECTOR_CONFIG): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return false;
    const t = v as Partial<Record<keyof SavedTuning, unknown>>;
    if (typeof t.sensitivity === 'number' && Number.isFinite(t.sensitivity)) {
      cfg.sensitivity = clamp(t.sensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX);
    }
    if (typeof t.thresholdDb === 'number' && Number.isFinite(t.thresholdDb)) {
      cfg.thresholdDb = clamp(t.thresholdDb, TRIGGER_MIN_DB, TRIGGER_MAX_DB);
    }
    return true;
  } catch {
    return false;
  }
}

function save(cfg: DetectorConfig): void {
  try {
    const v: SavedTuning = { sensitivity: cfg.sensitivity, thresholdDb: cfg.thresholdDb };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    // Storage unavailable: the change still applies for this session.
  }
}

/**
 * Handle a tuning key. Returns a short HUD message if the key was a tuning key, else null.
 */
export function handleTuningKey(code: string, cfg: DetectorConfig = DETECTOR_CONFIG): string | null {
  switch (code) {
    case 'BracketLeft':
      cfg.sensitivity = clamp(cfg.sensitivity / SENSITIVITY_STEP, SENSITIVITY_MIN, SENSITIVITY_MAX);
      break;
    case 'BracketRight':
      cfg.sensitivity = clamp(cfg.sensitivity * SENSITIVITY_STEP, SENSITIVITY_MIN, SENSITIVITY_MAX);
      break;
    case 'Minus':
      cfg.thresholdDb = clamp(cfg.thresholdDb - TRIGGER_STEP_DB, TRIGGER_MIN_DB, TRIGGER_MAX_DB);
      break;
    case 'Equal':
      cfg.thresholdDb = clamp(cfg.thresholdDb + TRIGGER_STEP_DB, TRIGGER_MIN_DB, TRIGGER_MAX_DB);
      break;
    case 'Digit0':
      cfg.sensitivity = SENSITIVITY;
      cfg.thresholdDb = TRIGGER_DB;
      break;
    default:
      return null;
  }
  save(cfg);
  return describeTuning(cfg);
}

export function describeTuning(cfg: DetectorConfig = DETECTOR_CONFIG): string {
  return `Sensitivity ${cfg.sensitivity.toFixed(2)}×  ·  trigger ${cfg.thresholdDb.toFixed(0)} dB above room  ([ ] and - = to adjust, 0 resets)`;
}
