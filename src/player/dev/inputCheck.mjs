#!/usr/bin/env node
/**
 * src/player/dev/inputCheck.mjs: automated input check in headless Chrome / Edge (no dependencies)
 * Owner: SENSES
 *
 *   npm run dev:all                                  # in one terminal
 *   node src/player/dev/inputCheck.mjs [url]          # default http://localhost:5173/
 *
 * Browser: $CHROME_PATH, else Chrome / Edge / Chromium in the usual places (macOS, Windows, Linux).
 * Uses the dev-only fake controller (?fakepad=unplugged, src/player/dev/fakePad.ts) and the
 * Chrome DevTools Protocol over Node's built-in WebSocket (Node 22+).
 *
 * How it stays deterministic: the animation loop is stopped and the game is stepped at exactly
 * 60 Hz (world runUpdates(1/60)), keys and mouse come in as real input events, the entity is off
 * (its menu setting) and pedestrian / car pushes are disabled (applyImpulse is a no-op except where
 * this script calls the real one). Headless Chrome can't lock the pointer, so the check sets
 * controls.isLocked = true where the real game would have the mouse locked.
 *
 * Cases:
 *   a) keyboard only: W/A/S/D at the pre-#20 speeds and directions, Shift changes nothing, mouse looks,
 *      and the gamepad code makes no Gamepad API calls at all
 *   b) fake pad only (no pointer lock): sticks move and look, deadzone, auto-sweep turns on
 *   c) both: keyboard still works with the pad connected and idle; the two add up
 *   d) pad unplugged mid-game: nothing stuck, keyboard keeps working, polling stops
 *   e) cane: manual sweep, auto-sweep, hard tap from keyboard (C, right mouse, B) and pad (Y, RT, A);
 *      V doesn't tap, X does nothing
 *   g) two pads: the most recently active one drives; a non-standard (DualShock-style) pad goes
 *      through the fallback layout table and its id is logged once
 *   f) haptics: cane contact, light knock, full stun, car hit strengths; silent no-op without rumble
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] ?? 'http://localhost:5173/';
const PORT = 9400 + Math.floor(Math.random() * 400);

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(pf, 'Google/Chrome/Application/chrome.exe'),
    path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
    path.join(local, 'Google/Chrome/Application/chrome.exe'),
    path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

const browserPath = findBrowser();
if (!browserPath) {
  console.error('No Chrome / Edge found. Set CHROME_PATH.');
  process.exit(2);
}
const profile = mkdtempSync(path.join(tmpdir(), 'inputcheck-'));
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,720',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
function cleanup() {
  try {
    browser.kill();
  } catch {}
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }, 300);
}
process.on('exit', cleanup);

// ---------------------------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
for (let i = 0; i < 50 && !page; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
  } catch {}
}
if (!page) {
  console.error('Could not reach the browser over CDP.');
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const consoleLines = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    consoleLines.push({ type: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleLines.push({ type: 'exception', text: d.exception?.description ?? d.text });
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
const VK = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyC: 67, KeyV: 86, KeyX: 88, KeyB: 66, ShiftLeft: 16 };
let modifiers = 0;
const keyName = (code) => (code === 'ShiftLeft' ? 'Shift' : code.replace('Key', '').toLowerCase());
async function keyDown(code) {
  if (code === 'ShiftLeft') modifiers |= 8;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: keyName(code), modifiers, windowsVirtualKeyCode: VK[code] });
}
async function keyUp(code) {
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName(code), modifiers, windowsVirtualKeyCode: VK[code] });
  if (code === 'ShiftLeft') modifiers &= ~8;
}
async function tap(code) {
  await keyDown(code);
  await keyUp(code);
  await sleep(30);
}
async function mouse(type, button, x = 640, y = 360) {
  await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

const results = [];
let currentCase = '';
function check(name, ok, detail = '') {
  results.push({ c: currentCase, name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (xs) => xs.map((x) => x.toFixed(2)).join(' / ');

// ---------------------------------------------------------------------------------------------
// Load the game
// ---------------------------------------------------------------------------------------------

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('blindsim.entityEnabled', '0');` });
const url = new URL(URL_ARG);
url.searchParams.set('fakepad', 'unplugged');
console.log(`Input check: ${url.href}\nBrowser: ${browserPath}\n`);
await send('Page.navigate', { url: url.href });

let ready = false;
for (let i = 0; i < 180 && !ready; i++) {
  await sleep(1000);
  ready = await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.startsWith('Click to begin') && !b.disabled)`).catch(() => false);
}
if (!ready) {
  console.error('The start screen never offered "Click to begin" (is the dev server running?).');
  process.exit(2);
}
const beginAt = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Click to begin')); const q = b.getBoundingClientRect(); return [q.x + q.width / 2, q.y + q.height / 2]; })()`);
await mouse('mousePressed', 'left', beginAt[0], beginAt[1]);
await mouse('mouseReleased', 'left', beginAt[0], beginAt[1]);
await sleep(1500);

// module access: the exact URLs the page loaded, so these are the game's own instances
await ev(`window.__mod = (p) => { const e = performance.getEntriesByType('resource').map(r => r.name).filter(n => new URL(n).pathname === p); return import(e.length ? e[e.length - 1] : p); }`);
await ev(`(async () => {
  const W = await __mod('/src/world/index.ts');
  const ctl = (await __mod('/src/player/controller.ts')).getPlayerController();
  const cane = await __mod('/src/senses/cane.ts');
  const gp = await __mod('/src/player/gamepad.ts');
  for (let i = 0; i < 50 && !window.__fakePad; i++) await new Promise(r => setTimeout(r, 100));
  ctl.realImpulse = ctl.applyImpulse.bind(ctl);
  ctl.applyImpulse = () => {};                 // no pedestrian / car pushes during the measurements
  W.world.renderer.setAnimationLoop(null);     // the check steps the game itself
  const q = W.world.camera.quaternion;
  window.__T = { W, ctl, cane, gp, fp: window.__fakePad, start: W.world.camera.position.clone(), startQ: q.clone() };
})()`);
if (!(await ev(`!!window.__T.fp`))) {
  console.error('The fake pad did not load (is this a dev server? ?fakepad needs import.meta.env.DEV).');
  process.exit(2);
}

/** Step n frames at 60 Hz; returns speed every 6 frames (0.1 s) and the final pose. */
const stepJs = (n) => `(() => { const { W, ctl } = __T; const out = []; for (let i = 1; i <= ${n}; i++) { W.runUpdates(1/60); if (i % 6 === 0) out.push(ctl.getSpeed()); }
  const p = W.world.camera.position, q = W.world.camera.quaternion;
  return { out, x: p.x, z: p.z, yaw: Math.atan2(2*(q.w*q.y + q.x*q.z), 1 - 2*(q.y*q.y + q.x*q.x)), pitch: Math.asin(Math.max(-1, Math.min(1, 2*(q.w*q.x - q.y*q.z)))), stunned: ctl.isStunned(), speed: ctl.getSpeed() }; })()`;
