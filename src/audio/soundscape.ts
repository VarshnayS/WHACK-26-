/**
 * src/audio/soundscape.ts: immersive spatial audio (Web Audio, HRTF), purely audio, no pings
 * Owner: SENSES. Installed from initMic() in ./index.ts; the AudioContext is created by
 * startSoundscape(), which the start screen calls inside its "Click to begin" handler (browser
 * autoplay rule). Later gestures only resume it if the browser suspended it.
 *
 * The AudioListener follows the camera position and orientation every frame. Sources:
 *   - CARS: procedural engine (detuned saws + sub, low-passed, rough AM) + tyre/road noise; pitch and
 *     level follow speed, with an (exaggerated) Doppler shift as they pass. Nearest MAX_CAR_VOICES.
 *   - PEDESTRIANS: soft footstep taps synced to their walk cycle (onPedestrianStep from
 *     src/world/soundSources.ts, at the step itself; the faint ping follows 0.3–0.5 s later like an
 *     echo), and murmured conversation in groups: a voiced source through
 *     moving formant filters with syllable envelopes; group members take turns.
 *   - PLAYER: own footsteps / idle shuffle (from the 'footstep' pings of src/senses/footsteps.ts),
 *     cane taps (from 'cane' pings), a heavy thud + ear ringing on world 'stunned'.
 *   - ENTITY (when world.entity exists): slow, uneven, dragging steps, louder as it approaches.
 *   - AMBIENT: distant traffic hum + light wind (non-spatial bed).
 *
 * Reads world.agents, world.pings and world.entity only. Never fires a ping.
 * Budget: ≤ 4 engines + 2 conversations + 4 one-shot panners + 1 entity ≈ 10 HRTF voices; sources
 * fade in/out as they are picked. Keys: U mute, `,` / `.` volume down / up (saved per browser).
 * Recordings can replace any sound: see SFX_FILES in ./soundscapeConfig.ts (public/sfx/).
 */
import * as THREE from 'three';
import type { Agent, World } from '../world';
import type { ActivePing } from '../shared/contracts';
import type { StunnedPayload } from '../player/controller';
import * as C from './soundscapeConfig';
import type { SfxName } from './soundscapeConfig';
import { brownNoise, renderOneShots, whiteNoise } from './synth';
import { onPedestrianStep } from '../world/soundSources';
import { getCaneState } from '../senses/cane';

// --- small helpers ------------------------------------------------------------------------------

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}
function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function makePanner(ctx: AudioContext, refDistance = C.PANNER_REF_DISTANCE, rolloff = C.PANNER_ROLLOFF): PannerNode {
  return new PannerNode(ctx, {
    panningModel: 'HRTF',
    distanceModel: 'inverse',
    refDistance,
    rolloffFactor: rolloff,
    maxDistance: 10000,
  });
}

function setPannerPos(p: PannerNode, x: number, y: number, z: number): void {
  if (p.positionX) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }
}

/** A looping noise source started at a random offset (so voices don't phase together). */
function noiseSource(ctx: AudioContext, buf: AudioBuffer): AudioBufferSourceNode {
  const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
  src.start(0, Math.random() * buf.duration);
  return src;
}

/** A slow sine LFO feeding `target` with ±depth around its current value. */
function lfo(ctx: AudioContext, hz: number, depth: number, target: AudioParam): OscillatorNode {
  const osc = new OscillatorNode(ctx, { frequency: hz });
  const g = new GainNode(ctx, { gain: depth });
  osc.connect(g).connect(target);
  osc.start(ctx.currentTime + Math.random());
  return osc;
}

// --- cars ---------------------------------------------------------------------------------------

const tmpDir = new THREE.Vector3();
const tmpRel = new THREE.Vector3();

class CarVoice {
  agent: Agent | null = null;
  private readonly out: GainNode;
  private readonly panner: PannerNode;
  private readonly oscBus: GainNode;
  private readonly saw1: OscillatorNode;
  private readonly saw2: OscillatorNode;
  private readonly sub: OscillatorNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly engineGain: GainNode;
  private readonly tyreGain: GainNode;
  private readonly tyreFilter: BiquadFilterNode;
  private readonly tyreSrc: AudioBufferSourceNode;
  private sample: AudioBufferSourceNode | null = null;
  private connected = false;
  private releaseAt = 0;

