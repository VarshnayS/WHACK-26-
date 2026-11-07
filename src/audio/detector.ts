/**
 * src/audio/detector.ts: audio features -> sonar detection events
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 *
 * PURE MODULE: no DOM, no Web Audio, no three.js. Everything here can be driven with
 * synthetic arrays (see OnsetDetector.step) so it is testable outside the browser.
 *
 * Pipeline per frame:
 *   FeatureExtractor.compute(timeData, freqDb) -> AudioFeatures (RMS dBFS, peak, centroid, flux)
 *   OnsetDetector.step(features, nowMs)        -> 0..n DetectionEvents
 */

export type DetectionKind = 'transient' | 'sustained';

// =============================================================================================
// QUICK TUNING: the knobs you'll actually want to touch. Every mic and room is different.
// These are defaults: in game, [ ] change SENSITIVITY and - = change TRIGGER_DB live
// (saved per browser), and the debug meter (`) shows the result.
// =============================================================================================

/** Pulse size multiplier. 1 = normal, 1.5 = everything reaches further, 0.7 = smaller. */
export const SENSITIVITY = 1.0;
/** dB above the room's noise you must be to fire a pulse. Lower = triggers on quieter sounds. */
export const TRIGGER_DB = 12;
/**
 * Learn how loud this mic gets in real time: the loudest recent sound = a full-size pulse.
 * Makes quiet / low-gain mics and noisy rooms feel as responsive as a good mic.
 * false = fixed scale (FIXED_RANGE_DB above the trigger = full size).
 */
export const AUTO_RANGE = true;
/** Only used when AUTO_RANGE is false: dB above the trigger that counts as max loudness. */
export const FIXED_RANGE_DB = 40;
/** Response curve: < 1 makes quiet/medium sounds give bigger pulses, 1 = linear. */
export const STRENGTH_CURVE = 0.7;
/**
 * Smallest / largest pulse reach in metres: a whisper just over the trigger reveals ~3 m,
 * a full shout ~40 m (the voice ping's range in world.ping).
 */
export const MIN_RADIUS_M = 3;
export const MAX_RADIUS_M = 40;

/** Every tunable for the audio -> sonar module lives here (README "Audio sonar"). */
export interface DetectorConfig {
  /** AnalyserNode FFT size (time-domain window = fftSize samples, ~43 ms at 48 kHz). */
  fftSize: number;
  /** Floor for every dB value (digital silence would otherwise be -Infinity). */
  minDb: number;

  /** Ignore bins below this for centroid/flux (DC, rumble, handling noise). */
  analysisMinHz: number;
  /** Spectral centroid mapped log-linearly from these frequencies to brightness 0..1. */
  centroidMinHz: number;
  centroidMaxHz: number;

  /** Noise floor before calibration has run (dBFS). */
  initialFloorDb: number;
  /** Lowest the noise floor may go (dBFS); stops a dead-silent mic making the gate hair-trigger. */
  minFloorDb: number;
  /** EMA time constants (s) for the floor rising / falling while quiet. Rising is slow on purpose. */
  floorRiseTauS: number;
  floorFallTauS: number;
  /** Don't adapt the floor for this long after an event ends (keeps reverb tails out of it). */
  floorHoldMs: number;

  /** Onset when RMS > noiseFloor + thresholdDb (and flux is rising). */
  thresholdDb: number;
  /** An event ends when RMS < noiseFloor + releaseDb. */
  releaseDb: number;
  /** A transient also ends once RMS falls this far below its own peak (claps decay fast, voices don't). */
  transientDropDb: number;
  /** Normalised spectral flux (0..~1) that counts as "rising". */
  fluxMin: number;
  /** A flux spike within this window before the RMS gate opens still counts as rising. */
  fluxWindowMs: number;
  /** Minimum time between onsets, so one clap = one pulse. */
  refractoryMs: number;

  /** Energy held longer than this is "sustained" (shout, hum) instead of "transient". */
  sustainMs: number;
  /** While sustained, emit a smaller pulse at most this often. */
  sustainRepeatMs: number;
  /** Force a sustained event to end after this long (stops a fan switching on from pulsing forever). */
  sustainMaxMs: number;
  /** Strength multiplier for the repeat pulses of a sustained sound. */
  sustainRepeatScale: number;

