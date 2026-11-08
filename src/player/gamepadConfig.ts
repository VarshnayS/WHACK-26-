/**
 * src/player/gamepadConfig.ts: THE controller mapping (one table) and stick tuning
 * Owner: SENSES
 *
 * Button indices follow the W3C "standard" gamepad layout (Xbox names; on a Switch-style pad A/B and
 * X/Y swap places but the indices are the same). Most bindings just replay a keyboard key
 * (src/player/gamepad.ts dispatches the same keydown/keyup on window), so a button behaves exactly
 * like its key, including the ones owned by other modules (V map, O picker, debug keys).
 * Hold LT for the second layer (the controller's Shift).
 * The README controls table and the start-screen overlay are generated from / match this table.
 */

/** Standard-mapping button indices. */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;
export type PadButton = keyof typeof PAD;

/** What a button press does. */
export type PadAction =
  /** Replay a keyboard key (KeyboardEvent.code), optionally with Shift. */
  | { kind: 'key'; code: string; shift?: boolean }
  /** Previous / next vision preset (no keyboard key: O opens the picker). */
  | { kind: 'vision'; step: -1 | 1 };

export interface PadBinding {
  button: PadButton;
  /** 'base' = pressed alone; 'lt' = pressed while LT is held. */
  layer: 'base' | 'lt';
  action: PadAction;
  /** The keyboard equivalent, for the README / overlay. */
  keys: string;
  label: string;
}

const key = (code: string, shift = false): PadAction => ({ kind: 'key', code, shift });

/**
 * Press bindings. Held inputs live in gamepad.ts: left stick = move (analogue), L3 = run toggle,
 * right stick = look, RT = hold to sweep the cane, LT = second layer.
 */
export const PAD_BINDINGS: readonly PadBinding[] = [
  // --- base layer ---
  { button: 'B', layer: 'base', action: key('Space'), keys: 'Space', label: 'Voice ping' },
  { button: 'X', layer: 'base', action: key('Space', true), keys: 'Shift+Space', label: 'Max-strength voice ping' },
  { button: 'A', layer: 'base', action: key('KeyB'), keys: 'B', label: 'Hard cane tap' },
  { button: 'Y', layer: 'base', action: key('KeyX'), keys: 'X', label: 'Auto-sweep on / off' },
  { button: 'VIEW', layer: 'base', action: key('KeyV'), keys: 'V', label: 'Architect hotspot map' },
  { button: 'MENU', layer: 'base', action: key('KeyO'), keys: 'O', label: 'Vision picker' },
  { button: 'LB', layer: 'base', action: { kind: 'vision', step: -1 }, keys: 'O, pick', label: 'Previous vision mode' },
  { button: 'RB', layer: 'base', action: { kind: 'vision', step: 1 }, keys: 'O, pick', label: 'Next vision mode' },
  { button: 'UP', layer: 'base', action: key('Period'), keys: '.', label: 'Sound volume up' },
  { button: 'DOWN', layer: 'base', action: key('Comma'), keys: ',', label: 'Sound volume down' },
  { button: 'LEFT', layer: 'base', action: key('KeyU'), keys: 'U', label: 'Mute / unmute sound' },
  { button: 'RIGHT', layer: 'base', action: key('KeyC', true), keys: 'Shift+C', label: 'Recalibrate the mic' },
  { button: 'R3', layer: 'base', action: key('KeyR'), keys: 'R', label: 'Debug: reveal all' },
  // --- LT layer (hold LT) ---
  { button: 'LEFT', layer: 'lt', action: key('KeyM', true), keys: 'Shift+M', label: 'Mute / unmute the mic' },
  { button: 'UP', layer: 'lt', action: key('BracketRight'), keys: ']', label: 'Mic sensitivity up' },
  { button: 'DOWN', layer: 'lt', action: key('BracketLeft'), keys: '[', label: 'Mic sensitivity down' },
  { button: 'RB', layer: 'lt', action: key('Equal'), keys: '=', label: 'Mic trigger level up' },
  { button: 'LB', layer: 'lt', action: key('Minus'), keys: '-', label: 'Mic trigger level down' },
  { button: 'B', layer: 'lt', action: key('Digit0'), keys: '0', label: 'Reset mic tuning' },
  { button: 'X', layer: 'lt', action: key('KeyH'), keys: 'H', label: 'Haptics test (next level)' },
  { button: 'MENU', layer: 'lt', action: key('Backquote'), keys: '`', label: 'Audio debug meter' },
  { button: 'VIEW', layer: 'lt', action: key('KeyJ'), keys: 'J', label: 'Audit: inject test events' },
  { button: 'R3', layer: 'lt', action: key('KeyF'), keys: 'F', label: 'Debug: free-fly camera' },
  { button: 'Y', layer: 'lt', action: key('KeyT'), keys: 'T', label: 'Debug: entity overlay' },
  { button: 'A', layer: 'lt', action: key('KeyN'), keys: 'N', label: 'Debug: entity test ping' },
  { button: 'RIGHT', layer: 'lt', action: key('KeyP'), keys: 'P', label: 'Dev: fake ping' },
  { button: 'L3', layer: 'lt', action: key('KeyP', true), keys: 'Shift+P', label: 'Dev: one ping of each type' },
];

/** Held inputs, for the README / overlay (same order as the README table). */
export const PAD_HELD: readonly { input: string; keys: string; label: string }[] = [
  { input: 'Left stick', keys: 'WASD', label: 'Move (analogue: push further to go faster)' },
  { input: 'L3 (click)', keys: 'Hold Shift', label: 'Run (toggle; stops when you let go of the stick)' },
  { input: 'Right stick', keys: 'Mouse', label: 'Look' },
  { input: 'RT (hold)', keys: 'Hold C / right mouse', label: 'Sweep the cane by hand' },
  { input: 'LT (hold)', keys: 'Shift', label: 'Second layer for the bindings marked LT+' },
];

/** Stick tuning. */
export const STICK_DEADZONE = 0.15;
/** Look speed at full deflection (rad/s): yaw, pitch. */
export const LOOK_YAW_SPEED = 2.8;
export const LOOK_PITCH_SPEED = 1.9;
/** Response curve exponent (>1 = finer control near the centre). */
export const LOOK_CURVE = 2;
/** Trigger values above this count as pressed (RT sweep, LT layer). */
export const TRIGGER_THRESHOLD = 0.35;
/** Stick deflection below this cancels the L3 run toggle. */
export const RUN_CANCEL_BELOW = 0.2;