  constructor(
    private readonly ctx: AudioContext,
    noise: AudioBuffer,
    private readonly dest: AudioNode,
  ) {
    this.out = new GainNode(ctx, { gain: 0 });
    this.panner = makePanner(ctx);
    this.out.connect(this.panner);

    this.oscBus = new GainNode(ctx, { gain: 1 });
    this.saw1 = new OscillatorNode(ctx, { type: 'sawtooth', frequency: C.ENGINE_HZ_IDLE });
    this.saw2 = new OscillatorNode(ctx, { type: 'sawtooth', frequency: C.ENGINE_HZ_IDLE * 2.01 });
    this.sub = new OscillatorNode(ctx, { type: 'square', frequency: C.ENGINE_HZ_IDLE * 0.5 });
    const g2 = new GainNode(ctx, { gain: 0.35 });
    const gSub = new GainNode(ctx, { gain: 0.4 });
    this.saw1.connect(this.oscBus);
    this.saw2.connect(g2).connect(this.oscBus);
    this.sub.connect(gSub).connect(this.oscBus);
    this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 300, Q: 2 });
    this.engineGain = new GainNode(ctx, { gain: C.ENGINE_GAIN_IDLE });
    this.oscBus.connect(this.lowpass).connect(this.engineGain).connect(this.out);
    // roughness: fast irregular amplitude wobble (cylinder firing unevenness)
    lfo(ctx, rand(11, 17), 0.12, this.engineGain.gain);
    lfo(ctx, rand(5, 7), 0.06, this.engineGain.gain);

    this.tyreSrc = noiseSource(ctx, noise);
    this.tyreFilter = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 900, Q: 0.6 });
    this.tyreGain = new GainNode(ctx, { gain: 0 });
    this.tyreSrc.connect(this.tyreFilter).connect(this.tyreGain).connect(this.out);

    const t = ctx.currentTime;
    this.saw1.start(t);
    this.saw2.start(t);
    this.sub.start(t);
  }

  /** Replace the oscillators with a recorded engine loop (SFX_FILES.engine). */
  useSample(buf: AudioBuffer): void {
    if (this.sample) return;
    this.sample = noiseSource(this.ctx, buf);
    this.sample.connect(this.lowpass);
    this.oscBus.gain.value = 0;
  }

  get free(): boolean {
    return !this.agent && this.ctx.currentTime >= this.releaseAt;
  }

  assign(agent: Agent): void {
    this.agent = agent;
    if (!this.connected) {
      this.panner.connect(this.dest);
      this.connected = true;
    }
    this.out.gain.setTargetAtTime(1, this.ctx.currentTime, C.FADE_TAU);
  }

  release(): void {
    if (!this.agent) return;
    this.agent = null;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, C.FADE_TAU);
    this.releaseAt = t + C.FADE_TAU * 6;
  }

  update(listener: THREE.Vector3, listenerVel: THREE.Vector3): void {
    const t = this.ctx.currentTime;
    if (!this.agent) {
      if (this.connected && t >= this.releaseAt) {
        this.panner.disconnect();
        this.connected = false;
      }
      return;
    }
    const a = this.agent;
    const p = a.position;
    setPannerPos(this.panner, p.x, p.y + 0.5, p.z);

    const s = clamp(Math.hypot(a.velocity.x, a.velocity.z) / C.CAR_FULL_SPEED, 0, 1);
    // Doppler: approach speed along the line from the car to the listener
    tmpDir.copy(listener).sub(p);
    const d = tmpDir.length();
    let approach = 0;
    if (d > 1e-3) {
      tmpRel.copy(a.velocity).sub(listenerVel);
      approach = tmpRel.dot(tmpDir) / d;
    }
    const c = C.SPEED_OF_SOUND;
    const doppler = c / (c - clamp(approach * C.DOPPLER_EXAGGERATION, -0.5 * c, 0.5 * c));

    const f0 = lerp(C.ENGINE_HZ_IDLE, C.ENGINE_HZ_FULL, s) * doppler;
    const tau = 0.06;
    this.saw1.frequency.setTargetAtTime(f0, t, tau);
    this.saw2.frequency.setTargetAtTime(f0 * 2.01, t, tau);
    this.sub.frequency.setTargetAtTime(f0 * 0.5, t, tau);
    this.lowpass.frequency.setTargetAtTime(lerp(260, 1100, s) * doppler, t, tau);
    this.engineGain.gain.setTargetAtTime(lerp(C.ENGINE_GAIN_IDLE, C.ENGINE_GAIN_FULL, s), t, tau);
    this.tyreGain.gain.setTargetAtTime(C.TYRE_GAIN_FULL * s * s, t, tau);
    this.tyreFilter.frequency.setTargetAtTime(lerp(500, 1300, s) * doppler, t, tau);
    this.tyreSrc.playbackRate.setTargetAtTime(doppler, t, tau);
    if (this.sample) this.sample.playbackRate.setTargetAtTime(lerp(0.7, 1.3, s) * doppler, t, tau);
  }
}