  /** Multiplies strength (after the curve). See SENSITIVITY. */
  sensitivity: number;
  /** strength = ((dB above trigger) / range) ^ strengthGamma. See STRENGTH_CURVE. */
  strengthGamma: number;
  /** Fixed dB above (floor + threshold) that maps to strength 1, when autoRange is off. */
  strengthRangeDb: number;
  /** Learn the "full strength" loudness from the mic in real time. See AUTO_RANGE. */
  autoRange: boolean;
  /** Auto-range: starting "full strength" level in dB above the floor (until something louder is heard). */
  autoRangeStartDb: number;
  /** Auto-range: the full-strength level never gets closer than this to the trigger (dB). Stops tiny sounds maxing out. */
  autoRangeMinSpanDb: number;
  /** Auto-range: a new loudest sound sets full strength this many dB above itself, so an even louder one still looks bigger. */
  autoRangeHeadroomDb: number;
  /** Auto-range: each sound quieter than the learned level pulls it this fraction of the way down (0..1). */
  autoRangeLearnRate: number;
  /** Auto-range: how fast the learned level relaxes back down (dB per second), so it re-learns. */
  autoRangeDecayDbPerS: number;
  /** Auto-range: loudest RMS (dBFS) a mic can realistically deliver before clipping; caps the learned level. */
  ceilingDb: number;
  /** maxRadius (m) at strength 0 and strength 1. */
  minRadius: number;
  maxRadius: number;
  /** Pulse speed (m/s) per kind: transients are fast and crisp, sustained are slower and wider. */
  transientSpeed: number;
  sustainedSpeed: number;

  /** Length of the silent calibration at start / on C (ms). */
  calibrationMs: number;
  /** Which percentile of the calibration RMS samples becomes the floor (0.5 = median). */
  calibrationPercentile: number;

  /** SPACE pulse strength (Shift+SPACE is always 1). */
  keyboardStrength: number;
  /** Brightness used for keyboard pulses. */
  keyboardBrightness: number;

  /** Draw each active pulse as an expanding ring (src/sonar/debug-rings.ts) until the shader exists. */
  debugRings: boolean;
}

export const DETECTOR_CONFIG: DetectorConfig = {
  fftSize: 2048,
  minDb: -100,

  analysisMinHz: 60,
  centroidMinHz: 200,
  centroidMaxHz: 6000,

  initialFloorDb: -60,
  minFloorDb: -85,
  floorRiseTauS: 4,
  floorFallTauS: 0.6,
  floorHoldMs: 500,

  thresholdDb: TRIGGER_DB,
  releaseDb: 8,
  transientDropDb: 12,
  fluxMin: 0.35,
  fluxWindowMs: 80,
  refractoryMs: 250,

  sustainMs: 300,
  sustainRepeatMs: 400,
  sustainMaxMs: 6000,
  sustainRepeatScale: 0.5,

  sensitivity: SENSITIVITY,
  strengthGamma: STRENGTH_CURVE,
  strengthRangeDb: FIXED_RANGE_DB,
  autoRange: AUTO_RANGE,
  autoRangeStartDb: 45,
  autoRangeMinSpanDb: 12,
  autoRangeHeadroomDb: 3,
  autoRangeLearnRate: 0.3,
  autoRangeDecayDbPerS: 0.5,
  ceilingDb: -6,
  minRadius: MIN_RADIUS_M,
  maxRadius: MAX_RADIUS_M,
  transientSpeed: 45,
  sustainedSpeed: 25,

  calibrationMs: 1500,
  calibrationPercentile: 0.5,

  keyboardStrength: 0.5,
  keyboardBrightness: 0.5,

  debugRings: false, // world.ping now drives the real shader
};

// ---------------------------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------------------------

export interface AudioFeatures {
  /** RMS of the time-domain window in dBFS (clamped to config.minDb). */
  rmsDb: number;
  /** Absolute sample peak, 0..1 (1 = clipping). */
  peak: number;
  /** Magnitude-weighted mean frequency in Hz. */
  centroidHz: number;
  /** centroidHz mapped to 0..1 (log scale between centroidMinHz and centroidMaxHz). */
  brightness: number;
  /** Half-wave rectified spectral flux, normalised by total magnitude: ~0 steady, ~1 sudden onset. */
  flux: number;
}

