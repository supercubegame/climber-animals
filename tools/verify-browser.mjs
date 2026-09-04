#!/usr/bin/env node
// SLOW GATE. Loads the shipped single file over file:// in headless Chromium,
// drives it with REAL keyboard and mouse events, and reads state back through
// window.__game.
//   npm i puppeteer && node tools/verify-browser.mjs [--log=browser-gate.log]
//
// Runs in CI only (needs a browser download). Every threshold below cites where
// its number came from: a CI measurement, or an offline replay of the same
// controller against the pure core. The log prints the live value each run so the
// next round tightens from data instead of from vibes.
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'shots');
const lines = [];
const metrics = {};
let pass = 0, fail = 0;
const log = (s) => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function record(name, ok, detail) {
  if (ok) { pass++; log(`[PASS] ${name}${detail ? ' \u2014 ' + detail : ''}`); }
  else { fail++; log(`[FAIL] ${name}${detail ? ' \u2014 ' + detail : ''}`); }
}
function finish() {
  log('');
  log('--- measured values (tighten the floors above from these next round) ---');
  for (const [k, v] of Object.entries(metrics)) log(`  ${k} = ${v}`);
  log('');
  log(`${pass}/${pass + fail} checks passed${fail ? `, ${fail} FAILED` : ''}`);
  const a = process.argv.find((x) => x.startsWith('--log='));
  if (a) writeFileSync(join(ROOT, a.slice(6)), lines.join('\n') + '\n');
  process.exit(fail ? 1 : 0);
}

let puppeteer;
try { puppeteer = (await import('puppeteer')).default; }
catch {
  // Not "skip". A missing browser means this run verified NOTHING, and that must
  // not look like health.
  log('[FAIL] env:puppeteer-available \u2014 puppeteer is not installed, so NO browser behaviour was verified this run (this is not a pass and not a skip)');
  fail++; finish();
}

log('=== Climber Animals \u2014 browser gate ===');
const url = pathToFileURL(join(ROOT, 'climber-animals.html')).href;
log(`loading ${url}`);
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction('window.__game && window.__game.ticks > 30', { timeout: 15000 });

// ---------------------------------------------------------------- autopilot
// Steers the animal toward the next platform using ONLY real key events. All the
// maths is here, on the Node side; the page hands over raw coordinates.
//
// Inverse of the shell's currentInput():
//   mx = f*sin(yaw) + r*cos(yaw)      f = mx*sin(yaw) + mz*cos(yaw)
//   mz = f*cos(yaw) - r*sin(yaw)      r = mx*cos(yaw) - mz*sin(yaw)
// (the 2x2 is orthonormal, so the inverse is its transpose)
const HOLD_BAND = 0.30;   // treat an axis as "pressed" past this much of the unit vector
const EASE_RADIUS = 1.0;  // inside this distance to the target, release the sticks
const EDGE_MARGIN = 0.9;  // jump once this close to the edge you are walking toward
const POLL_MS = 35;

// Distance from an INTERIOR point to the box edge, along the direction of travel.
// Test-side navigation, deliberately not imported from the core: the gate must
// not lean on the thing it is grading.
//
// The previous version projected the player's position onto the bearing to the
// target and compared it against the ray exit along that same bearing. Movement
// is 8-way quantised, so the actual travel direction is up to 22.5 degrees off
// that bearing; on the 26-unit farmyard the animal walked off the z edge while
// the projection still read 12 of 16 and the jump never fired. CI reported it as
// "Space asked for on 0 polls, 7 falls, 0 platforms". See docs/PITFALLS.md.
function distToEdge(box, px, pz, dx, dz) {
  const tx = Math.abs(dx) < 1e-9 ? Infinity : ((dx > 0 ? box.x + box.w / 2 : box.x - box.w / 2) - px) / dx;
  const tz = Math.abs(dz) < 1e-9 ? Infinity : ((dz > 0 ? box.z + box.d / 2 : box.z - box.d / 2) - pz) / dz;
  return Math.max(0, Math.min(tx, tz));
}