// --- murmur (distant conversation) --------------------------------------------------------------

/** Vowel formants F1, F2, F3 (Hz), adult average. */
const VOWELS: readonly [number, number, number][] = [
  [800, 1200, 2500], // a
  [500, 1900, 2500], // e
  [320, 2200, 3000], // i
  [500, 900, 2400], // o
  [350, 800, 2300], // u
  [600, 1500, 2450], // schwa-ish
];

class MurmurVoice {
  members: Agent[] = [];
  private readonly pitch: number[] = [];
  private readonly formantScale: number[] = [];
  private readonly out: GainNode;
  private readonly env: GainNode;
  private readonly panner: PannerNode;
  private readonly glottis: OscillatorNode;
  private readonly f: BiquadFilterNode[];
  private connected = false;
  private releaseAt = 0;
  private nextPhraseAt = 0;
  private lastSpeaker = 0;
  /** Phrase schedule: the speaker whose position the panner follows from `start` on. */
  private queuedSpeaker = 0;
  private queuedStart = 0;
  private speaker = 0;

  constructor(
    private readonly ctx: AudioContext,
    noise: AudioBuffer,
    private readonly dest: AudioNode,
  ) {
    this.out = new GainNode(ctx, { gain: 0 });
    this.panner = makePanner(ctx, 2, 1.3);
    this.out.connect(this.panner);

    this.glottis = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 130 });
    const breath = noiseSource(ctx, noise);
    const breathGain = new GainNode(ctx, { gain: 0.25 });
    const src = new GainNode(ctx, { gain: 1 });
    this.glottis.connect(src);
    breath.connect(breathGain).connect(src);

    const sum = new GainNode(ctx, { gain: 1 });
    const levels = [1, 0.55, 0.25];
    this.f = levels.map((lvl, i) => {
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: VOWELS[5][i], Q: 7 });
      src.connect(bp).connect(new GainNode(ctx, { gain: lvl * 3 })).connect(sum);
      return bp;
    });
    // distance / crowd muffle
    const muffle = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1700, Q: 0.5 });
    this.env = new GainNode(ctx, { gain: 0 });
    sum.connect(muffle).connect(this.env).connect(this.out);
    this.glottis.start();
  }

  get free(): boolean {
    return this.members.length === 0 && this.ctx.currentTime >= this.releaseAt;
  }

  assign(members: Agent[]): void {
    this.members = members.slice();
    this.pitch.length = 0;
    this.formantScale.length = 0;
    for (let i = 0; i < members.length; i++) {
      const high = Math.random() < 0.5;
      this.pitch.push(high ? rand(175, 235) : rand(95, 140));
      this.formantScale.push(high ? rand(1.1, 1.2) : rand(0.95, 1.02));
    }
    this.speaker = this.lastSpeaker = Math.floor(Math.random() * members.length);
    this.queuedSpeaker = this.speaker;
    this.queuedStart = 0;
    const t = this.ctx.currentTime;
    this.nextPhraseAt = t + rand(0.3, 2.5);
    if (!this.connected) {
      this.panner.connect(this.dest);
      this.connected = true;
    }
    this.out.gain.setTargetAtTime(C.MURMUR_GAIN, t, C.FADE_TAU);
  }

  release(): void {
    if (this.members.length === 0) return;
    this.members = [];
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, C.FADE_TAU);
    this.releaseAt = t + C.FADE_TAU * 6;
  }

  /** Schedule one phrase (a run of syllables by one speaker) starting at t0. */
  private schedulePhrase(t0: number): void {
    const n = this.members.length;
    // take turns: usually the other person answers, sometimes the same one carries on
    let who = this.lastSpeaker;
    if (n > 1 && Math.random() < 0.8) who = (this.lastSpeaker + 1 + Math.floor(Math.random() * (n - 1))) % n;
    this.lastSpeaker = who;
    this.queuedSpeaker = who;
    this.queuedStart = t0;

    const base = this.pitch[who];
    const fs = this.formantScale[who];
    const question = Math.random() < 0.25;
    const syllables = 3 + Math.floor(Math.random() * 9);
    const env = this.env.gain;
    let t = t0;
    for (let k = 0; k < syllables; k++) {
      const dur = rand(0.11, 0.24);
      const along = k / syllables;
      // falling intonation (declination); questions rise at the end
      const contour = question && k >= syllables - 2 ? 1.18 : 1 + 0.12 * (1 - along);
      this.glottis.frequency.setTargetAtTime(base * contour * rand(0.95, 1.05), t, 0.03);
      const v = pick(VOWELS);
      for (let i = 0; i < 3; i++) this.f[i].frequency.setTargetAtTime(v[i] * fs, t, 0.025);
      const amp = rand(0.5, 1) * (1 - 0.35 * along);
      env.setTargetAtTime(amp, t, 0.02); // vowel onset
      env.setTargetAtTime(amp * 0.06, t + dur * 0.72, 0.025); // consonant dip
      t += dur;
    }
    env.setTargetAtTime(0, t, 0.05);
    // pause before the next turn; now and then a longer lull
    this.nextPhraseAt = t + (Math.random() < 0.15 ? rand(2, 6) : rand(0.2, 0.9));
  }

  update(): void {
    const t = this.ctx.currentTime;
    if (this.members.length === 0) {
      if (this.connected && t >= this.releaseAt) {
        this.panner.disconnect();
        this.connected = false;
      }
      return;
    }
    if (t >= this.nextPhraseAt - 0.15) this.schedulePhrase(Math.max(t, this.nextPhraseAt));
    if (t >= this.queuedStart) this.speaker = this.queuedSpeaker;
    const a = this.members[this.speaker] ?? this.members[0];
    setPannerPos(this.panner, a.position.x, a.position.y + C.MOUTH_HEIGHT, a.position.z);
  }
}

