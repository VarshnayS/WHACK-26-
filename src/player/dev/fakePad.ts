/**
 * src/player/dev/fakePad.ts: a virtual controller for testing without one (DEV BUILDS ONLY)
 * Owner: SENSES
 *
 * Open the game with ?fakepad=1 (plugged in at load) or ?fakepad=unplugged. src/senses/index.ts
 * imports this file only inside `if (import.meta.env.DEV && …)`, so production builds never contain it.
 *
 *  - Overrides navigator.getGamepads() to add a 'standard' mapping pad at index 3 (real pads keep
 *    their slots) and fires gamepadconnected / gamepaddisconnected like a real hot-plug.
 *  - On-screen panel (bottom left): sliders for both sticks and both triggers (they spring back to
 *    0 on release unless "hold" is ticked), buttons for every standard button (press and hold;
 *    "latch" makes a click toggle), a plug / unplug box, and a log of the rumble calls the game sends
 *    (vibrationActuator.playEffect: duration, strong, weak).
 *  - window.__fakePad: the same controls for scripts (src/player/dev/inputCheck.mjs).
 *
 * The panel needs the mouse cursor, so with ?fakepad Esc (mouse released) does NOT open the pause
 * screen; click the scene to lock the mouse and play with the keyboard again.
 */
import { PAD, type PadButton } from '../gamepadConfig';

const FAKE_INDEX = 3;
const BUTTON_TOTAL = 17;
const LOG_LINES = 10;
/** Shortest press the panel sends for a click (ms). */
const MIN_PRESS_MS = 120;

export interface FakeRumble {
  /** ms since the page loaded */
  t: number;
  type: string;
  duration: number;
  strong: number;
  weak: number;
}

interface FakeButton {
  pressed: boolean;
  touched: boolean;
  value: number;
}

export interface FakePadApi {
  connect(on: boolean): void;
  isConnected(): boolean;
  /** 0 lx, 1 ly, 2 rx, 3 ry; -1..1 (up / left = -1). */
  setAxis(i: number, v: number): void;
  /** Standard button index; value 0..1 (triggers are analogue). */
  setButton(i: number, value: number): void;
  press(name: PadButton, on: boolean): void;
  isPressed(i: number): boolean;
  /** false = behave like a pad without vibrationActuator (haptics must be a silent no-op). */
  setRumbleSupported(on: boolean): void;
  /** Every rumble the game asked for (oldest first). */
  rumbles: FakeRumble[];
  /** Calls to navigator.getGamepads() so far (proves the game doesn't poll without a pad). */
  getGamepadsCalls(): number;
  reset(): void;
}

let installed: FakePadApi | null = null;

