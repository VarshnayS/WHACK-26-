/**
 * src/senses/cane.ts: the white cane
 * Owner: SENSES
 *
 * Hold right mouse or C to sweep the cane left/right in front of the player (~1.2 m reach, ~60° arc).
 * It's drawn as a thin white line that is always visible (not masked by the sonar) while held.
 *
 * SWEEP SONAR: while held, the tip sends a silent world.ping(tip, CANE_SWEEP_PING_RANGE, 'cane')
 * every CANE_SWEEP_PING_DEG of sweep, so sweeping paints the street ~4–5 m around the player.
 *
 * Every frame two short rays are cast against world.tilesGroup: one along the shaft (hand to tip)
 * and one swept from the previous tip to the new one, just above the ground. A steep surface
 * (wall, curb face, bollard) is a contact: the tip stops there and bounces back, and the cane fires
 * world.ping(tip, CANE_TAP_RANGE, 'cane') plus world.audit.record({ kind: 'detected', caneActive: true }).
 * V while holding = a hard tap: world.ping(tip, CANE_HARD_TAP_RANGE, 'cane'). Taps bump
 * CaneState.tapSerial; the soundscape (src/audio/soundscape.ts) plays the tap sound only for those,
 * so the sweep pings stay silent.
 * Flat hits along the shaft (the floor) just rest the tip on the ground.
 * Tuning: src/senses/config.ts.
 */
import * as THREE from 'three';
import type { World } from '../world';
import { EYE_HEIGHT } from '../config';
import {
  CANE_ARC_DEG,
  CANE_BOUNCE_LOCK,
  CANE_CONTACT_REPEAT,
  CANE_HAND_DOWN,
  CANE_HAND_FORWARD,
  CANE_HAND_RIGHT,
  CANE_HARD_TAP_COOLDOWN,
  CANE_HARD_TAP_RANGE,
  CANE_LINE_OPACITY,
  CANE_MAX_OBSTACLE_NORMAL_Y,
  CANE_REACH,
  CANE_SWEEP_DEG_PER_S,
  CANE_SWEEP_PING_DEG,
  CANE_SWEEP_PING_RANGE,
  CANE_SWEEP_RAY_HEIGHT,
  CANE_TAP_COOLDOWN,
  CANE_TAP_RANGE,
} from './config';

const DEG = Math.PI / 180;
const HALF_ARC = (CANE_ARC_DEG / 2) * DEG;
const SWEEP_SPEED = CANE_SWEEP_DEG_PER_S * DEG;

const hand = new THREE.Vector3();
const tip = new THREE.Vector3();
const prevTip = new THREE.Vector3();
const dir = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const rayOrigin = new THREE.Vector3();
const sweepDirV = new THREE.Vector3();
const normal = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const raycaster = new THREE.Raycaster();

let initialised = false;

/** Live cane state for the HUD indicator (src/hud/caneIndicator.ts). Read-only outside this file. */
export interface CaneState {
  held: boolean;
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
  /** Whether the latest tap was a hard tap (V). */
  lastTapHard: boolean;
}
const state: CaneState = {
  held: false,
  angle: 0,
  halfArc: 0,
  touching: false,
  lastTap: -Infinity,
  tapSerial: 0,
  lastTapHard: false,
};