// --- one-shot panner pool -----------------------------------------------------------------------

interface OneShotSlot {
  input: GainNode;
  panner: PannerNode;
  busyUntil: number;
}

// --- the soundscape -----------------------------------------------------------------------------

class Soundscape {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private playerBus!: GainNode;
  private spatialBus!: GainNode;
  private ambientBus!: GainNode;
  private tinnitus!: GainNode;
  private entityPanner!: PannerNode;
  private buffers = new Map<SfxName, AudioBuffer[]>();
  private cars: CarVoice[] = [];
  private murmurs: MurmurVoice[] = [];
  private slots: OneShotSlot[] = [];

  private volume = C.MASTER_VOLUME;
  private muted = false;
  private msgEl: HTMLDivElement | null = null;
  private msgTimer = 0;

  private lastPingStart = Infinity;
  private reassignTimer = 0;
  private groupTimer = 0;
  private stepSide = 1;
  /** CaneState.tapSerial already played (sweep pings don't bump it, so they stay silent). */
  private caneTapHeard = 0;
  /** CaneState.touchSerial already played (auto-sweep touch-downs: a soft tick). */
  private caneTouchHeard = 0;
  private entityNextStep = 0;
  private entityLimp = 1;
  private readonly chatty = new WeakMap<Agent, boolean>();
  private offStep: (() => void) | null = null;

  private readonly listenerPos = new THREE.Vector3();
  private readonly lastListenerPos = new THREE.Vector3();
  private readonly listenerVel = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly carPick: Agent[] = [];

  constructor(private readonly world: World) {
    try {
      const v = Number(window.localStorage.getItem(C.VOLUME_STORAGE_KEY));
      if (window.localStorage.getItem(C.VOLUME_STORAGE_KEY) !== null && Number.isFinite(v)) {
        this.volume = clamp(v, 0, 1);
      }
    } catch {
      /* storage blocked: keep the default */
    }
  }

  install(): void {
    window.addEventListener('pointerdown', this.onGesture, true);
    window.addEventListener('keydown', this.onGesture, true);
    window.addEventListener('keydown', this.onKeyDown);
    this.world.on('stunned', this.onStunned);
    this.world.onUpdate(this.update);
    this.offStep = onPedestrianStep(this.onPedStep);
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.onGesture, true);
    window.removeEventListener('keydown', this.onGesture, true);
    window.removeEventListener('keydown', this.onKeyDown);
    this.world.off('stunned', this.onStunned);
    this.offStep?.();
    this.msgEl?.remove();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  // --- start-up (inside the first user gesture) --------------------------------------------------

  private readonly onGesture = (): void => {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  };

  /** Create / resume the AudioContext. Call inside a user gesture. */
  begin(): void {
    if (!this.ctx) this.start();
    else this.onGesture();
  }