async function autopilot(page, ms, { pressKeys = true } = {}) {
  const held = new Set();
  const setKeys = async (want) => {
    for (const k of [...held]) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
  };

  const t0 = Date.now();
  let maxIdx = 0, samples = 0, jumpPolls = 0;
  while (Date.now() - t0 < ms) {
    const n = await page.evaluate(() => window.__game.nav());
    samples++;
    if (n.idx > maxIdx) maxIdx = n.idx;
    const want = new Set();
    if (n.next) {
      let dx = n.next.x - n.px, dz = n.next.z - n.pz;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-6) {
        dx /= dist; dz /= dist;
        if (dist > EASE_RADIUS) {
          const sy = Math.sin(n.camYaw), cy = Math.cos(n.camYaw);
          const f = dx * sy + dz * cy;   // inverse of the shell's currentInput():
          const r = dx * cy - dz * sy;   // the 2x2 is orthonormal, so inverse = transpose
          if (f > HOLD_BAND) want.add('KeyW'); else if (f < -HOLD_BAND) want.add('KeyS');
          if (r > HOLD_BAND) want.add('KeyD'); else if (r < -HOLD_BAND) want.add('KeyA');
        }
        // Jump only when the edge you are walking toward is close. Holding Space
        // from the middle of a platform looks like a bunny hop but lands you in
        // the gap: the arc peaks before the gap even starts.
        if (n.onGround && n.cur) {
          // Where the quantised keys will actually send us, which is not the same
          // as the bearing to the target.
          let mx = 0, mz = 0;
          const sy2 = Math.sin(n.camYaw), cy2 = Math.cos(n.camYaw);
          const fwd = (want.has('KeyW') ? 1 : 0) - (want.has('KeyS') ? 1 : 0);
          const rgt = (want.has('KeyD') ? 1 : 0) - (want.has('KeyA') ? 1 : 0);
          mx = fwd * sy2 + rgt * cy2;
          mz = fwd * cy2 - rgt * sy2;
          const ml = Math.hypot(mx, mz);
          if (ml > 1e-9 && distToEdge(n.cur, n.px, n.pz, mx / ml, mz / ml) <= EDGE_MARGIN) {
            want.add('Space'); jumpPolls++;
          }
        }
      }
    }
    if (pressKeys) await setKeys(want);
    await sleep(POLL_MS);
  }
  for (const k of [...held]) await page.keyboard.up(k);
  const end = await page.evaluate(() => window.__game.nav());
  return { maxIdx, samples, jumpPolls, end };
}

// 1. boot clean
const info = await page.evaluate(() => ({
  version: window.__game.version, ...window.__game.level,
  ticks: window.__game.ticks, inner: window.__game.errors.length,
}));
metrics.platformCount = info.count;
metrics.topY = Math.round(info.topY);
record('boot:no-errors', consoleErrors.length === 0 && info.inner === 0,
  consoleErrors.length ? consoleErrors.slice(0, 4).join(' | ') : `clean boot, v${info.version}, ${info.count} platforms, top ${Math.round(info.topY)}m`);

// 2. the loop is still ticking LATER, which the load-time wait does not imply.
//    (The previous check asserted ticks > 30 right after waiting for ticks > 30.
//    It could not fail. See docs/PITFALLS.md.)
const tick0 = await page.evaluate(() => window.__game.ticks);
await sleep(600);
const tick1 = await page.evaluate(() => window.__game.ticks);
const delta = tick1 - tick0;
metrics.ticksPer600ms = delta;
record('loop:advances-over-time', delta >= 24,
  `+${delta} fixed steps over 600ms of wall clock (floor 24 = a third of the 72 implied by the 60.0 fps CI measured on 2026-09-04)`);

// 3. THE v1.0 BUG: is the animal actually on screen? v1.0 rendered it 83px below
//    the bottom edge, which read as "there is no third-person model" / "it must be
//    first person". Nothing in the gate could see it, because the camera maths
//    lived in the shell where nothing could reach it.
const aim0 = await page.evaluate(() => window.__game.aimPixel());
metrics.aimPixel = aim0 ? `${Math.round(aim0.x)},${Math.round(aim0.y)} of ${aim0.w}x${aim0.h}` : 'null';
const aimOk = !!aim0 && aim0.x > 60 && aim0.x < aim0.w - 60 && aim0.y > 60 && aim0.y < aim0.h - 60;
record('camera:animal-is-on-screen', aimOk,
  aim0
    ? `aim point at ${Math.round(aim0.x)},${Math.round(aim0.y)} in a ${aim0.w}x${aim0.h} viewport, ${Math.round(Math.min(aim0.x, aim0.w - aim0.x, aim0.y, aim0.h - aim0.y))}px clear of the nearest edge (v1.0 put it at y=935 of 852)`
    : 'aimPixel() returned null: the camera target is behind the near plane');

