/**
 * src/world/soundConfig.ts: constants for the SOUND module only (pings + world sound sources).
 * Owner: SOUND (feat/sound-sources). Plain constants only.
 *
 * Everything is drawn white on black: a style only changes speed, ring thickness, brightness and
 * how fast the ring fades after it passes. Tune here, nowhere else.
 */
import type { PingStyle, PingType } from '../shared/contracts';
import { PED_PING_BRIGHTNESS, PED_PING_RANGE, PED_PING_RADIUS, VOICE_FADE } from '../config';

// --- ping look per type ------------------------------------------------------------------------

export const PING_STYLES: Readonly<Record<PingType, Readonly<PingStyle>>> = {
  /** Player's voice / clap: big, bright, slow enough to read the street. */
  voice: { speed: 30, thickness: 1.2, brightness: 1.0, fade: VOICE_FADE },
  /** Player's own footsteps: faint, short (callers use ~2–5 m ranges). */
  footstep: { speed: 12, thickness: 0.3, brightness: 0.35, fade: 2.5 },
  /** Cane tap: tiny, sharp, quick. */
  cane: { speed: 15, thickness: 0.12, brightness: 0.85, fade: 4 },
  /** Car engine: medium, periodic. */
  car: { speed: 20, thickness: 0.6, brightness: 0.55, fade: 1.5 },
  /** Other people's footsteps: faint. */
  pedestrian: { speed: 10, thickness: 0.25, brightness: PED_PING_BRIGHTNESS, fade: 2.5 },
  /** Player hits something: sharp and bright. */
  impact: { speed: 40, thickness: 0.25, brightness: 1.0, fade: 2.5 },
};

/** The player's own sounds: always outrank world sounds in the ping budget. */
export const PLAYER_PING_TYPES: readonly PingType[] = ['voice', 'footstep', 'cane', 'impact'];

/**
 * A ping stays in the pool until its wave reaches `range`, plus this many fade time constants
 * (1/style.fade seconds each) so the trail can die out (3 ≈ 5 % left).
 */
export const PING_LINGER_FADES = 3;

/** Distances below this count as this (m) when ranking audibility, so a ping at your feet isn't infinite. */
export const AUDIBILITY_MIN_DISTANCE = 1;

// --- world sound sources -----------------------------------------------------------------------

/** Only cars within this distance of the player make pings (m). */
export const AGENT_SOUND_RADIUS = 40;
/** Only pedestrians within this distance make pings (m): REVEAL TUNING in src/config.ts. */
export const PEDESTRIAN_PING_RADIUS = PED_PING_RADIUS;

/** Car speed (m/s) that counts as "full speed" for engine pings (cars drive at ~8 ± 1 m/s). */
export const CAR_FULL_SPEED = 9;
/** Engine ping range at a standstill / at full speed (m). */
export const CAR_RANGE_IDLE = 4;
export const CAR_RANGE_FULL = 15;
/** Time between engine pings at a standstill / at full speed (s). */
export const CAR_INTERVAL_IDLE = 2.0;
export const CAR_INTERVAL_FULL = 0.6;
/** Engine pings come from this high above the car's base (m). */
export const CAR_ENGINE_HEIGHT = 0.5;

/** Pedestrian footstep ping range (m), scaled by walking speed between these (REVEAL TUNING in src/config.ts). */
export const PEDESTRIAN_STEP_RANGE_MIN = PED_PING_RANGE * 0.8;
export const PEDESTRIAN_STEP_RANGE_MAX = PED_PING_RANGE;
/** Walking speed (m/s) that gives PEDESTRIAN_STEP_RANGE_MAX. */
export const PEDESTRIAN_STEP_FULL_SPEED = 1.6;
/** Below this speed a pedestrian is shuffling/standing: no footstep pings. */
export const PEDESTRIAN_STEP_MIN_SPEED = 0.3;

/** Impact ping range: base + per m/s of impact speed, capped (m). */
export const IMPACT_RANGE_BASE = 6;
export const IMPACT_RANGE_PER_MPS = 2;
export const IMPACT_RANGE_MAX = 20;