  private start(): void {
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

    const limiter = new DynamicsCompressorNode(ctx, { threshold: -10, knee: 6, ratio: 8, attack: 0.003, release: 0.2 });
    this.master = new GainNode(ctx, { gain: this.muted ? 0 : this.volume });
    this.master.connect(limiter).connect(ctx.destination);
    this.playerBus = new GainNode(ctx, { gain: 1 });
    this.spatialBus = new GainNode(ctx, { gain: 1 });
    this.ambientBus = new GainNode(ctx, { gain: 1 });
    this.playerBus.connect(this.master);
    this.spatialBus.connect(this.master);
    this.ambientBus.connect(this.master);

    this.buffers = renderOneShots(ctx);
    const white = whiteNoise(ctx);
    const brown = brownNoise(ctx);

    for (let i = 0; i < C.MAX_CAR_VOICES; i++) this.cars.push(new CarVoice(ctx, white, this.spatialBus));
    for (let i = 0; i < C.MAX_MURMUR_VOICES; i++) this.murmurs.push(new MurmurVoice(ctx, white, this.spatialBus));
    for (let i = 0; i < C.MAX_ONESHOT_VOICES; i++) {
      const input = new GainNode(ctx, { gain: 1 });
      const panner = makePanner(ctx, 1.5, 1.2);
      input.connect(panner).connect(this.spatialBus);
      this.slots.push({ input, panner, busyUntil: 0 });
    }
    this.entityPanner = makePanner(ctx, 2, 1);
    this.entityPanner.connect(this.spatialBus);

    // ear ringing after a stun (silent until then)
    const ring = new OscillatorNode(ctx, { frequency: C.TINNITUS_HZ });
    this.tinnitus = new GainNode(ctx, { gain: 0 });
    ring.connect(this.tinnitus).connect(this.playerBus);
    ring.start();

    this.buildAmbient(ctx, white, brown);
    this.lastPingStart = performance.now() / 1000; // only react to pings fired from now on
    this.lastListenerPos.copy(this.world.camera.position);
    void this.loadFiles(ctx);
    console.info('[soundscape] started (U mute, , / . volume)');
  }