// 4. the farmyard is drawn. v1.0's all-or-nothing near culling would have thrown
//    the whole ground plane away; here we count green pixels in the lower half.
const grass = await page.evaluate(() => {
  const c = document.getElementById('view');
  const g = c.getContext('2d');
  let green = 0, n = 0;
  for (let ix = 0; ix < 40; ix++) {
    for (let iy = 14; iy < 25; iy++) {   // lower ~45% of the frame
      const d = g.getImageData(Math.floor((ix + 0.5) * c.width / 40), Math.floor((iy + 0.5) * c.height / 25), 1, 1).data;
      if (d[1] > d[2] + 20 && d[1] > 90) green++;
      n++;
    }
  }
  return { green, n };
});
metrics.grassPixelPct = +(100 * grass.green / grass.n).toFixed(1);
record('render:farmyard-is-drawn', grass.green / grass.n > 0.35,
  `${grass.green}/${grass.n} samples in the lower frame read as grass (${(100 * grass.green / grass.n).toFixed(0)}%, floor 35%). The core says the ground covers 45-98% of the viewport depending on pitch.`);

// 5. canvas actually painted. Floor 20 distinct quantised colours: CI measured 44
//    on 2026-09-04, and this is the check that proves geometry is drawn rather
//    than just "the file is not empty" (that is the screenshot size check).
const paint = await page.evaluate(() => {
  const c = document.getElementById('view');
  const g = c.getContext('2d');
  const seen = new Set();
  let n = 0;
  for (let ix = 0; ix < 40; ix++) {
    for (let iy = 0; iy < 25; iy++) {
      const d = g.getImageData(Math.floor((ix + 0.5) * c.width / 40), Math.floor((iy + 0.5) * c.height / 25), 1, 1).data;
      seen.add((d[0] >> 3) + ',' + (d[1] >> 3) + ',' + (d[2] >> 3));
      n++;
    }
  }
  return { distinct: seen.size, samples: n, w: c.width, h: c.height };
});
metrics.distinctColours = paint.distinct;
record('render:canvas-not-blank', paint.distinct >= 20,
  `${paint.distinct} distinct colours across ${paint.samples} samples at ${paint.w}x${paint.h} (floor 20, measured 44)`);

// 6. CONTROL: same steering maths, no keys sent. Nothing may move. Without this,
//    the climb below could be coming from anywhere and the gate would not know.
const control = await autopilot(page, 3500, { pressKeys: false });
metrics.controlMaxIdx = control.maxIdx;
metrics.controlBestY = +control.end.bestY.toFixed(2);
record('input:control-run-does-not-move', control.maxIdx === 0 && control.end.bestY < 0.01,
  control.maxIdx === 0 && control.end.bestY < 0.01
    ? `3.5s of steering with the keyboard muted: still on platform 0 at ${control.end.bestY.toFixed(2)}m over ${control.samples} samples \u21d2 the climb below is the key path, not something else`
    : `the animal moved with NO keys pressed: idx ${control.maxIdx}, best ${control.end.bestY.toFixed(2)}m \u2014 something other than input is driving it`);

// 7. the real thing: climb a real stretch of the actual tower
const run = await autopilot(page, 24000, { pressKeys: true });
metrics.autopilotMaxIdx = run.maxIdx;
metrics.autopilotBestY = +run.end.bestY.toFixed(2);
metrics.autopilotFalls = run.end.falls;
metrics.autopilotJumpPolls = run.jumpPolls;
metrics.autopilotSamples = run.samples;
metrics.autopilotPollMs = Math.round(24000 / Math.max(1, run.samples));
// MEASURED, not guessed: an offline replay of this exact controller against the
// pure core reaches platform 23 / 23.6m in 24s with zero falls, and holds 22-23
// across every poll interval from 20ms to 140ms. Floors are half that. The 24s
// budget includes ~4s of walking across the farmyard before the first jump.
// CI on 2026-09-04 measured 23 / 23.61m, so the offline predictor is trustworthy.
const CLIMB_IDX_FLOOR = 11;
const CLIMB_Y_FLOOR = 11;
const climbed = run.maxIdx >= CLIMB_IDX_FLOOR && run.end.bestY >= CLIMB_Y_FLOOR;
record('input:autopilot-climbs-the-tower', climbed,
  `reached platform #${run.maxIdx} / ${run.end.bestY.toFixed(2)}m in 24s via real keys ` +
  `(Space asked for on ${run.jumpPolls} polls, ${run.end.falls} falls, ${run.samples} samples \u2248 ${Math.round(24000 / Math.max(1, run.samples))}ms per poll). ` +
  `Floors idx ${CLIMB_IDX_FLOOR} / ${CLIMB_Y_FLOOR}m = half the offline-measured 23 / 23.6.`);

