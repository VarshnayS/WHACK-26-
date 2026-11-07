/**
 * src/audio/synth.ts: procedural sounds for the soundscape (no files, no dependencies)
 * Owner: SENSES
 *
 * One-shots (steps, taps, thuds) are rendered ONCE into AudioBuffers at start-up with plain
 * JS DSP (noise, decaying sines, an RBJ biquad), a few random variants each. Playing one is then
 * just an AudioBufferSourceNode, so it costs almost nothing per hit, and a CC0 recording
 * (SFX_FILES in ./soundscapeConfig.ts) can replace any of them because a buffer is a buffer.
 */
import type { SfxName } from './soundscapeConfig';

type FilterType = 'lowpass' | 'highpass' | 'bandpass';

/** In-place RBJ biquad (one pass). */
function biquad(x: Float32Array, type: FilterType, freq: number, q: number, sr: number): Float32Array {
  const w0 = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = b0;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = b0;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
  return x;
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** Exponentially decaying noise burst (attack in s, decay time constant in s) added into `out`. */
function addNoiseBurst(
  out: Float32Array,
  sr: number,
  at: number,
  amp: number,
  attack: number,
  decay: number,
  filter: [FilterType, number, number][],
): void {
  const len = Math.min(out.length - Math.floor(at * sr), Math.floor((attack + decay * 6) * sr));
  if (len <= 0) return;
  const n = new Float32Array(len);
  for (let i = 0; i < len; i++) n[i] = Math.random() * 2 - 1;
  for (const [type, f, q] of filter) biquad(n, type, f, q, sr);
  const start = Math.floor(at * sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = t < attack ? t / attack : Math.exp(-(t - attack) / decay);
    out[start + i] += n[i] * env * amp;
  }
}

/** Decaying sine with an exponential pitch glide from f0 to f1 (glide time constant in s). */
function addTone(
  out: Float32Array,
  sr: number,
  at: number,
  amp: number,
  f0: number,
  f1: number,
  glide: number,
  decay: number,
): void {
  const start = Math.floor(at * sr);
  const len = Math.min(out.length - start, Math.floor(decay * 7 * sr));
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / glide);
    phase += (2 * Math.PI * f) / sr;
    const attack = Math.min(1, t / 0.002);
    out[start + i] += Math.sin(phase) * Math.exp(-t / decay) * attack * amp;
  }
}

/** Scale so the peak is `peak`, with a tiny fade at the end so nothing clicks. */
function finish(x: Float32Array, sr: number, peak = 0.9): Float32Array {
  let max = 0;
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]));
  const k = max > 0 ? peak / max : 0;
  const fade = Math.min(x.length, Math.floor(0.01 * sr));
  for (let i = 0; i < x.length; i++) {
    const tail = x.length - i < fade ? (x.length - i) / fade : 1;
    x[i] *= k * tail;
  }
  return x;
}

function toBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
  return buf;
}

// --- one-shot recipes ---------------------------------------------------------------------------

/** Shoe on pavement: low heel thump, gritty scuff, smaller toe roll. */
function footstep(sr: number, bright: number): Float32Array {
  const x = new Float32Array(Math.floor(0.3 * sr));
  addTone(x, sr, 0, 0.7, rand(110, 140), rand(55, 70), 0.015, 0.03);
  addNoiseBurst(x, sr, 0, 0.5, 0.002, rand(0.018, 0.03), [
    ['bandpass', rand(1400, 2600) * bright, 0.9],
    ['highpass', 300, 0.7],
  ]);
  const toe = rand(0.045, 0.08);
  addNoiseBurst(x, sr, toe, 0.25, 0.004, rand(0.015, 0.025), [['bandpass', rand(2200, 3400) * bright, 1.2]]);
  addTone(x, sr, toe, 0.2, 140, 80, 0.01, 0.02);
  return finish(x, sr);
}

/** Standing still: a soft cloth rustle / weight shift. */
function shuffle(sr: number): Float32Array {
  const x = new Float32Array(Math.floor(0.6 * sr));
  addNoiseBurst(x, sr, 0, 0.5, 0.08, 0.09, [
    ['bandpass', rand(700, 1200), 0.6],
    ['lowpass', 2500, 0.7],
  ]);
  addNoiseBurst(x, sr, rand(0.15, 0.25), 0.35, 0.05, 0.06, [['bandpass', rand(1500, 2200), 0.8]]);
  return finish(x, sr, 0.6);
}

