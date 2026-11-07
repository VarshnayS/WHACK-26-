/**
 * src/audio/mic.ts: microphone input (getUserMedia -> AnalyserNode)
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 *
 * The analyser is never connected to the destination, so there is no feedback.
 * Needs localhost or HTTPS. The module entry point is initAudioSonar() in ./index.ts.
 */
import { DETECTOR_CONFIG } from './detector';

export type MicStartResult = 'ok' | 'denied' | 'no-device' | 'unsupported' | 'error';

export class MicInput {
  /** Reused every frame; sized from DETECTOR_CONFIG.fftSize. */
  readonly timeData = new Float32Array(DETECTOR_CONFIG.fftSize);
  readonly freqData = new Float32Array(DETECTOR_CONFIG.fftSize / 2);

  /** Fired once if the track ends on its own (mic unplugged, permission revoked). */
  onEnded: (() => void) | null = null;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private muted = false;
  private starting = false;
  private disposed = false;

  get ready(): boolean {
    return this.analyser !== null;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /**
   * Create (if needed) and resume the AudioContext. Call this synchronously inside a user
   * gesture handler (click / pointer lock) so the browser lets it run.
   */
  resumeContext(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** Ask for the mic and build the graph. Call resumeContext() first, in the gesture. */
  async start(): Promise<MicStartResult> {
    if (this.disposed) return 'error';
    if (this.analyser) return 'ok';
    if (this.starting) return 'error';
    if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
    this.resumeContext();
    const ctx = this.ctx;
    if (!ctx) return 'unsupported';

    this.starting = true;
    try {
      // AGC/NS/EC off, otherwise the browser normalises loudness and the dB readings mean nothing.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.starting = false;
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device';
      return 'error';
    }
    this.starting = false;
    if (this.disposed) {
      // dispose() ran while the permission prompt was open.
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
      return 'error';
    }

    this.source = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = DETECTOR_CONFIG.fftSize;
    analyser.smoothingTimeConstant = 0;
    this.source.connect(analyser); // NOT connected to ctx.destination
    this.analyser = analyser;

    for (const track of this.stream.getAudioTracks()) {
      track.enabled = !this.muted;
      track.addEventListener('ended', this.handleEnded, { once: true });
    }
    return 'ok';
  }

  /** Fill timeData/freqData from the analyser. Returns false if there's nothing to read. */
  read(): boolean {
    const a = this.analyser;
    if (!a || this.muted) return false;
    a.getFloatTimeDomainData(this.timeData);
    a.getFloatFrequencyData(this.freqData);
    return true;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.stream) for (const t of this.stream.getAudioTracks()) t.enabled = !muted;
  }

  /** Stop the tracks and close the AudioContext. The instance can't be restarted afterwards. */
  dispose(): void {
    this.disposed = true;
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        t.removeEventListener('ended', this.handleEnded);
        t.stop();
      }
    }
    this.source?.disconnect();
    this.analyser?.disconnect();
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close().catch(() => undefined);
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.ctx = null;
    this.onEnded = null;
  }

  private readonly handleEnded = (): void => {
    this.analyser?.disconnect();
    this.source?.disconnect();
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.onEnded?.();
  };
}
