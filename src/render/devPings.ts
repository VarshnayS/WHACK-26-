/**
 * src/render/devPings.ts: DEV ONLY fake pings for testing the sonar shader
 * Owner: RENDER (feat/sonar-render)
 *
 * Until SOUND's world.activePings() returns real pings, these let you see the shader work:
 *
 *   P        fire a fake ping of the next type (voice, footstep, cane, car, pedestrian, impact)
 *            from the player; the type is logged to the console
 *   Shift+P  fire one of each type in a row ahead of the player, to compare their looks
 *
 * src/render/pings.ts only calls into this file inside `if (import.meta.env.DEV)`, so production
 * builds drop it. The styles below are only a suggestion for SOUND's real per-type styles.
 */
import * as THREE from 'three';
import type { ActivePing, PingStyle, PingType } from '../shared/contracts';
import { world } from '../world';
import { EYE_HEIGHT } from '../config';

interface DevPingPreset {
  range: number;
  style: PingStyle;
  /** Fired from the feet instead of the head. */
  atFeet: boolean;
}

/** Suggested look per type: voice = big and lingering, cane = thin and crisp, footstep = tiny, ... */
export const DEV_PING_PRESETS: Record<PingType, DevPingPreset> = {
  voice: { range: 40, atFeet: false, style: { speed: 30, thickness: 1.5, brightness: 1.0, fade: 0.8 } },
  footstep: { range: 6, atFeet: true, style: { speed: 12, thickness: 0.4, brightness: 0.5, fade: 2.5 } },
  cane: { range: 5, atFeet: true, style: { speed: 20, thickness: 0.15, brightness: 0.9, fade: 3.5 } },
  car: { range: 25, atFeet: true, style: { speed: 40, thickness: 3.0, brightness: 0.6, fade: 1.5 } },
  pedestrian: { range: 5, atFeet: true, style: { speed: 10, thickness: 0.5, brightness: 0.35, fade: 3 } },
  impact: { range: 30, atFeet: false, style: { speed: 55, thickness: 0.8, brightness: 1.0, fade: 1.0 } },
  tactile: { range: 1.2, atFeet: true, style: { speed: 8, thickness: 0.15, brightness: 1.0, fade: 4 } },
  entity: { range: 12, atFeet: true, style: { speed: 6, thickness: 1.0, brightness: 1.0, fade: 0.35 } },
};

const TYPES = Object.keys(DEV_PING_PRESETS) as PingType[];
/** Spacing of the Shift+P row, in metres. */
const ROW_SPACING = 8;
/** Fake pings are dropped this long after they reach their range (s). */
const LINGER = 6;

const pings: ActivePing[] = [];
let nextType = 0;
let installed = false;

function fire(type: PingType, origin: THREE.Vector3, t: number): void {
  const preset = DEV_PING_PRESETS[type];
  const o = origin.clone();
  if (preset.atFeet) o.y -= EYE_HEIGHT - 0.1;
  pings.push({ origin: o, range: preset.range, type, start: t, style: { ...preset.style } });
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.code !== 'KeyP' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  const t = performance.now() / 1000;
  const cam = world.camera;
  if (e.shiftKey) {
    const forward = new THREE.Vector3();
    cam.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    TYPES.forEach((type, i) => fire(type, cam.position.clone().addScaledVector(forward, ROW_SPACING * (i + 1)), t));
    console.info(`[render dev] fake pings, one of each ahead: ${TYPES.join(', ')}`);
  } else {
    const type = TYPES[nextType++ % TYPES.length];
    fire(type, cam.position, t);
    console.info(`[render dev] fake ping: ${type}`);
  }
}

/** Install the P key once (dev only). */
export function initDevPings(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', onKeyDown);
  console.info('[render dev] P = fake ping (cycles types), Shift+P = one of each type');
}

/** Live fake pings, newest first so a fresh test ping always gets a shader slot. */
export function getDevPings(t: number): readonly ActivePing[] {
  for (let i = pings.length - 1; i >= 0; i--) {
    const p = pings[i];
    if (t - p.start > p.range / p.style.speed + LINGER) pings.splice(i, 1);
  }
  return pings.slice().reverse();
}
