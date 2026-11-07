/**
 * src/audio/index.ts: audio -> sonar wiring (mic, detector, calibration, keys, debug overlay)
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 *
 * Started once from src/main.ts via initMic() (= initAudioSonar(world)).
 *
 * Keys:  SPACE  medium transient pulse (works without a mic)
 *        ⇧SPACE max-strength pulse
 *        ⇧C     recalibrate the noise floor (plain C toggles the cane: src/senses/cane.ts)
 *        ⇧M     mute / unmute the mic (plain M is reserved for AUDIT's architect report)
 *        `      toggle the debug meter
 *        [ ]    sensitivity down / up      - =  trigger level down / up      0  reset (./tuning.ts)
 *        U      mute the soundscape        , .  volume down / up (./soundscape.ts)
 */
import * as THREE from 'three';
import { world as sharedWorld } from '../world';
import type { PingType } from '../shared/contracts';
import { initSoundscape, startSoundscape } from './soundscape';
import { Calibrator } from './calibration';
import { DebugMeter, type MeterSnapshot } from './debug-meter';
import {
  DETECTOR_CONFIG,
  FeatureExtractor,
  OnsetDetector,
  createDetectionEvent,
  createFeatures,
  radiusForStrength,
  type DetectionEvent,
} from './detector';
import { HudMessage } from './hud-message';
import { MicInput } from './mic';
import { describeTuning, handleTuningKey, loadTuning } from './tuning';

export { DETECTOR_CONFIG } from './detector';

/** The slice of `world` (src/world/index.ts) this module needs. */
export interface SonarWorld {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  onUpdate(fn: (dt: number) => void): () => void;
  /** The contract's ping (src/shared/contracts.ts): the only thing the sonar shader draws. */
  ping(origin: THREE.Vector3, range: number, type?: PingType): void;
  /** Live pings (debug meter count). */
  readonly pings: readonly unknown[];
}

type Status =
  | 'waiting'
  | 'requesting'
  | 'calibrating'
  | 'listening'
  | 'muted'
  | 'denied'
  | 'no-device'
  | 'unsupported'
  | 'error'
  | 'ended';

const FALLBACK = ' SPACE still pings.';
const STATUS_HUD: Record<Status, { text: string; hideAfterMs?: number; warn?: boolean }> = {
  waiting: { text: 'Click to enable mic sonar (SPACE = test pulse)' },
  requesting: { text: 'Allow microphone access to use your voice as sonar' },
  calibrating: { text: 'Stay quiet… calibrating mic' },
  listening: { text: 'Mic sonar ready: clap, click or shout', hideAfterMs: 2500 },
  muted: { text: 'Mic muted (Shift+M to unmute).' + FALLBACK },
  denied: { text: 'Mic blocked: allow it in site settings and reload.' + FALLBACK, hideAfterMs: 8000, warn: true },
  'no-device': { text: 'No microphone found.' + FALLBACK, hideAfterMs: 8000, warn: true },
  unsupported: { text: 'Mic needs localhost or HTTPS.' + FALLBACK, hideAfterMs: 8000, warn: true },
  error: { text: 'Mic failed to start.' + FALLBACK, hideAfterMs: 8000, warn: true },
  ended: { text: 'Mic disconnected.' + FALLBACK, hideAfterMs: 8000, warn: true },
};

class AudioSonar {
  private readonly cfg = DETECTOR_CONFIG;
  private readonly mic = new MicInput();
  private readonly extractor = new FeatureExtractor(DETECTOR_CONFIG.fftSize / 2);
  private readonly detector = new OnsetDetector();
  private readonly calibrator = new Calibrator();
  private readonly features = createFeatures();
  private readonly playerPos = new THREE.Vector3();
  private readonly keyEvent = createDetectionEvent();
  private readonly hud: HudMessage;
  private readonly meter: DebugMeter;
  private readonly snapshot: MeterSnapshot;

  private status: Status | null = null;
  /** Gestures only open the mic after startAudio() (the start screen's click). */
  private armed = false;
  private calibrated = false;
  private disposed = false;
  private unsubscribeUpdate: (() => void) | null = null;