const after = await page.evaluate(() => ({ fps: window.__game.fps }));
metrics.fps = +after.fps.toFixed(1);
record('loop:fps-alive', after.fps > 5,
  `${after.fps.toFixed(1)} fps (floor 5 = dead-loop detector only, NOT a benchmark; CI is software-rendered)`);

// --- mouse look, the other thing v1.0 got wrong -------------------------------
// A page only receives mouse movement continuously while the pointer is LOCKED;
// without a lock it sees the cursor but the camera cannot follow it, which is why
// v1.0 needed click-and-drag. Both paths exist, so both are tested -- but SEPARATELY.
//
// The first version tested them in one block and produced two nonsense failures.
// Three things were wrong with it, all in the test:
//   1. It dispatched MouseEvents on `window`, while the shell listens for
//      mousedown on the CANVAS. An event dispatched on window has window as its
//      target and never reaches a child element, so `dragging` never became true
//      and pitch never moved. The check was driving nothing.
//   2. It reused ONE detail string for pass and fail, so the report read
//      "[FAIL] ... pitch stayed inside [0.02, 1.15] and the two extremes differ"
//      -- a failure message describing success. Every record() below now prints
//      the measured numbers instead of a fixed sentence.
//   3. It exited pointer lock and immediately dragged, but releasing the button
//      fires a click, which re-arms the lock. The two input paths read different
//      event fields (movementX vs clientX), so interleaving them measured a mix
//      of both. Each path is now measured in its own isolated window.
// See docs/PITFALLS.md.

// Helper: drag on the CANVAS with real events, returning the camera delta.
//
// It releases pointer lock FIRST, every single time. Round two of this test still
// measured the lock path by accident: releasing the mouse button fires a click,
// the shell arms the lock on canvas click, so drag B's own mouseup re-armed it and
// drag C ran locked. The symptom was unmistakable once the numbers were printed --
// pitch pinned at exactly 0.020 (the clamp minimum) while yaw moved 1.536 rad,
// which is 640 x MOUSE_SENS_X, i.e. a movementX of 640 rather than the 420px this
// drag actually travelled. Under lock the shell reads movementX/movementY, and
// Puppeteer's absolute-coordinate moves do not produce the deltas you asked for.
//
// It also reads the camera BEFORE mouseup, so the re-arming click cannot
// contaminate this reading either, and it reports the lock state so a future
// regression says "measured the wrong path" instead of "pitch is broken".
async function dragBy(page, from, to, steps = 10) {
  await page.evaluate(() => { if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock(); });
  await sleep(220);
  const lockedAtStart = await page.evaluate(() => window.__game.pointerLocked);
  const before = await page.evaluate(() => ({ yaw: window.__game.camYaw, pitch: window.__game.camPitch }));
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  const mid = await page.evaluate(() => ({ yaw: window.__game.camYaw, pitch: window.__game.camPitch, locked: window.__game.pointerLocked }));
  await page.mouse.up();
  return {
    before, after: mid, lockedAtStart,
    dYaw: mid.yaw - before.yaw, dPitch: mid.pitch - before.pitch, locked: mid.locked,
  };
}

// A. pointer lock path. Click to arm, then move with no button held.
const yawBeforeLock = await page.evaluate(() => window.__game.camYaw);
await page.mouse.click(640, 400);
await sleep(350);
const locked = await page.evaluate(() => window.__game.pointerLocked);
metrics.pointerLockGranted = locked;
await page.mouse.move(500, 400);
await sleep(80);
await page.mouse.move(860, 400);          // horizontal only: isolates yaw
await sleep(150);
const lockYawDelta = Math.abs(await page.evaluate(() => window.__game.camYaw) - yawBeforeLock);
metrics.lockYawDelta = +lockYawDelta.toFixed(3);
record('input:pointer-lock-look',
  locked ? lockYawDelta > 0.1 : true,
  locked
    ? `lock GRANTED and bare mouse movement turned the camera by ${lockYawDelta.toFixed(3)} rad (floor 0.1). This is the path a real Edge session takes.`
    : `lock NOT granted by this headless browser, so continuous look was NOT verified this run (yaw moved ${lockYawDelta.toFixed(3)} rad). The drag fallback below was verified; only a real browser settles this one.`);

