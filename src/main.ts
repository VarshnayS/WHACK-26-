/**
 * src/main.ts: renderer (black clear colour) + main loop
 * Owner: shared integration file (renderer/loop set up by @USERNAME_A on feat/world-foundation)
 *
 * Every module is wired in here ONCE through its init function, and that is already done.
 * After that, modules register per-frame work with world.onUpdate(), so you should not
 * need to edit this file. If you do, tell the team first: it's the most likely conflict spot.
 */
import { world, runUpdates } from './world';
import { initTiles } from './world/tiles';
import { initAgents } from './world/agents';
import { initController } from './player/controller';
import { initHud } from './hud/hud';
import { initMic } from './audio'; // C: initAudioSonar(world)
import { updatePings } from './render/pings';
import { initAudit } from './world/audit/log';
import { initSoundSources } from './world/soundSources';
import { initSenses } from './senses';
import { initEntity } from './entity';
import { initFlow, isSimulationRunning } from './game/flow';

function setupRenderer(): void {
  const { renderer, camera } = world;
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('app')!.appendChild(renderer.domElement);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

async function start(): Promise<void> {
  setupRenderer();

  initHud(); // C
  initTiles(); // A
  await initAgents(); // A
  initController(); // C
  initAudit(world); // audit: world.audit + V report + J test events
  // initAudit replaced world.audit with an API that has log() but no record(). controller.ts, cane.ts,
  // soundSources.ts and entity/ still call world.audit.record(), which would throw and abort the frame.
  // A no-op loses nothing: wall and agent hits are logged through log() (collision.ts, agents.ts) and
  // catches by log.ts's own 'caught' listener.
  (world.audit as { record?: (e: unknown) => void }).record ??= () => {};
  void initMic(); // C (waits for a user gesture itself)
  initSoundSources(world); // stub: sound sources (src/world/soundSources.ts)
  initSenses(world); // stub: vision and other senses (src/senses/)
  initEntity(world); // stub: the entity (src/entity/)
  initFlow(world); // game flow: main menu, death, pause, quit to menu (src/game/)

  let last = performance.now();
  world.renderer.setAnimationLoop((now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1); // clamp after tab switches
    last = now;
    if (isSimulationRunning()) runUpdates(dt); // frozen on the death screen, pause and menu (after the first start)
    updatePings(world.camera.position); // B
    world.renderer.render(world.scene, world.camera);
  });
}

start().catch((err) => console.error('[main] failed to start', err));