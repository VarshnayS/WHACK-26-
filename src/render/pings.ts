/**
 * src/render/pings.ts: active pings -> shader uniforms
 * Owner: @USERNAME_B (sonar material)
 * Branch: feat/sonar-material
 *
 * STUB: signatures are final, bodies are placeholders.
 * Other modules fire pings through world.ping(origin, range), which calls addPing().
 */
import type * as THREE from 'three';

export interface Ping {
  /** World-space origin (copied, so the caller can reuse its vector). */
  origin: THREE.Vector3;
  /** Maximum distance in metres the wave reveals. */
  range: number;
  /** Start time in seconds (same clock as uTime). */
  start: number;
}

const pings: Ping[] = [];

/** Record a new ping. TODO(B): clone origin, use now(), drop the oldest beyond MAX_PINGS. */
export function addPing(origin: THREE.Vector3, range: number): void {
  void origin;
  void range; // placeholder
}

/**
 * Called once per frame by src/main.ts. TODO(B): expire finished pings and copy the
 * live ones + time + player position into sonarUniforms.
 */
export function updatePings(playerPos: THREE.Vector3): void {
  void playerPos; // placeholder
}

/** Currently active pings (e.g. for the entity AI: "last noise position"). */
export function getActivePings(): readonly Ping[] {
  return pings;
}

/** Shader clock in seconds. */
export function now(): number {
  return performance.now() / 1000;
}
