/**
 * src/audio/debug-meter.ts: audio debug overlay, toggled with ` (backtick)
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 *
 * Live RMS bar, noise-floor / release / threshold / full-strength lines, onset flashes, the
 * last event, live tuning values and the active pulse count. Draws nothing while hidden. Text is cached and only rebuilt when
 * the value changes (or at 10 Hz for the live dB readout).
 */
import type { DetectionEvent, DetectorPhase } from './detector';

const W = 360;
const H = 128;
const DB_MIN = -100;
const DB_MAX = 0;

/** Filled by index.ts every frame; the meter only reads it. */
export interface MeterSnapshot {
  nowMs: number;
  status: string;
  phase: DetectorPhase;
  rmsDb: number;
  peak: number;
  floorDb: number;
  releaseDb: number;
  gateDb: number;
  /** RMS level that currently gives a full-strength pulse (auto-range ceiling). */
  fullDb: number;
  sensitivity: number;
  thresholdDb: number;
  rangeDb: number;
  autoRange: boolean;
  calibrating: boolean;
  calibrationProgress: number;
  /** Bumped every time lastEvent changes. */
  eventSerial: number;
  lastEvent: DetectionEvent;
  activePulses: number;
}

const PULSE_COUNT_TEXT = Array.from({ length: 33 }, (_, i) => `active pulses: ${i}`);

export class DebugMeter {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D | null;
  private shown = false;
  private eventSerial = -1;
  private eventText = 'last: none yet';
  private levelText = '';
  private tuningText = '';
  private tuningKey = NaN;
  private lastLevelTextMs = -Infinity;

  constructor(parent: HTMLElement) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.cssText = `position:absolute;left:8px;top:8px;width:${W}px;height:${H}px;display:none;pointer-events:none;`;
    this.g = this.canvas.getContext('2d');
    this.g?.scale(dpr, dpr);
    parent.appendChild(this.canvas);
  }

  get visible(): boolean {
    return this.shown;
  }

  toggle(): boolean {
    this.shown = !this.shown;
    this.canvas.style.display = this.shown ? 'block' : 'none';
    return this.shown;
  }

  draw(s: MeterSnapshot): void {
    const g = this.g;
    if (!this.shown || !g) return;

    // Background, flashing on events (cyan = transient, amber = sustained).
    const sinceEvent = s.nowMs - s.lastEvent.timeMs;
    const flash = s.eventSerial > 0 && sinceEvent < 150 ? 1 - sinceEvent / 150 : 0;
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(0,0,0,0.8)';
    g.fillRect(0, 0, W, H);
    if (flash > 0) {
      g.globalAlpha = 0.45 * flash;
      g.fillStyle = s.lastEvent.kind === 'transient' ? '#0ff' : '#fa0';
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }

    // Level bar.
    const bx = 8;
    const by = 8;
    const bw = W - 16;
    const bh = 18;
    g.fillStyle = '#222';
    g.fillRect(bx, by, bw, bh);
    g.fillStyle = s.phase === 'idle' ? '#3c3' : s.phase === 'onset' ? '#0ff' : '#fa0';
    g.fillRect(bx, by, bw * norm(s.rmsDb), bh);
    // Sample peak tick.
    const peakDb = s.peak > 0 ? 20 * Math.log10(s.peak) : DB_MIN;
    g.fillStyle = s.peak >= 0.99 ? '#f00' : '#ccc';
    g.fillRect(bx + bw * norm(peakDb) - 1, by, 2, bh);
    // Floor / release / gate lines.
    vline(g, bx + bw * norm(s.floorDb), by - 3, bh + 6, '#fff');
    vline(g, bx + bw * norm(s.releaseDb), by, bh, '#886');
    vline(g, bx + bw * norm(s.gateDb), by - 3, bh + 6, '#f44');
    vline(g, bx + bw * norm(s.fullDb), by - 3, bh + 6, '#48f');

    if (s.calibrating) {
      g.fillStyle = '#fff';
      g.fillRect(bx, by + bh + 2, bw * s.calibrationProgress, 2);
    }

    // Text.
    if (s.eventSerial !== this.eventSerial) {
      this.eventSerial = s.eventSerial;
      const e = s.lastEvent;
      this.eventText =
        `last: ${e.kind}${e.repeat ? ' (repeat)' : ''}  str ${e.strength.toFixed(2)}  ` +
        `bri ${e.brightness.toFixed(2)}  r ${e.maxRadius.toFixed(0)}m`;
    }
    if (s.nowMs - this.lastLevelTextMs > 100) {
      this.lastLevelTextMs = s.nowMs;
      this.levelText =
        `rms ${s.rmsDb.toFixed(1)}  floor ${s.floorDb.toFixed(1)}  gate ${s.gateDb.toFixed(1)} dBFS`;
    }
    // Rebuilt only when a value changes (key presses show up immediately).
    const tuningKey =
      Math.round(s.sensitivity * 100) * 1e6 + Math.round(s.thresholdDb) * 1e3 +
      Math.round(s.rangeDb) + (s.autoRange ? 0.5 : 0);
    if (tuningKey !== this.tuningKey) {
      this.tuningKey = tuningKey;
      this.tuningText =
        `sens ${s.sensitivity.toFixed(2)}x  trig ${s.thresholdDb.toFixed(0)}dB  ` +
        `full @ +${(s.thresholdDb + s.rangeDb).toFixed(0)}dB ${s.autoRange ? '(auto-range)' : '(fixed)'}`;
    }
    g.font = '11px ui-monospace, monospace';
    g.fillStyle = '#fff';
    g.fillText(s.status, 8, 44);
    g.fillStyle = '#aaa';
    g.fillText(s.phase, W - 80, 44);
    g.fillStyle = '#fff';
    g.fillText(this.levelText, 8, 60);
    g.fillStyle = '#8af';
    g.fillText(this.tuningText, 8, 76);
    g.fillStyle = '#fff';
    g.fillText(this.eventText, 8, 92);
    g.fillText(PULSE_COUNT_TEXT[Math.min(s.activePulses, PULSE_COUNT_TEXT.length - 1)], 8, 108);
    g.fillStyle = '#888';
    g.fillText('SPACE ping  C calibrate  M mute  [ ] sens  - = trig', 8, 122);
  }

  dispose(): void {
    this.canvas.remove();
  }
}

function norm(db: number): number {
  const t = (db - DB_MIN) / (DB_MAX - DB_MIN);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function vline(g: CanvasRenderingContext2D, x: number, y: number, h: number, color: string): void {
  g.fillStyle = color;
  g.fillRect(Math.round(x) - 1, y, 2, h);
}
