/**
 * src/senses/config.ts: constants for this module only (one owner, so nobody shares a config file).
 * Plain constants only.
 */

// --- footsteps (src/senses/footsteps.ts) -------------------------------------------------------

/** Below this horizontal speed (m/s) the player counts as standing still. */
export const STEP_MIN_SPEED = 0.4;
/** Speeds (m/s) that count as a walk and a run (the controller tops out at 5.5). */
export const STEP_WALK_SPEED = 1.5;
export const STEP_RUN_SPEED = 5.0;
/** Distance per step (m) when walking / running: sets the step rate (~2 steps/s walking, ~3 running). */
export const STEP_LENGTH_WALK = 0.7;
export const STEP_LENGTH_RUN = 1.6;
/** Footstep ping range (m) when walking / running. */
export const STEP_RANGE_WALK = 3;
export const STEP_RANGE_RUN = 6;
/** Pings start this far above the ground (m), so nearby wall bases light up as well as the floor. */
export const STEP_PING_HEIGHT = 0.1;

/** Standing still: a faint breathing / shuffling pulse every this many seconds... */
export const IDLE_PULSE_INTERVAL = 4;
/** ...with this range (m), so you're never completely lost. */
export const IDLE_PULSE_RANGE = 1.5;

// --- cane (src/senses/cane.ts) -------------------------------------------------------------------

/** Horizontal reach of the cane tip in front of the feet (m). */
export const CANE_REACH = 1.2;
/** Full sweep arc (degrees), centred on where the player faces. */
export const CANE_ARC_DEG = 60;
/** Sweep speed (degrees per second): one side to the other in ~0.6 s. */
export const CANE_SWEEP_DEG_PER_S = 100;
/** Hand position relative to the eye (m): right, down, forward. */
export const CANE_HAND_RIGHT = 0.22;
export const CANE_HAND_DOWN = 0.85;
export const CANE_HAND_FORWARD = 0.2;
/** Height (m) above the ground of the ray swept from the last tip to the new one. */
export const CANE_SWEEP_RAY_HEIGHT = 0.12;
/** Surfaces with a normal steeper than this (|n.y| < it) are obstacles; flatter ones are floor. */
export const CANE_MAX_OBSTACLE_NORMAL_Y = 0.7;
/**
 * Sweep sonar: while the cane is held, its tip sends a silent ping every CANE_SWEEP_PING_DEG of
 * sweep, so the sweep paints a band of the street around you (100°/s ÷ 15° ≈ 7 pings/s).
 */
export const CANE_SWEEP_PING_RANGE = 4.5;
export const CANE_SWEEP_PING_DEG = 15;
/** Ping range (m) of a contact tap / a hard tap (V). These also play the tap sound. */
export const CANE_TAP_RANGE = 4.5;
export const CANE_HARD_TAP_RANGE = 6;
/** Minimum time between two contact taps (s), so resting on a wall doesn't machine-gun pings. */
export const CANE_TAP_COOLDOWN = 0.18;
/** While the cane stays against something, it taps again this often (s). */
export const CANE_CONTACT_REPEAT = 0.6;
/** After bouncing off something to the side, the sweep can't reverse again for this long (s). */
export const CANE_BOUNCE_LOCK = 0.12;
/** Minimum time between hard taps (s). */
export const CANE_HARD_TAP_COOLDOWN = 0.25;
/** Line opacity (white, never coloured). */
export const CANE_LINE_OPACITY = 0.9;