const step = (n) => ev(stepJs(n));
const locked = (on) => ev(`__T.ctl.controls.isLocked = ${on}`);
const caneState = () => ev(`(() => { const s = __T.cane.getCaneState(); return { auto: s.auto, held: s.held, angle: s.angle, tapSerial: s.tapSerial, touchSerial: s.touchSerial, hard: s.lastTapHard, strength: s.lastTapStrength }; })()`);
const fp = (js) => ev(`__T.fp.${js}`);
async function home() {
  await ev(`(() => { const { ctl, W, start, startQ } = __T; ctl.placeAt(start); W.world.camera.quaternion.copy(startQ); W.world.camera.updateMatrixWorld(true); })()`);
  await step(2);
}
/** Hold `codes` (and run `during` JS once) for `frames`; returns speeds + displacement in the start facing. */
async function drive(codes, frames, setup = null, teardown = null) {
  await home();
  const a = await step(1);
  for (const k of codes) await keyDown(k);
  if (setup) await ev(setup);
  await sleep(30);
  const b = await step(frames);
  for (const k of [...codes].reverse()) await keyUp(k);
  if (teardown) await ev(teardown);
  await sleep(30);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const fx = -Math.sin(a.yaw);
  const fz = -Math.cos(a.yaw);
  return { out: b.out, fwd: dx * fx + dz * fz, right: dx * -fz + dz * fx, peak: Math.max(0, ...b.out), stunned: b.stunned, end: b };
}
async function stopTime() {
  const d = await step(180);
  const i = d.out.findIndex((s) => s < 0.02);
  return i < 0 ? Infinity : (i + 1) * 0.1;
}
const at = (r, ...secs) => secs.map((s) => r.out[Math.round(s * 10) - 1]);
const PRE20 = [1.5, 3.0, 4.5, 5.5]; // m/s at 0.5 / 1 / 1.5 / 2 s holding a key (3 m/s² up to 5.5)