// B. drag fallback, in isolation. dragBy releases the lock itself.
const dragX = await dragBy(page, [400, 400], [760, 400]);   // horizontal: yaw
metrics.dragYawDelta = +dragX.dYaw.toFixed(3);
record('input:drag-look-turns-yaw', !dragX.lockedAtStart && !dragX.locked && Math.abs(dragX.dYaw) > 0.2,
  (dragX.lockedAtStart || dragX.locked)
    ? `pointer lock was active during this drag (start ${dragX.lockedAtStart}, end ${dragX.locked}), so it measured the lock path rather than the drag path`
    : `dragged 360px horizontally on the canvas: yaw ${dragX.before.yaw.toFixed(3)} \u2192 ${dragX.after.yaw.toFixed(3)} (\u0394 ${dragX.dYaw.toFixed(3)} rad, floor 0.2), pitch untouched at ${dragX.after.pitch.toFixed(3)}`);

// C. pitch responds to vertical drag. Direction is not asserted: the starting
//    pitch depends on everything above, so a run that begins near a clamp can
//    legitimately only move one way. Magnitude is what matters.
await sleep(120);
const dragY = await dragBy(page, [640, 200], [640, 620]);   // vertical: pitch
metrics.dragPitchDelta = +dragY.dPitch.toFixed(3);
metrics.dragPitchLocked = dragY.lockedAtStart || dragY.locked;
record('input:drag-look-turns-pitch', !dragY.lockedAtStart && !dragY.locked && Math.abs(dragY.dPitch) > 0.1,
  (dragY.lockedAtStart || dragY.locked)
    ? `pointer lock was active during this drag (start ${dragY.lockedAtStart}, end ${dragY.locked}), so it measured the lock path, not the drag path. That is the failure, not the camera.`
    : `dragged 420px vertically on the canvas: pitch ${dragY.before.pitch.toFixed(3)} \u2192 ${dragY.after.pitch.toFixed(3)} (\u0394 ${dragY.dPitch.toFixed(3)}, floor 0.1); yaw moved ${dragY.dYaw.toFixed(3)}`);

// D. the clamp itself. Drag past both limits and require the bounds to hold.
//    Separately require the two extremes to DIFFER, otherwise a camera frozen at
//    one value passes a bounds check trivially.
//
//    ONE drag per direction, deliberately. Round three used two 600px drags each
//    way and failed with pitch stuck at 0.0200 after dragging toward the MAXIMUM,
//    which is only possible if a drag was measured under pointer lock: every
//    mouseup fires a click, the shell arms the lock on canvas click, and the grant
//    is asynchronous, so a rapid second drag races it. Fewer mouseups, fewer
//    races. 700px x MOUSE_SENS_Y = 1.26 rad, which spans the whole
//    [0.02, 1.15] range from any start, so one drag is enough.
//
//    The lock state is ASSERTED, not just collected. Round three already had the
//    numbers proving lock contamination and threw them away, which is how a test
//    defect got reported as a product defect twice.
const PITCH_MIN = 0.02, PITCH_MAX = 1.15;
const toMax = await dragBy(page, [640, 50], [640, 750], 24);   // downward drag raises pitch
const hi = await page.evaluate(() => window.__game.camPitch);
await sleep(200);
const toMin = await dragBy(page, [640, 750], [640, 50], 24);
const lo = await page.evaluate(() => window.__game.camPitch);
metrics.pitchAfterMaxDrag = +hi.toFixed(4);
metrics.pitchAfterMinDrag = +lo.toFixed(4);
const clampLocked = toMax.lockedAtStart || toMax.locked || toMin.lockedAtStart || toMin.locked;
metrics.clampDragLocked = clampLocked;
const inBounds = hi <= PITCH_MAX + 1e-9 && lo >= PITCH_MIN - 1e-9;
const spread = hi - lo;
record('input:camera-pitch-is-clamped', !clampLocked && inBounds && spread > 0.2,
  clampLocked
    ? `pointer lock was active during a clamp drag (toMax ${toMax.lockedAtStart}/${toMax.locked}, toMin ${toMin.lockedAtStart}/${toMin.locked}), so this measured the lock path and the readings mean nothing. Test defect, not a camera defect.`
    : !inBounds
      ? `pitch escaped its limits: after dragging toward max it read ${hi.toFixed(4)} (cap ${PITCH_MAX}), after dragging toward min ${lo.toFixed(4)} (floor ${PITCH_MIN})`
      : spread <= 0.2
        ? `the two extremes came out ${spread.toFixed(4)} apart (need >0.2): ${lo.toFixed(4)} vs ${hi.toFixed(4)}. A bounds check passes trivially on a frozen camera, so this proves nothing yet.`
        : `700px drag each way, one mouseup per direction: pitch reached ${hi.toFixed(4)} then ${lo.toFixed(4)}, both inside [${PITCH_MIN}, ${PITCH_MAX}], ${spread.toFixed(3)} apart. ` +
          `Stops hit: max ${Math.abs(hi - PITCH_MAX) < 1e-6 ? 'YES' : `no, stopped at ${hi.toFixed(4)}`}, min ${Math.abs(lo - PITCH_MIN) < 1e-6 ? 'YES' : `no, stopped at ${lo.toFixed(4)}`}.`);

