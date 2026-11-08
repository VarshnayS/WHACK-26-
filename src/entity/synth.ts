/**
 * src/entity/synth.ts: procedurally generated entity sounds (no audio files)
 * Owner: entity (src/entity/)
 *
 * Pure functions: each returns mono samples in -1..1 at the given sample rate.
 * src/entity/audio.ts turns them into AudioBuffers and plays them positionally.
 */

/** Small seeded RNG so every load sounds the same. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

function normalise(out: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] *= peak / max;
  return out;
}

/** One heavy, dragging footstep: low thump + gritty scuff. `variant` changes the texture. */
export function footstep(sampleRate: number, variant = 0): Float32Array {
  const n = Math.floor(sampleRate * 0.32);
  const out = new Float32Array(n);
  const noise = rng(101 + variant * 17);
  const f0 = 68 + variant * 6;
  let lp = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // Thump: falling sine.
    const f = f0 * (0.6 + 0.4 * Math.exp(-t * 25));
    phase += (2 * Math.PI * f) / sampleRate;
    const thump = Math.sin(phase) * Math.exp(-t * 28);
    // Scuff: low-passed noise that drags on a little after the impact.
    lp += 0.18 * (noise() - lp);
    const drag = t < 0.012 ? 0 : Math.exp(-(t - 0.012) * 14) * (0.6 + 0.4 * Math.sin(t * 90));
    out[i] = thump * 0.9 + lp * drag * 1.6;
  }
  return normalise(out);
}

/**
 * One wet, ragged breath cycle (inhale then a longer, rattling exhale), loopable.
 * Loop it and raise playbackRate to make it pant.
 */
export function breathCycle(sampleRate: number): Float32Array {
  const dur = 3.2;
  const n = Math.floor(sampleRate * dur);
  const out = new Float32Array(n);
  const noise = rng(7);
  let lp = 0;
  let hpPrev = 0;
  let hp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let env = 0;
    let bright = 0.1;
    let rattle = 0;
    if (t < 1.1) {
      // Inhale: thin and hissy.
      env = Math.sin((Math.PI * t) / 1.1) ** 2 * 0.55;
      bright = 0.25;
    } else if (t > 1.35 && t < 3.0) {
      // Exhale: lower, louder, with a throat rattle.
      const u = (t - 1.35) / 1.65;
      env = Math.sin(Math.PI * u) ** 1.5;
      bright = 0.09;
      rattle = 0.55;
    }
    const x = noise();
    lp += bright * (x - lp);
    hp = 0.97 * (hp + lp - hpPrev); // remove rumble
    hpPrev = lp;
    const trem = 1 - rattle * (0.5 + 0.5 * Math.sin(2 * Math.PI * 31 * t + Math.sin(t * 7) * 2));
    out[i] = hp * env * trem;
  }
  return normalise(out, 0.8);
}

/** Low, throaty growl for when it locks on to you. `pitch` scales the voice. */
export function growl(sampleRate: number, dur = 1.6, pitch = 1): Float32Array {
  const n = Math.floor(sampleRate * dur);
  const out = new Float32Array(n);
  const noise = rng(33);
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = pitch * (50 + 7 * Math.sin(2 * Math.PI * 0.8 * t) + 3 * noise());
    phase += f / sampleRate;
    const saw = 2 * (phase - Math.floor(phase)) - 1;
    const src = saw + noise() * 0.5;
    lp += 0.07 * (src - lp);
    const env = Math.min(1, t / 0.12) * Math.exp(-Math.max(0, t - dur * 0.55) * 4);
    const trem = 0.55 + 0.45 * Math.sin(2 * Math.PI * 17 * t);
    out[i] = Math.tanh(lp * 3) * env * trem;
  }
  return normalise(out);
}

/** A sharp gasp: the sound it makes when it hears you. */
export function gasp(sampleRate: number): Float32Array {
  const dur = 0.7;
  const n = Math.floor(sampleRate * dur);
  const out = new Float32Array(n);
  const noise = rng(55);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const u = t / dur;
    const env = u < 0.85 ? u ** 2 : (1 - (u - 0.85) / 0.15) * 0.72; // swell, then cut off
    lp += (0.08 + 0.35 * u) * (noise() - lp); // gets brighter as it inhales
    out[i] = lp * env;
  }
  return normalise(out, 0.85);
}

/** Distorted shriek for the catch. */
export function shriek(sampleRate: number): Float32Array {
  const dur = 1.4;
  const n = Math.floor(sampleRate * dur);
  const out = new Float32Array(n);
  const noise = rng(77);
  let p1 = 0;
  let p2 = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = 520 * Math.exp(-t * 1.3) + 90 + 30 * Math.sin(2 * Math.PI * 9 * t);
    p1 += f / sampleRate;
    p2 += (f * 1.51) / sampleRate;
    const src = Math.sin(2 * Math.PI * p1) + 0.6 * Math.sin(2 * Math.PI * p2) + noise() * 0.8;
    lp += 0.3 * (src - lp);
    const env = Math.min(1, t / 0.03) * Math.exp(-t * 1.6);
    out[i] = Math.tanh(lp * 4) * env;
  }
  return normalise(out, 0.95);
}
/** A deep, distorted impact for the jumpscare: sub thump plus a burst of noise. */
export function boom(sampleRate: number): Float32Array {
  const dur = 0.9;
  const n = Math.floor(sampleRate * dur);
  const out = new Float32Array(n);
  const noise = rng(91);
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    phase += (2 * Math.PI * (38 + 70 * Math.exp(-t * 18))) / sampleRate;
    lp += 0.25 * (noise() - lp);
    const thump = Math.sin(phase) * Math.exp(-t * 4);
    const crack = lp * Math.exp(-t * 22) * 2.5;
    out[i] = Math.tanh((thump + crack) * 2.2);
  }
  return normalise(out, 0.98);
}