// ---------------------------------------------------------------------------------------------
// a) keyboard only
// ---------------------------------------------------------------------------------------------
currentCase = 'a';
console.log('a) keyboard only (no controller ever connected)');
await locked(true);
const calls0 = await fp('getGamepadsCalls()');
await step(120);
check('gamepad code is inert: 0 Gamepad API calls in 120 frames', (await fp('getGamepadsCalls()')) === calls0 && !(await ev('__T.gp.isGamepadPolling()')));
check('cane auto-sweep starts off with keyboard', (await caneState()).auto === false);
{
  const r = await drive(['KeyW'], 120);
  const v = at(r, 0.5, 1, 1.5, 2);
  check('W: speed builds to 5.5 m/s like pre-#20', v.every((s, i) => near(s, PRE20[i], 0.06)), `${fmt(v)} m/s, want ${fmt(PRE20)}`);
  check('W moves forward', r.fwd > 4 && Math.abs(r.right) < 0.1 * r.fwd, `fwd ${r.fwd.toFixed(2)} m, right ${r.right.toFixed(2)} m`);
  const t = await stopTime();
  check('release from 5.5 m/s stops in ~1.4 s (pre-#20 friction)', near(t, 1.4, 0.11), `${t.toFixed(1)} s`);
}
for (const [code, dir] of [['KeyS', 'back'], ['KeyA', 'left'], ['KeyD', 'right']]) {
  const r = await drive([code], 120);
  // within ~6° of the intended direction (a wall nearby can nudge a strafe slightly; streamed tiles vary)
  const ok = dir === 'back' ? r.fwd < -4 && Math.abs(r.right) < 0.1 * -r.fwd : dir === 'left' ? r.right < -4 && Math.abs(r.fwd) < 0.1 * -r.right : r.right > 4 && Math.abs(r.fwd) < 0.1 * r.right;
  check(`${code.slice(3)}: ${dir} at pre-#20 speed`, ok && near(r.peak, 5.5, 0.06) && !r.stunned, `peak ${r.peak.toFixed(2)} m/s, fwd ${r.fwd.toFixed(2)}, right ${r.right.toFixed(2)}`);
  await stopTime();
}
{
  const w = await drive(['KeyW'], 120);
  await stopTime();
  const sw = await drive(['ShiftLeft', 'KeyW'], 120);
  await stopTime();
  check('Shift changes nothing (Shift+W = W)', sw.out.every((s, i) => near(s, w.out[i], 1e-6)), `Shift+W ${fmt(at(sw, 0.5, 1, 1.5, 2))}`);
  const diag = await drive(['KeyW', 'KeyD'], 120);
  await stopTime();
  check('W+D: diagonal, same top speed', near(diag.peak, 5.5, 0.06) && diag.fwd > 2 && diag.right > 2, `peak ${diag.peak.toFixed(2)}`);
}
{
  await home();
  const y0 = (await step(1)).yaw;
  await ev(`document.dispatchEvent(new MouseEvent('mousemove', { movementX: 200, movementY: 0 }))`);
  const y1 = (await step(1)).yaw;
  check('mouse looks (200 px → 0.4 rad yaw, PointerLockControls default)', near(y1 - y0, -0.4, 0.01), `${(y1 - y0).toFixed(3)} rad`);
}

