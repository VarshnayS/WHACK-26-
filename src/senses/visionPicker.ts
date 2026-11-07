/**
 * src/senses/visionPicker.ts: the vision mode picker (start screen and the O overlay)
 * Owner: SENSES / RENDER
 *
 * One button per preset (src/senses/visionConfig.ts) with a one-line description, plus a 0–100
 * severity slider (low acuity -> total blindness). White on black. Stays in sync with
 * onVisionChange, so two pickers (start screen, O overlay) never disagree.
 */
import { VISION_PRESETS } from './visionConfig';
import { SEVERITY_PREFIX } from './visionConfig';
import { currentVision, onVisionChange, setVision } from './vision';

const BTN =
  'display:block;width:100%;box-sizing:border-box;text-align:left;margin:0 0 6px;padding:7px 10px;' +
  'font:inherit;cursor:pointer;border:1px solid rgba(255,255,255,0.45);border-radius:4px;';

function styleButton(btn: HTMLButtonElement, selected: boolean): void {
  btn.style.cssText = BTN + (selected ? 'background:#fff;color:#000;' : 'background:#000;color:#fff;');
}

/** Build a picker element. Call dispose() when it is thrown away. */
export function createVisionPicker(): { el: HTMLElement; dispose(): void } {
  const el = document.createElement('div');
  el.style.cssText = 'width:min(440px,90vw);text-align:left;pointer-events:auto;';

  const heading = document.createElement('div');
  heading.textContent = 'Vision';
  heading.style.cssText = 'font-size:13px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.7;margin:0 0 8px;';
  el.appendChild(heading);

  const buttons = VISION_PRESETS.map((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const title = document.createElement('div');
    title.textContent = p.label;
    title.style.cssText = 'font-size:14px;';
    const note = document.createElement('div');
    note.textContent = p.note;
    note.style.cssText = 'font-size:11px;opacity:0.75;margin-top:2px;';
    btn.append(title, note);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setVision(p.id);
      btn.blur(); // so SPACE / WASD go to the game, not the button
    });
    el.appendChild(btn);
    return { id: p.id, btn };
  });

  const sliderRow = document.createElement('label');
  sliderRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:10px;font-size:13px;cursor:pointer;';
  const sliderText = document.createElement('span');
  sliderText.style.cssText = 'white-space:nowrap;min-width:9.5em;';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.style.cssText = 'flex:1;accent-color:#fff;';
  slider.addEventListener('input', () => setVision(`${SEVERITY_PREFIX}${slider.value}`));
  slider.addEventListener('click', (e) => e.stopPropagation());
  sliderRow.append(sliderText, slider);
  el.appendChild(sliderRow);

  const scale = document.createElement('div');
  scale.textContent = '0 = low acuity · 100 = total blindness';
  scale.style.cssText = 'font-size:11px;opacity:0.6;margin-top:2px;text-align:right;';
  el.appendChild(scale);

  function refresh(): void {
    const mode = currentVision();
    for (const b of buttons) styleButton(b.btn, b.id === mode.id);
    const isSlider = mode.id.startsWith(SEVERITY_PREFIX);
    if (isSlider) slider.value = mode.id.slice(SEVERITY_PREFIX.length);
    sliderText.textContent = isSlider ? `Severity ${slider.value} / 100` : 'Severity (custom)';
    sliderText.style.fontWeight = isSlider ? '600' : '400';
  }
  refresh();
  const off = onVisionChange(refresh);
  return {
    el,
    dispose() {
      off();
      el.remove();
    },
  };
}