export function installFakePad(startConnected: boolean): FakePadApi {
  if (installed) return installed;

  const buttons: FakeButton[] = Array.from({ length: BUTTON_TOTAL }, () => ({ pressed: false, touched: false, value: 0 }));
  const axes = [0, 0, 0, 0];
  const rumbles: FakeRumble[] = [];
  let connected = false;
  let calls = 0;

  const actuator = {
    type: 'dual-rumble',
    effects: ['dual-rumble'],
    playEffect(type: string, p: { duration?: number; strongMagnitude?: number; weakMagnitude?: number }) {
      rumbles.push({
        t: Math.round(performance.now()),
        type,
        duration: p.duration ?? 0,
        strong: p.strongMagnitude ?? 0,
        weak: p.weakMagnitude ?? 0,
      });
      renderLog();
      return Promise.resolve('complete');
    },
    reset() {
      return Promise.resolve('complete');
    },
  };
  const pad: {
    id: string;
    index: number;
    connected: boolean;
    mapping: string;
    timestamp: number;
    axes: number[];
    buttons: FakeButton[];
    vibrationActuator: typeof actuator | null;
  } = {
    id: 'Fake standard gamepad (dev ?fakepad)',
    index: FAKE_INDEX,
    connected: false,
    mapping: 'standard',
    timestamp: performance.now(),
    axes,
    buttons,
    vibrationActuator: actuator,
  };
  const touch = () => {
    pad.timestamp = performance.now();
  };

  const realGetGamepads = navigator.getGamepads.bind(navigator);
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => {
      calls++;
      const list: (Gamepad | null)[] = [...realGetGamepads()];
      while (list.length <= FAKE_INDEX) list.push(null);
      if (connected) list[FAKE_INDEX] = pad as unknown as Gamepad;
      return list;
    },
  });

  function fire(type: 'gamepadconnected' | 'gamepaddisconnected'): void {
    const e = new Event(type);
    Object.defineProperty(e, 'gamepad', { value: pad });
    window.dispatchEvent(e);
  }

  const api: FakePadApi = {
    connect(on) {
      if (on === connected) return;
      connected = on;
      pad.connected = on;
      touch();
      fire(on ? 'gamepadconnected' : 'gamepaddisconnected');
      ui.plug.checked = on;
    },
    isConnected: () => connected,
    setAxis(i, v) {
      axes[i] = Math.max(-1, Math.min(1, v));
      touch();
    },
    setButton(i, value) {
      const b = buttons[i];
      if (!b) return;
      b.value = Math.max(0, Math.min(1, value));
      b.pressed = b.value > 0.5 || (b.value > 0 && i !== PAD.LT && i !== PAD.RT);
      b.touched = b.value > 0;
      touch();
      ui.buttonEls.get(i)?.style.setProperty('background', b.pressed ? '#fff' : '#000');
      ui.buttonEls.get(i)?.style.setProperty('color', b.pressed ? '#000' : '#fff');
    },
    press(name, on) {
      api.setButton(PAD[name], on ? 1 : 0);
    },
    isPressed: (i) => buttons[i]?.pressed ?? false,
    setRumbleSupported(on) {
      pad.vibrationActuator = on ? actuator : null;
    },
    rumbles,
    getGamepadsCalls: () => calls,
    reset() {
      for (let i = 0; i < axes.length; i++) axes[i] = 0;
      for (let i = 0; i < BUTTON_TOTAL; i++) api.setButton(i, 0);
      for (const s of ui.sliders) s.value = '0';
      touch();
    },
  };

  const ui = buildPanel(api);
  function renderLog(): void {
    ui.log.textContent = rumbles
      .slice(-LOG_LINES)
      .map((r) => `${(r.t / 1000).toFixed(1)}s ${r.duration}ms S${r.strong.toFixed(2)} W${r.weak.toFixed(2)}`)
      .join('\n') || '(no rumble yet)';
  }
  renderLog();

  installed = api;
  (window as unknown as { __fakePad: FakePadApi }).__fakePad = api;
  if (startConnected) api.connect(true);
  console.info(`[fakepad] virtual controller ready (${startConnected ? 'plugged in' : 'unplugged'}); window.__fakePad for scripts`);
  return api;
}

// ---------------------------------------------------------------------------
// Panel (white on black, like everything else)
// ---------------------------------------------------------------------------

const BUTTON_ORDER: [PadButton, string][] = [
  ['A', 'A'], ['B', 'B'], ['X', 'X'], ['Y', 'Y'],
  ['LB', 'LB'], ['RB', 'RB'], ['VIEW', 'View'], ['MENU', 'Menu'],
  ['L3', 'L3'], ['R3', 'R3'], ['UP', '↑'], ['DOWN', '↓'],
  ['LEFT', '←'], ['RIGHT', '→'],
];

