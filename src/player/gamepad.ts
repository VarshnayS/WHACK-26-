/**
 * src/player/gamepad.ts: controller input (Gamepad API, no dependencies)
 * Owner: SENSES
 *
 * The gamepad SOURCE for src/player/input.ts. It never touches the keyboard state and never replaces
 * it: the left stick goes to setPadSource() and is ADDED to the keys there.
 *
 *  - Inert without a controller: polling only runs while at least one pad has fired
 *    'gamepadconnected' (browsers fire it on the pad's first button press, also for pads that were
 *    already plugged in). No pad = no getGamepads() calls and no writes, every frame.
 *  - Hot-plugging and several pads: the most recently active pad (a button, trigger or stick past the
 *    deadzone) drives the game; switching releases anything the old pad was holding.
 *  - Layout: 'standard' mapping indices; any other mapping is read through PAD_LAYOUTS
 *    (src/player/gamepadConfig.ts) and the pad id is logged once.
 *  - Left stick: movement (radial deadzone). Right stick: look (rotates world.camera like
 *    PointerLockControls does, so mouse and stick add up; works without pointer lock).
 *  - RT: hold to sweep the cane. LT: hold for the second layer.
 *  - Everything else comes from PAD_BINDINGS. A 'key' binding sends the same keydown on press and
 *    keyup on release to window, so a button does exactly what its key does.
 *  - Connecting a controller turns cane auto-sweep on (and the last one leaving turns it back off)
 *    unless the player has toggled it themselves.
 *
 * Sticks are ignored while the start screen / vision overlay is open or the free-fly camera is on.
 */
import * as THREE from 'three';
import { world } from '../world';
import { setAutoSweepDefault } from '../senses/cane';
import { VISION_PRESETS } from '../senses/visionConfig';
import { isOverlayOpen } from '../hud/startScreen';
import { isDebugCameraActive } from '../world/debugCamera';
import { showInputMessage } from '../hud/inputHud';
import { clearPadSource, setActivePad, setPadSource } from './input';
import {
  LOOK_CURVE,
  LOOK_PITCH_SPEED,
  LOOK_YAW_SPEED,
  PAD,
  PAD_BINDINGS,
  PAD_LAYOUTS,
  STICK_DEADZONE,
  TRIGGER_THRESHOLD,
  type PadAction,
  type PadBinding,
  type PadButton,
  type PadLayout,
} from './gamepadConfig';

export { getActivePad, onPadChange } from './input';

const BUTTON_COUNT = 16; // A .. D-pad right (the Home / guide button is never bound)
const PITCH_LIMIT = Math.PI / 2 - 0.05;
const BUTTON_NAMES = Object.keys(PAD) as PadButton[];

// ---------------------------------------------------------------------------
// Reading a pad into standard order
// ---------------------------------------------------------------------------

/** One pad's state in standard order. */
interface Snapshot {
  pressed: boolean[];
  /** Stick axes after the radial deadzone: [lx, ly, rx, ry]. */
  sticks: [number, number, number, number];
  /** Left-stick deflection after the deadzone, 0..1. */
  moveMag: number;
  /** Anything being touched (picks the active pad). */
  active: boolean;
}

function newSnapshot(): Snapshot {
  return { pressed: new Array(BUTTON_COUNT).fill(false), sticks: [0, 0, 0, 0], moveMag: 0, active: false };
}

/** Radial deadzone, rescaled so the edge of the deadzone reads 0. Returns the scaled magnitude. */
function deadzone(x: number, y: number, out: number[], at: number): number {
  const mag = Math.hypot(x, y);
  if (!(mag >= STICK_DEADZONE)) {
    out[at] = 0;
    out[at + 1] = 0;
    return 0;
  }
  const scaled = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  out[at] = (x / mag) * scaled;
  out[at + 1] = (y / mag) * scaled;
  return scaled;
}

const layoutCache = new Map<string, PadLayout | null>();

/** null = standard mapping (read directly). Logs the id once for anything else. */
function layoutFor(pad: Gamepad): PadLayout | null {
  const key = `${pad.mapping}|${pad.id}`;
  if (layoutCache.has(key)) return layoutCache.get(key)!;
  let layout: PadLayout | null = null;
  if (pad.mapping !== 'standard') {
    layout = PAD_LAYOUTS.find((l) => l.match.test(pad.id)) ?? PAD_LAYOUTS[PAD_LAYOUTS.length - 1];
    console.info(`[gamepad] "${pad.id}" reports mapping "${pad.mapping || 'none'}": using the "${layout.name}" fallback layout`);
  }
  layoutCache.set(key, layout);
  return layout;
}