// ---------------------------------------------------------------------------------------------
// b) fake pad only
// ---------------------------------------------------------------------------------------------
currentCase = 'b';
console.log('\nb) fake pad only (mouse not locked: keyboard movement is off, the stick still works)');
await locked(false);
await fp('connect(true)');
await step(2);
check('pad connected: polling on, auto-sweep switched on by default', (await ev('__T.gp.isGamepadPolling()')) && (await caneState()).auto === true);
{
  const r = await drive([], 120, `__T.fp.setAxis(1, -1)`, `__T.fp.setAxis(1, 0)`);
  const v = at(r, 0.5, 1, 1.5, 2);
  check('left stick forward: same momentum as the keys', v.every((s, i) => near(s, PRE20[i], 0.06)) && r.fwd > 4, `${fmt(v)} m/s, fwd ${r.fwd.toFixed(2)} m`);
  await stopTime();
  const s = await drive([], 60, `__T.fp.setAxis(0, 1)`, `__T.fp.setAxis(0, 0)`);
  check('left stick right: strafes right', s.right > 0.8 && Math.abs(s.fwd) < 0.05, `right ${s.right.toFixed(2)} m`);
  await stopTime();
  const h = await drive([], 180, `__T.fp.setAxis(1, -0.5)`, `__T.fp.setAxis(1, 0)`);
  const want = 5.5 * (0.5 - 0.15) / 0.85;
  check('half stick: top speed scales with the push (radial deadzone 0.15)', near(h.peak, want, 0.05), `peak ${h.peak.toFixed(2)}, want ${want.toFixed(2)}`);
  await stopTime();
  const dz = await drive([], 60, `__T.fp.setAxis(1, -0.12)`, `__T.fp.setAxis(1, 0)`);
  check('stick inside the deadzone: no movement', dz.peak === 0);
}
{
  await home();
  const a = await step(1);
  await fp('setAxis(2, 1)');
  const b = await step(30);
  await fp('setAxis(2, 0)');
  check('right stick right: turns right (2.8 rad/s full tilt)', near(b.yaw - a.yaw, -1.4, 0.03), `${(b.yaw - a.yaw).toFixed(3)} rad in 0.5 s`);
  await fp('setAxis(3, -1)');
  const c = await step(20);
  await fp('setAxis(3, 0)');
  check('right stick up: looks up', c.pitch - b.pitch > 0.5, `pitch +${(c.pitch - b.pitch).toFixed(2)} rad`);
}

// ---------------------------------------------------------------------------------------------
// c) both at once
// ---------------------------------------------------------------------------------------------
currentCase = 'c';
console.log('\nc) keyboard + pad connected (idle) at the same time');
await locked(true);
{
  const c0 = await fp('getGamepadsCalls()');
  const r = await drive(['KeyW'], 120);
  const v = at(r, 0.5, 1, 1.5, 2);
  check('idle pad connected: W unchanged from (a)', v.every((s, i) => near(s, PRE20[i], 0.06)) && r.fwd > 4, `${fmt(v)} m/s`);
  check('(the pad is being polled meanwhile)', (await fp('getGamepadsCalls()')) > c0);
  await stopTime();
  const d = await drive(['KeyW'], 120, `__T.fp.setAxis(0, 1)`, `__T.fp.setAxis(0, 0)`);
  check('W + stick right add up: diagonal, clamped to full speed', d.fwd > 2 && d.right > 2 && near(d.peak, 5.5, 0.06), `fwd ${d.fwd.toFixed(2)}, right ${d.right.toFixed(2)}, peak ${d.peak.toFixed(2)}`);
  await stopTime();
  const o = await drive(['KeyW'], 60, `__T.fp.setAxis(1, 1)`, `__T.fp.setAxis(1, 0)`);
  check('W + stick back cancel out (sources add, neither overrides)', o.peak < 0.01, `peak ${o.peak.toFixed(3)}`);
  await stopTime();
  await home();
  const y0 = (await step(1)).yaw;
  await fp('setAxis(2, 1)');
  await ev(`document.dispatchEvent(new MouseEvent('mousemove', { movementX: 200, movementY: 0 }))`);
  const y1 = (await step(30)).yaw;
  await fp('setAxis(2, 0)');
  check('mouse + right stick look add up', near(y1 - y0, -1.8, 0.04), `${(y1 - y0).toFixed(3)} rad (0.4 mouse + 1.4 stick)`);
}