  private readonly world: SonarWorld;

  constructor(world: SonarWorld) {
    this.world = world;
    if (loadTuning(this.cfg)) console.info(`[audio] loaded saved tuning: ${describeTuning(this.cfg)}`);
    const hudRoot = document.getElementById('hud') ?? document.body;
    this.hud = new HudMessage(hudRoot);
    this.meter = new DebugMeter(hudRoot);
    this.features.rmsDb = this.cfg.minDb;
    this.snapshot = {
      nowMs: 0,
      status: '',
      phase: 'idle',
      rmsDb: this.cfg.minDb,
      peak: 0,
      floorDb: 0,
      releaseDb: 0,
      gateDb: 0,
      fullDb: 0,
      sensitivity: 1,
      thresholdDb: 0,
      rangeDb: 0,
      autoRange: true,
      calibrating: false,
      calibrationProgress: 0,
      eventSerial: 0,
      lastEvent: createDetectionEvent(),
      activePulses: 0,
    };
  }

  start(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('pointerdown', this.onGesture);
    document.addEventListener('pointerlockchange', this.onGesture);
    this.unsubscribeUpdate = this.world.onUpdate(this.update);
    this.setStatus('waiting');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('pointerdown', this.onGesture);
    document.removeEventListener('pointerlockchange', this.onGesture);
    this.unsubscribeUpdate?.();
    this.unsubscribeUpdate = null;
    this.mic.dispose();
    this.meter.dispose();
    this.hud.dispose();
  }

  // --- per frame (no allocations) --------------------------------------------------------

  private readonly update = (): void => {
    const nowMs = performance.now();

    if (this.mic.read()) {
      this.extractor.compute(this.mic.timeData, this.mic.freqData, this.mic.sampleRate, this.features);

      if (this.calibrator.active()) {
        const floor = this.calibrator.step(this.features, nowMs);
        if (!this.calibrator.active()) {
          if (floor !== null) this.detector.seedFloor(floor);
          this.calibrated = true;
          this.setStatus('listening');
        }
      } else if (this.status === 'listening') {
        const events = this.detector.step(this.features, nowMs);
        for (let i = 0; i < events.length; i++) this.firePlayerPulse(events[i]);
      }
    }

    const now = nowMs / 1000;
    if (this.meter.visible) this.drawMeter(nowMs, now);
  };

  private drawMeter(nowMs: number, now: number): void {
    const s = this.snapshot;
    const d = this.detector;
    s.nowMs = nowMs;
    s.status = this.status ?? 'waiting';
    s.phase = d.phase;
    s.rmsDb = this.features.rmsDb;
    s.peak = this.features.peak;
    s.floorDb = d.noiseFloorDb;
    s.releaseDb = d.releaseLevelDb;
    s.gateDb = d.gateDb;
    s.fullDb = d.fullStrengthDb;
    s.sensitivity = this.cfg.sensitivity;
    s.thresholdDb = this.cfg.thresholdDb;
    s.rangeDb = d.rangeDb;
    s.autoRange = this.cfg.autoRange;
    s.calibrating = this.calibrator.active();
    s.calibrationProgress = this.calibrator.progress(nowMs);
    s.activePulses = this.world.pings.length;
    this.meter.draw(s);
  }

  // --- pulses ----------------------------------------------------------------------------

  private firePlayerPulse(e: DetectionEvent): void {
    this.world.camera.getWorldPosition(this.playerPos);
    // The shader only draws world.activePings(); the entity hears the same pings.
    this.world.ping(this.playerPos, e.maxRadius, 'voice');
    Object.assign(this.snapshot.lastEvent, e);
    this.snapshot.eventSerial++;
  }

  private keyboardPulse(max: boolean): void {
    const e = this.keyEvent;
    const strength = max ? 1 : this.cfg.keyboardStrength;
    e.kind = 'transient';
    e.repeat = false;
    e.timeMs = performance.now();
    e.levelDb = 0;
    e.aboveFloorDb = 0;
    e.strength = strength;
    e.brightness = this.cfg.keyboardBrightness;
    e.maxRadius = radiusForStrength(strength, this.cfg);
    e.speed = this.cfg.transientSpeed;
    this.firePlayerPulse(e);
  }