  private buildAmbient(ctx: AudioContext, white: AudioBuffer, brown: AudioBuffer): void {
    // distant traffic hum: deep rumble drifting slowly across the stereo field
    const hum = noiseSource(ctx, brown);
    const humLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 170, Q: 0.4 });
    const humGain = new GainNode(ctx, { gain: C.AMBIENT_HUM_GAIN });
    const humPan = new StereoPannerNode(ctx, { pan: 0 });
    hum.connect(humLp).connect(humGain).connect(humPan).connect(this.ambientBus);
    lfo(ctx, 0.05, C.AMBIENT_HUM_GAIN * 0.35, humGain.gain);
    lfo(ctx, 0.031, 0.4, humPan.pan);

    // light wind: band-passed noise with a wandering centre and slow gusts
    const wind = noiseSource(ctx, white);
    const windBp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 550, Q: 0.8 });
    const windGain = new GainNode(ctx, { gain: C.AMBIENT_WIND_GAIN });
    const windPan = new StereoPannerNode(ctx, { pan: 0 });
    wind.connect(windBp).connect(windGain).connect(windPan).connect(this.ambientBus);
    lfo(ctx, 0.07, 250, windBp.frequency);
    lfo(ctx, 0.11, C.AMBIENT_WIND_GAIN * 0.6, windGain.gain);
    lfo(ctx, 0.045, 0.6, windPan.pan);
  }

  /** Load the optional recordings listed in SFX_FILES (none by default). */
  private async loadFiles(ctx: AudioContext): Promise<void> {
    for (const [name, urls] of Object.entries(C.SFX_FILES) as [SfxName, string[]][]) {
      if (!urls?.length) continue;
      try {
        const bufs = await Promise.all(
          urls.map(async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
            return ctx.decodeAudioData(await res.arrayBuffer());
          }),
        );
        if (this.ctx !== ctx) return;
        if (name === 'engine') for (const car of this.cars) car.useSample(bufs[0]);
        else if (name === 'ambient') {
          this.ambientBus.gain.value = 0;
          const loop = noiseSource(ctx, bufs[0]);
          loop.connect(new GainNode(ctx, { gain: 0.5 })).connect(this.master);
        } else this.buffers.set(name, bufs);
        console.info(`[soundscape] using recorded '${name}' (${bufs.length} file(s))`);
      } catch (err) {
        console.warn(`[soundscape] could not load '${name}', keeping the synth:`, err);
      }
    }
  }

  // --- playback helpers ----------------------------------------------------------------------------

  /** Non-spatial one-shot on the player bus (`pan` -1..1). */
  private playPlayer(name: SfxName, gain: number, pan = 0, rate = rand(0.93, 1.07)): void {
    const ctx = this.ctx;
    const list = this.buffers.get(name);
    if (!ctx || !list?.length) return;
    const src = new AudioBufferSourceNode(ctx, { buffer: pick(list), playbackRate: rate });
    const g = new GainNode(ctx, { gain });
    const p = new StereoPannerNode(ctx, { pan });
    src.connect(g).connect(p).connect(this.playerBus);
    src.start();
  }

  /** Spatial one-shot through a pooled HRTF panner; skipped if every slot is busy. */
  private playAt(name: SfxName, pos: THREE.Vector3, gain: number): void {
    const ctx = this.ctx;
    const list = this.buffers.get(name);
    if (!ctx || !list?.length) return;
    const t = ctx.currentTime;
    let slot: OneShotSlot | null = null;
    for (const s of this.slots) {
      if (s.busyUntil <= t) {
        slot = s;
        break;
      }
    }
    if (!slot) return;
    const buf = pick(list);
    const rate = rand(0.92, 1.08);
    setPannerPos(slot.panner, pos.x, pos.y, pos.z);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
    const g = new GainNode(ctx, { gain });
    src.connect(g).connect(slot.input);
    src.start(t);
    slot.busyUntil = t + buf.duration / rate;
  }

  // --- per frame ---------------------------------------------------------------------------------

  private readonly update = (dt: number): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.updateListener(dt);
    this.scanPings();

    this.reassignTimer -= dt;
    if (this.reassignTimer <= 0) {
      this.reassignTimer = C.VOICE_REASSIGN_INTERVAL;
      this.assignCars();
    }
    this.groupTimer -= dt;
    if (this.groupTimer <= 0) {
      this.groupTimer = C.GROUP_SCAN_INTERVAL;
      this.assignConversations();
    }
    for (const car of this.cars) car.update(this.listenerPos, this.listenerVel);
    for (const m of this.murmurs) m.update();
    this.updateEntity();
  };

  private updateListener(dt: number): void {
    const ctx = this.ctx!;
    const cam = this.world.camera;
    this.listenerPos.copy(cam.position);
    cam.getWorldDirection(this.fwd);
    this.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    if (dt > 0) {
      // smoothed listener velocity, for the Doppler shift
      const k = Math.min(1, dt * 8);
      this.listenerVel.x += ((this.listenerPos.x - this.lastListenerPos.x) / dt - this.listenerVel.x) * k;
      this.listenerVel.z += ((this.listenerPos.z - this.lastListenerPos.z) / dt - this.listenerVel.z) * k;
      this.listenerVel.y = 0;
    }
    this.lastListenerPos.copy(this.listenerPos);

    const L = ctx.listener;
    const p = this.listenerPos;
    if (L.positionX) {
      L.positionX.value = p.x;
      L.positionY.value = p.y;
      L.positionZ.value = p.z;
      L.forwardX.value = this.fwd.x;
      L.forwardY.value = this.fwd.y;
      L.forwardZ.value = this.fwd.z;
      L.upX.value = this.up.x;
      L.upY.value = this.up.y;
      L.upZ.value = this.up.z;
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(this.fwd.x, this.fwd.y, this.fwd.z, this.up.x, this.up.y, this.up.z);
    }
  }

  /** React to pings fired since last frame (steps, cane taps). Never creates pings. */
  private scanPings(): void {
    let newest = this.lastPingStart;
    const pings = this.world.pings;
    for (let i = 0; i < pings.length; i++) {
      const p = pings[i];
      if (p.start <= this.lastPingStart) continue;
      if (p.start > newest) newest = p.start;
      this.onPing(p);
    }
    this.lastPingStart = newest;
  }

  private onPing(p: ActivePing): void {
    const lp = this.listenerPos;
    const dx = p.origin.x - lp.x;
    const dz = p.origin.z - lp.z;
    const d = Math.hypot(dx, dz);
    switch (p.type) {
      case 'footstep': {
        if (d > 2.5) return; // not the player's own feet
        if (p.range <= C.SHUFFLE_MAX_RANGE) {
          this.playPlayer('shuffle', C.PLAYER_SHUFFLE_GAIN, rand(-0.2, 0.2));
          return;
        }
        this.stepSide = -this.stepSide;
        const run = clamp((p.range - 3) / 3, 0, 1);
        this.playPlayer('footstep', lerp(C.PLAYER_STEP_GAIN_WALK, C.PLAYER_STEP_GAIN_RUN, run), 0.12 * this.stepSide);
        return;
      }
      case 'cane': {
        // Only taps and auto-sweep touch-downs make a sound; the sweep-sonar pings are silent
        // (src/senses/cane.ts).
        const cane = getCaneState();
        if (cane.tapSerial !== this.caneTapHeard) {
          this.caneTapHeard = cane.tapSerial;
          this.caneTouchHeard = cane.touchSerial;
          this.playAt('cane', p.origin, C.CANE_GAIN * (cane.lastTapHard ? 2.2 : 1));
        } else if (cane.touchSerial !== this.caneTouchHeard) {
          this.caneTouchHeard = cane.touchSerial;
          this.playAt('cane', p.origin, C.CANE_TOUCH_GAIN);
        }
        return;
      }
      default:
        return;
    }
  }

  /** A pedestrian put a foot down (heard at once; its ping comes later). */
  private readonly onPedStep = (agent: Agent, speed: number): void => {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (agent.position.distanceToSquared(this.listenerPos) > C.PED_STEP_RADIUS * C.PED_STEP_RADIUS) return;
    this.playAt('pedStep', agent.position, C.PED_STEP_GAIN * clamp(speed / 1.6, 0.5, 1));
  };

  private assignCars(): void {
    const lp = this.listenerPos;
    const r2 = C.CAR_AUDIBLE_RADIUS * C.CAR_AUDIBLE_RADIUS;
    const pickList = this.carPick;
    pickList.length = 0;
    for (const a of this.world.agents) {
      if (a.type === 'car' && a.position.distanceToSquared(lp) <= r2) pickList.push(a);
    }
    pickList.sort((a, b) => a.position.distanceToSquared(lp) - b.position.distanceToSquared(lp));
    if (pickList.length > this.cars.length) pickList.length = this.cars.length;

    for (const v of this.cars) if (v.agent && !pickList.includes(v.agent)) v.release();
    for (const a of pickList) {
      if (this.cars.some((v) => v.agent === a)) continue;
      const v = this.cars.find((x) => x.free);
      if (v) v.assign(a);
    }
  }

  /** Find walking/standing groups near the listener and give the nearest chatty ones a voice. */
  private assignConversations(): void {
    const lp = this.listenerPos;
    const r2 = C.MURMUR_RADIUS * C.MURMUR_RADIUS;
    const peds: Agent[] = [];
    for (const a of this.world.agents) {
      if (a.type === 'pedestrian' && a.position.distanceToSquared(lp) <= r2) peds.push(a);
    }

    // union-find over close pairs moving alike (passers-by going opposite ways don't count)
    const parent = peds.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const g2 = C.GROUP_DISTANCE * C.GROUP_DISTANCE;
    const v2 = C.GROUP_MAX_REL_SPEED * C.GROUP_MAX_REL_SPEED;
    for (let i = 0; i < peds.length; i++) {
      for (let j = i + 1; j < peds.length; j++) {
        const a = peds[i];
        const b = peds[j];
        if (a.position.distanceToSquared(b.position) > g2) continue;
        const dvx = a.velocity.x - b.velocity.x;
        const dvz = a.velocity.z - b.velocity.z;
        if (dvx * dvx + dvz * dvz > v2) continue;
        parent[find(i)] = find(j);
      }
    }
    const byRoot = new Map<number, Agent[]>();
    for (let i = 0; i < peds.length; i++) {
      const r = find(i);
      let list = byRoot.get(r);
      if (!list) byRoot.set(r, (list = []));
      list.push(peds[i]);
    }
    const groups = [...byRoot.values()].filter((g) => g.length >= 2);
    groups.sort((a, b) => a[0].position.distanceToSquared(lp) - b[0].position.distanceToSquared(lp));

    // drop voices whose group broke up or wandered off
    const keep = (members: Agent[]): boolean =>
      members.some((m) => m.position.distanceToSquared(lp) <= r2 * 1.2) &&
      groups.some((g) => members.filter((m) => g.includes(m)).length >= 2);
    for (const m of this.murmurs) if (m.members.length && !keep(m.members)) m.release();

    for (const g of groups) {
      if (this.murmurs.some((m) => m.members.some((a) => g.includes(a)))) continue;
      let chatty = this.chatty.get(g[0]);
      if (chatty === undefined) {
        chatty = Math.random() < C.GROUP_CHATTY_CHANCE;
        for (const a of g) this.chatty.set(a, chatty);
      }
      if (!chatty) continue;
      const v = this.murmurs.find((m) => m.free);
      if (!v) break;
      v.assign(g);
    }
  }

  private updateEntity(): void {
    const e = this.world.entity;
    const ctx = this.ctx!;
    if (!e) return;
    const t = ctx.currentTime;
    const speed = Math.hypot(e.velocity.x, e.velocity.z);
    const d = e.position.distanceTo(this.listenerPos);
    setPannerPos(this.entityPanner, e.position.x, e.position.y + 0.1, e.position.z);
    if (speed < 0.2 || d > C.ENTITY_AUDIBLE_RADIUS) {
      this.entityNextStep = Math.max(this.entityNextStep, t);
      return;
    }
    if (t < this.entityNextStep) return;
    const list = this.buffers.get('entityStep');
    if (!list?.length) return;
    // louder the closer it gets (on top of the panner's distance falloff)
    const near = 1 - clamp(d / C.ENTITY_AUDIBLE_RADIUS, 0, 1);
    const src = new AudioBufferSourceNode(ctx, { buffer: pick(list), playbackRate: rand(0.85, 1.0) });
    const g = new GainNode(ctx, { gain: C.ENTITY_STEP_GAIN * lerp(0.5, 1.4, near) });
    src.connect(g).connect(this.entityPanner);
    src.start(t);
    // slow and uneven: alternate long / short steps (a limp), plus jitter
    this.entityLimp = -this.entityLimp;
    const interval = (C.ENTITY_STEP_INTERVAL / Math.max(0.5, speed)) * (1 + C.ENTITY_STEP_LIMP * this.entityLimp);
    this.entityNextStep = t + interval * rand(0.85, 1.15);
  }

  // --- events and keys ---------------------------------------------------------------------------

  private readonly onStunned = (payload?: unknown): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    const p = payload as Partial<StunnedPayload> | undefined;
    const intensity = clamp(p?.intensity ?? 1, 0, 1);
    const duration = Math.max(0.3, p?.duration ?? 1);
    this.playPlayer('thud', C.THUD_GAIN * lerp(0.6, 1, intensity), 0, rand(0.9, 1.0));
    const t = ctx.currentTime;
    const g = this.tinnitus.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(C.TINNITUS_GAIN * intensity, t + 0.05, 0.05);
    g.setTargetAtTime(0, t + 0.35, duration / 2.5);
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    switch (e.code) {
      case 'KeyU':
        this.muted = !this.muted;
        this.applyVolume();
        this.show(this.muted ? 'Sound muted (U)' : `Sound on: volume ${Math.round(this.volume * 100)} %`);
        break;
      case 'Comma':
      case 'Period': {
        const step = e.code === 'Comma' ? -C.VOLUME_STEP : C.VOLUME_STEP;
        this.volume = clamp(Math.round((this.volume + step) * 10) / 10, 0, 1);
        this.muted = false;
        this.applyVolume();
        try {
          window.localStorage.setItem(C.VOLUME_STORAGE_KEY, String(this.volume));
        } catch {
          /* storage blocked */
        }
        this.show(`Volume ${Math.round(this.volume * 100)} %  ( , / . )`);
        break;
      }
      default:
    }
  };

  /** Debug snapshot (also handy from the console). */
  stats(): { running: boolean; cars: number; conversations: number; volume: number; muted: boolean } {
    return {
      running: this.ctx?.state === 'running',
      cars: this.cars.filter((v) => v.agent).length,
      conversations: this.murmurs.filter((m) => m.members.length > 0).length,
      volume: this.volume,
      muted: this.muted,
    };
  }

  private applyVolume(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, ctx.currentTime, 0.05);
  }

  private show(text: string): void {
    if (!this.msgEl) {
      this.msgEl = document.createElement('div');
      this.msgEl.style.cssText =
        'position:absolute;left:50%;top:44px;transform:translateX(-50%);padding:4px 10px;' +
        'background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.25);border-radius:4px;' +
        'white-space:nowrap;display:none;';
      (document.getElementById('hud') ?? document.body).appendChild(this.msgEl);
    }
    this.msgEl.textContent = text;
    this.msgEl.style.display = 'block';
    window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => {
      if (this.msgEl) this.msgEl.style.display = 'none';
    }, 1800);
  }
}

let instance: Soundscape | null = null;

/** Install the soundscape (audio starts on the first click / key press). Safe to call twice. */
export function initSoundscape(world: World): void {
  if (instance) return;
  instance = new Soundscape(world);
  instance.install();
}

/** Start the audio engine. Must be called inside a user gesture (the start screen's click). */
export function startSoundscape(): void {
  instance?.begin();
}

/** Debug: how many voices are live right now, or null before init. */
export function getSoundscapeStats(): ReturnType<Soundscape['stats']> | null {
  return instance?.stats() ?? null;
}

export function disposeSoundscape(): void {
  instance?.dispose();
  instance = null;
}

import.meta.hot?.dispose(() => disposeSoundscape());
