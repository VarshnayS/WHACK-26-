/**
 * src/entity/audio.ts: positional sound for the entity (footsteps, breathing, growl, gasp, shriek)
 * Owner: entity (src/entity/)
 *
 * Everything is generated in src/entity/synth.ts and played through THREE.PositionalAudio
 * attached to the entity's body, so it comes from where it really is (wear headphones).
 *
 * Volume follows distance explicitly: full volume inside each sound's near distance, falling off
 * steeply (squared) to silence at its far distance. The panner only gives direction.
 *   footsteps  near 2 m, silent beyond 50 m    how you usually first notice it
 *   breathing  near 1 m, silent beyond 15 m    means it's close
 *   voice      near 3 m, silent beyond 60 m    gasp when it hears you, growl when it surges, shriek on a catch
 *
 * The AudioListener lives on the camera. If another module already added one, it is reused.
 */
import * as THREE from 'three';
import type { EntityStateName } from '../shared/contracts';
import type { EntityBrain } from './brain';
import { breathCycle, footstep, gasp, growl, shriek } from './synth';

interface Voice {
  audio: THREE.PositionalAudio;
  bus: GainNode;
  /** Full volume within this distance (m). */
  near: number;
  /** Silent beyond this distance (m). */
  far: number;
}

/** 1 within `near`, 0 beyond `far`, squared in between so it swells noticeably as it closes in. */
export function distanceGain(d: number, near: number, far: number): number {
  const t = THREE.MathUtils.clamp((far - d) / (far - near), 0, 1);
  return t * t;
}

const STRIDE: Record<EntityStateName, number> = {
  patrol: 0.85,
  investigate: 1.0,
  chase: 1.15,
  caught: Infinity,
};

/** Breathing loudness and pace per state. */
const BREATH: Record<EntityStateName, { gain: number; rate: number }> = {
  patrol: { gain: 0.7, rate: 1.0 },
  investigate: { gain: 0.9, rate: 1.2 },
  chase: { gain: 1.2, rate: 1.7 },
  caught: { gain: 0, rate: 1 },
};

let master = 1;

/** Find the AudioListener on the camera, or add one. */
export function getListener(camera: THREE.Camera): THREE.AudioListener {
  const existing = camera.children.find((c): c is THREE.AudioListener => c instanceof THREE.AudioListener);
  if (existing) return existing;
  const listener = new THREE.AudioListener();
  camera.add(listener);
  return listener;
}

/** Overall entity volume 0..1 (e.g. for a settings menu). */
export function setEntityVolume(v: number): void {
  master = Math.max(0, v); // applied on the next frame
}

export function initEntityAudio(brain: EntityBrain, body: THREE.Object3D, camera: THREE.Camera): (dt: number) => void {
  const listener = getListener(camera);
  const ctx = listener.context;

  // Browsers start audio suspended until the player interacts with the page.
  const resume = () => {
    if (ctx.state !== 'running') void ctx.resume();
  };
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);

  const toBuffer = (samples: Float32Array): AudioBuffer => {
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    return buf;
  };
  const sr = ctx.sampleRate;
  const sounds = {
    steps: [0, 1, 2].map((v) => toBuffer(footstep(sr, v))),
    breath: toBuffer(breathCycle(sr)),
    growl: toBuffer(growl(sr)),
    grumble: toBuffer(growl(sr, 1.1, 0.8)),
    gasp: toBuffer(gasp(sr)),
    shriek: toBuffer(shriek(sr)),
  };

  const makeVoice = (y: number, near: number, far: number): Voice => {
    const audio = new THREE.PositionalAudio(listener);
    // Direction only: distance loudness is applied by hand below (distanceGain).
    audio.panner.distanceModel = 'linear';
    audio.setRolloffFactor(0);
    const bus = ctx.createGain();
    bus.gain.value = 0;
    audio.setNodeSource(bus as unknown as AudioBufferSourceNode);
    audio.position.y = y;
    body.add(audio);
    return { audio, bus, near, far };
  };

  const feet = makeVoice(0.1, 2, 50);
  const breathVoice = makeVoice(2.0, 1, 15);
  const mouth = makeVoice(2.0, 3, 60);
  const voices = [feet, breathVoice, mouth];
  const voicePos = new THREE.Vector3();

  const play = (voice: Voice, buffer: AudioBuffer, gain = 1, rate = 1): void => {
    if (ctx.state !== 'running') return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(voice.bus);
    src.start();
    src.onended = () => g.disconnect();
  };

  // Breathing: one loop that runs for the whole game; its volume/pace follow the state.
  const breathGain = ctx.createGain();
  breathGain.gain.value = 0;
  breathGain.connect(breathVoice.bus);
  let breathSrc: AudioBufferSourceNode | null = null;
  const startBreath = () => {
    if (breathSrc || ctx.state !== 'running') return;
    breathSrc = ctx.createBufferSource();
    breathSrc.buffer = sounds.breath;
    breathSrc.loop = true;
    breathSrc.connect(breathGain);
    breathSrc.start();
  };

  brain.on((e) => {
    if (e.type === 'heard') {
      if (brain.state !== 'chase') play(mouth, sounds.gasp, 0.9, 0.9 + Math.random() * 0.15);
    } else if (e.type === 'caught') {
      play(mouth, sounds.shriek, 1.5);
    } else if (e.state === 'chase') {
      play(mouth, sounds.growl, 1.2);
    } else if (e.previous === 'chase' && e.state === 'patrol') {
      play(mouth, sounds.grumble, 0.7); // lost interest
    }
  });

  const last = brain.position.clone();
  let travelled = 0;
  let stepIndex = 0;

  return () => {
    startBreath();

    // Loudness from distance to the player (the camera).
    const t = ctx.currentTime;
    for (const v of voices) {
      v.audio.getWorldPosition(voicePos);
      const d = voicePos.distanceTo(camera.position);
      v.bus.gain.setTargetAtTime(master * distanceGain(d, v.near, v.far), t, 0.05);
    }

    // Footsteps from distance actually covered, with a limp: every other step is lighter.
    const moved = Math.hypot(brain.position.x - last.x, brain.position.z - last.z);
    last.copy(brain.position);
    travelled += moved > 5 ? 0 : moved; // ignore teleports (spawn/reset)
    const stride = STRIDE[brain.state];
    if (travelled >= stride) {
      travelled = 0;
      const heavy = stepIndex++ % 2 === 0;
      const loud = brain.state === 'chase' ? 1.3 : brain.state === 'investigate' ? 1.0 : 0.8;
      play(
        feet,
        sounds.steps[Math.floor(Math.random() * sounds.steps.length)],
        loud * (heavy ? 1 : 0.6),
        (heavy ? 0.92 : 1.05) + (Math.random() - 0.5) * 0.1,
      );
    }
    if (stride === Infinity) travelled = 0;

    // Breathing follows the state smoothly.
    const b = BREATH[brain.state];
    const now = ctx.currentTime;
    breathGain.gain.setTargetAtTime(b.gain, now, 0.4);
    breathSrc?.playbackRate.setTargetAtTime(b.rate, now, 0.6);
  };
}