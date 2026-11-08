// src/player/stunEffect.ts
//
// "Dazed" camera effect after an impact. It deliberately does NOT touch the camera's
// rotation, because PointerLockControls owns it and would bake any offset into the
// player's look direction. Instead it uses:
//   - CSS roll / sway / zoom + blur on the WebGL canvas
//   - a brief dark-red flash overlay (red = stuns/danger only; the HUD adds the red edge vignette)
//   - a head dip value the controller subtracts from camera height
//
// Usage:
//   const fx = createStunEffect(world.renderer.domElement);
//   fx.trigger(duration, intensity);  // intensity 0..1
//   fx.update(dt);                    // every frame
//   camera Y target -= fx.headDip

export interface StunEffect {
  /** Start (or restart) the effect. `intensity` 0..1 scales every part of it. */
  trigger(duration: number, intensity: number): void;
  update(dt: number): void;
  /** Metres to lower the camera by this frame. */
  readonly headDip: number;
  /** Cancel any effect in progress straight away (no fade). */
  reset(): void;
  dispose(): void;
}

const MAX_ROLL_DEG = 4;
const MAX_BLUR_PX = 5;
const MAX_ZOOM = 0.05;
const MAX_HEAD_DIP = 0.25;
const FLASH_DURATION = 0.18;
const FLASH_OPACITY = 0.3;

export function createStunEffect(canvas: HTMLCanvasElement): StunEffect {
  const flash = document.createElement('div');
  Object.assign(flash.style, {
    position: 'fixed',
    inset: '0',
    background: '#b00000',
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '10',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(flash);
  canvas.style.transformOrigin = 'center center';

  let duration = 0;
  let elapsed = 0;
  let intensity = 0;
  let active = false;

  const fx: StunEffect = {
    headDip: 0,

    trigger(d, i) {
      // A stronger hit overrides a weaker one still in progress.
      if (active && i < intensity * (1 - elapsed / duration)) return;
      duration = Math.max(0.1, d);
      intensity = Math.min(1, Math.max(0, i));
      elapsed = 0;
      active = true;
    },

    update(dt) {
      if (!active) return;
      elapsed += dt;
      if (elapsed >= duration) {
        active = false;
        (fx as { headDip: number }).headDip = 0;
        canvas.style.transform = '';
        canvas.style.filter = '';
        flash.style.opacity = '0';
        return;
      }

      const remaining = 1 - elapsed / duration;
      // Quick attack, then a long ease-out so the daze fades gradually.
      const attack = Math.min(1, elapsed / 0.06);
      const env = attack * Math.pow(remaining, 1.5) * intensity;

      // Two slow sines at unrelated frequencies = woozy, non-repeating sway.
      const roll = (Math.sin(elapsed * 7.3) * 0.7 + Math.sin(elapsed * 3.1) * 0.3) * MAX_ROLL_DEG * env;
      const zoom = 1 + MAX_ZOOM * env;
      canvas.style.transform = `rotate(${roll.toFixed(2)}deg) scale(${zoom.toFixed(3)})`;
      canvas.style.filter = `blur(${(MAX_BLUR_PX * env).toFixed(2)}px)`;

      const flashT = Math.max(0, 1 - elapsed / FLASH_DURATION);
      flash.style.opacity = (flashT * flashT * FLASH_OPACITY * intensity).toFixed(3);

      (fx as { headDip: number }).headDip =
        MAX_HEAD_DIP * env * (0.75 + 0.25 * Math.sin(elapsed * 9));
    },

    reset() {
      active = false;
      elapsed = 0;
      (fx as { headDip: number }).headDip = 0;
      canvas.style.transform = '';
      canvas.style.filter = '';
      flash.style.opacity = '0';
    },

    dispose() {
      canvas.style.transform = '';
      canvas.style.filter = '';
      flash.remove();
    },
  };
  return fx;
}