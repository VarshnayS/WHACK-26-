/**
 * src/render/pings.ts: active pings -> sonar shader uniforms (read-only consumer)
 * Owner: RENDER (feat/sonar-render)
 *
 * SOUND owns ping storage (world.ping / world.activePings()). Once per frame, updatePings() (called
 * by src/main.ts) reads world.activePings() (priority order, at most MAX_PINGS) and writes each
 * ping's origin, current radius, range and style into the uniforms of src/render/sonarMaterial.ts.
 *
 * Dev builds also mix in fake pings from src/render/devPings.ts (P / Shift+P) so the shader can be
 * tested before SOUND's pings land. Never in production builds.
 */
import type * as THREE from 'three';
import { MAX_PINGS, type ActivePing, type VisionMode } from '../shared/contracts';
import { world } from '../world';
import { sonarUniforms } from './sonarMaterial';
import { getDevPings, initDevPings } from './devPings';
import { pingColor, pingTrailLevel } from './pingColors';

const WHITE = [1, 1, 1] as const;

/** Thinnest ring drawn, in metres (keeps the shader's smoothstep well defined). */
const MIN_THICKNESS = 0.05;
/** A ping whose whole range was passed this many fade time-constants ago is invisible: skip it. */
const FADED_AFTER = 6;

/** Write one ping into slot `i`. Returns false if the ping isn't visible (slot stays free). */
function writePing(p: ActivePing, i: number, t: number): boolean {
  const { speed, thickness, brightness, fade } = p.style;
  const age = t - p.start;
  if (age < 0 || !(speed > 0) || !(p.range > 0) || !(brightness > 0)) return false;
  const radius = age * speed;
  const fadePerMetre = Math.max(fade, 0) / speed;
  // the last revealed point (at range) was passed (radius - range) / speed seconds ago
  if (radius > p.range && (radius - p.range) * fadePerMetre > FADED_AFTER) return false;

  const u = sonarUniforms;
  u.uPingA.value[i].set(p.origin.x, p.origin.y, p.origin.z, radius);
  u.uPingB.value[i].set(p.range, Math.max(thickness, MIN_THICKNESS), Math.min(brightness, 1), fadePerMetre);
  const c = pingColor(p.type, p.style) ?? WHITE;
  u.uPingC.value[i].set(c[0], c[1], c[2], pingTrailLevel(p.type));
  return true;
}

function writeAll(list: readonly ActivePing[], n: number, t: number): number {
  for (let j = 0; j < list.length && n < MAX_PINGS; j++) if (writePing(list[j], n, t)) n++;
  return n;
}

const DEG = Math.PI / 180;

/** world.vision (+ render-side acuity) and the gaze -> vision uniforms. */
function updateVision(): void {
  const u = sonarUniforms;
  const v = world.vision as VisionMode & { acuity?: number };
  u.uVisDist.value = Math.max(0, v.visibleDistance);
  u.uVisOuter.value = Math.max(0, Math.min(v.peripheralLimitDeg, v.fovDeg / 2)) * DEG;
  u.uVisInner.value = Math.max(0, v.centralLossDeg / 2) * DEG;
  u.uVisAcuity.value = Math.min(1, Math.max(0, v.acuity ?? 1));
  world.camera.getWorldDirection(u.uViewDir.value);
}

/** Called once per frame by src/main.ts: time, player position, vision and active pings -> uniforms. */
export function updatePings(playerPos: THREE.Vector3): void {
  const t = now();
  const u = sonarUniforms;
  u.uTime.value = t;
  u.uPlayerPos.value.copy(playerPos);
  updateVision();

  let n = writeAll(world.activePings(), 0, t);
  if (import.meta.env.DEV) {
    initDevPings();
    n = writeAll(getDevPings(t), n, t);
  }
  u.uPingCount.value = n;
}

/** Currently active pings (same as world.activePings()). */
export function getActivePings(): readonly ActivePing[] {
  return world.activePings();
}

/** Shader clock in seconds (same clock as ActivePing.start). */
export function now(): number {
  return performance.now() / 1000;
}
