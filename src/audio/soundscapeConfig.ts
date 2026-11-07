/**
 * src/audio/soundscapeConfig.ts: tuning for the spatial soundscape (src/audio/soundscape.ts)
 * Owner: SENSES. Plain constants only.
 *
 * Sounds are procedural unless a recording is listed in SFX_FILES below (files in public/sfx/,
 * licences and authors in public/sfx/CREDITS.md). Several files per name = random variants. The
 * files are fetched and decoded behind the start screen; any that fail to load are skipped
 * silently and that sound stays procedural.
 */

/** Names of the sounds that can be replaced by files in public/sfx/. */
export type SfxName =
  | 'footstep' // player step (one-shot)
  | 'shuffle' // player standing still: breathing / shuffling (one-shot)
  | 'pedStep' // other people's footsteps (one-shot, spatial)
  | 'cane' // cane tap (one-shot, spatial)
  | 'thud' // player stunned (one-shot)
  | 'entityStep' // the entity's footsteps (one-shot, spatial)
  | 'engine' // car engine LOOP (one file per car, crossfaded excerpts); pitch follows speed + Doppler
  | 'passBy' // a car passing close by (spatial one-shot, its loudest moment lined up with the car's)
  | 'chatter' // people talking (long clips; random excerpts become one speaker's lines)
  | 'ambient'; // campus bed LOOP

/**
 * Recordings, relative to the site root (public/). Only listed files are fetched (no probing).
 * Credits: public/sfx/CREDITS.md. Names not listed here stay procedural.
 */
export const SFX_FILES: Partial<Record<SfxName, string[]>> = {
  pedStep: ['sfx/footsteps/concrete-step-1.mp3', 'sfx/footsteps/concrete-step-2.mp3', 'sfx/footsteps/concrete-step-3.mp3'],
  engine: ['sfx/cars/engine-loop-1.mp3', 'sfx/cars/engine-loop-2.mp3'],
  passBy: ['sfx/cars/pass-by-1.mp3'],
  // chatter: no licence-safe English recording yet, so conversations use the procedural murmur.
  // Add clips here (e.g. 'sfx/pedestrians/chat-1.mp3'; 5-20 s, mono) and credit them in CREDITS.md.
};

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

/** Overall car level (engines, tyres and pass-bys), 0..1. */
export const CAR_VOLUME = 0.5;
/** Cars further than this are silent (m). */
export const CAR_AUDIBLE_RADIUS = 45;
/** Cars fade in from the edge of hearing range down to this fraction of it (no pop on entry/exit). */
export const CAR_FADE_START = 0.55;
/** Car distance falloff (inverse model; steeper than other sources so far cars are barely audible). */
export const CAR_PANNER_REF_DISTANCE = 3;
export const CAR_PANNER_ROLLOFF = 1.8;
/** Fade time constant (s) when a car voice is picked or dropped. */
export const CAR_FADE_TAU = 0.6;
/** Speed (m/s) that counts as full throttle (cars drive at ~8 ± 1 m/s). */
export const CAR_FULL_SPEED = 9;
/** Procedural engine firing frequency (Hz) at idle / full speed (fallback when no recording). */
export const ENGINE_HZ_IDLE = 26;
export const ENGINE_HZ_FULL = 60;
/** Engine level at idle / full speed. */
export const ENGINE_GAIN_IDLE = 0.2;
export const ENGINE_GAIN_FULL = 0.45;
/** Engine low-pass cutoff (Hz) at idle / full speed: keeps the engine dull and road-like. */
export const ENGINE_LOWPASS_IDLE = 260;
export const ENGINE_LOWPASS_FULL = 800;
/** Recorded engine loop: playback rate at idle / full speed (below 1 = a deeper engine). */
export const ENGINE_SAMPLE_RATE_IDLE = 0.8;
export const ENGINE_SAMPLE_RATE_FULL = 0.97;
/** Each car's engine is detuned by up to this much (±), so no two cars sound the same. */
export const ENGINE_SAMPLE_DETUNE = 0.07;
/** Recorded engine loops: length of each excerpt and of the crossfade between them (s). */
export const ENGINE_LOOP_SEGMENT = 1.4;
export const ENGINE_LOOP_XFADE = 0.35;
/** Tyre / road noise level at full speed (scales with speed squared); low-passed brown noise. */
export const TYRE_GAIN_FULL = 0.3;
/** Tyre noise low-pass cutoff (Hz) at a crawl / full speed. */
export const TYRE_LOWPASS_SLOW = 350;
export const TYRE_LOWPASS_FULL = 900;
/** Pass-by recording: played when a car will pass within this distance (m)... */
export const PASSBY_MAX_DISTANCE = 9;
/** ...starting this long (s) before its closest approach... */
export const PASSBY_LEAD = 3.5;
/** ...lined up so the recording's loudest moment (s into the file) is the closest approach. */
export const PASSBY_PEAK = 8.1;
export const PASSBY_GAIN = 0.8;
/** Engine and tyre loop level while the pass-by recording plays (it has its own engine). */
export const PASSBY_ENGINE_DUCK = 0.45;
/** Speed of sound (m/s) for the Doppler shift. */
export const SPEED_OF_SOUND = 343;
/**
 * Doppler exaggeration. At ~8 m/s the real shift is only ±2 %, so the approach speed is multiplied
 * by this before the shift is computed: noticeable, but still a natural pitch drop as a car passes.
 */
export const DOPPLER_EXAGGERATION = 1.5;

// --- pedestrians -------------------------------------------------------------------------------

/** Pedestrian footsteps further than this are not played (m). */
export const PED_STEP_RADIUS = 22;
export const PED_STEP_GAIN = 0.55;
/** Each pedestrian step's level and pitch vary randomly by up to this much (±, fraction). */
export const PED_STEP_GAIN_JITTER = 0.25;
export const PED_STEP_RATE_JITTER = 0.07;
/** Conversations are only voiced within this distance (m). */
export const MURMUR_RADIUS = 15;
/** Two pedestrians closer than this (m), moving alike, count as one group. */
export const GROUP_DISTANCE = 1.8;
/** ...and "moving alike" means their velocities differ by less than this (m/s). */
export const GROUP_MAX_REL_SPEED = 0.6;
/** How often groups are re-detected (s). */
export const GROUP_SCAN_INTERVAL = 1;
/** Chance a detected group is chatty at all (the rest walk in silence). */
export const GROUP_CHATTY_CHANCE = 0.75;
export const MURMUR_GAIN = 0.5;
/** Recorded chatter (SFX_FILES.chatter): level, and one speaker's line length (s). */
export const CHATTER_GAIN = 0.7;
export const CHATTER_LINE_MIN = 1.2;
export const CHATTER_LINE_MAX = 4;
/** Gap between lines (s); now and then (CHATTER_LULL_CHANCE) a longer lull. */
export const CHATTER_GAP_MIN = 0.25;
export const CHATTER_GAP_MAX = 1.2;
export const CHATTER_LULL_CHANCE = 0.15;
export const CHATTER_LULL_MIN = 2;
export const CHATTER_LULL_MAX = 6;
/** Playback rate varies by up to this much (±) per line, so excerpts don't sound repeated. */
export const CHATTER_RATE_JITTER = 0.08;
/** Gentle outdoor muffle on recorded chatter (Hz). */
export const CHATTER_LOWPASS = 4000;
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
export const AMBIENT_HUM_GAIN = 0.045;
export const AMBIENT_WIND_GAIN = 0.035;
