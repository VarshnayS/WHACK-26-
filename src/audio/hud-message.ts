/**
 * src/audio/hud-message.ts: one-line status message for the audio module (top centre of #hud)
 * Owner: @USERNAME_C (mic/HUD/audio/collision)
 *
 * Kept inside src/audio so the audio module doesn't touch src/hud/hud.ts.
 */
export class HudMessage {
  private readonly el: HTMLDivElement;
  private timer: number | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:absolute;left:50%;top:12px;transform:translateX(-50%);padding:4px 10px;' +
      'background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.25);border-radius:4px;' +
      'white-space:nowrap;display:none;';
    parent.appendChild(this.el);
  }

  /** Show `text`; hide it again after `hideAfterMs` if given, otherwise keep it up. */
  show(text: string, hideAfterMs?: number): void {
    this.clearTimer();
    this.el.textContent = text;
    this.el.style.display = 'block';
    if (hideAfterMs !== undefined) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.el.style.display = 'none';
      }, hideAfterMs);
    }
  }

  hide(): void {
    this.clearTimer();
    this.el.style.display = 'none';
  }

  dispose(): void {
    this.clearTimer();
    this.el.remove();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
