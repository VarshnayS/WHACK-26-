/**
 * src/senses/cane.ts: the white cane
 * Owner: SENSES
 *
 * The cane is always out. It's drawn in first person as a thin tube from the lower-right of the view
 * to its tip on the ground ~1.2 m ahead, using the shared sonar material with its own arm's-reach
 * glow stretched over the whole cane, so it's always lit (and turns red with stun/danger pings like
 * everything else). The tip sits ~55° below the eye line, out of the 75° view, so the drawn tip is
 * raised to stay just inside the bottom edge; looking down shows it where it really is.
 *
 * SWEEPING
 *  - Manual: hold right mouse or controller RT (src/player/input.ts). Constant 100°/s across a 60° arc.
 *  - Auto-sweep (C / controller Y toggles; as before PR #20, C is a toggle): the two-point touch
 *    technique. Off by default with keyboard and mouse; a controller connecting turns it on (and the
 *    last one leaving turns it off again) unless the player has toggled it themselves. The tip
 *    swings in rhythm with the footsteps (src/senses/footsteps.ts) and touches down on the opposite
 *    side to the stepping foot (left tap on the right step), lifting slightly mid-arc. Each touch-down
 *    pings and ticks. Standing still, the cane rests in the centre.
 *  - Neither: the cane rests in the centre, still detecting what it bumps into.
 *
 * SWEEP SONAR: while sweeping, the tip sends a silent world.ping(tip, CANE_SWEEP_PING_RANGE, 'cane')
 * every CANE_SWEEP_PING_DEG of sweep, so sweeping paints the street ~4–5 m around the player.
 *
 * CONTACTS: every frame two short rays are cast against world.tilesGroup: along the shaft (hand to
 * tip) and from the previous tip to the new one, just above the ground. A steep surface (wall, curb
 * face, bollard) is a contact: the tip stops there (and bounces back when sweeping), and the cane
 * fires world.ping(tip, CANE_TAP_RANGE, 'cane') plus the tap sound and
 * world.audit.record({ kind: 'detected', caneActive: true, position: tip }). Its strength (0..1)
 * comes from how fast the tip was moving (sweep + walk + turn) and goes to onCaneContact listeners
 * (haptics, src/player/haptics.ts).
 * B = hard tap: world.ping(tip, CANE_HARD_TAP_RANGE, 'cane'), louder.
 *
 * Taps bump CaneState.tapSerial and auto-sweep touch-downs bump touchSerial; the soundscape
 * (src/audio/soundscape.ts) plays the tap / soft tick only for those, so the sweep pings stay silent.
 * Tuning: src/senses/config.ts.
 */
import * as THREE from 'three';
import type { World } from '../world';
import { EYE_HEIGHT } from '../config';
import { createSonarMaterial } from '../render/sonarMaterial';
import { getStepProgress } from './footsteps';
import { recordAudit } from '../player/auditRecord';
import { isCaneSweepHeld } from '../player/input';
import {
  CANE_ARC_DEG,
  CANE_AUTO_LIFT,
  CANE_AUTO_MAX_DEG_PER_S,
  CANE_AUTO_SWEEP,
  CANE_BOUNCE_LOCK,
  CANE_CONTACT_MIN_SPEED,
  CANE_CONTACT_REPEAT,
  CANE_HAND_DOWN,
  CANE_HAND_FORWARD,
  CANE_HAND_RIGHT,
  CANE_HARD_TAP_COOLDOWN,
  CANE_HARD_TAP_RANGE,
  CANE_HARD_TAP_STRENGTH,
  CANE_MAX_OBSTACLE_NORMAL_Y,
  CANE_REACH,
  CANE_REST_DEG_PER_S,
  CANE_STRENGTH_FULL_SPEED,
  CANE_SWEEP_DEG_PER_S,
  CANE_SWEEP_PING_DEG,
  CANE_SWEEP_PING_RANGE,
  CANE_SWEEP_RAY_HEIGHT,
  CANE_TAP_COOLDOWN,
  CANE_TAP_RANGE,
  CANE_VIEW_GRID,
  CANE_VIEW_HAND,
  CANE_VIEW_LIT_REACH,
  CANE_VIEW_MARGIN_DEG,
  CANE_VIEW_RADIUS_HAND,
  CANE_VIEW_RADIUS_TIP,
} from './config';

