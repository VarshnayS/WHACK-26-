// src/player/controller.ts
//
// First-person controller: WASD + mouse look (PointerLockControls), momentum,
// raycast ground-following, wall sliding, rebound, and the collision "stun" penalty.

import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { world } from '../world';
import {
  PLAYER_HEIGHT,
  REBOUND_MIN_IMPACT,
  checkCollision,
  computeRebound,
  groundHeight,
  initCollisionTestGeometry,
  setCollisionTargets,
} from './collision';
import { createStunEffect } from './stunEffect';
import { clampToPlayArea, isInsidePlayArea } from '../world/playArea';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MAX_SPEED = 5.5;          // m/s, cap (a brisk run)
const ACCELERATION = 3.0;       // m/s^2 while a key is held (~1.8 s to reach max)
const DECELERATION = 4.0;       // m/s^2 friction when no key is held (~1.4 s to stop)
const TURN_FRICTION = 4.0;      // 1/s, bleeds sideways velocity so direction changes feel responsive

const STUN_SPEED_THRESHOLD = 2.5; // m/s INTO a wall needed to stun (glancing slides don't count)
const STUN_MIN_DURATION = 0.5;    // s, at the threshold speed
const STUN_MAX_DURATION = 2.0;    // s, at MAX_SPEED
const STUN_FRICTION = 5.0;        // m/s^2, how fast the rebound slide dies off while stunned
const BUMP_EFFECT_DURATION = 0.4; // s, small camera wobble for non-stunning bumps
const BUMP_EFFECT_INTENSITY = 0.25;
const GROUND_SMOOTHING = 20;      // 1/s, smooths Y over small bumps (still "glued" to the floor)
const WALL_PUSH_OUT_DISTANCE = 0.3; // if closer than this to a wall, nudge away from it
const PLAY_AREA_INSET = 0.3;      // m, the player stops this far inside the corridor walls
const EXTERNAL_MAX_SPEED = 9;     // m/s, cap on speed after applyImpulse() (a car hit is a fling, not a launch)

/** Set to false when real terrain (world.tilesGroup) is ready. */
const USE_TEST_GEOMETRY = false;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ControllerOptions {
  /** Called when the player is stunned. Hook heavy breathing audio and monster AI here. */
  onStunned?: (duration: number, impactSpeed: number) => void;
}

/** Extra info for applyImpulse(). */
export interface ImpulseOptions {
  /**
   * Speed (m/s) of the hit along the contact normal. Compared with the same bump / stun thresholds
   * as wall hits (REBOUND_MIN_IMPACT, STUN_SPEED_THRESHOLD) and scales the stun duration the same way.
   */
  impactSpeed?: number;
  /** Stun regardless of impactSpeed (e.g. hit by a car); the duration still scales with impactSpeed. */
  forceStun?: boolean;
}

