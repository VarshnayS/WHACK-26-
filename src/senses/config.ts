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

/**
 * The cane is always out and visible. Hold C / right mouse / RT = manual sweep. X / controller Y
 * toggles auto-sweep (two-point touch synced to the footsteps); this is its starting state.
 */
export const CANE_AUTO_SWEEP = true;
/** Horizontal reach of the cane tip in front of the feet (m). */
export const CANE_REACH = 1.2;
/** Full sweep arc (degrees), centred on where the player faces. */
export const CANE_ARC_DEG = 60;
/** Manual sweep speed (degrees per second): one side to the other in ~0.6 s. */
export const CANE_SWEEP_DEG_PER_S = 100;
/** Fastest the auto-sweep may swing to catch up with the step rhythm (deg/s), and how fast the cane recentres at rest. */
export const CANE_AUTO_MAX_DEG_PER_S = 260;
export const CANE_REST_DEG_PER_S = 120;
/** Two-point touch: the tip lifts this far (m) mid-arc and touches down at each side on a step. */
export const CANE_AUTO_LIFT = 0.04;
/** Physical hand position relative to the eye (m): right, down, forward. Used for the shaft raycast. */
export const CANE_HAND_RIGHT = 0.22;
export const CANE_HAND_DOWN = 0.85;
export const CANE_HAND_FORWARD = 0.2;
/**
 * Drawn hand position in camera space (m: right, down, forward). The tip is ~55° below the eye
 * line, out of a 75° view, so the visible cane is drawn from the lower-right of the view and its
 * tip is raised just enough to stay CANE_VIEW_MARGIN_DEG inside the bottom edge. Looking down shows
 * it where it really is.
 */
export const CANE_VIEW_HAND = [0.26, 0.34, 0.32] as const;
export const CANE_VIEW_MARGIN_DEG = 13;
/** Visible cane: tube radius at the hand / tip (m) and its grid spacing (m). */
export const CANE_VIEW_RADIUS_HAND = 0.0045;
export const CANE_VIEW_RADIUS_TIP = 0.0025;
export const CANE_VIEW_GRID = 0.12;
/** The cane's own "arm's reach" glow radius (m): covers its whole length so it's always lit. */
export const CANE_VIEW_LIT_REACH = 3;
/** Height (m) above the ground of the ray swept from the last tip to the new one. */
export const CANE_SWEEP_RAY_HEIGHT = 0.12;
/** Surfaces with a normal steeper than this (|n.y| < it) are obstacles; flatter ones are floor. */
export const CANE_MAX_OBSTACLE_NORMAL_Y = 0.7;
/**
 * Sweep sonar: while the cane sweeps, its tip sends a silent ping every CANE_SWEEP_PING_DEG of
 * sweep, so the sweep paints a band of the street around you (100°/s ÷ 15° ≈ 7 pings/s). In
 * auto-sweep each touch-down also pings (with a soft tick).
 */
export const CANE_SWEEP_PING_RANGE = 4.5;
export const CANE_SWEEP_PING_DEG = 15;
/** Ping range (m) of a contact tap / a hard tap (B). These also play the tap sound. */
export const CANE_TAP_RANGE = 1.5;
export const CANE_HARD_TAP_RANGE = 6;
/** Minimum time between two contact taps (s), so resting on a wall doesn't machine-gun pings. */
export const CANE_TAP_COOLDOWN = 0.18;
/** While the cane stays against something and is moving, it taps again this often (s). */
export const CANE_CONTACT_REPEAT = 0.6;
/** Tip speed (m/s) below which a cane resting on something doesn't tap again. */
export const CANE_CONTACT_MIN_SPEED = 0.3;
/** Tip speed (m/s, sweep + walk) that counts as a full-strength contact (strength 1). */
export const CANE_STRENGTH_FULL_SPEED = 4;
/** After bouncing off something to the side, the sweep can't reverse again for this long (s). */
export const CANE_BOUNCE_LOCK = 0.12;
/** Minimum time between hard taps (s). */
export const CANE_HARD_TAP_COOLDOWN = 0.25;
/** Contact strength reported for a hard tap (0..1, for haptics). */
export const CANE_HARD_TAP_STRENGTH = 0.7;
