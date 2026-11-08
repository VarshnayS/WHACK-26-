/**
 * src/player/input.ts: ONE input state built from separate sources each frame
 * Owner: SENSES
 *
 * Sources:
 *  - keyboard + mouse: held keys (W/A/S/D), right mouse button (hold = sweep the cane). Mouse look
 *    stays in PointerLockControls (src/player/controller.ts), which rotates the camera directly.
 *  - gamepad: src/player/gamepad.ts writes the left stick and RT here (setPadSource) and applies the
 *    right stick to the camera itself, so mouse and stick look simply add up.
 *
 * Rules (the fix for PR #20's keyboard regression):
 *  - Sources are ADDED, never swapped: movement = keyboard vector + stick vector, clamped to length 1.
 *    An idle source contributes zero, so it can never override the other one.
 *  - Keyboard alone gives length 1 in any direction (diagonals are clamped), so the controller's top
 *    speed and momentum are exactly what they were before PR #20.
 *  - With no controller connected nothing writes to the pad source (gamepad.ts doesn't poll), so it
 *    stays at zero.
 *
 * The active-controller registry (getActivePad / onPadChange) also lives here, so the HUD and haptics
 * can read it without importing gamepad.ts (which would be an import cycle through the start screen).
 */

// ---------------------------------------------------------------------------
// Keyboard + mouse source
// ---------------------------------------------------------------------------

const keys = new Set<string>();
let rightMouse = false;

const onKeyDown = (e: KeyboardEvent) => keys.add(e.code);
const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
const onMouseDown = (e: MouseEvent) => {
  if (e.button === 2) rightMouse = true;
};
const onMouseUp = (e: MouseEvent) => {
  if (e.button === 2) rightMouse = false;
};
const onContextMenu = (e: Event) => e.preventDefault(); // right mouse is the cane, not a menu
const onBlur = () => clearHeldInput(); // avoid "stuck" keys when the window loses focus

let attached = 0;

/** Start listening (called by initController). Returns detach. Safe to call more than once. */
export function attachInput(): () => void {
  if (attached++ === 0) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', onBlur);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--attached > 0) return;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('blur', onBlur);
  };
}

/** Forget held keys and mouse buttons (window blur, run restart). */
export function clearHeldInput(): void {
  keys.clear();
  rightMouse = false;
}

function axis(positive: string, negative: string): number {
  return (keys.has(positive) ? 1 : 0) - (keys.has(negative) ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Gamepad source (written by src/player/gamepad.ts only while a controller is connected)
// ---------------------------------------------------------------------------

const pad = { x: 0, z: 0, caneHeld: false };

/** Left stick (x = strafe right, z = forward, deadzone already applied) and RT. */
export function setPadSource(x: number, z: number, caneHeld: boolean): void {
  pad.x = x;
  pad.z = z;
  pad.caneHeld = caneHeld;
}

export function clearPadSource(): void {
  setPadSource(0, 0, false);
}

// ---------------------------------------------------------------------------
// Combined state
// ---------------------------------------------------------------------------

/** Movement wish relative to where the camera faces. */
export interface MoveInput {
  /** Strafe right, -1..1. */
  x: number;
  /** Forward, -1..1. */
  z: number;
  /** 0..1: length of the combined vector; scales the top speed (keyboard alone = 1). */
  amount: number;
}

/**
 * Keyboard + stick, clamped to length 1. `keyboardLive` = the mouse is locked (pre-#20 rule: keys
 * only move you while playing); the stick works without pointer lock.
 */
export function readMove(keyboardLive: boolean, out: MoveInput = { x: 0, z: 0, amount: 0 }): MoveInput {
  let x = (keyboardLive ? axis('KeyD', 'KeyA') : 0) + pad.x;
  let z = (keyboardLive ? axis('KeyW', 'KeyS') : 0) + pad.z;
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  out.x = x;
  out.z = z;
  out.amount = Math.min(1, len);
  return out;
}

/** Hold to sweep the cane by hand: right mouse or controller RT. */
export function isCaneSweepHeld(): boolean {
  return rightMouse || pad.caneHeld;
}

// ---------------------------------------------------------------------------
// Active controller registry
// ---------------------------------------------------------------------------

let activePad: Gamepad | null = null;
type PadListener = (pad: Gamepad | null) => void;
const padListeners = new Set<PadListener>();

/** The controller in use (latest snapshot), or null. */
export function getActivePad(): Gamepad | null {
  return activePad;
}

/** Called when the active controller changes (a pad) or the last one goes away (null). Returns unsubscribe. */
export function onPadChange(fn: PadListener): () => void {
  padListeners.add(fn);
  return () => padListeners.delete(fn);
}

/** gamepad.ts only. `changed` = a different controller (or none) than before: notify listeners. */
export function setActivePad(p: Gamepad | null, changed: boolean): void {
  activePad = p;
  if (changed) for (const fn of padListeners) fn(p);
}
