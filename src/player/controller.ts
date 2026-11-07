/**
 * src/player/controller.ts: first-person movement
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 * Branch: feat/mic-hud-audio
 *
 * STUB: signatures are final, bodies are placeholders.
 */
import type * as THREE from 'three';
import { world } from '../world';

/**
 * Set up PointerLockControls (click to lock, Esc to release), WASD walking at EYE_HEIGHT,
 * and register movement with world.onUpdate().
 *
 * TODO(C): debug keys from the README
 *  - Space: test ping, world.ping(world.camera.position, range)
 *  - F: toggle free-fly debug camera
 *  - R: setRevealAll() from src/render/sonarMaterial.ts
 * Movement should respect checkCollision()/groundHeight() from ./collision once implemented.
 */
export function initController(): void {
  // placeholder
}

/** Player position (the camera position). */
export function getPlayerPosition(): THREE.Vector3 {
  return world.camera.position;
}