// ---------------------------------------------------------------------------------------------
// d) pad unplugged mid-game
// ---------------------------------------------------------------------------------------------
currentCase = 'd';
console.log('\nd) pad unplugged mid-game');
{
  await home();
  await fp('setAxis(1, -1)');
  const moving = await step(60);
  await fp('connect(false)'); // the stick is still "held" on the dead pad
  const after = await step(120);
  check('unplugged while the stick is held: comes to a stop, nothing stuck', moving.speed > 2.5 && after.speed === 0, `${moving.speed.toFixed(2)} → ${after.speed.toFixed(2)} m/s`);
  await fp('setAxis(1, 0)');
  check('auto-sweep back to off without a controller', (await caneState()).auto === false);
  const c0 = await fp('getGamepadsCalls()');
  await step(60);
  check('polling stopped again: 0 Gamepad API calls', (await fp('getGamepadsCalls()')) === c0 && !(await ev('__T.gp.isGamepadPolling()')));
  const r = await drive(['KeyW'], 60);
  check('keyboard works after the unplug', near(at(r, 0.5)[0], 1.5, 0.06) && near(at(r, 1)[0], 3.0, 0.06), `${fmt(at(r, 0.5, 1))} m/s`);
  await stopTime();
  await fp('connect(true)');
  await home();
  await keyDown('KeyW');
  await step(30);
  await fp('connect(false)');
  const w = await step(30);
  await keyUp('KeyW');
  check('unplugged while W is held: W carries on', near(w.speed, 3.0, 0.06), `${w.speed.toFixed(2)} m/s at 1 s`);
  await stopTime();
}