function buildPanel(api: FakePadApi) {
  const el = document.createElement('div');
  el.id = 'fakepad';
  el.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:2500;width:250px;max-height:calc(100vh - 16px);overflow:auto;' +
    'background:#000;color:#fff;border:1px solid #fff;border-radius:4px;padding:6px 8px;' +
    'font:11px/1.35 ui-monospace,Menlo,monospace;pointer-events:auto;user-select:none;';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-weight:600;';
  head.textContent = 'Fake pad (dev)';
  const fold = document.createElement('span');
  fold.textContent = '–';
  head.appendChild(fold);
  const body = document.createElement('div');
  head.addEventListener('click', () => {
    const hide = body.style.display !== 'none';
    body.style.display = hide ? 'none' : '';
    fold.textContent = hide ? '+' : '–';
  });

  const row = (...kids: HTMLElement[]) => {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px;';
    r.append(...kids);
    return r;
  };
  const check = (label: string, on: boolean) => {
    const l = document.createElement('label');
    l.style.cssText = 'display:flex;align-items:center;gap:3px;cursor:pointer;';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = on;
    c.style.accentColor = '#fff';
    l.append(c, document.createTextNode(label));
    return { l, c };
  };

  const plug = check('plugged in', false);
  plug.c.addEventListener('change', () => api.connect(plug.c.checked));
  const hold = check('hold', false);
  const latch = check('latch', false);

  const sliders: HTMLInputElement[] = [];
  const slider = (label: string, min: number, set: (v: number) => void) => {
    const name = document.createElement('span');
    name.textContent = label;
    name.style.cssText = 'width:22px;';
    const s = document.createElement('input');
    s.type = 'range';
    s.min = String(min);
    s.max = '1';
    s.step = '0.01';
    s.value = '0';
    s.style.cssText = 'flex:1;accent-color:#fff;';
    const val = document.createElement('span');
    val.style.cssText = 'width:34px;text-align:right;';
    val.textContent = '0.00';
    const apply = () => {
      const v = Number(s.value);
      val.textContent = v.toFixed(2);
      set(v);
    };
    s.addEventListener('input', apply);
    const springBack = () => {
      if (hold.c.checked) return;
      s.value = '0';
      apply();
    };
    s.addEventListener('pointerup', springBack);
    s.addEventListener('change', springBack);
    sliders.push(s);
    return row(name, s, val);
  };

  const stickTitle = document.createElement('div');
  stickTitle.style.cssText = 'margin-top:6px;opacity:0.7;';
  stickTitle.textContent = 'Sticks (up / left = -1) · triggers';

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin-top:6px;';
  const buttonEls = new Map<number, HTMLElement>();
  for (const [name, label] of BUTTON_ORDER) {
    const i = PAD[name];
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'font:inherit;padding:3px 0;background:#000;color:#fff;border:1px solid #fff;border-radius:3px;cursor:pointer;';
    let down = false;
    let downAt = 0;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (latch.c.checked) {
        api.setButton(i, api.isPressed(i) ? 0 : 1);
        return;
      }
      down = true;
      downAt = performance.now();
      api.setButton(i, 1);
    });
    const up = () => {
      if (!down || latch.c.checked) return;
      down = false;
      // a quick click still lasts a few frames, so the game's poll sees the press even at low fps
      const wait = Math.max(0, MIN_PRESS_MS - (performance.now() - downAt));
      window.setTimeout(() => {
        if (!down) api.setButton(i, 0);
      }, wait);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointerleave', up);
    buttonEls.set(i, b);
    grid.appendChild(b);
  }

  const logTitle = document.createElement('div');
  logTitle.style.cssText = 'margin-top:6px;opacity:0.7;';
  logTitle.textContent = 'Rumble calls (time · ms · strong · weak)';
  const log = document.createElement('pre');
  log.style.cssText = 'margin:2px 0 0;white-space:pre;font:inherit;';

  const hint = document.createElement('div');
  hint.style.cssText = 'margin-top:6px;opacity:0.6;';
  hint.textContent = 'Esc frees the mouse without pausing. Click the scene for keyboard + mouse.';

  body.append(
    row(plug.l, hold.l, latch.l),
    stickTitle,
    slider('LX', -1, (v) => api.setAxis(0, v)),
    slider('LY', -1, (v) => api.setAxis(1, v)),
    slider('RX', -1, (v) => api.setAxis(2, v)),
    slider('RY', -1, (v) => api.setAxis(3, v)),
    slider('LT', 0, (v) => api.setButton(PAD.LT, v)),
    slider('RT', 0, (v) => api.setButton(PAD.RT, v)),
    grid,
    logTitle,
    log,
    hint,
  );
  el.append(head, body);
  // keep panel clicks away from the game (start screen "click anywhere", pointer lock)
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.appendChild(el);

  return { plug: plug.c, sliders, buttonEls, log };
}
