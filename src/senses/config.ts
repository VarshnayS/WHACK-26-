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
