/**
 * src/player/haptics.ts: controller rumble, scaled by impact
 * Owner: SENSES
 *
 * Uses gamepad.vibrationActuator.playEffect('dual-rumble', { duration, strongMagnitude,
 * weakMagnitude }) on the active controller (src/player/gamepad.ts). If the pad or browser can't
 * rumble, that's logged once and everything else carries on.
 *
 * What vibrates (nothing else, for now):
 *  - cane contact / hard tap: a short sharp weak-motor pulse scaled by contact strength
 *    (src/senses/cane.ts onCaneContact);
 *  - bumps and stuns: the controller's existing impact score (PlayerImpact.level, the stun effect
 *    intensity: 0.25 light knock, 0.5..1 stun) mapped linearly to the strong motor (0.3..1) and
 *    duration (120..800 ms); the weak motor rises with it so a full stun is full on both motors;
 *  - car hits (forceStun): always maximum.
 *
 * Channels have priorities so a cane tick never cuts off a stun rumble. To add footsteps or an
 * entity heartbeat later: add a channel to PRIORITY and call rumble() from a listener here.
 * H (or LT+X) = haptics test: plays the next test level each press and shows its values.
 */
import { onCaneContact } from '../senses/cane';
import { onPlayerImpact, type PlayerImpact } from './controller';
import { getActivePad, onPadChange } from './gamepad';
import { showInputMessage } from '../hud/inputHud';

/** A dual-rumble effect. Magnitudes 0..1, duration in ms. */
export interface Rumble {
  duration: number;
  strong: number;
  weak: number;
}

/** Higher wins while it's playing. Future: footstep: 0, heartbeat: 2. */
const PRIORITY = { cane: 1, impact: 3, test: 4 } as const;
export type HapticChannel = keyof typeof PRIORITY;

// --- mapping (tuning) --------------------------------------------------------------------------

const CANE_WEAK_MIN = 0.25;
const CANE_WEAK_MAX = 0.9;
const CANE_MS_MIN = 35;
const CANE_MS_MAX = 70;
/** Impact score range from src/player/controller.ts: BUMP_EFFECT_INTENSITY .. full stun. */
const LEVEL_KNOCK = 0.25;
const LEVEL_FULL = 1;
const IMPACT_STRONG_MIN = 0.3;
const IMPACT_STRONG_MAX = 1;
const IMPACT_WEAK_MIN = 0.1;
const IMPACT_WEAK_MAX = 1;
const IMPACT_MS_MIN = 120;
const IMPACT_MS_MAX = 800;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Cane contact: weak motor only, short and sharp. `strength` 0..1. */
export function caneRumble(strength: number): Rumble {
  const s = clamp01(strength);
  return { duration: Math.round(lerp(CANE_MS_MIN, CANE_MS_MAX, s)), strong: 0, weak: lerp(CANE_WEAK_MIN, CANE_WEAK_MAX, s) };
}

/** Bump / stun from the controller's impact score; a car hit (forced) is always maximum. */
export function impactRumble(level: number, forced: boolean): Rumble {
  if (forced) return { duration: IMPACT_MS_MAX, strong: 1, weak: 1 };
  const u = clamp01((level - LEVEL_KNOCK) / (LEVEL_FULL - LEVEL_KNOCK));
  return {
    duration: Math.round(lerp(IMPACT_MS_MIN, IMPACT_MS_MAX, u)),
    strong: lerp(IMPACT_STRONG_MIN, IMPACT_STRONG_MAX, u),
    weak: lerp(IMPACT_WEAK_MIN, IMPACT_WEAK_MAX, u),
  };
}

// --- output ------------------------------------------------------------------------------------

interface Actuator {
  effects?: readonly string[];
  playEffect(type: string, params: { duration: number; strongMagnitude: number; weakMagnitude: number; startDelay?: number }): Promise<unknown>;
}

let busyUntil = 0;
let busyPriority = -1;
const warned = new Set<string>();
let lastResult: 'ok' | 'unsupported' | 'no-pad' | 'error' = 'no-pad';

