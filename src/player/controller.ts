// src/player/controller.ts
//
// First-person controller: WASD + mouse look (PointerLockControls), momentum,
// raycast ground-following, wall sliding, rebound, and the collision "stun" penalty.
// Movement comes from src/player/input.ts: keyboard + controller stick, added together and clamped.
// Keyboard alone behaves exactly as before PR #20: speed builds up to MAX_SPEED while a key is held
// (no Shift, no walk cap). The stick uses the same momentum; how far it's pushed scales the top speed.
// onPlayerImpact() reports every bump and stun (haptics).

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
  logCollisionHit,
  type CollisionHit,
} from './collision';
import { createStunEffect } from './stunEffect';
import { recordAudit } from './auditRecord';
import { attachInput, clearHeldInput, readMove, type MoveInput } from './input';
import { clampToPlayArea, isInsidePlayArea } from '../world/playArea';


// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MAX_SPEED = 5.5;          // m/s, cap (a brisk run); a part-pushed stick scales it down
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
// Red 'impact' ping at the wall on a stun (same scale SOUND uses for agent hits)
const WALL_IMPACT_RANGE_BASE = 6;     // m
const WALL_IMPACT_RANGE_PER_MPS = 2;  // m per m/s of impact speed
const WALL_IMPACT_RANGE_MAX = 20;     // m

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

/**
 * Payload of world.emit('stunned', ...), fired by this controller on every stun (walls and
 * applyImpulse hits: pedestrians, cars). Listeners: HUD red vignette, soundscape thud, audit.
 */
export interface StunnedPayload {
  /** Stun length in seconds. */
  duration: number;
  /** m/s along the contact normal. */
  impactSpeed: number;
  /** 0..1, how hard the hit was (drives the effects). */
  intensity: number;
  /** Contact point for wall hits, else the player's position (a copy, safe to keep). */
  position: THREE.Vector3;
  /** What caused it: a wall/tile hit, or an external push (agent collision). */
  source: 'wall' | 'impulse';
}

/** A bump or stun, for haptics. `level` is the stun effect's intensity (the existing impact score). */
export interface PlayerImpact {
  /** 0..1: BUMP_EFFECT_INTENSITY (0.25) for a light knock, 0.5..1 for a stun (0.5 + 0.5 t). */
  level: number;
  stunned: boolean;
  /** m/s along the contact normal. */
  impactSpeed: number;
  source: StunnedPayload['source'];
  /** applyImpulse(..., { forceStun: true }): only car hits do this. */
  forced: boolean;
}
type ImpactFn = (impact: PlayerImpact) => void;
const impactListeners = new Set<ImpactFn>();

/** Called on every bump and stun (walls, pedestrians, cars). Returns unsubscribe. */
export function onPlayerImpact(fn: ImpactFn): () => void {
  impactListeners.add(fn);
  return () => impactListeners.delete(fn);
}
function notifyImpact(impact: PlayerImpact): void {
  for (const fn of impactListeners) fn(impact);
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
  /** Clear stun, velocity, held keys and the daze effect (used when a run restarts). */
  reset(): void;
  /**
   * Teleport to `position` (x/z; y snaps to the ground), stop, clear any stun, and face `lookAt`
   * if given (level gaze). Clamped inside the corridor walls. Used for the route's start point.
   */
  placeAt(position: THREE.Vector3, lookAt?: THREE.Vector3): void;
  /** Disable e.g. while the free-fly debug camera is active. */
  setEnabled(enabled: boolean): void;
  dispose(): void;
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
const lastPoint = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);
const move: MoveInput = { x: 0, z: 0, amount: 0 };

let current: PlayerController | null = null;
let lastLoggedWallObject: THREE.Object3D | null = null;

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
  const detachInput = attachInput();

/**
 * Check for walls in the direction of travel and slide along them.
 * Returns the strongest impact speed and logs each newly encountered wall.
 */