/** Aluminium cane tip on concrete: hard click + short metallic ring. */
function caneTap(sr: number): Float32Array {
  const x = new Float32Array(Math.floor(0.25 * sr));
  addNoiseBurst(x, sr, 0, 0.8, 0.0005, 0.004, [['highpass', 2500, 0.7]]);
  addTone(x, sr, 0, 0.35, rand(2200, 2500), rand(2150, 2400), 0.05, 0.05);
  addTone(x, sr, 0, 0.18, rand(3600, 3900), rand(3500, 3800), 0.05, 0.03);
  addTone(x, sr, 0, 0.2, 400, 260, 0.01, 0.012);
  return finish(x, sr, 0.8);
}

/** Stun: heavy body impact, a low sweep with some saturation. */
function thud(sr: number): Float32Array {
  const x = new Float32Array(Math.floor(0.9 * sr));
  addTone(x, sr, 0, 1, 120, 38, 0.08, 0.22);
  addTone(x, sr, 0, 0.4, 70, 30, 0.1, 0.3);
  addNoiseBurst(x, sr, 0, 0.8, 0.002, 0.06, [
    ['lowpass', 500, 0.8],
    ['lowpass', 900, 0.7],
  ]);
  addNoiseBurst(x, sr, 0, 0.25, 0.001, 0.015, [['bandpass', 1800, 1]]);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * 2.2);
  return finish(x, sr, 0.95);
}

/** The entity: a heavy, dragging step: deep thump, gravel crunch, a long scrape. */
function entityStep(sr: number): Float32Array {
  const x = new Float32Array(Math.floor(1.0 * sr));
  addTone(x, sr, 0, 1, rand(70, 85), rand(32, 40), 0.04, 0.16);
  addNoiseBurst(x, sr, 0, 0.6, 0.004, 0.07, [
    ['lowpass', rand(500, 750), 0.9],
    ['highpass', 80, 0.7],
  ]);
  addNoiseBurst(x, sr, rand(0.08, 0.14), 0.22, 0.12, 0.18, [
    ['bandpass', rand(700, 1000), 1.4],
    ['lowpass', 1600, 0.7],
  ]);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * 1.6);
  return finish(x, sr, 0.95);
}

const VARIANTS = 4;

/** Render every procedural one-shot (a few variants each). Runs once, ~50 ms. */
export function renderOneShots(ctx: BaseAudioContext): Map<SfxName, AudioBuffer[]> {
  const sr = ctx.sampleRate;
  const make = (fn: () => Float32Array, n = VARIANTS) => Array.from({ length: n }, () => toBuffer(ctx, fn()));
  return new Map<SfxName, AudioBuffer[]>([
    ['footstep', make(() => footstep(sr, 1))],
    ['shuffle', make(() => shuffle(sr), 3)],
    ['pedStep', make(() => footstep(sr, 1.3))],
    ['cane', make(() => caneTap(sr), 3)],
    ['thud', make(() => thud(sr), 2)],
    ['entityStep', make(() => entityStep(sr), 3)],
  ]);
}

// --- loops ------------------------------------------------------------------------------------

/** Loopable white noise (seconds long). */
export function whiteNoise(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const x = new Float32Array(Math.floor(seconds * ctx.sampleRate));
  for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
  return toBuffer(ctx, x);
}

/** Loopable brown noise (integrated white noise, normalised): a deep rumble. */
export function brownNoise(ctx: BaseAudioContext, seconds = 4): AudioBuffer {
  const x = new Float32Array(Math.floor(seconds * ctx.sampleRate));
  let last = 0;
  for (let i = 0; i < x.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    x[i] = last;
  }
  // cross-fade the ends so the loop has no click
  const fade = Math.floor(0.05 * ctx.sampleRate);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    x[i] = x[i] * t + x[x.length - fade + i] * (1 - t);
  }
  return toBuffer(ctx, finish(x.subarray(0, x.length - fade), ctx.sampleRate, 0.9).slice());
}
