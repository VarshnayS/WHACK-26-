/**
 * src/player/gamepad.ts: controller input (Gamepad API, no dependencies)
 * Owner: SENSES
 *
 * Listens for gamepadconnected / gamepaddisconnected (HUD toast) and polls navigator.getGamepads()
 * every frame, so a pad that was already plugged in is picked up on its first button press as well.
 * With no controller everything falls back silently to keyboard and mouse.
 *
 *  - Left stick: analogue movement (PlayerController.setPadInput); L3 toggles run.
 *  - Right stick: look (rotates world.camera like PointerLockControls; works without pointer lock).
 *  - RT: hold to sweep the cane (setCanePadHeld). LT: hold for the second layer.
 *  - Everything else comes from PAD_BINDINGS (src/player/gamepadConfig.ts). A 'key' binding sends
 *    the same keydown on press and keyup on release to window, so a button does exactly what its
 *    key does, whichever module owns that key.
 *
 * Sticks are ignored while the start screen / vision overlay is open or the free-fly camera is on.
 */
import * as THREE from 'three';
import { world } from '../world';
import { getPlayerController } from './controller';
import { setCanePadHeld } from '../senses/cane';
import { VISION_PRESETS } from '../senses/visionConfig';
import { isOverlayOpen } from '../hud/startScreen';
import { isDebugCameraActive } from '../world/debugCamera';
import { showInputMessage } from '../hud/inputHud';
import {
  LOOK_CURVE,
  LOOK_PITCH_SPEED,
  LOOK_YAW_SPEED,
  PAD,
  PAD_BINDINGS,
  RUN_CANCEL_BELOW,
  STICK_DEADZONE,
  TRIGGER_THRESHOLD,
  type PadAction,
  type PadBinding,
} from './gamepadConfig';

const BUTTON_COUNT = 17;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

let activeIndex: number | null = null;
let activePad: Gamepad | null = null;
const prev: boolean[] = new Array(BUTTON_COUNT).fill(false);
/** The binding a button fired on press, so its release sends the matching keyup (even if LT changed). */
const firedOnPress: (PadBinding | null)[] = new Array(BUTTON_COUNT).fill(null);
let runToggle = false;
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

type PadListener = (pad: Gamepad | null) => void;
const padListeners = new Set<PadListener>();

/** The controller in use (latest snapshot), or null. */
export function getActivePad(): Gamepad | null {
  return activePad;
}

/** Called when a controller connects (pad) or the last one disconnects (null). Returns unsubscribe. */
export function onPadChange(fn: PadListener): () => void {
  padListeners.add(fn);
  return () => padListeners.delete(fn);
}

function setActive(pad: Gamepad | null): void {
  const changed = (pad?.index ?? null) !== activeIndex;
  activeIndex = pad?.index ?? null;
  activePad = pad;
  if (!changed) return;
  prev.fill(false);
  firedOnPress.fill(null);
  runToggle = false;
  if (pad) {
    showInputMessage(`Controller connected: ${shortName(pad.id)}`, 2500);
    console.info(`[gamepad] connected: ${pad.id} (mapping "${pad.mapping || 'none'}")`);
    if (pad.mapping !== 'standard') {
      console.warn('[gamepad] non-standard mapping: buttons may be in different places');
    }
  } else {
    showInputMessage('Controller disconnected: keyboard and mouse', 2500);
    getPlayerController()?.setPadInput(0, 0, false);
    setCanePadHeld(false);
  }
  for (const fn of padListeners) fn(pad);
}

function shortName(id: string): string {
  return id.replace(/\s*\(.*\)\s*$/, '').trim() || id;
}

function pressed(pad: Gamepad, i: number): boolean {
  const b = pad.buttons[i];
  if (!b) return false;
  return i === PAD.LT || i === PAD.RT ? b.value > TRIGGER_THRESHOLD : b.pressed;
}