export interface PlayerController {
  controls: PointerLockControls;
  /** Current horizontal speed in m/s. */
  getSpeed(): number;
  /** Copies the current horizontal velocity (m/s, y = 0) into `out`. */
  getVelocity(out?: THREE.Vector3): THREE.Vector3;
  /**
   * External push (agent collisions): adds `impulse` (m/s, horizontal part only) to the velocity, so it
   * goes through the normal momentum, friction and wall-sliding. With `options.impactSpeed` it also
   * triggers the usual bump wobble / stun + onStunned using the same thresholds as wall hits.
   */
  applyImpulse(impulse: THREE.Vector3, options?: ImpulseOptions): void;
  isStunned(): boolean;
  /** Disable e.g. while the free-fly debug camera is active. */
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Keyboard state
// ---------------------------------------------------------------------------

const keys = new Set<string>();
const onKeyDown = (e: KeyboardEvent) => keys.add(e.code);
const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
const onBlur = () => keys.clear(); // avoid "stuck" keys when the window loses focus

function axis(positive: string, negative: string): number {
  return (keys.has(positive) ? 1 : 0) - (keys.has(negative) ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const velocity = new THREE.Vector3(); // horizontal only (y stays 0)
const wish = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const dirTmp = new THREE.Vector3();
const lateral = new THREE.Vector3();
const reboundTmp = new THREE.Vector3();
const clampTmp = new THREE.Vector3();
const clampNormal = new THREE.Vector3();
const lastNormal = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);

let current: PlayerController | null = null;

/** The live controller, or null before initController() has run (agents look it up each frame). */
export function getPlayerController(): PlayerController | null {
  return current;
}

export function initController(options: ControllerOptions = {}): PlayerController {
  const camera = world.camera as THREE.PerspectiveCamera;
  // PointerLockControls drives the camera directly, so camera.position is the player's eye position.
  const controls = new PointerLockControls(camera, world.renderer.domElement);
  const effect = createStunEffect(world.renderer.domElement);

  let enabled = true;
  let stunTimer = 0;

  // Collision targets
  if (USE_TEST_GEOMETRY) {
    initCollisionTestGeometry(world.scene);
    camera.position.set(0, PLAYER_HEIGHT, 0);
  } else {
    setCollisionTargets([world.tilesGroup]);
  }
  camera.position.y = groundHeight(camera.position) + PLAYER_HEIGHT;

  // Input listeners
  const onClick = () => {
    if (enabled && !controls.isLocked) controls.lock();
  };
  world.renderer.domElement.addEventListener('click', onClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  /**
   * Check for walls in the direction of travel and slide along them (two passes so
   * corners work). Returns the speed that was heading INTO a wall; the wall normal
   * of the strongest hit is left in `lastNormal`.
   */
  function resolveWalls(pos: THREE.Vector3): number {
    let impactSpeed = 0;
    for (let pass = 0; pass < 2; pass++) {
      const speed = velocity.length();
      if (speed < 1e-3) break;
      dirTmp.copy(velocity).divideScalar(speed);

      const hit = checkCollision(pos, dirTmp);
      if (!hit.blocked) break;

      // Remove only the component pushing into the wall -> slide along it.
      const into = -velocity.dot(hit.normal);
      if (into > 0) {
        if (into > impactSpeed) {
          impactSpeed = into;
          lastNormal.copy(hit.normal);
        }
        velocity.addScaledVector(hit.normal, into);
      }
      // If we've ended up too close, ease back out of the wall.
      if (hit.distance < WALL_PUSH_OUT_DISTANCE) {
        pos.addScaledVector(hit.normal, WALL_PUSH_OUT_DISTANCE - hit.distance);
      }
    }
    return impactSpeed;
  }

  /** Keep the player inside the corridor walls and drop the velocity pushing out through them. */
  function keepInsidePlayArea(pos: THREE.Vector3): void {
    if (isInsidePlayArea(pos, -PLAY_AREA_INSET)) return;
    clampToPlayArea(pos, PLAY_AREA_INSET, clampTmp);
    clampNormal.set(clampTmp.x - pos.x, 0, clampTmp.z - pos.z);
    pos.x = clampTmp.x;
    pos.z = clampTmp.z;
    const len = clampNormal.length();
    if (len < 1e-6) return;
    clampNormal.divideScalar(len); // points back into the corridor
    const into = velocity.dot(clampNormal);
    if (into < 0) velocity.addScaledVector(clampNormal, -into);
  }

  /**
   * Stun / bump for an impact that did not come from resolveWalls() (see applyImpulse). Same
   * thresholds and duration curve as the wall-hit stun in update().
   */
  function stunFromImpact(impactSpeed: number, force: boolean): void {
    if (impactSpeed < STUN_SPEED_THRESHOLD && !force) {
      if (impactSpeed >= REBOUND_MIN_IMPACT) effect.trigger(BUMP_EFFECT_DURATION, BUMP_EFFECT_INTENSITY);
      return;
    }
    const t = THREE.MathUtils.clamp(
      (impactSpeed - STUN_SPEED_THRESHOLD) / (MAX_SPEED - STUN_SPEED_THRESHOLD),
      0,
      1,
    );
    const duration = THREE.MathUtils.lerp(STUN_MIN_DURATION, STUN_MAX_DURATION, t);
    stunTimer = Math.max(stunTimer, duration);
    effect.trigger(duration, 0.5 + 0.5 * t);
    options.onStunned?.(duration, impactSpeed);
  }

  function update(dtRaw: number) {
    if (!enabled) return;
    const dt = Math.min(dtRaw, 0.05); // avoid huge steps after tab switches
    const pos = camera.position;

    if (stunTimer > 0) {
      // ---- Stunned: no input, but the rebound slide plays out and dies off ----
      stunTimer = Math.max(0, stunTimer - dt);
      const speed = velocity.length();
      if (speed > 0) {
        velocity.multiplyScalar(Math.max(0, speed - STUN_FRICTION * dt) / speed);
      }
      resolveWalls(pos); // don't bounce through a second wall
      pos.x += velocity.x * dt;
      pos.z += velocity.z * dt;
    } else {
      // ---- 1. Input -> wish direction (relative to where the camera faces) ----
      const ix = controls.isLocked ? axis('KeyD', 'KeyA') : 0;
      const iz = controls.isLocked ? axis('KeyW', 'KeyS') : 0;

      euler.setFromQuaternion(camera.quaternion);
      forward.set(0, 0, -1).applyAxisAngle(UP, euler.y);
      right.set(-forward.z, 0, forward.x);
      wish.set(0, 0, 0).addScaledVector(forward, iz).addScaledVector(right, ix);

      // ---- 2. Momentum / friction ----
      if (wish.lengthSq() > 0) {
        wish.normalize();
        // Bleed velocity that isn't along the wish direction, so turning feels crisp.
        const along = velocity.dot(wish);
        lateral.copy(velocity).addScaledVector(wish, -along);
        lateral.multiplyScalar(Math.max(0, 1 - TURN_FRICTION * dt));
        velocity.copy(lateral).addScaledVector(wish, along);
        // Speed builds up the longer the key is held.
        velocity.addScaledVector(wish, ACCELERATION * dt);
        if (velocity.length() > MAX_SPEED) velocity.setLength(MAX_SPEED);
      } else {
        const speed = velocity.length();
        if (speed > 0) {
          const newSpeed = Math.max(0, speed - DECELERATION * dt);
          velocity.multiplyScalar(newSpeed / speed);
        }
      }

      // ---- 3. Wall collision + sliding ----
      const impactSpeed = resolveWalls(pos);

      // ---- 4. Rebound: bounce back off the wall instead of dead-stopping ----
      if (impactSpeed >= REBOUND_MIN_IMPACT) {
        velocity.add(computeRebound(lastNormal, impactSpeed, reboundTmp));
      }

      // ---- 5. Stun on hard impacts (the rebound keeps carrying the player back) ----
      if (impactSpeed >= STUN_SPEED_THRESHOLD) {
        const t = THREE.MathUtils.clamp(
          (impactSpeed - STUN_SPEED_THRESHOLD) / (MAX_SPEED - STUN_SPEED_THRESHOLD),
          0,
          1,
        );
        const duration = THREE.MathUtils.lerp(STUN_MIN_DURATION, STUN_MAX_DURATION, t);
        stunTimer = duration;
        // Kill the sideways slide; only the rebound (away from the wall) remains.
        const away = velocity.dot(lastNormal);
        velocity.copy(lastNormal).multiplyScalar(Math.max(0, away));
        effect.trigger(duration, 0.5 + 0.5 * t);
        options.onStunned?.(duration, impactSpeed);
      } else if (impactSpeed >= REBOUND_MIN_IMPACT) {
        effect.trigger(BUMP_EFFECT_DURATION, BUMP_EFFECT_INTENSITY); // light bump: small wobble
      }

      // ---- 6. Apply horizontal movement ----
      pos.x += velocity.x * dt;
      pos.z += velocity.z * dt;
    }

    // ---- 6b. Stay inside the corridor walls (after either movement step) ----
    keepInsidePlayArea(pos);

    // ---- 7. Stay glued to the ground (with the stun head-dip) ----
    effect.update(dt);
    const targetY = groundHeight(pos) + PLAYER_HEIGHT - effect.headDip;
    pos.y += (targetY - pos.y) * Math.min(1, GROUND_SMOOTHING * dt);
  }

  world.onUpdate(update);

  const controller: PlayerController = {
    controls,
    getSpeed: () => velocity.length(),
    getVelocity: (out = new THREE.Vector3()) => out.copy(velocity),
    applyImpulse(impulse, impulseOptions = {}) {
      if (!enabled) return;
      velocity.x += impulse.x;
      velocity.z += impulse.z;
      velocity.y = 0;
      if (velocity.length() > EXTERNAL_MAX_SPEED) velocity.setLength(EXTERNAL_MAX_SPEED);
      stunFromImpact(impulseOptions.impactSpeed ?? 0, impulseOptions.forceStun ?? false);
    },
    isStunned: () => stunTimer > 0,
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) {
        velocity.set(0, 0, 0);
        if (controls.isLocked) controls.unlock();
      }
    },
    dispose() {
      world.renderer.domElement.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      effect.dispose();
      controls.dispose();
      if (current === controller) current = null;
    },
  };
  current = controller;
  return controller;
}