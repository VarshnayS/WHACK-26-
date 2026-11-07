/**
 * src/world/playArea.ts: the play corridor along University Road (boundary walls)
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * A straight rectangle centred on the origin: CORRIDOR_LENGTH along CORRIDOR_BEARING and
 * ±CORRIDOR_HALF_WIDTH across (src/config.ts). Walls are vertical and infinitely high.
 *
 * For the collision owner (C): world.isInsidePlayArea(pos) is the wall test; clampToPlayArea()
 * gives the nearest point inside, e.g. to push the player back after a step.
 *
 * Local frame (same as the tiles): Y up, metres, +X = west, +Z = north.
 */
import * as THREE from 'three';
import { CORRIDOR_BEARING, CORRIDOR_HALF_WIDTH, CORRIDOR_LENGTH } from '../config';

const bearing = THREE.MathUtils.degToRad(CORRIDOR_BEARING);

/** Unit vector along the road (direction of CORRIDOR_BEARING) in the local frame. */
export const CORRIDOR_ALONG = new THREE.Vector3(-Math.sin(bearing), 0, Math.cos(bearing));
/** Unit vector across the road; CORRIDOR_ACROSS x up = CORRIDOR_ALONG (right-handed basis). */
export const CORRIDOR_ACROSS = new THREE.Vector3(Math.cos(bearing), 0, Math.sin(bearing));
export const CORRIDOR_HALF_LENGTH = CORRIDOR_LENGTH / 2;

/** Rotation taking corridor coordinates (x = across, y = up, z = along) into the local frame. */
export const CORRIDOR_BASIS = new THREE.Matrix4().makeBasis(CORRIDOR_ACROSS, new THREE.Vector3(0, 1, 0), CORRIDOR_ALONG);

/** Position in corridor coordinates: metres along the road and across it (y ignored). */
export function toCorridor(pos: THREE.Vector3): { along: number; across: number } {
  return {
    along: pos.x * CORRIDOR_ALONG.x + pos.z * CORRIDOR_ALONG.z,
    across: pos.x * CORRIDOR_ACROSS.x + pos.z * CORRIDOR_ACROSS.z,
  };
}

/**
 * True if `pos` is inside the corridor walls (height ignored).
 * `margin` > 0 grows the area, < 0 shrinks it (e.g. -0.3 to keep a body radius off the wall).
 */
export function isInsidePlayArea(pos: THREE.Vector3, margin = 0): boolean {
  const { along, across } = toCorridor(pos);
  return Math.abs(along) <= CORRIDOR_HALF_LENGTH + margin && Math.abs(across) <= CORRIDOR_HALF_WIDTH + margin;
}

/** Nearest point inside the corridor (shrunk by `inset` metres); y is kept. Writes into `out`. */
export function clampToPlayArea(pos: THREE.Vector3, inset = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const { along, across } = toCorridor(pos);
  const a = THREE.MathUtils.clamp(along, -CORRIDOR_HALF_LENGTH + inset, CORRIDOR_HALF_LENGTH - inset);
  const c = THREE.MathUtils.clamp(across, -CORRIDOR_HALF_WIDTH + inset, CORRIDOR_HALF_WIDTH - inset);
  const y = pos.y;
  return out
    .set(0, 0, 0)
    .addScaledVector(CORRIDOR_ALONG, a)
    .addScaledVector(CORRIDOR_ACROSS, c)
    .setY(y);
}

/** Corner points (local frame, y = 0) of the corridor grown by `margin` metres. */
export function corridorCorners(margin = 0): THREE.Vector3[] {
  const a = CORRIDOR_HALF_LENGTH + margin;
  const c = CORRIDOR_HALF_WIDTH + margin;
  return [
    [-a, -c],
    [a, -c],
    [a, c],
    [-a, c],
  ].map(([sa, sc]) => new THREE.Vector3().addScaledVector(CORRIDOR_ALONG, sa).addScaledVector(CORRIDOR_ACROSS, sc));
}

/**
 * Debug outline of the walls (two white rectangles at 0 m and 4 m plus corner posts).
 * Hidden by default; debugKeys.ts shows it while reveal-all (R) is on. Not part of the game look.
 */
export function createPlayAreaOutline(): THREE.LineSegments {
  const corners = corridorCorners();
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    for (const h of [0, 4]) points.push(a.clone().setY(h), b.clone().setY(h));
    points.push(a.clone().setY(0), a.clone().setY(4));
  }
  const outline = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xffffff }),
  );
  outline.name = 'playAreaOutline';
  outline.visible = false;
  outline.frustumCulled = false;
  return outline;
}