const DEG = Math.PI / 180;
const HALF_ARC = (CANE_ARC_DEG / 2) * DEG;
const SWEEP_SPEED = CANE_SWEEP_DEG_PER_S * DEG;
const AUTO_MAX_SPEED = CANE_AUTO_MAX_DEG_PER_S * DEG;
const REST_SPEED = CANE_REST_DEG_PER_S * DEG;
/** A tip jump longer than this in one frame is a teleport (run start, placeAt), not a fast swing. */
const TELEPORT_SQ = 1.5 * 1.5;
const UP = new THREE.Vector3(0, 1, 0);

const hand = new THREE.Vector3();
const tip = new THREE.Vector3();
const freeTip = new THREE.Vector3();
const prevTip = new THREE.Vector3();
const prevFreeTip = new THREE.Vector3();
const dir = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const rayOrigin = new THREE.Vector3();
const sweepDirV = new THREE.Vector3();
const normal = new THREE.Vector3();
const viewHand = new THREE.Vector3(CANE_VIEW_HAND[0], -CANE_VIEW_HAND[1], -CANE_VIEW_HAND[2]);
const viewTip = new THREE.Vector3();
const viewDir = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const raycaster = new THREE.Raycaster();

let initialised = false;

/** Live cane state (the soundscape and HUD read it). Read-only outside this file. */
export interface CaneState {
  /** True while the cane is sweeping (manual hold, or auto-sweep while walking). */
  held: boolean;
  /** Auto-sweep mode on (C / controller Y). */
  auto: boolean;
  /** Sweep angle in radians, + = to the player's left, within ±halfArc. */
  angle: number;
  /** Half the sweep arc in radians. */
  halfArc: number;
  /** True while the cane is against something. */
  touching: boolean;
  /** performance.now() / 1000 of the last tap (contact or hard tap). */
  lastTap: number;
  /** Bumped on every tap (not on sweep pings), so listeners can tell a tap from a sweep ping. */
  tapSerial: number;
  /** Whether the latest tap was a hard tap (B). */
  lastTapHard: boolean;
  /** 0..1 strength of the latest tap (tip speed for contacts, CANE_HARD_TAP_STRENGTH for hard taps). */
  lastTapStrength: number;
  /** Bumped on every auto-sweep touch-down (a soft tick, not a contact). */
  touchSerial: number;
}
const state: CaneState = {
  held: false,
  auto: CANE_AUTO_SWEEP,
  angle: 0,
  halfArc: HALF_ARC,
  touching: false,
  lastTap: -Infinity,
  tapSerial: 0,
  lastTapHard: false,
  lastTapStrength: 0,
  touchSerial: 0,
};

/** Where the cane tip is this frame (world space). Reused every frame: read it, don't keep it. */
export function getCaneTip(): Readonly<THREE.Vector3> {
  return tip;
}

export function getCaneState(): Readonly<CaneState> {
  return state;
}

/** A cane contact or hard tap, for haptics. */
export interface CaneContact {
  /** 0..1: how fast the tip hit (sweep speed + walk speed), or CANE_HARD_TAP_STRENGTH for a hard tap. */
  strength: number;
  hard: boolean;
  /** Tip position (a copy, safe to keep). */
  position: THREE.Vector3;
}
type ContactFn = (c: CaneContact) => void;
const contactListeners = new Set<ContactFn>();
const autoListeners = new Set<(on: boolean) => void>();

/** Called on every cane contact and hard tap. Returns unsubscribe. */
export function onCaneContact(fn: ContactFn): () => void {
  contactListeners.add(fn);
  return () => contactListeners.delete(fn);
}