export function getCaneState(): Readonly<CaneState> {
  return state;
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

export function initCane(world: World): void {
  if (initialised) return;
  initialised = true;

  let mouseHeld = false;
  let keyHeld = false;
  let angle = 0; // radians, + = to the player's left
  let sweepDir = 1;
  let lastTap = -Infinity;
  let lastHardTap = -Infinity;
  let wasHeld = false;
  let inContact = false;
  let lastBounce = -Infinity;
  let sweepTravel = 0; // degrees swept since the last sweep ping

  // --- the line (white, always visible while held) ---
  const positions = new Float32Array(6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: CANE_LINE_OPACITY,
    depthTest: false, // drawn over the black world: the player always sees their own cane
  });
  const line = new THREE.Line(geometry, material);
  line.name = 'cane';
  line.frustumCulled = false;
  line.renderOrder = 10;
  line.visible = false;
  world.scene.add(line);

  // --- input ---
  const held = () => mouseHeld || keyHeld;
  window.addEventListener('mousedown', (e) => {
    if (e.button === 2) mouseHeld = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) mouseHeld = false;
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyC' && !e.shiftKey) keyHeld = true; // Shift+C = mic recalibration
    if (e.code === 'KeyV' && !e.repeat && held()) hardTap();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyC') keyHeld = false;
  });
  window.addEventListener('blur', () => {
    mouseHeld = false;
    keyHeld = false;
  });

  function now(): number {
    return performance.now() / 1000;
  }

  function tap(range: number, hard: boolean): void {
    // state first: the soundscape reads tapSerial when it sees the ping
    state.lastTap = now();
    state.lastTapHard = hard;
    state.tapSerial++;
    world.ping(tip, range, 'cane');
  }

  function contact(): void {
    const t = now();
    if (t - lastTap < CANE_TAP_COOLDOWN) return;
    lastTap = t;
    tap(CANE_TAP_RANGE, false);
    world.audit.record({ kind: 'detected', caneActive: true, position: tip.clone() });
  }

  function hardTap(): void {
    const t = now();
    if (t - lastHardTap < CANE_HARD_TAP_COOLDOWN) return;
    lastHardTap = t;
    lastTap = t; // the hard tap covers any contact this frame
    tap(CANE_HARD_TAP_RANGE, true);
  }

  world.onUpdate((dt) => {
    const isHeld = held();
    line.visible = isHeld;
    state.held = isHeld;
    state.halfArc = HALF_ARC;
    if (!isHeld) {
      wasHeld = false;
      state.touching = false;
      return;
    }

    const cam = world.camera;
    euler.setFromQuaternion(cam.quaternion);
    forward.set(-Math.sin(euler.y), 0, -Math.cos(euler.y));
    right.set(-forward.z, 0, forward.x);

    // sweep: constant speed, bouncing at the ends of the arc
    const prevAngle = angle;
    angle += sweepDir * SWEEP_SPEED * Math.min(dt, 0.05);
    if (angle > HALF_ARC) {
      angle = HALF_ARC;
      sweepDir = -1;
    } else if (angle < -HALF_ARC) {
      angle = -HALF_ARC;
      sweepDir = 1;
    }

    const feetY = cam.position.y - EYE_HEIGHT;
    hand
      .copy(cam.position)
      .addScaledVector(right, CANE_HAND_RIGHT)
      .addScaledVector(forward, CANE_HAND_FORWARD);
    hand.y -= CANE_HAND_DOWN;
    // tip on the ground, CANE_REACH ahead of the feet, rotated by the sweep angle (+ = left)
    dir.copy(forward).applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle);
    tip.set(cam.position.x, feetY + 0.02, cam.position.z).addScaledVector(dir, CANE_REACH);
    if (!wasHeld) prevTip.copy(tip);

    // 1) shaft: hand -> tip (walls in front; a floor hit just rests the tip on the ground)
    const shaftLen = dir.copy(tip).sub(hand).length();
    dir.divideScalar(shaftLen || 1);
    // a wall straight ahead shortens the cane but it keeps sweeping along it
    const obstacleAhead = castCane(world, hand, dir, shaftLen, tip, tip) === 'obstacle';

    // 2) sweep: last tip -> new tip, just above the ground (posts, curbs, wall bases to the side)
    let sideHit = false;
    if (!obstacleAhead) {
      rayOrigin.copy(prevTip);
      rayOrigin.y += CANE_SWEEP_RAY_HEIGHT;
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
    if (sideHit && t - lastBounce > CANE_BOUNCE_LOCK) {
      // the tip bounces back off what it touched; start the next sweep ray just clear of it
      lastBounce = t;
      sweepDir = -sweepDir;
      prevTip.addScaledVector(sweepDirV, -0.04);
    }

    // tap on first touch, then every CANE_CONTACT_REPEAT s while it stays against something
    const touching = obstacleAhead || sideHit;
    if (touching && (!inContact || t - lastTap >= CANE_CONTACT_REPEAT)) contact();
    inContact = touching;

    // sweep sonar: a silent ping from the tip every CANE_SWEEP_PING_DEG of sweep (one on pick-up)
    sweepTravel += Math.abs(angle - prevAngle) / DEG;
    if (!wasHeld || sweepTravel >= CANE_SWEEP_PING_DEG) {
      sweepTravel = wasHeld ? sweepTravel % CANE_SWEEP_PING_DEG : 0;
      world.ping(tip, CANE_SWEEP_PING_RANGE, 'cane');
    }
    wasHeld = true;
    state.angle = angle;
    state.touching = touching;

    positions[0] = hand.x;
    positions[1] = hand.y;
    positions[2] = hand.z;
    positions[3] = tip.x;
    positions[4] = tip.y;
    positions[5] = tip.z;
    geometry.attributes.position.needsUpdate = true;
  });
}
