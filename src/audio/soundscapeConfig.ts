/**
 * src/audio/soundscapeConfig.ts: tuning for the spatial soundscape (src/audio/soundscape.ts)
 * Owner: SENSES. Plain constants only.
 *
 * Every sound is procedural for now. To replace one with a recording, drop CC0 files into
 * public/sfx/ and list them in SFX_FILES below (several files per name = random variants).
 * Files that fail to load are skipped with one console warning and the synth is kept.
 */

/** Names of the sounds that can be replaced by files in public/sfx/. */
export type SfxName =
  | 'footstep' // player step (one-shot)
  | 'shuffle' // player standing still: breathing / shuffling (one-shot)
  | 'pedStep' // other people's footsteps (one-shot, spatial)
  | 'cane' // cane tap (one-shot, spatial)
  | 'thud' // player stunned (one-shot)
  | 'entityStep' // the entity's footsteps (one-shot, spatial)
  | 'engine' // car engine LOOP; pitch follows speed + Doppler
  | 'ambient'; // campus bed LOOP

/**
 * Optional recordings, e.g. `footstep: ['/sfx/step-1.ogg', '/sfx/step-2.ogg']`. Empty = all synth.
 * Only listed files are fetched (no probing, so no 404s in the console).
 */
export const SFX_FILES: Partial<Record<SfxName, string[]>> = {};

// --- mix ---------------------------------------------------------------------------------------

/** Master volume 0..1 at first start (then saved per browser). `,` / `.` change it, U mutes. */
export const MASTER_VOLUME = 0.8;
export const VOLUME_STEP = 0.1;
export const VOLUME_STORAGE_KEY = 'whack.soundscape.volume';

/** Fade time constant (s) when a source starts or stops being voiced. */
export const FADE_TAU = 0.25;

// --- voice budget (keeps CPU low: ~10 spatial voices at once) -----------------------------------

/** Continuous car engine voices (nearest cars). */
export const MAX_CAR_VOICES = 4;
/** Simultaneous conversations (nearest talking groups). */
export const MAX_MURMUR_VOICES = 2;
/** Pooled HRTF panners for one-shots (pedestrian steps, cane taps). Busy slots = sound skipped. */
export const MAX_ONESHOT_VOICES = 4;
/** Re-pick which sources get voices this often (s). */
export const VOICE_REASSIGN_INTERVAL = 0.25;

// --- spatial falloff (PannerNode, inverse distance model) ---------------------------------------

export const PANNER_REF_DISTANCE = 3;
export const PANNER_ROLLOFF = 1.1;

// --- cars --------------------------------------------------------------------------------------

/** Cars further than this are silent (m). */
export const CAR_AUDIBLE_RADIUS = 80;
/** Speed (m/s) that counts as full throttle (cars drive at ~8 ± 1 m/s). */
export const CAR_FULL_SPEED = 9;
/** Engine firing frequency (Hz) at idle / full speed. */
export const ENGINE_HZ_IDLE = 32;
export const ENGINE_HZ_FULL = 78;
/** Engine level at idle / full speed. */
export const ENGINE_GAIN_IDLE = 0.22;
export const ENGINE_GAIN_FULL = 0.5;
/** Tyre / road noise level at full speed (scales with speed squared). */
export const TYRE_GAIN_FULL = 0.45;
/** Speed of sound (m/s) for the Doppler shift. */
export const SPEED_OF_SOUND = 343;
/**
 * Doppler exaggeration. At ~8 m/s the real shift is only ±2 %, which is hard to hear, so the
 * approach speed is multiplied by this before the shift is computed.
 */
export const DOPPLER_EXAGGERATION = 3;

// --- pedestrians -------------------------------------------------------------------------------

/** Pedestrian footsteps further than this are not played (m). */
export const PED_STEP_RADIUS = 22;
export const PED_STEP_GAIN = 0.55;
/** Conversations are only voiced within this distance (m). */
export const MURMUR_RADIUS = 28;
/** Two pedestrians closer than this (m), moving alike, count as one group. */
export const GROUP_DISTANCE = 1.8;
/** ...and "moving alike" means their velocities differ by less than this (m/s). */
export const GROUP_MAX_REL_SPEED = 0.6;
/** How often groups are re-detected (s). */
export const GROUP_SCAN_INTERVAL = 1;
/** Chance a detected group is chatty at all (the rest walk in silence). */
export const GROUP_CHATTY_CHANCE = 0.75;
export const MURMUR_GAIN = 0.5;
/** Height of a speaker's mouth above their base (m). */
export const MOUTH_HEIGHT = 1.55;

// --- player ------------------------------------------------------------------------------------

/** Player footstep level for a walking (3 m) / running (6 m) ping; idle shuffle level. */
export const PLAYER_STEP_GAIN_WALK = 0.35;
export const PLAYER_STEP_GAIN_RUN = 0.7;
export const PLAYER_SHUFFLE_GAIN = 0.18;
/** A footstep ping with range at or below this (m) is the idle shuffle. */
export const SHUFFLE_MAX_RANGE = 2;
export const CANE_GAIN = 0.6;
export const THUD_GAIN = 1;
/** Ear ringing after a stun: level and pitch (Hz). */
export const TINNITUS_GAIN = 0.03;
export const TINNITUS_HZ = 3900;

// --- entity ------------------------------------------------------------------------------------

/** Entity steps are audible within this distance (m), getting louder as it approaches. */
export const ENTITY_AUDIBLE_RADIUS = 60;
/** Mean time between entity steps (s) at 1 m/s; uneven by ENTITY_STEP_LIMP. */
export const ENTITY_STEP_INTERVAL = 0.85;
/** Alternate steps are this much longer / shorter (a dragging limp). */
export const ENTITY_STEP_LIMP = 0.35;
export const ENTITY_STEP_GAIN = 1.2;

// --- ambient -----------------------------------------------------------------------------------

/** Distant traffic hum and wind levels. */
export const AMBIENT_HUM_GAIN = 0.07;
export const AMBIENT_WIND_GAIN = 0.035;
