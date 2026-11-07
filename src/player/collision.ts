/**
 * src/player/collision.ts: collision + ground height
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 * Branch: feat/collision
 *
 * STUB: signatures are final, bodies are placeholders.
 * Implement with THREE.Raycaster against world.tilesGroup (works on geometry with no textures).
 * Add three-mesh-bvh only if FPS drops, and discuss it first (README "Dependencies").
 */
import type * as THREE from 'three';

export interface CollisionHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  object: THREE.Object3D;
}

/** Returns the first hit within arm's reach moving from `pos` along `dir`, or null. */
export function checkCollision(pos: THREE.Vector3, dir: THREE.Vector3): CollisionHit | null {
  void pos;
  void dir;
  return null; // placeholder: no collisions yet
}

/** World-space ground height (y) under `pos`. */
export function groundHeight(pos: THREE.Vector3): number {
  void pos;
  return 0; // placeholder: flat ground (README troubleshooting relies on this)
}