function resolveWalls(pos: THREE.Vector3): number {
  let impactSpeed = 0;
  let strongestHit: CollisionHit | null = null;

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
        
        // Combine the properties we need from both branches
        lastPoint.copy(hit.point); // Needed from main
        strongestHit = hit;        // Needed from HEAD for the audit logger
      }
      
      // Stop the velocity into the wall (Execute ONLY once)
      velocity.addScaledVector(hit.normal, into);
    }

    // Ease back out if we've ended up too close (Execute ONLY once)
    if (hit.distance < WALL_PUSH_OUT_DISTANCE) {
      pos.addScaledVector(
        hit.normal,
        WALL_PUSH_OUT_DISTANCE - hit.distance,
      );
    }
  }

  // Log once when entering contact with a new wall.
  const contactObject = strongestHit?.object ?? null;

  if (strongestHit && contactObject !== lastLoggedWallObject) {
    logCollisionHit(strongestHit, impactSpeed, pos);
  }

  lastLoggedWallObject = contactObject;

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
      if (impactSpeed >= REBOUND_MIN_IMPACT) {
        effect.trigger(BUMP_EFFECT_DURATION, BUMP_EFFECT_INTENSITY);
        notifyImpact({ level: BUMP_EFFECT_INTENSITY, stunned: false, impactSpeed, source: 'impulse', forced: false });
      }
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
    // agents.ts / SOUND already fire the red impact ping and the audit record for agent hits
    emitStunned(duration, impactSpeed, 0.5 + 0.5 * t, camera.position, 'impulse');
    notifyImpact({ level: 0.5 + 0.5 * t, stunned: true, impactSpeed, source: 'impulse', forced: force });
  }

  function emitStunned(
    duration: number,
    impactSpeed: number,
    intensity: number,
    position: THREE.Vector3,
    source: StunnedPayload['source'],
  ): void {
    const payload: StunnedPayload = { duration, impactSpeed, intensity, position: position.clone(), source };
    world.emit('stunned', payload);
  }

  /** Wall/tile hit: audit record (contract: SENSES records wall collisions) + red ring on a stun. */
  function wallHit(impactSpeed: number, stunned: boolean): void {
    recordAudit(world, {
      kind: 'collision',
      hit: 'building',
      position: lastPoint.clone(),
      impactSpeed,
      normal: lastNormal.clone(),
    });
    if (!stunned) return;
    const range = Math.min(WALL_IMPACT_RANGE_MAX, WALL_IMPACT_RANGE_BASE + WALL_IMPACT_RANGE_PER_MPS * impactSpeed);
    world.ping(lastPoint, range, 'impact');
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
      // Keyboard (only while the mouse is locked, as before) + stick, clamped to length 1.
      readMove(controls.isLocked, move);
      const cap = MAX_SPEED * move.amount; // keyboard alone: amount = 1

      euler.setFromQuaternion(camera.quaternion);
      forward.set(0, 0, -1).applyAxisAngle(UP, euler.y);
      right.set(-forward.z, 0, forward.x);
      wish.set(0, 0, 0).addScaledVector(forward, move.z).addScaledVector(right, move.x);

      // ---- 2. Momentum / friction ----
      if (wish.lengthSq() > 0) {
        wish.normalize();
        // Bleed velocity that isn't along the wish direction, so turning feels crisp.
        const along = velocity.dot(wish);
        lateral.copy(velocity).addScaledVector(wish, -along);
        lateral.multiplyScalar(Math.max(0, 1 - TURN_FRICTION * dt));
        velocity.copy(lateral).addScaledVector(wish, along);
        const speed = velocity.length();
        if (cap < MAX_SPEED && speed > cap) {
          // eased off the stick: slow down to the new top speed (the keyboard never gets here)
          velocity.setLength(Math.max(cap, speed - DECELERATION * dt));
        } else {
          // Speed builds up the longer the key is held.
          velocity.addScaledVector(wish, ACCELERATION * dt);
          if (velocity.length() > cap) velocity.setLength(cap);
        }
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
        wallHit(impactSpeed, true);
        emitStunned(duration, impactSpeed, 0.5 + 0.5 * t, lastPoint, 'wall');
        notifyImpact({ level: 0.5 + 0.5 * t, stunned: true, impactSpeed, source: 'wall', forced: false });
      } else if (impactSpeed >= REBOUND_MIN_IMPACT) {
        effect.trigger(BUMP_EFFECT_DURATION, BUMP_EFFECT_INTENSITY); // light bump: small wobble
        wallHit(impactSpeed, false);
        notifyImpact({ level: BUMP_EFFECT_INTENSITY, stunned: false, impactSpeed, source: 'wall', forced: false });
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
    reset() {
      stunTimer = 0;
      velocity.set(0, 0, 0);
      clearHeldInput();
      effect.reset();
    },
    placeAt(position, lookAt) {
      const pos = camera.position;
      pos.x = position.x;
      pos.z = position.z;
      velocity.set(0, 0, 0);
      stunTimer = 0;
      keepInsidePlayArea(pos);
      pos.y = groundHeight(pos) + PLAYER_HEIGHT;
      if (lookAt) {
        const dx = lookAt.x - pos.x;
        const dz = lookAt.z - pos.z;
        // forward is (-sin yaw, 0, -cos yaw) in the YXZ euler update() reads
        if (dx * dx + dz * dz > 1e-6) camera.quaternion.setFromEuler(euler.set(0, Math.atan2(-dx, -dz), 0, 'YXZ'));
      }
      camera.updateMatrixWorld(true);
      lastLoggedWallObject = null;
    },
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) {
        velocity.set(0, 0, 0);
        if (controls.isLocked) controls.unlock();
      }
    },
    dispose() {
      world.renderer.domElement.removeEventListener('click', onClick);
      detachInput();
      effect.dispose();
      controls.dispose();
      if (current === controller) current = null;
    },
  };
  current = controller;
  return controller;
}