/** Triggers on axes rest at -1, but some browsers report 0 until first touched: ignore until it moves. */
const triggerAxisSeen = new Set<string>();

function triggerFromAxis(pad: Gamepad, axis: number): number {
  const v = pad.axes[axis];
  if (v === undefined) return 0;
  const k = `${pad.index}:${axis}`;
  if (!triggerAxisSeen.has(k)) {
    if (v === 0) return 0;
    triggerAxisSeen.add(k);
  }
  return (v + 1) / 2;
}

/** Hat switch: -1 = up, clockwise in steps of 2/7; anything outside -1..1 = centred. */
function hatDirections(v: number | undefined): { up: boolean; down: boolean; left: boolean; right: boolean } {
  const none = { up: false, down: false, left: false, right: false };
  if (v === undefined || Math.abs(v) > 1.001) return none;
  const i = Math.round((v + 1) * 3.5) % 8; // 0 up, 1 up-right, 2 right, ... 7 up-left
  return { up: i === 7 || i === 0 || i === 1, right: i >= 1 && i <= 3, down: i >= 3 && i <= 5, left: i >= 5 && i <= 7 };
}

function readPad(pad: Gamepad, out: Snapshot): Snapshot {
  const layout = layoutFor(pad);
  let anyButton = false;
  const btn = (raw: number | undefined, trigger: boolean): boolean => {
    if (raw === undefined) return false;
    const b = pad.buttons[raw];
    if (!b) return false;
    return trigger ? b.value > TRIGGER_THRESHOLD : b.pressed;
  };
  if (!layout) {
    for (let i = 0; i < BUTTON_COUNT; i++) out.pressed[i] = btn(i, i === PAD.LT || i === PAD.RT);
  } else {
    for (const name of BUTTON_NAMES) {
      const i = PAD[name];
      out.pressed[i] = btn(layout.buttons[name], name === 'LT' || name === 'RT');
    }
    if (layout.triggerAxes) {
      out.pressed[PAD.LT] = triggerFromAxis(pad, layout.triggerAxes.LT) > TRIGGER_THRESHOLD;
      out.pressed[PAD.RT] = triggerFromAxis(pad, layout.triggerAxes.RT) > TRIGGER_THRESHOLD;
    }
    if (layout.dpadAxes) {
      const x = pad.axes[layout.dpadAxes.x] ?? 0;
      const y = pad.axes[layout.dpadAxes.y] ?? 0;
      out.pressed[PAD.LEFT] ||= x < -0.5;
      out.pressed[PAD.RIGHT] ||= x > 0.5;
      out.pressed[PAD.UP] ||= y < -0.5;
      out.pressed[PAD.DOWN] ||= y > 0.5;
    } else if (layout.hatAxis !== undefined && pad.axes.length > layout.hatAxis) {
      const h = hatDirections(pad.axes[layout.hatAxis]);
      out.pressed[PAD.UP] ||= h.up;
      out.pressed[PAD.DOWN] ||= h.down;
      out.pressed[PAD.LEFT] ||= h.left;
      out.pressed[PAD.RIGHT] ||= h.right;
    }
  }
  for (let i = 0; i < BUTTON_COUNT; i++) anyButton ||= out.pressed[i];
  const s = layout?.sticks ?? { lx: 0, ly: 1, rx: 2, ry: 3 };
  const a = pad.axes;
  out.moveMag = deadzone(a[s.lx] ?? 0, a[s.ly] ?? 0, out.sticks, 0);
  const lookMag = deadzone(a[s.rx] ?? 0, a[s.ry] ?? 0, out.sticks, 2);
  out.active = anyButton || out.moveMag > 0 || lookMag > 0;
  return out;
}

// ---------------------------------------------------------------------------
// Active pad, button edges
// ---------------------------------------------------------------------------

/** Indices of connected pads (from the connect / disconnect events). Empty = fully inert. */
const connected = new Set<number>();
/** performance.now() of each pad's last input, to pick the most recently active one. */
const lastActive = new Map<number, number>();
const lastTimestamp = new Map<number, number>();

let activeIndex: number | null = null;
const prev: boolean[] = new Array(BUTTON_COUNT).fill(false);
/** The binding a button fired on press, so its release sends the matching keyup (even if LT changed). */
const firedOnPress: (PadBinding | null)[] = new Array(BUTTON_COUNT).fill(null);
const snap = newSnapshot();
const otherSnap = newSnapshot();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

function shortName(id: string): string {
  return id.replace(/\s*\(.*\)\s*$/, '').trim() || id;
}

