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
import { MAX_PINGS, type ActivePing } from '../shared/contracts';
import { world } from '../world';
import { WAVE_SPEED } from '../config';
import { PING_UNUSED, sonarUniforms } from './sonarMaterial';
import { getDevPings, initDevPings } from './devPings';
import { pingColor } from './pingColors';

/** Thinnest ring drawn, in metres (keeps the shader's smoothstep well defined). */
const MIN_THICKNESS = 0.05;
/** A ping whose whole range was passed this many fade time-constants ago is invisible: skip it. */
const FADED_AFTER = 6;

/**
 * @deprecated Shape of the old ping list (still imported by src/world/index.ts). Use ActivePing
 * from src/shared/contracts.ts.
 */
export interface Ping {
  origin: THREE.Vector3;
  range: number;
  start: number;
}

/**
 * @deprecated No-op. Ping storage now lives in SOUND's world.ping(); this stays only so
 * src/world/index.ts compiles until SOUND rewires it.
 */
export function addPing(origin: THREE.Vector3, range: number): void {
  void origin;
  void range;
}

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
  const c = pingColor(p.type, p.style);
  if (c) u.uPingC.value[i].set(c[0], c[1], c[2], 1);
  else u.uPingC.value[i].set(1, 1, 1, 0);
  // legacy layout for src/world/agentMaterial.ts: a start time that gives the same radius at WAVE_SPEED
  u.uPingOrigin.value[i].copy(p.origin);
  u.uPingStart.value[i] = t - radius / WAVE_SPEED;
  u.uPingRange.value[i] = p.range;
  return true;
}

function writeAll(list: readonly ActivePing[], n: number, t: number): number {
  for (let j = 0; j < list.length && n < MAX_PINGS; j++) if (writePing(list[j], n, t)) n++;
  return n;
}

/** Called once per frame by src/main.ts: time, player position and active pings -> uniforms. */
export function updatePings(playerPos: THREE.Vector3): void {
  const t = now();
  const u = sonarUniforms;
  u.uTime.value = t;
  u.uPlayerPos.value.copy(playerPos);

  let n = writeAll(world.activePings(), 0, t);
  if (import.meta.env.DEV) {
    initDevPings();
    n = writeAll(getDevPings(t), n, t);
  }
  u.uPingCount.value = n;
  for (let i = n; i < MAX_PINGS; i++) u.uPingStart.value[i] = PING_UNUSED;
}

/** Currently active pings (same as world.activePings()). */
export function getActivePings(): readonly ActivePing[] {
  return world.activePings();
}

/** Shader clock in seconds (same clock as ActivePing.start). */
export function now(): number {
  return performance.now() / 1000;
}
