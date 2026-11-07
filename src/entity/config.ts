/**
 * src/entity/config.ts: constants for this module only (one owner, so nobody shares a config file).
 * Plain constants only. Distances in metres, speeds in m/s, times in seconds.
 */
import type { PingType } from '../shared/contracts';

// --- movement --------------------------------------------------------------------------------------

/** Speed while wandering the footway graph. */
export const PATROL_SPEED = 1.0;
/** Speed while walking to a sound it heard. */
export const INVESTIGATE_SPEED = 1.8;
/** Speed while chasing the player (faster than walking, so going quiet is the only escape). */
export const CHASE_SPEED = 2.2;

/** Patrol targets are graph nodes this far from where it stands. */
export const PATROL_MIN_HOP = 15;
export const PATROL_MAX_HOP = 60;

/** Closer than this, it walks straight to a target instead of along the path graph. */
export const DIRECT_RADIUS = 15;
/** A waypoint counts as reached within this distance. */
export const WAYPOINT_REACHED = 0.5;
/** Kept at least this far inside the corridor walls. */
export const WALL_INSET = 0.5;

// --- hearing ---------------------------------------------------------------------------------------

/** A ping is heard if distance < loudness x MAX_HEARING (loudness 1 = a full voice ping). */
export const MAX_HEARING = 60;
/** A ping of this range counts as full loudness for its type. */
export const REFERENCE_RANGE = 40;
/** range / REFERENCE_RANGE is clamped to this, so tiny pings are still faintly audible. */
export const RANGE_FACTOR_MIN = 0.25;
export const RANGE_FACTOR_MAX = 1.5;

/**
 * How loud each ping type is to the entity. Voice and impact are loud, footsteps quiet, cars and
 * pedestrians background (only heard when very close).
 */
export const TYPE_LOUDNESS: Record<PingType, number> = {
  voice: 1,
  impact: 1,
  cane: 0.5,
  footstep: 0.3,
  car: 0.1,
  pedestrian: 0.1,
};

/** Ping types the player makes. Hearing one of these close enough starts a chase. */
export const PLAYER_TYPES: readonly PingType[] = ['voice', 'impact', 'cane', 'footstep'];

/** It chases if it hears a player sound within this distance. */
export const CHASE_RADIUS = 15;

/** After investigating a sound it searches around it for this long. */
export const SEARCH_TIME = 5;
/** Search wander radius around the sound. */
export const SEARCH_RADIUS = 4;

/** With no new sound for this long it gives up and goes back to patrol. */
export const LOSE_INTEREST_TIME = 8;

/** Catch distance (horizontal). */
export const CATCH_RADIUS = 1.0;

// --- its own sounds --------------------------------------------------------------------------------

/** It gives off a faint 'pedestrian' ping roughly every this many metres walked. */
export const FOOTSTEP_PING_EVERY = 3;
/** Range of those footstep pings. */
export const FOOTSTEP_PING_RANGE = 2;
/** Procedural positional audio (src/entity/audio.ts): footsteps, breathing, gasp, growl, shriek. */
export const AUDIO_ENABLED = true;

// --- body ------------------------------------------------------------------------------------------

/** Total height of the figure. */
export const BODY_HEIGHT = 2.5;
/** Grid spacing on its body (object-space grid). */
export const BODY_GRID_SIZE = 0.1;
/** Metres per full walk cycle (two steps). */
export const STRIDE_LENGTH = 1.8;

// --- debug -----------------------------------------------------------------------------------------

/** Range of the test 'voice' ping fired with N. */
export const TEST_PING_RANGE = 30;