// 8. HUD is wired to state, not just decorative
const hud = await page.evaluate(() => ({
  best: document.getElementById('h-best').textContent,
  falls: document.getElementById('h-falls').textContent,
  stateBest: window.__game.state.bestY, stateFalls: window.__game.state.falls,
}));
const hudOk = Math.abs(parseFloat(hud.best) - hud.stateBest) < 0.15 &&
  parseInt(hud.falls, 10) === hud.stateFalls;
record('hud:reflects-state', hudOk,
  `HUD best "${hud.best}" vs state ${hud.stateBest.toFixed(2)}; HUD falls "${hud.falls}" vs state ${hud.stateFalls}`);

await page.screenshot({ path: join(SHOTS, 'climbed.png') });

// 9. falling costs height, from wherever the autopilot got to.
//     CASCADE GUARD: this walks off an edge and expects to lose height, which is
//     impossible if the autopilot never left the ground. When that happened it
//     reported as a SECOND independent failure, so one broken jump trigger read
//     as two bugs. A dependent check must name its upstream cause instead.
if (!climbed) {
  record('genre:falling-costs-height', false,
    `NOT RUN: root cause is input:autopilot-climbs-the-tower above. The animal never left the farmyard (best ${run.end.bestY.toFixed(2)}m), so there is no height to lose. Fix that check first; this one is cascade noise.`);
} else {
  const fell = await page.evaluate(async () => {
    const start = window.__game.state.y;
    const ev = (t, code) => window.dispatchEvent(new KeyboardEvent(t, { code, bubbles: true }));
    ev('keydown', 'KeyD');
    await new Promise((r) => setTimeout(r, 4000));
    ev('keyup', 'KeyD');
    return { start, end: window.__game.state.y, falls: window.__game.state.falls };
  });
  metrics.fellFrom = +fell.start.toFixed(2);
  metrics.fellTo = +fell.end.toFixed(2);
  record('genre:falling-costs-height', fell.end < fell.start - 0.3,
    `walked off from ${fell.start.toFixed(2)}m \u2192 ${fell.end.toFixed(2)}m (no checkpoint caught it)`);
}

// 10. species switch through the real key path
const sp = await page.evaluate(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  return window.__game.state.speciesId;
});
record('input:species-switch', sp === 'chicken', `Digit2 \u2192 speciesId "${sp}"`);

// 11. screenshot exists at all. Deliberately left loose at 9000 bytes: a flat
//    colour 1280x800 PNG compresses to 12-19KB, so a tighter byte floor would be
//    a false-red factory. Measured 104957. Image QUALITY is the colour check
//    above; this one only catches an empty capture, and says so.
await page.screenshot({ path: join(SHOTS, 'final.png') });
const shot = statSync(join(SHOTS, 'final.png')).size;
metrics.screenshotBytes = shot;
record('artifact:screenshot-captured', shot > 9000, `final.png ${shot} bytes (floor 9000, measured 104957; catches an empty capture only, by design)`);

record('boot:still-no-errors', consoleErrors.length === 0,
  consoleErrors.length ? consoleErrors.slice(0, 4).join(' | ') : 'zero console errors across the whole session');

await browser.close();
finish();