/** Called whenever auto-sweep is switched on or off. Returns unsubscribe. */
export function onAutoSweepChange(fn: (on: boolean) => void): () => void {
  autoListeners.add(fn);
  return () => autoListeners.delete(fn);
}

/** True once the player has toggled auto-sweep themselves: controller connects no longer change it. */
let autoChosen = false;

export function setAutoSweep(on: boolean): void {
  if (on === state.auto) return;
  state.auto = on;
  for (const fn of autoListeners) fn(on);
}

/** The player's toggle (C / controller Y). */
export function toggleAutoSweep(): void {
  autoChosen = true;
  setAutoSweep(!state.auto);
}

/**
 * Default for the current input: on while a controller is connected, off with keyboard and mouse
 * (src/player/gamepad.ts calls this). Ignored once the player has toggled it.
 */
export function setAutoSweepDefault(on: boolean): void {
  if (!autoChosen) setAutoSweep(on);
}

/** Hard tap (B / controller A). Set in initCane. */
let hardTapImpl: () => void = () => {};
export function caneHardTap(): void {
  hardTapImpl();
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/**
 * First steep-surface hit along origin -> origin + d * len, or the first floor hit if `floorOut`
 * is given. Returns the obstacle hit point (in `out`) or null.
 */
function castCane(
  world: World,
  origin: THREE.Vector3,
  d: THREE.Vector3,
  len: number,
  out: THREE.Vector3,
  floorOut: THREE.Vector3 | null,
): 'obstacle' | 'floor' | null {
  if (len < 1e-3) return null;
  raycaster.set(origin, d);
  raycaster.near = 0;
  raycaster.far = len;
  const hits = raycaster.intersectObject(world.tilesGroup, true);
  for (const h of hits) {
    if (!h.face) continue;
    normal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    if (Math.abs(normal.y) < CANE_MAX_OBSTACLE_NORMAL_Y) {
      out.copy(h.point);
      return 'obstacle';
    }
    if (floorOut) {
      floorOut.copy(h.point);
      return 'floor';
    }
  }
  return null;
}

function approach(from: number, to: number, maxStep: number): number {
  const d = to - from;
  return Math.abs(d) <= maxStep ? to : from + Math.sign(d) * maxStep;
}

/** The visible cane: a unit tube along +Y (0..1), placed between the hand and the tip each frame. */
function createCaneMesh(): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(CANE_VIEW_RADIUS_TIP, CANE_VIEW_RADIUS_HAND, 1, 6, 1, true);
  geometry.translate(0, 0.5, 0);
  const material = createSonarMaterial({ name: 'cane', gridSpace: 'object', gridSize: CANE_VIEW_GRID });
  // This material only: stretch the always-on arm's-reach glow over the whole cane, so it's lit
  // along its length (the shared uniforms object is copied, never changed).
  material.uniforms = { ...material.uniforms, uArmReach: { value: CANE_VIEW_LIT_REACH } };
  // Additive: the black between the grid lines adds nothing, so only white (or red) lines show.
  material.blending = THREE.AdditiveBlending;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false; // the player always feels where their own cane is
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'cane';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

export function initCane(world: World): void {
  if (initialised) return;
  initialised = true;

  let angle = 0; // radians, + = to the player's left
  let sweepDir = 1;
  let lastTap = -Infinity;
  let lastHardTap = -Infinity;
  let first = true;
  let inContact = false;
  let lastBounce = -Infinity;
  let sweepTravel = 0; // degrees swept since the last sweep ping
  let lastStepCount = -1;
  let tipSpeed = 0; // m/s, unobstructed tip speed (sweep + walk + turn)

  const mesh = createCaneMesh();
  world.camera.add(mesh); // the camera is in the scene, so its children render

  // --- input (held sweep: right mouse / RT, read from src/player/input.ts each frame) ---
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    // Shift+C = mic recalibration (src/audio/index.ts), so plain C only
    if (e.code === 'KeyC' && !e.shiftKey) toggleAutoSweep();
    if (e.code === 'KeyB') hardTap();
  });

  function now(): number {
    return performance.now() / 1000;
  }

  function tap(range: number, hard: boolean, strength: number): void {
    // state first: the soundscape reads tapSerial when it sees the ping
    state.lastTap = now();
    state.lastTapHard = hard;
    state.lastTapStrength = strength;
    state.tapSerial++;
    world.ping(tip, range, 'cane');
    const c: CaneContact = { strength, hard, position: tip.clone() };
    for (const fn of contactListeners) fn(c);
  }

  function contact(): void {
    const t = now();
    if (t - lastTap < CANE_TAP_COOLDOWN) return;
    lastTap = t;
    tap(CANE_TAP_RANGE, false, Math.min(1, tipSpeed / CANE_STRENGTH_FULL_SPEED));
    recordAudit(world, { kind: 'detected', caneActive: true, position: tip.clone() });
  }

  function hardTap(): void {
    const t = now();
    if (t - lastHardTap < CANE_HARD_TAP_COOLDOWN) return;
    lastHardTap = t;
    lastTap = t; // the hard tap covers any contact this frame
    tap(CANE_HARD_TAP_RANGE, true, CANE_HARD_TAP_STRENGTH);
  }
  hardTapImpl = hardTap;

  world.onUpdate((dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const manual = isCaneSweepHeld();
    const step = getStepProgress();
    const autoSweeping = !manual && state.auto && step.moving;
    const sweeping = manual || autoSweeping;

    const cam = world.camera;
    euler.setFromQuaternion(cam.quaternion);
    forward.set(-Math.sin(euler.y), 0, -Math.cos(euler.y));
    right.set(-forward.z, 0, forward.x);

    // --- sweep angle ---
    const prevAngle = angle;
    let lift = 0;
    let touchDown = false;
    if (manual) {
      // constant speed, bouncing at the ends of the arc
      angle += sweepDir * SWEEP_SPEED * dt;
      if (angle > HALF_ARC) {
        angle = HALF_ARC;
        sweepDir = -1;
      } else if (angle < -HALF_ARC) {
        angle = -HALF_ARC;
        sweepDir = 1;
      }
    } else if (autoSweeping) {
      // two-point touch: at step n (even = right foot) the tip is on the left (+), odd = right (-)
      const target = HALF_ARC * Math.cos(Math.PI * (step.count + step.phase));
      angle = approach(angle, target, AUTO_MAX_SPEED * dt);
      sweepDir = angle >= prevAngle ? 1 : -1;
      lift = CANE_AUTO_LIFT * Math.sin(Math.PI * step.phase);
      touchDown = lastStepCount >= 0 && step.count !== lastStepCount;
    } else {
      angle = approach(angle, 0, REST_SPEED * dt);
    }
    lastStepCount = step.count;

    // --- physical cane: hand and tip in world space ---
    const feetY = cam.position.y - EYE_HEIGHT;
    hand
      .copy(cam.position)
      .addScaledVector(right, CANE_HAND_RIGHT)
      .addScaledVector(forward, CANE_HAND_FORWARD);
    hand.y -= CANE_HAND_DOWN;
    // tip on the ground, CANE_REACH ahead of the feet, rotated by the sweep angle (+ = left)
    dir.copy(forward).applyAxisAngle(UP, angle);
    tip.set(cam.position.x, feetY + 0.02 + lift, cam.position.z).addScaledVector(dir, CANE_REACH);
    freeTip.copy(tip);
    // teleported (run start / placeAt): don't sweep-cast across the jump or count it as tip speed
    if (first || freeTip.distanceToSquared(prevFreeTip) > TELEPORT_SQ) {
      prevTip.copy(tip);
      prevFreeTip.copy(tip);
    }
    // contact strength: how fast the unobstructed tip moves (sweep + walk + turning)
    tipSpeed = dt > 0 ? Math.hypot(freeTip.x - prevFreeTip.x, freeTip.z - prevFreeTip.z) / dt : 0;
    prevFreeTip.copy(freeTip);

    // 1) shaft: hand -> tip (walls in front; a floor hit just rests the tip on the ground)
    const shaftLen = dir.copy(tip).sub(hand).length();
    dir.divideScalar(shaftLen || 1);
    // a wall straight ahead shortens the cane but it keeps sweeping along it
    const obstacleAhead = castCane(world, hand, dir, shaftLen, tip, lift > 0 ? null : tip) === 'obstacle';

    // 2) sweep: last tip -> new tip, just above the ground (posts, curbs, wall bases to the side)
    let sideHit = false;
    if (!obstacleAhead) {
      rayOrigin.copy(prevTip);
      rayOrigin.y = Math.min(prevTip.y, tip.y) + CANE_SWEEP_RAY_HEIGHT;
      sweepDirV.copy(tip).sub(prevTip);
      sweepDirV.y = 0;
      const sweepLen = sweepDirV.length();
      if (sweepLen > 1e-3) {
        sweepDirV.divideScalar(sweepLen);
        if (castCane(world, rayOrigin, sweepDirV, sweepLen + 0.03, rayOrigin, null) === 'obstacle') {
          tip.set(rayOrigin.x, tip.y, rayOrigin.z);
          sideHit = true;
        }
      }
    }

    const t = now();
    prevTip.copy(tip);
    if (sideHit && manual && t - lastBounce > CANE_BOUNCE_LOCK) {
      // the tip bounces back off what it touched; start the next sweep ray just clear of it
      lastBounce = t;
      sweepDir = -sweepDir;
      prevTip.addScaledVector(sweepDirV, -0.04);
    }

    // tap on first touch, then every CANE_CONTACT_REPEAT s while it's still moving against something
    const touching = obstacleAhead || sideHit;
    if (touching && (!inContact || (t - lastTap >= CANE_CONTACT_REPEAT && tipSpeed >= CANE_CONTACT_MIN_SPEED))) {
      contact();
    }
    inContact = touching;

    // sweep sonar: a silent ping every CANE_SWEEP_PING_DEG of sweep; auto touch-downs ping + tick
    if (touchDown && !touching) {
      state.touchSerial++; // before the ping: the soundscape reads it
      world.ping(tip, CANE_SWEEP_PING_RANGE, 'cane');
      sweepTravel = 0;
    } else if (sweeping) {
      sweepTravel += Math.abs(angle - prevAngle) / DEG;
      if (sweepTravel >= CANE_SWEEP_PING_DEG) {
        sweepTravel %= CANE_SWEEP_PING_DEG;
        world.ping(tip, CANE_SWEEP_PING_RANGE, 'cane');
      }
    }

    first = false;
    state.held = sweeping;
    state.angle = angle;
    state.touching = touching;

    updateMesh(cam);
  });

  /** Place the visible tube from the drawn hand to the (raised if needed) tip, in camera space. */
  function updateMesh(cam: THREE.PerspectiveCamera): void {
    cam.updateMatrixWorld();
    viewTip.copy(tip);
    cam.worldToLocal(viewTip);
    // angle of the tip below the view direction, in the camera's vertical plane
    const below = Math.atan2(-viewTip.y, -viewTip.z);
    const maxBelow = (cam.fov / 2 - CANE_VIEW_MARGIN_DEG) * DEG;
    if (below > maxBelow) {
      // rotate it up about the camera's right axis until it's just inside the bottom edge
      const a = below - maxBelow;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const y = viewTip.y;
      const z = viewTip.z;
      viewTip.y = y * c - z * s;
      viewTip.z = y * s + z * c;
    }
    viewDir.copy(viewTip).sub(viewHand);
    const len = viewDir.length();
    if (len < 1e-4) return;
    viewDir.divideScalar(len);
    mesh.position.copy(viewHand);
    mesh.quaternion.setFromUnitVectors(UP, viewDir);
    mesh.scale.set(1, len, 1);
  }
}