  // --- mic lifecycle ---------------------------------------------------------------------

  /** Called by startAudio() inside the start screen's click. */
  arm(): void {
    this.armed = true;
    this.onGesture();
  }

  private readonly onGesture = (): void => {
    if (this.disposed || !this.armed) return;
    // Must run synchronously inside the gesture so the browser lets the AudioContext start.
    this.mic.resumeContext();
    if (this.status === 'waiting') void this.enableMic();
  };

  private async enableMic(): Promise<void> {
    this.setStatus('requesting');
    const result = await this.mic.start();
    if (this.disposed) return;
    if (result !== 'ok') {
      this.setStatus(result);
      return;
    }
    this.mic.onEnded = () => this.setStatus('ended');
    this.beginCalibration();
  }

  private beginCalibration(): void {
    if (!this.mic.ready) {
      this.hud.show('Mic not active yet: click to enable it', 2000);
      return;
    }
    if (this.mic.isMuted) {
      this.hud.show('Unmute (Shift+M) before calibrating', 2000);
      return;
    }
    this.detector.reset();
    this.detector.resetRange(); // C = new room / new mic: re-learn how loud it gets too
    this.extractor.reset();
    this.calibrator.start(performance.now());
    this.setStatus('calibrating');
  }

  private toggleMute(): void {
    if (!this.mic.ready) {
      this.hud.show('Mic not active yet: click to enable it', 2000);
      return;
    }
    const muted = !this.mic.isMuted;
    this.mic.setMuted(muted);
    this.detector.reset();
    this.extractor.reset();
    this.features.rmsDb = this.cfg.minDb;
    this.features.peak = 0;
    if (muted) {
      this.calibrator.cancel();
      this.setStatus('muted');
    } else if (this.calibrated) {
      this.setStatus('listening');
    } else {
      this.beginCalibration();
    }
  }

  private setStatus(s: Status): void {
    const info = STATUS_HUD[s];
    if (s !== this.status) {
      this.status = s;
      // One log line per state change, nothing per frame.
      if (info.warn) console.warn(`[audio] ${s}`);
      else console.info(`[audio] ${s}`);
    }
    this.hud.show(info.text, info.hideAfterMs);
  }

  // --- keys ------------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    ) {
      return;
    }
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.keyboardPulse(e.shiftKey);
        break;
      case 'Backquote':
        this.meter.toggle();
        break;
      case 'KeyC':
        if (e.shiftKey) this.beginCalibration(); // plain C = cane (src/senses/cane.ts)
        break;
      case 'KeyM':
        if (e.shiftKey) this.toggleMute(); // plain M = AUDIT's architect report
        break;
      default: {
        const msg = handleTuningKey(e.code, this.cfg);
        if (msg) this.hud.show(msg, 2500);
      }
    }
  };
}

let instance: AudioSonar | null = null;

/**
 * Wire the mic -> detector -> pulse bus into `world`. Returns straight away; the mic itself
 * opens on the first click / pointer lock. Safe to call twice (second call is a no-op).
 */
export async function initAudioSonar(world: SonarWorld): Promise<void> {
  if (instance) return;
  instance = new AudioSonar(world);
  instance.start();
}

/**
 * Start the audio engine (soundscape + mic). Call inside a user gesture: the start screen's
 * "Click to begin" (browser autoplay rule). Safe to call again (e.g. after the browser suspended it).
 */
export function startAudio(): void {
  startSoundscape();
  instance?.arm();
}

/** Entry point used by src/main.ts. */
export function initMic(): Promise<void> {
  initSoundscape(sharedWorld);
  return initAudioSonar(sharedWorld);
}

/** Stop the mic tracks, close the AudioContext, remove listeners and the overlay. */
export function dispose(): void {
  instance?.dispose();
  instance = null;
}

import.meta.hot?.dispose(() => dispose());