export function createFeatures(): AudioFeatures {
  return { rmsDb: -Infinity, peak: 0, centroidHz: 0, brightness: 0, flux: 0 };
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Map a centroid frequency to brightness 0..1. */
export function brightnessFromCentroid(hz: number, cfg: DetectorConfig = DETECTOR_CONFIG): number {
  if (!(hz > 0)) return 0;
  const lo = Math.log(cfg.centroidMinHz);
  const hi = Math.log(cfg.centroidMaxHz);
  return clamp01((Math.log(hz) - lo) / (hi - lo));
}

/** Map strength 0..1 to a pulse maxRadius in metres. */
export function radiusForStrength(strength: number, cfg: DetectorConfig = DETECTOR_CONFIG): number {
  return cfg.minRadius + (cfg.maxRadius - cfg.minRadius) * clamp01(strength);
}

/**
 * Turns one analyser frame into AudioFeatures. Keeps the previous magnitude spectrum for
 * flux. Allocates only in the constructor.
 */
export class FeatureExtractor {
  private readonly prevMag: Float32Array;
  private hasPrev = false;
  private readonly cfg: DetectorConfig;

  constructor(binCount: number, cfg: DetectorConfig = DETECTOR_CONFIG) {
    this.cfg = cfg;
    this.prevMag = new Float32Array(binCount);
  }

  /** Forget the previous spectrum (e.g. after mute), so the next frame has flux 0. */
  reset(): void {
    this.hasPrev = false;
  }

  /**
   * @param timeData  time-domain samples in -1..1 (AnalyserNode.getFloatTimeDomainData)
   * @param freqDb    magnitude spectrum in dB (AnalyserNode.getFloatFrequencyData)
   * @param sampleRate AudioContext.sampleRate
   * @param out       reused output object
   */
  compute(
    timeData: Float32Array,
    freqDb: Float32Array,
    sampleRate: number,
    out: AudioFeatures,
  ): AudioFeatures {
    const cfg = this.cfg;

    // Time domain: RMS + peak.
    let sumSq = 0;
    let peak = 0;
    const n = timeData.length;
    for (let i = 0; i < n; i++) {
      const s = timeData[i];
      sumSq += s * s;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    out.rmsDb = rmsDb > cfg.minDb ? rmsDb : cfg.minDb;
    out.peak = peak;

    // Frequency domain: centroid + normalised positive flux.
    const bins = Math.min(freqDb.length, this.prevMag.length);
    const binHz = sampleRate / (2 * freqDb.length);
    const startBin = Math.max(1, Math.ceil(cfg.analysisMinHz / binHz));
    const prev = this.prevMag;
    let magSum = 0;
    let weighted = 0;
    let fluxSum = 0;
    for (let i = startBin; i < bins; i++) {
      const db = freqDb[i];
      // getFloatFrequencyData gives -Infinity for empty bins; 10^(-Inf) = 0 which is what we want.
      const mag = db > cfg.minDb ? Math.pow(10, db / 20) : 0;
      magSum += mag;
      weighted += mag * i * binHz;
      const d = mag - prev[i];
      if (d > 0) fluxSum += d;
      prev[i] = mag;
    }
    out.centroidHz = magSum > 0 ? weighted / magSum : 0;
    out.brightness = brightnessFromCentroid(out.centroidHz, cfg);
    out.flux = this.hasPrev && magSum > 0 ? fluxSum / magSum : 0;
    this.hasPrev = true;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Onset detection + classification
// ---------------------------------------------------------------------------------------------

export interface DetectionEvent {
  kind: DetectionKind;
  /** true for the follow-up pulses of a held sound (smaller, rate-limited). */
  repeat: boolean;
  /** Same clock as the nowMs passed to step(). */
  timeMs: number;
  /** Peak RMS (dBFS) over the part of the sound this event covers. */
  levelDb: number;
  /** levelDb minus the noise floor. */
  aboveFloorDb: number;
  strength: number;
  brightness: number;
  maxRadius: number;
  speed: number;
}

export type DetectorPhase = 'idle' | 'onset' | 'sustained';

export function createDetectionEvent(): DetectionEvent {
  return {
    kind: 'transient',
    repeat: false,
    timeMs: 0,
    levelDb: 0,
    aboveFloorDb: 0,
    strength: 0,
    brightness: 0,
    maxRadius: 0,
    speed: 0,
  };
}

/**
 * Adaptive-floor onset detector.
 *
 *   idle      --RMS > floor+threshold, recent flux spike, refractory over-->  onset
 *   onset     --RMS < floor+release or peak-transientDrop--> emit transient, idle
 *   onset     --still loud after sustainMs--> emit sustained, sustained
 *   sustained --every sustainRepeatMs--> emit sustained repeat
 *   sustained --RMS < floor+release or sustainMaxMs--> idle
 *
 * step() returns a reused array whose event objects are only valid until the next step().
 */
export class OnsetDetector {
  /** Current adaptive noise floor in dBFS. */
  noiseFloorDb: number;
  phase: DetectorPhase = 'idle';
  /** nowMs of the last onset / last emitted event (-Infinity if none). */
  lastOnsetMs = -Infinity;
  lastEventMs = -Infinity;
  /** Auto-range: dB above the floor that currently counts as full strength. */
  loudRefDb: number;

  private lastStepMs = -Infinity;
  private lastFluxSpikeMs = -Infinity;
  private prevFlux = 0;
  private lastEndMs = -Infinity;

  // Current sound being tracked.
  private onsetMs = 0;
  private eventPeakDb = -Infinity;
  private peakCentroid = 0;
  private windowPeakDb = -Infinity;
  private windowBrightSum = 0;
  private windowFrames = 0;
  private nextRepeatMs = 0;

  private readonly out: DetectionEvent[] = [];
  private readonly pool: DetectionEvent[] = [createDetectionEvent(), createDetectionEvent()];

  private readonly cfg: DetectorConfig;

  constructor(cfg: DetectorConfig = DETECTOR_CONFIG) {
    this.cfg = cfg;
    this.noiseFloorDb = cfg.initialFloorDb;
    this.loudRefDb = cfg.autoRangeStartDb;
  }

  /** dB above the trigger that maps to strength 1 right now (auto-ranged or fixed). */
  get rangeDb(): number {
    return this.cfg.autoRange ? this.loudRefDb - this.cfg.thresholdDb : this.cfg.strengthRangeDb;
  }

  /** RMS level (dBFS) that currently gives a full-strength pulse. */
  get fullStrengthDb(): number {
    return this.noiseFloorDb + this.cfg.thresholdDb + this.rangeDb;
  }

  /** Map a level in dB above the noise floor to strength 0..1 (curve + sensitivity applied). */
  strengthFor(aboveFloorDb: number): number {
    const cfg = this.cfg;
    const t = clamp01((aboveFloorDb - cfg.thresholdDb) / Math.max(1, this.rangeDb));
    return clamp01(Math.pow(t, cfg.strengthGamma) * cfg.sensitivity);
  }

  /** Forget the learned loudness (auto-range starts again from autoRangeStartDb). */
  resetRange(): void {
    this.loudRefDb = this.cfg.autoRangeStartDb;
    this.clampLoudRef();
  }

  /** RMS level that opens the gate. */
  get gateDb(): number {
    return this.noiseFloorDb + this.cfg.thresholdDb;
  }

  /** RMS level below which a sound counts as finished. */
  get releaseLevelDb(): number {
    return this.noiseFloorDb + this.cfg.releaseDb;
  }

  /** Set the floor directly (calibration) and drop any sound in progress. */
  seedFloor(db: number): void {
    this.noiseFloorDb = Math.max(this.cfg.minFloorDb, db);
    this.clampLoudRef(); // keep what was learned about the mic, within the new headroom
    this.reset();
  }

  /** Drop any sound in progress without emitting (mute, calibration). Keeps the floor. */
  reset(): void {
    this.phase = 'idle';
    this.prevFlux = 0;
    this.lastFluxSpikeMs = -Infinity;
    this.lastStepMs = -Infinity;
  }

  step(f: AudioFeatures, nowMs: number): readonly DetectionEvent[] {
    const cfg = this.cfg;
    const out = this.out;
    out.length = 0;

    const dtS = Number.isFinite(this.lastStepMs)
      ? Math.min(Math.max((nowMs - this.lastStepMs) / 1000, 0), 0.25)
      : 0;
    this.lastStepMs = nowMs;

    const rms = f.rmsDb;
    if (f.flux >= cfg.fluxMin && f.flux > this.prevFlux) this.lastFluxSpikeMs = nowMs;
    this.prevFlux = f.flux;

    if (cfg.autoRange && dtS > 0) {
      this.loudRefDb -= cfg.autoRangeDecayDbPerS * dtS;
      this.clampLoudRef();
    }

    switch (this.phase) {
      case 'idle': {
        const fluxRising = nowMs - this.lastFluxSpikeMs <= cfg.fluxWindowMs;
        const refractoryOver = nowMs - this.lastOnsetMs >= cfg.refractoryMs;
        if (rms > this.gateDb && fluxRising && refractoryOver) {
          this.phase = 'onset';
          this.onsetMs = nowMs;
          this.lastOnsetMs = nowMs;
          this.eventPeakDb = rms;
          this.peakCentroid = f.brightness;
          this.resetWindow();
          this.track(f);
        } else if (nowMs - this.lastEndMs >= cfg.floorHoldMs && dtS > 0) {
          this.adaptFloor(rms, dtS);
        }
        break;
      }

      case 'onset': {
        if (rms > this.eventPeakDb) {
          this.eventPeakDb = rms;
          this.peakCentroid = f.brightness;
        }
        this.track(f);
        const released =
          rms < this.releaseLevelDb || rms < this.eventPeakDb - cfg.transientDropDb;
        if (released) {
          this.emit('transient', false, this.eventPeakDb, this.peakCentroid, nowMs);
          this.end(nowMs);
        } else if (nowMs - this.onsetMs >= cfg.sustainMs) {
          this.emit('sustained', false, this.windowPeakDb, this.windowBrightness(), nowMs);
          this.phase = 'sustained';
          this.resetWindow();
          this.nextRepeatMs = nowMs + cfg.sustainRepeatMs;
        }
        break;
      }

      case 'sustained': {
        if (rms < this.releaseLevelDb || nowMs - this.onsetMs >= cfg.sustainMaxMs) {
          this.end(nowMs);
          break;
        }
        this.track(f);
        if (nowMs >= this.nextRepeatMs) {
          this.emit('sustained', true, this.windowPeakDb, this.windowBrightness(), nowMs);
          this.resetWindow();
          this.nextRepeatMs = nowMs + cfg.sustainRepeatMs;
        }
        break;
      }
    }

    return out;
  }

  /** Keep the learned level between (trigger + min span) and the mic's headroom. */
  private clampLoudRef(): void {
    const cfg = this.cfg;
    const min = cfg.thresholdDb + cfg.autoRangeMinSpanDb;
    const headroom = cfg.ceilingDb - this.noiseFloorDb;
    const max = Math.max(min, headroom);
    this.loudRefDb = Math.min(max, Math.max(min, this.loudRefDb));
  }

  private adaptFloor(rms: number, dtS: number): void {
    const tau = rms > this.noiseFloorDb ? this.cfg.floorRiseTauS : this.cfg.floorFallTauS;
    const a = 1 - Math.exp(-dtS / tau);
    this.noiseFloorDb = Math.max(this.cfg.minFloorDb, this.noiseFloorDb + (rms - this.noiseFloorDb) * a);
  }

  private track(f: AudioFeatures): void {
    if (f.rmsDb > this.windowPeakDb) this.windowPeakDb = f.rmsDb;
    this.windowBrightSum += f.brightness;
    this.windowFrames++;
  }

  private resetWindow(): void {
    this.windowPeakDb = -Infinity;
    this.windowBrightSum = 0;
    this.windowFrames = 0;
  }

  private windowBrightness(): number {
    return this.windowFrames > 0 ? this.windowBrightSum / this.windowFrames : 0;
  }

  private end(nowMs: number): void {
    this.phase = 'idle';
    this.lastEndMs = nowMs;
  }

  private emit(
    kind: DetectionKind,
    repeat: boolean,
    levelDb: number,
    brightness: number,
    nowMs: number,
  ): void {
    const cfg = this.cfg;
    const above = levelDb - this.noiseFloorDb;
    const target = above + cfg.autoRangeHeadroomDb;
    if (cfg.autoRange && !repeat && target > this.loudRefDb) {
      // Instant attack: the loudest sound so far (+ headroom) defines full strength.
      this.loudRefDb = target;
      this.clampLoudRef();
    }
    let strength = this.strengthFor(above);
    if (cfg.autoRange && !repeat && target < this.loudRefDb) {
      // Learn downwards after judging this sound, so a quiet mic's scale settles in a few sounds.
      this.loudRefDb += (target - this.loudRefDb) * cfg.autoRangeLearnRate;
      this.clampLoudRef();
    }
    if (repeat) strength *= cfg.sustainRepeatScale;

    const e = this.pool[this.out.length] ?? createDetectionEvent();
    e.kind = kind;
    e.repeat = repeat;
    e.timeMs = nowMs;
    e.levelDb = levelDb;
    e.aboveFloorDb = above;
    e.strength = strength;
    e.brightness = clamp01(brightness);
    e.maxRadius = radiusForStrength(strength, cfg);
    e.speed = kind === 'transient' ? cfg.transientSpeed : cfg.sustainedSpeed;
    this.out.push(e);
    this.lastEventMs = nowMs;
  }
}