/** Release everything the active pad is holding (keyups for held buttons, stick, RT). */
function releaseAll(): void {
  for (let i = 0; i < BUTTON_COUNT; i++) {
    if (firedOnPress[i]) buttonUp(i);
    prev[i] = false;
  }
  clearPadSource();
}

function setActive(pad: Gamepad | null): void {
  const index = pad?.index ?? null;
  const changed = index !== activeIndex;
  if (changed) releaseAll();
  const wasNone = activeIndex === null;
  activeIndex = index;
  setActivePad(pad, changed);
  if (!changed) return;
  if (pad) {
    showInputMessage(`Controller connected: ${shortName(pad.id)}`, 2500);
    console.info(`[gamepad] using ${pad.id} (mapping "${pad.mapping || 'none'}", index ${pad.index})`);
    layoutFor(pad);
    if (wasNone) setAutoSweepDefault(true);
  } else {
    showInputMessage('Controller disconnected: keyboard and mouse', 2500);
    setAutoSweepDefault(false);
  }
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
  const name = BUTTON_NAMES.find((k) => PAD[k] === i);
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

function curve(v: number): number {
  return Math.sign(v) * Math.pow(Math.abs(v), LOOK_CURVE);
}

// ---------------------------------------------------------------------------
// Per-frame poll (only while a pad is connected)
// ---------------------------------------------------------------------------

function poll(dt: number): void {
  if (connected.size === 0) return; // inert: no controller, no reads, no writes

  const pads = navigator.getGamepads();
  const now = performance.now();

  // pick the most recently active connected pad
  let best: Gamepad | null = null;
  let bestTime = -Infinity;
  for (const p of pads) {
    if (!p || !p.connected) continue;
    if (!connected.has(p.index)) connected.add(p.index); // e.g. connect event raced the poll
    const s = p.index === activeIndex ? snap : otherSnap;
    readPad(p, s);
    if (s.active && p.timestamp !== lastTimestamp.get(p.index)) lastActive.set(p.index, now);
    lastTimestamp.set(p.index, p.timestamp);
    const t = lastActive.get(p.index) ?? -1;
    // ties keep the current pad
    if (t > bestTime || (t === bestTime && p.index === activeIndex)) {
      best = p;
      bestTime = t;
    }
  }
  if (!best) {
    // none readable this frame: hand back to the keyboard, but keep polling until the browser says
    // the pad is gone (gamepaddisconnected), in case this was a one-frame gap
    setActive(null);
    return;
  }
  setActive(best);
  readPad(best, snap); // (re-read into the active slot: it may have just switched)

  // --- buttons (edges) ---
  const lt = snap.pressed[PAD.LT];
  for (let i = 0; i < BUTTON_COUNT; i++) {
    if (i === PAD.LT || i === PAD.RT) continue;
    const down = snap.pressed[i];
    if (down && !prev[i]) buttonDown(i, lt);
    else if (!down && prev[i]) buttonUp(i);
    prev[i] = down;
  }

  // --- held inputs ---
  const live = !isOverlayOpen() && !isDebugCameraActive();
  if (!live) {
    clearPadSource();
    return;
  }
  const [mx, my, lx, ly] = snap.sticks;
  setPadSource(mx, -my, snap.pressed[PAD.RT]);

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
  if (typeof navigator.getGamepads !== 'function') {
    console.info('[gamepad] Gamepad API unavailable: keyboard and mouse only');
    return;
  }
  window.addEventListener('gamepadconnected', (e) => {
    const p = (e as GamepadEvent).gamepad;
    connected.add(p.index);
    lastActive.set(p.index, performance.now()); // a freshly connected pad is the active one
    if (activeIndex === null) setActive(p);
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    const idx = (e as GamepadEvent).gamepad.index;
    connected.delete(idx);
    lastActive.delete(idx);
    lastTimestamp.delete(idx);
    if (idx !== activeIndex) return;
    // hand over to another connected pad, or back to keyboard and mouse
    const pads = navigator.getGamepads();
    let next: Gamepad | null = null;
    let t = -Infinity;
    for (const p of pads) {
      if (p && p.connected && connected.has(p.index) && (lastActive.get(p.index) ?? -1) > t) {
        next = p;
        t = lastActive.get(p.index) ?? -1;
      }
    }
    setActive(next);
  });
  world.onUpdate((dt) => poll(Math.min(dt, 0.05)));
}

/** For tests / the dev fake pad: is the poll running at all? */
export function isGamepadPolling(): boolean {
  return connected.size > 0;
}
