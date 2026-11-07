// src/player/collision.ts
//
// Raycast-based collision for the player. No bounding boxes and no physics
// engine, so the same code works on the temporary test geometry now and on the
// raw Google 3D Tiles mesh later.
//
// Public API (wire these into the shared `world` object later):
//   groundHeight(pos)          -> Y of the ground surface under pos.x / pos.z (0 if no hit)
//   checkCollision(pos, dir)   -> CollisionHit (blocked, distance, wall normal)
//   setCollisionTargets(objs)  -> choose which objects are solid
//   initCollisionTestGeometry  -> temporary flat ground + random box walls

import * as THREE from 'three';

/** Eye height above the ground, in metres. */
export const PLAYER_HEIGHT = 1.7;
/** Walls closer than this (along the movement ray) block movement. */
export const WALL_THRESHOLD = 0.5;
/** Ground ray starts this far above the player's eye (i.e. just above the head). */
const GROUND_RAY_START_OFFSET = 0.2;

/**
 * Heights (relative to the eye) at which horizontal wall rays are cast:
 * roughly knee-ish, waist and chest. Starting above ~0.5 m means small curbs
 * don't count as walls.
 */
const WALL_RAY_HEIGHT_OFFSETS = [-1.2, -0.7, -0.1];
/** Extra rays fanned out either side of the movement direction (radians), so thin
 *  obstacles and corners are caught as well as dead-ahead walls. */
const WALL_RAY_ANGLES = [0, Math.PI / 6, -Math.PI / 6];
/** Surfaces whose normal is more vertical than this are floor/slope, not wall. */
const MAX_WALL_NORMAL_Y = 0.7;

export interface CollisionHit {
  blocked: boolean;
  /** Distance along the ray to the wall (Infinity if not blocked). */
  distance: number;
  /** Horizontal unit normal of the wall, facing back towards the player. */
  normal: THREE.Vector3;
  point: THREE.Vector3;
  object: THREE.Object3D | null;
}

// ---------------------------------------------------------------------------
// Collision targets
// ---------------------------------------------------------------------------

let targets: THREE.Object3D[] = [];

/** Set the objects the player collides with. For the real game use [world.tilesGroup]. */
export function setCollisionTargets(objects: THREE.Object3D[]): void {
  targets = objects;
}

const raycaster = new THREE.Raycaster();
const tmpOrigin = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/**
 * Y coordinate of the ground surface below `pos` (NOT including player height).
 * Casts straight down from just above the player's head. Returns 0 if nothing is hit.
 * Controller sets camera Y = groundHeight(pos) + PLAYER_HEIGHT.
 */
export function groundHeight(pos: THREE.Vector3): number {
  tmpOrigin.set(pos.x, pos.y + GROUND_RAY_START_OFFSET, pos.z);
  raycaster.set(tmpOrigin, DOWN);
  raycaster.near = 0;
  raycaster.far = Infinity;
  const hits = raycaster.intersectObjects(targets, true);
  return hits.length > 0 ? hits[0].point.y : 0;
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

function noHit(): CollisionHit {
  return {
    blocked: false,
    distance: Infinity,
    normal: new THREE.Vector3(),
    point: new THREE.Vector3(),
    object: null,
  };
}

/**
 * Cast horizontal rays from `pos` in the (horizontal) direction `dir`.
 * If any wall is within `threshold` metres, returns blocked = true along with
 * the wall's horizontal normal. The caller uses the normal to remove only the
 * velocity component pushing into the wall (wall sliding).
 */
export function checkCollision(
  pos: THREE.Vector3,
  dir: THREE.Vector3,
  threshold: number = WALL_THRESHOLD,
): CollisionHit {
  const result = noHit();

  tmpDir.set(dir.x, 0, dir.z);
  if (tmpDir.lengthSq() < 1e-8) return result;
  tmpDir.normalize();
  const baseDir = tmpDir.clone();

  raycaster.near = 0;
  raycaster.far = threshold;

  for (const hOff of WALL_RAY_HEIGHT_OFFSETS) {
    for (const angle of WALL_RAY_ANGLES) {
      const rayDir = baseDir.clone().applyAxisAngle(UP, angle);
      tmpOrigin.set(pos.x, pos.y + hOff, pos.z);
      raycaster.set(tmpOrigin, rayDir);

      const hits = raycaster.intersectObjects(targets, true);
      if (hits.length === 0) continue;
      const hit = hits[0];
      if (hit.distance >= result.distance || !hit.face) continue;

      // World-space face normal.
      tmpNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      // Ignore floors / walkable slopes.
      if (Math.abs(tmpNormal.y) > MAX_WALL_NORMAL_Y) continue;

      tmpNormal.y = 0;
      if (tmpNormal.lengthSq() < 1e-8) continue;
      tmpNormal.normalize();
      // Tile meshes can have inconsistent winding: always face the player.
      if (tmpNormal.dot(baseDir) > 0) tmpNormal.negate();

      result.blocked = true;
      result.distance = hit.distance;
      result.normal.copy(tmpNormal);
      result.point.copy(hit.point);
      result.object = hit.object;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Rebound
// ---------------------------------------------------------------------------

/** Impacts slower than this (m/s into the wall) don't bounce at all. */
export const REBOUND_MIN_IMPACT = 1.0;
/** Fraction of the impact speed returned as bounce (0 = dead stop, 1 = perfect bounce). */
export const REBOUND_RESTITUTION = 0.3;
/** Upper limit on bounce speed (m/s), so a full-speed crash is a stumble, not a ricochet. */
export const REBOUND_MAX_SPEED = 1.8;

/**
 * Velocity impulse that pushes the player back off a wall after an impact.
 * `normal` is the horizontal wall normal from checkCollision (facing the player) and
 * `impactSpeed` is the speed that was heading into the wall. Add the result to the
 * player's velocity AFTER the into-wall component has been removed (sliding).
 */
export function computeRebound(
  normal: THREE.Vector3,
  impactSpeed: number,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  if (impactSpeed < REBOUND_MIN_IMPACT) return out.set(0, 0, 0);
  const speed = Math.min(impactSpeed * REBOUND_RESTITUTION, REBOUND_MAX_SPEED);
  return out.copy(normal).setY(0).normalize().multiplyScalar(speed);
}

// ---------------------------------------------------------------------------
// Temporary test geometry (remove once real terrain is ready)
// ---------------------------------------------------------------------------

/** Small seeded RNG so the test layout is identical for everyone. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Adds a flat PlaneGeometry ground and a few random BoxGeometry walls to
 * `scene`, and registers them as the collision targets.
 *
 * Uses a dim wireframe material so you can see the layout in the black scene.
 * Swap for the shared sonar material if you want it to match the rest of the game.
 */
export function initCollisionTestGeometry(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();
  group.name = 'collision-test-geometry';

  const material = new THREE.MeshBasicMaterial({
    color: 0x888888,
    wireframe: true,
    side: THREE.DoubleSide,
  });

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200, 100, 100), material);
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  const rand = mulberry32(26);
  for (let i = 0; i < 25; i++) {
    const w = 1 + rand() * 4;
    const h = 2 + rand() * 3;
    const d = 1 + rand() * 4;
    const x = (rand() - 0.5) * 60;
    const z = (rand() - 0.5) * 60;
    if (Math.hypot(x, z) < 5) continue; // keep the spawn point clear

    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    box.position.set(x, h / 2, z);
    box.rotation.y = rand() * Math.PI;
    group.add(box);
  }

  scene.add(group);
  group.updateMatrixWorld(true); // raycasts use matrixWorld
  setCollisionTargets([group]);
  return group;
}