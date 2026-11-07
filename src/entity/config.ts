/**
 * src/entity/config.ts: tuning for the entity that hunts the player
 * Owner: entity (src/entity/)
 *
 * Kept separate from src/config.ts so tuning the entity never conflicts with shared config.
 * Distances in metres, speeds in metres per second, times in seconds.
 */
export const ENTITY = {
  /** Grace period after load before it starts roaming (a noise wakes it early). */
  START_DELAY: 8,

  /** Spawn this far from the player (picked from OSM footway nodes when available). */
  SPAWN_MIN: 70,
  SPAWN_MAX: 120,

  /** Movement speed per state. Player walking speed is roughly 1.4 to 2. */
  WANDER_SPEED: 1.1,
  INVESTIGATE_SPEED: 2.2,
  HUNT_SPEED: 2.9,

  /** Agitation (0..1) rises with every noise it hears and makes it faster and more accurate. */
  AGITATION_PER_NOISE: 0.25,
  AGITATION_DECAY: 0.03, // per second
  AGITATION_SPEED_BONUS: 0.5, // +50% speed at full agitation

  /** It hears a ping if it's within ping.range * HEARING_FACTOR of the ping's origin. */
  HEARING_FACTOR: 1.5,
  /** Aim error at the very edge of its hearing (shrinks to 0 right next to the noise). */
  HEARING_ERROR: 12,

  /** Within this radius it senses the player directly, but only if the player is moving. */
  SENSE_RADIUS: 5,
  /** Player speed above this counts as moving (standing still hides you). */
  MOVE_THRESHOLD: 0.3,
  /** Within this radius it senses the player even when they stand still. */
  CLOSE_SENSE_RADIUS: 1.5,
  /** While hunting, the player escapes once they're this far away. */
  LOSE_RADIUS: 9,

  /** Game over distance (horizontal). */
  CATCH_RADIUS: 0.9,

  /** How long it stands and listens where it heard a noise before wandering again. */
  LINGER_TIME: 4,

  /** Wander targets are picked this far from the player, so it roams the player's area. */
  WANDER_MIN: 25,
  WANDER_MAX: 60,

  /** Closer than this it walks straight at the target instead of using the path graph. */
  DIRECT_RADIUS: 20,
  WAYPOINT_REACHED: 0.6,

  /** Sonar ping it gives off when it starts hunting / catches you (telegraphs where it is). */
  HUNT_REVEAL_RANGE: 6,
  CATCH_REVEAL_RANGE: 15,

  /** Body height (the mesh is built to this). */
  HEIGHT: 2.4,
} as const;