/** Radial deadzone, rescaled so the edge of the deadzone reads 0. */
function stick(x: number, y: number): [number, number, number] {
  const mag = Math.hypot(x, y);
  if (mag < STICK_DEADZONE) return [0, 0, 0];
  const scaled = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return [(x / mag) * scaled, (y / mag) * scaled, scaled];
}

function curve(v: number): number {
  return Math.sign(v) * Math.pow(Math.abs(v), LOOK_CURVE);
}

function sendKey(type: 'keydown' | 'keyup', action: Extract<PadAction, { kind: 'key' }>): void {
  window.dispatchEvent(
    new KeyboardEvent(type, {
      code: action.code,
      key: action.code === 'Space' ? ' ' : action.code,
      shiftKey: !!action.shift,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function cycleVision(step: -1 | 1): void {
  const ids = VISION_PRESETS.map((p) => p.id);
  const at = ids.indexOf(world.vision.id);
  const next = at < 0 ? (step > 0 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length;
  world.setVision(ids[next]);
  showInputMessage(`Vision: ${world.vision.label}`, 1500);
}

function buttonDown(i: number, lt: boolean): void {
  if (i === PAD.L3 && !lt) {
    runToggle = !runToggle;
    return;
  }
  const name = (Object.keys(PAD) as (keyof typeof PAD)[]).find((k) => PAD[k] === i);
  if (!name) return;
  const layer = lt ? 'lt' : 'base';
  const b = PAD_BINDINGS.find((x) => x.button === name && x.layer === layer);
  if (!b) return;
  firedOnPress[i] = b;
  if (b.action.kind === 'key') sendKey('keydown', b.action);
  else cycleVision(b.action.step);
}

function buttonUp(i: number): void {
  const b = firedOnPress[i];
  firedOnPress[i] = null;
  if (b && b.action.kind === 'key') sendKey('keyup', b.action);
}

function poll(dt: number): void {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let pad: Gamepad | null = activeIndex !== null ? (pads[activeIndex] ?? null) : null;
  if (!pad || !pad.connected) {
    pad = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
  }
  setActive(pad);
  if (!pad) return;

  // --- buttons (edges) ---
  const lt = pressed(pad, PAD.LT);
  for (let i = 0; i < BUTTON_COUNT; i++) {
    if (i === PAD.LT || i === PAD.RT) continue;
    const now = pressed(pad, i);
    if (now && !prev[i]) buttonDown(i, lt);
    else if (!now && prev[i]) buttonUp(i);
    prev[i] = now;
  }

  // --- held inputs ---
  const live = !isOverlayOpen() && !isDebugCameraActive();
  setCanePadHeld(live && pressed(pad, PAD.RT));

  const [mx, my, mmag] = live ? stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0) : [0, 0, 0];
  if (mmag < RUN_CANCEL_BELOW) runToggle = false;
  getPlayerController()?.setPadInput(mx, -my, runToggle);

  if (!live) return;
  const [lx, ly] = stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
  if (lx === 0 && ly === 0) return;
  const cam = world.camera;
  euler.setFromQuaternion(cam.quaternion);
  euler.y -= curve(lx) * LOOK_YAW_SPEED * dt;
  euler.x = THREE.MathUtils.clamp(euler.x - curve(ly) * LOOK_PITCH_SPEED * dt, -PITCH_LIMIT, PITCH_LIMIT);
  cam.quaternion.setFromEuler(euler);
}

let initialised = false;

export function initGamepad(): void {
  if (initialised) return;
  initialised = true;
  if (!('getGamepads' in navigator)) {
    console.info('[gamepad] Gamepad API unavailable: keyboard and mouse only');
    return;
  }
  window.addEventListener('gamepadconnected', (e) => {
    if (activeIndex === null) setActive((e as GamepadEvent).gamepad);
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    if ((e as GamepadEvent).gamepad.index === activeIndex) setActive(null);
  });
  world.onUpdate((dt) => poll(Math.min(dt, 0.05)));
}
