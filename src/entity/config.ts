/**
 * src/entity/config.ts: constants for this module only (one owner, so nobody shares a config file).
 * Plain constants only. Distances in metres, speeds in m/s, times in seconds.
 */
import type { PingType } from '../shared/contracts';

// --- movement --------------------------------------------------------------------------------------

/**
 * true: it always knows where the player is and takes the shortest route to them (constant time
 * pressure); sounds make it surge. false: hearing-only patrol/investigate/chase.
 */
export const OMNISCIENT = true;
/** OMNISCIENT: stalking speed at the start, how fast it ramps up (m/s per second hunting), and the cap. */
export const STALK_SPEED = 1.4;
export const STALK_RAMP = 0.015;
export const STALK_MAX_SPEED = 3.0;
/** OMNISCIENT: speed for BOOST_TIME after it hears a player sound (player run cap is 5.5). */
export const CHASE_BOOST_SPEED = 3.5;
export const BOOST_TIME = 5;
/** OMNISCIENT: how often it re-plans the shortest route to the player. */
export const REPLAN_INTERVAL = 0.5;

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
/** After a catch it keeps chasing; another 'caught' can't fire for this long. */
export const CATCH_COOLDOWN = 3;

// --- its own sounds --------------------------------------------------------------------------------

/** It gives off a faint 'pedestrian' ping roughly every this many metres walked. */
export const FOOTSTEP_PING_EVERY = 3;
/** Range of those footstep pings. */
export const FOOTSTEP_PING_RANGE = 2;
/** Procedural positional audio (src/entity/audio.ts): footsteps, breathing, gasp, growl, shriek. */
export const AUDIO_ENABLED = true;

// --- body ------------------------------------------------------------------------------------------

/** Height of the figure's proportions before BODY_SCALE. */
export const BODY_HEIGHT = 2.5;
/** Uniform scale on the whole figure (1.1 = about 2.6 m tall): still taller than people, but squat. */
export const BODY_SCALE = 1.1;
/** Extra thickness for torso, limbs and neck (1 = the old thin figure). */
export const BODY_BULK = 2.1;
/**
 * Colour of its sonar lines (r, g, b in 0..1), so it stands out from the white world.
 * Red fits AGENTS.md rule 9 ("red is allowed only for stuns and danger"): the entity is the danger.
 * Set to [1, 1, 1] for plain white.
 */
export const BODY_TINT: readonly [number, number, number] = [0.95, 0.08, 0.05];
/** Grid spacing on its body (object-space grid). */
export const BODY_GRID_SIZE = 0.1;
/** Metres per full walk cycle (two steps) at BODY_SCALE 1; scaled with the body. */
export const STRIDE_LENGTH = 1.8;

// --- debug -----------------------------------------------------------------------------------------

/** Range of the test 'voice' ping fired with N. */
export const TEST_PING_RANGE = 30;