// ---------------------------------------------------------------------------------------------
// e) cane
// ---------------------------------------------------------------------------------------------
currentCase = 'e';
console.log('\ne) cane from keyboard / mouse and from the pad');
{
  await home();
  let s = await caneState();
  await tap('KeyC');
  const on = (await caneState()).auto;
  await tap('KeyC');
  const off = (await caneState()).auto;
  check('C toggles auto-sweep (pre-#20 meaning)', s.auto === false && on === true && off === false);
  await tap('KeyX');
  check('X does nothing to the cane', (await caneState()).auto === false);
  await keyDown('ShiftLeft');
  await tap('KeyC');
  await keyUp('ShiftLeft');
  check('Shift+C (mic recalibration) does not toggle the cane', (await caneState()).auto === false);

  await mouse('mousePressed', 'right');
  const a0 = (await caneState()).angle;
  await step(20);
  const held = await caneState();
  await mouse('mouseReleased', 'right');
  await step(40);
  const rel = await caneState();
  check('hold right mouse: manual sweep', held.held && Math.abs(held.angle - a0) > 0.3 && !rel.held, `swept ${((held.angle - a0) * 57.3).toFixed(0)}°`);

  await tap('KeyC');
  const t0 = (await caneState()).touchSerial;
  await keyDown('KeyW');
  const mid = await step(150);
  const walking = await caneState();
  await keyUp('KeyW');
  await step(150);
  check('auto-sweep: touches down in step while walking (keyboard)', walking.held && walking.touchSerial - t0 >= 2, `${walking.touchSerial - t0} touch-downs in 2.5 s, speed ${mid.speed.toFixed(1)}`);
  await tap('KeyC');

  s = await caneState();
  await tap('KeyB');
  const b = await caneState();
  check('B: hard tap', b.tapSerial === s.tapSerial + 1 && b.hard);
  await sleep(300);
  await tap('KeyV');
  const v = await caneState();
  const reportOpen = await ev(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Export JSON' && b.offsetParent !== null)`);
  await tap('KeyV');
  check('V: architect map only, no cane tap', v.tapSerial === b.tapSerial && reportOpen, `report open ${reportOpen}`);

  // pad
  await fp('connect(true)');
  await step(2);
  check('auto-sweep stays as the player set it once they have toggled it', (await caneState()).auto === false);
  await fp(`press('Y', true)`);
  await step(2);
  await fp(`press('Y', false)`);
  await step(2);
  check('pad Y toggles auto-sweep', (await caneState()).auto === true);
  await fp(`press('Y', true)`);
  await step(2);
  await fp(`press('Y', false)`);
  await step(2);
  await fp(`setButton(7, 1)`);
  const p0 = (await caneState()).angle;
  await step(20);
  const rt = await caneState();
  await fp(`setButton(7, 0)`);
  await step(40);
  check('pad RT held: manual sweep', rt.held && Math.abs(rt.angle - p0) > 0.3 && !(await caneState()).held);
  await fp(`press('Y', true)`);
  await step(2);
  await fp(`press('Y', false)`);
  await home();
  const t1 = (await caneState()).touchSerial;
  await locked(false);
  await fp('setAxis(1, -1)');
  const pw = await step(150);
  const padWalk = await caneState();
  await fp('setAxis(1, 0)');
  await step(150);
  check('auto-sweep while walking with the stick', padWalk.held && padWalk.touchSerial - t1 >= 2, `${padWalk.touchSerial - t1} touch-downs`);
  await locked(true);
  s = await caneState();
  await sleep(300);
  await fp(`press('A', true)`);
  await step(2);
  await fp(`press('A', false)`);
  await step(2);
  const pa = await caneState();
  check('pad A: hard tap', pa.tapSerial === s.tapSerial + 1 && pa.hard);
}

// ---------------------------------------------------------------------------------------------
// g) two pads + a non-standard layout
// ---------------------------------------------------------------------------------------------
currentCase = 'g';
console.log('\ng) two controllers (most recently active wins) + a non-standard (DualShock-style) layout');
{
  // a second pad in this page only: raw DualShock order, mapping '' (what Firefox / Safari report)
  await ev(`(() => {
    const mk = () => ({ pressed: false, touched: false, value: 0 });
    const axes = [0, 0, 0, -1, -1, 0, 0, 0, 0, 1.2857];   // sticks 0/1 + 2/5, L2/R2 on 3/4 (rest -1), hat on 9
    window.__pad2 = { id: 'Wireless Controller (Vendor: 054c Product: 09cc)', index: 2, connected: true, mapping: '', timestamp: performance.now(), axes, buttons: Array.from({ length: 18 }, mk) };
    const inner = navigator.getGamepads;
    window.__restoreGetGamepads = () => Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: inner });
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => { const l = inner(); l[2] = window.__pad2.connected ? window.__pad2 : null; return l; } });
    window.__pad2.set = (fn) => { fn(window.__pad2); window.__pad2.timestamp = performance.now(); };
    const e = new Event('gamepadconnected'); Object.defineProperty(e, 'gamepad', { value: window.__pad2 }); window.dispatchEvent(e);
  })()`);
  await step(3);
  const activeId = () => ev(`(async () => (await __mod('/src/player/input.ts')).getActivePad()?.id ?? null)()`);
  check('newly connected second pad becomes the active one', (await activeId())?.startsWith('Wireless Controller'));
  const fallbackLogs = () => consoleLines.filter((l) => l.text.includes('fallback layout')).length;
  await step(30);
  check('non-standard mapping: fallback layout chosen and the id logged once', fallbackLogs() === 1 && consoleLines.some((l) => l.text.includes('"playstation" fallback layout')));
  let s = await caneState();
  await sleep(300);
  await ev(`__pad2.set(p => { p.buttons[1].pressed = true; p.buttons[1].value = 1; })`); // Cross = standard A
  await step(2);
  await ev(`__pad2.set(p => { p.buttons[1].pressed = false; p.buttons[1].value = 0; })`);
  await step(2);
  check('DualShock Cross (raw 1) acts as A: hard tap', (await caneState()).tapSerial === s.tapSerial + 1);
  await home();
  const y0 = (await step(1)).yaw;
  await ev(`__pad2.set(p => { p.axes[2] = 1; })`); // right stick x is raw axis 2 on this layout
  const y1 = (await step(30)).yaw;
  await ev(`__pad2.set(p => { p.axes[2] = 0; })`);
  check('DualShock right stick (raw axes 2/5) looks', near(y1 - y0, -1.4, 0.03), `${(y1 - y0).toFixed(3)} rad`);
  await step(10);
  check('triggers resting at -1 on axes are not "held" (no cane sweep)', !(await caneState()).held);
  const pressedUp = await ev(`(async () => { const seen = []; const h = (e) => seen.push(e.code); window.addEventListener('keydown', h);
    __pad2.set(p => { p.axes[9] = -1; }); (await __mod('/src/world/index.ts')).runUpdates(1/60); (await __mod('/src/world/index.ts')).runUpdates(1/60);
    __pad2.set(p => { p.axes[9] = 1.2857; }); (await __mod('/src/world/index.ts')).runUpdates(1/60);
    window.removeEventListener('keydown', h); return seen; })()`);
  check('hat switch up (axis 9 = -1) acts as D-pad up (sends ".")', pressedUp.includes('Period'), JSON.stringify(pressedUp));
  // back to the first pad: pressing its button makes it the most recent
  s = await caneState();
  await sleep(300);
  await fp(`press('A', true)`);
  await step(2);
  await fp(`press('A', false)`);
  await step(2);
  check('pressing a button on the first pad switches back to it (and its A taps)', (await activeId())?.startsWith('Fake') && (await caneState()).tapSerial === s.tapSerial + 1);
  await ev(`(() => { __pad2.connected = false; const e = new Event('gamepaddisconnected'); Object.defineProperty(e, 'gamepad', { value: __pad2 }); window.dispatchEvent(e); __restoreGetGamepads(); })()`);
  await step(3);
  check('unplugging the idle second pad keeps the first one active', (await activeId())?.startsWith('Fake') && (await ev('__T.gp.isGamepadPolling()')));
}

// ---------------------------------------------------------------------------------------------
// f) haptics
// ---------------------------------------------------------------------------------------------
currentCase = 'f';
console.log('\nf) haptics (fake pad rumble log)');
{
  const lastRumble = () => ev(`__T.fp.rumbles.length ? __T.fp.rumbles[__T.fp.rumbles.length - 1] : null`);
  const rumbleCount = () => ev(`__T.fp.rumbles.length`);
  const same = (r, want) => r && r.type === 'dual-rumble' && r.duration === want.duration && near(r.strong, want.strong, 0.005) && near(r.weak, want.weak, 0.005);
  const show = (r) => (r ? `${r.duration} ms, strong ${r.strong.toFixed(3)}, weak ${r.weak.toFixed(3)}` : 'none');
  const caneWant = (s) => ({ duration: Math.round(35 + 35 * s), strong: 0, weak: 0.25 + 0.65 * s });

  // real cane contacts: walk forward from the start until the cane meets something (fast tip), then
  // stand there and sweep into it with RT (slower tip). The cane's tap cooldowns run on real time,
  // so this part steps the game with short real pauses.
  const contacts = [];
  async function contactUntil(label, hold, release) {
    const n0 = await rumbleCount();
    await hold();
    for (let i = 0; i < 120 && (await rumbleCount()) === n0; i++) {
      await step(3);
      await sleep(25);
    }
    await release();
    const s = await caneState();
    const r = await lastRumble();
    const ok = (await rumbleCount()) > n0 && !s.hard && same(r, caneWant(s.strength));
    contacts.push(s.strength);
    check(`cane contact (${label}): weak motor scaled by tip speed`, ok, `strength ${s.strength.toFixed(2)} → ${show(r)}`);
  }
  await home();
  await ev(`__T.cane.setAutoSweep(false)`);
  await sleep(1000); // let earlier rumbles finish (priorities run on real time)
  await contactUntil('walking into it', () => keyDown('KeyW'), () => keyUp('KeyW'));
  await ev(`__T.ctl.reset()`);
  await step(60);
  await sleep(1000);
  await contactUntil('sweeping at rest with RT', () => fp('setButton(7, 1)'), () => fp('setButton(7, 0)'));
  check('contact strength differs with tip speed', contacts.length === 2 && contacts[1] < contacts[0] - 0.05, contacts.map((x) => x.toFixed(2)).join(' vs '));
  await sleep(300);
  {
    const n0 = await rumbleCount();
    await tap('KeyB');
    const r = await lastRumble();
    check('hard tap: caneRumble(0.7)', (await rumbleCount()) === n0 + 1 && same(r, caneWant(0.7)), show(r));
  }
  await home();
  const impulse = (opts) => ev(`(() => { const { ctl } = __T; const V = ctl.getVelocity().constructor; ctl.realImpulse(new V(0, 0, 0.01), ${JSON.stringify(opts)}); })()`);
  const cases = [
    ['light knock (impact 1.5 m/s → level 0.25)', { impactSpeed: 1.5 }, { duration: 120, strong: 0.3, weak: 0.1 }],
    ['full stun (impact 5.5 m/s → level 1.0)', { impactSpeed: 5.5 }, { duration: 800, strong: 1, weak: 1 }],
    ['car hit (forceStun → always max)', { impactSpeed: 0.5, forceStun: true }, { duration: 800, strong: 1, weak: 1 }],
  ];
  for (const [label, opts, want] of cases) {
    await sleep(900);
    const n0 = await rumbleCount();
    await impulse(opts);
    const r = await lastRumble();
    check(label, (await rumbleCount()) === n0 + 1 && same(r, want), show(r));
    await ev(`__T.ctl.reset()`);
  }
  await sleep(900);
  await fp('setRumbleSupported(false)');
  const warnBefore = consoleLines.filter((l) => l.type === 'warning' || l.type === 'error').length;
  const n0 = await rumbleCount();
  const played = await ev(`window.blindSimHaptics.rumble({ duration: 100, strong: 1, weak: 1 })`);
  await impulse({ impactSpeed: 5.5 });
  await ev(`__T.ctl.reset()`);
  const warnAfter = consoleLines.filter((l) => l.type === 'warning' || l.type === 'error').length;
  check('pad without vibrationActuator: silent no-op', played === false && (await rumbleCount()) === n0 && warnAfter === warnBefore);
  await fp('setRumbleSupported(true)');
}

// ---------------------------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------------------------
currentCase = 'console';
console.log('\nconsole');
// headless-only noise: no pointer lock and no microphone in a headless browser
const HEADLESS_ONLY = /Pointer Lock|WrongDocumentError|pointer lock|\[audio\] denied/i;
const bad = consoleLines.filter((l) => (l.type === 'error' || l.type === 'exception' || l.type === 'warning') && !HEADLESS_ONLY.test(l.text));
check('no console errors, exceptions or warnings (headless pointer-lock / mic noise excluded)', bad.length === 0, bad.slice(0, 3).map((l) => l.text.slice(0, 120)).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => `${f.c}) ${f.name}`).join('; ')}` : ''}`);
ws.close();
process.exit(failed.length ? 1 : 0);