function actuatorOf(pad: Gamepad): Actuator | null {
  const a = (pad as Gamepad & { vibrationActuator?: Actuator | null }).vibrationActuator;
  if (!a || typeof a.playEffect !== 'function') return null;
  if (Array.isArray(a.effects) && !a.effects.includes('dual-rumble')) return null;
  return a;
}

/** Whether the active controller can rumble (null = no controller). */
export function hapticsSupported(): boolean | null {
  const pad = getActivePad();
  return pad ? actuatorOf(pad) !== null : null;
}

/** Play `r` on `channel`. Returns false if skipped (no pad, unsupported, or a higher priority is playing). */
export function rumble(channel: HapticChannel, r: Rumble): boolean {
  const pad = getActivePad();
  if (!pad) {
    lastResult = 'no-pad';
    return false;
  }
  const act = actuatorOf(pad);
  if (!act) {
    lastResult = 'unsupported';
    if (!warned.has(pad.id)) {
      warned.add(pad.id);
      console.warn(`[haptics] no dual-rumble on "${pad.id}" in this browser; haptics off`);
    }
    return false;
  }
  const now = performance.now();
  const p = PRIORITY[channel];
  if (now < busyUntil && p < busyPriority) return false;
  busyUntil = now + r.duration;
  busyPriority = p;
  lastResult = 'ok';
  act
    .playEffect('dual-rumble', {
      duration: r.duration,
      strongMagnitude: clamp01(r.strong),
      weakMagnitude: clamp01(r.weak),
    })
    .catch((err: unknown) => {
      lastResult = 'error';
      if (!warned.has(`${pad.id}:error`)) {
        warned.add(`${pad.id}:error`);
        console.warn('[haptics] playEffect failed:', err);
      }
    });
  return true;
}

// --- wiring ------------------------------------------------------------------------------------

const TESTS: { label: string; make: () => Rumble }[] = [
  { label: 'cane tap (strength 0.5)', make: () => caneRumble(0.5) },
  { label: 'light knock (level 0.25)', make: () => impactRumble(0.25, false) },
  { label: 'mid stun (level 0.75)', make: () => impactRumble(0.75, false) },
  { label: 'full stun (level 1.0)', make: () => impactRumble(1, false) },
  { label: 'car hit (max)', make: () => impactRumble(1, true) },
];
let testIndex = 0;

function runTest(): void {
  const t = TESTS[testIndex];
  testIndex = (testIndex + 1) % TESTS.length;
  const r = t.make();
  const played = rumble('test', r);
  const values = `${r.duration} ms · strong ${r.strong.toFixed(2)} · weak ${r.weak.toFixed(2)}`;
  const note = played
    ? ''
    : lastResult === 'no-pad'
      ? '  (no controller connected)'
      : '  (this controller / browser cannot rumble)';
  showInputMessage(`Haptics test ${testIndex === 0 ? TESTS.length : testIndex}/${TESTS.length}: ${t.label}: ${values}${note}`, 3000);
}

let initialised = false;

export function initHaptics(): void {
  if (initialised) return;
  initialised = true;

  // check support as soon as a controller connects; log it once per controller
  onPadChange((pad) => {
    if (!pad || warned.has(pad.id)) return;
    warned.add(pad.id);
    if (actuatorOf(pad)) console.info(`[haptics] dual-rumble available on "${pad.id}"`);
    else console.warn(`[haptics] no dual-rumble on "${pad.id}" in this browser; haptics off`);
  });
  onCaneContact((c) => rumble('cane', caneRumble(c.strength)));
  onPlayerImpact((i: PlayerImpact) => rumble('impact', impactRumble(i.level, i.forced)));

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyH' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    runTest();
  });

  // console helper: blindSimHaptics.test() / .rumble({ duration, strong, weak })
  (window as unknown as Record<string, unknown>).blindSimHaptics = {
    test: runTest,
    rumble: (r: Rumble) => rumble('test', r),
    supported: hapticsSupported,
  };
}
