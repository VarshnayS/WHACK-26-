/**
 * src/world/debugCamera.ts: free-fly debug camera (toggle with F)
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * For checking tile/OSM alignment and warming the tile cache without the player controller.
 * Moves world.camera directly:
 *   mouse  look (click the canvas to lock the pointer)
 *   WASD   move horizontally      E / Q  up / down
 *   Shift  fast (x5)              G      drop to eye height above the ground
 * The player controller (src/player/controller.ts) should ignore input while
 * isDebugCameraActive() is true.
 */
import * as THREE from 'three';
import { world } from './index';
import { groundHeight } from '../player/collision';
import { EYE_HEIGHT } from '../config';

const WALK_SPEED = 4; // m/s
const FAST_MULTIPLIER = 5;
const LOOK_SENSITIVITY = 0.0022; // radians per pixel

let active = false;
let initialised = false;
let lockedByUs = false;
const keys = new Set<string>();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const move = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export function isDebugCameraActive(): boolean {
  return active;
}

function canvas(): HTMLCanvasElement {
  return world.renderer.domElement;
}

function requestLock(): void {
  try {
    // Returns a promise in current browsers; swallow "user gesture required" rejections.
    const result = canvas().requestPointerLock() as unknown;
    if (result instanceof Promise) result.catch(() => undefined);
    lockedByUs = true;
  } catch {
    /* pointer lock unavailable; mouse look will start after a click */
  }
}

export function setDebugCamera(on: boolean): void {
  if (on === active) return;
  active = on;
  keys.clear();
  if (on) {
    requestLock();
  } else if (lockedByUs && document.pointerLockElement === canvas()) {
    document.exitPointerLock();
    lockedByUs = false;
  }
}

export function toggleDebugCamera(): void {
  setDebugCamera(!active);
}

/** Put the camera at eye height above the ground under it. */
export function dropToEyeHeight(): void {
  const cam = world.camera.position;
  cam.y = groundHeight(cam) + EYE_HEIGHT;
}

function onKeyDown(e: KeyboardEvent): void {
  if (!active) return;
  keys.add(e.code);
  if (e.code === 'KeyG' && !e.repeat) dropToEyeHeight();
}

function onKeyUp(e: KeyboardEvent): void {
  keys.delete(e.code);
}

function onMouseMove(e: MouseEvent): void {
  if (!active || document.pointerLockElement !== canvas()) return;
  euler.setFromQuaternion(world.camera.quaternion);
  euler.y -= e.movementX * LOOK_SENSITIVITY;
  euler.x -= e.movementY * LOOK_SENSITIVITY;
  euler.x = THREE.MathUtils.clamp(euler.x, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  world.camera.quaternion.setFromEuler(euler);
}

function update(dt: number): void {
  if (!active) return;
  const cam = world.camera;

  cam.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  right.crossVectors(forward, UP).normalize();

  move.set(0, 0, 0);
  if (keys.has('KeyW')) move.add(forward);
  if (keys.has('KeyS')) move.sub(forward);
  if (keys.has('KeyD')) move.add(right);
  if (keys.has('KeyA')) move.sub(right);
  if (keys.has('KeyE')) move.y += 1;
  if (keys.has('KeyQ')) move.y -= 1;
  if (move.lengthSq() === 0) return;

  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
  move.normalize().multiplyScalar(WALK_SPEED * (fast ? FAST_MULTIPLIER : 1) * dt);
  cam.position.add(move);
}

/** Install listeners and the per-frame update. Safe to call more than once. */
export function initDebugCamera(): void {
  if (initialised) return;
  initialised = true;
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => keys.clear());
  document.addEventListener('mousemove', onMouseMove);
  canvas().addEventListener('click', () => {
    if (active && document.pointerLockElement !== canvas()) requestLock();
  });
  world.onUpdate(update);
}
