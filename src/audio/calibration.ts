/**
 * src/audio/calibration.ts: seed the noise floor from ~1.5 s of silence
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 *
 * Pure (no DOM). index.ts shows "Stay quiet…" while active() and runs it again on C.
 * Uses a percentile rather than the mean, so a cough mid-calibration doesn't wreck the floor.
 */
import { DETECTOR_CONFIG, type AudioFeatures, type DetectorConfig } from './detector';

/** Enough for 1.5 s at 240 fps; extra frames are ignored. */
const MAX_SAMPLES = 512;

export class Calibrator {
  private readonly samples = new Float32Array(MAX_SAMPLES);
  private count = 0;
  private startMs = 0;
  private running = false;

  private readonly cfg: DetectorConfig;

  constructor(cfg: DetectorConfig = DETECTOR_CONFIG) {
    this.cfg = cfg;
  }

  start(nowMs: number): void {
    this.count = 0;
    this.startMs = nowMs;
    this.running = true;
  }

  cancel(): void {
    this.running = false;
  }

  active(): boolean {
    return this.running;
  }

  /** 0..1 progress for the HUD/meter. */
  progress(nowMs: number): number {
    if (!this.running) return 1;
    return Math.min(1, (nowMs - this.startMs) / this.cfg.calibrationMs);
  }

  /**
   * Feed one frame. Returns the measured floor (dBFS) on the frame calibration finishes,
   * otherwise null. Returns null and stops if no frames were collected.
   */
  step(f: AudioFeatures, nowMs: number): number | null {
    if (!this.running) return null;
    if (this.count < MAX_SAMPLES) this.samples[this.count++] = f.rmsDb;
    if (nowMs - this.startMs < this.cfg.calibrationMs) return null;

    this.running = false;
    if (this.count === 0) return null;
    // One-off sort at the end of calibration, not per frame.
    const sorted = this.samples.subarray(0, this.count).sort();
    const idx = Math.min(this.count - 1, Math.floor(this.cfg.calibrationPercentile * this.count));
    return sorted[idx];
  }
}
