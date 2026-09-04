#!/usr/bin/env node
// SLOW GATE. Loads the shipped single file over file:// in headless Chromium,
// drives it with REAL keyboard events, and reads state back through window.__game.
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
  if (ok) { pass++; log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
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
  log('[FAIL] env:puppeteer-available — puppeteer is not installed, so NO browser behaviour was verified this run (this is not a pass and not a skip)');
  fail++; finish();
}

log('=== Climber Animals — browser gate ===');
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
const EDGE_MARGIN = 0.8;  // jump once this close to the platform's far edge
const POLL_MS = 35;

// Standing room from a platform centre along (dx,dz): the ray-box exit distance.
// Same maths as src/core/level.mjs rayExitXZ, deliberately re-stated here because
// the gate must not import the thing it is grading.
function rayExit(w, d, dx, dz) {
  const ax = Math.abs(dx), az = Math.abs(dz);
  return Math.min(ax > 1e-9 ? (w / 2) / ax : Infinity, az > 1e-9 ? (d / 2) / az : Infinity);
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
        // Jump only near the far edge. Holding Space from the platform centre
        // looks like a bunny hop but lands you in the gap: the arc peaks before
        // the gap starts. This is what the offline replay proved before this
        // ever ran in a browser -- see docs/PITFALLS.md.
        if (n.onGround && n.cur) {
          const exit = rayExit(n.cur.w, n.cur.d, dx, dz);
          const offset = (n.px - n.cur.x) * dx + (n.pz - n.cur.z) * dz;
          if (offset >= exit - EDGE_MARGIN) { want.add('Space'); jumpPolls++; }
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

// 3. canvas actually painted. Floor 20 distinct quantised colours: CI measured 44
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

// 4. CONTROL: same steering maths, no keys sent. Nothing may move. Without this,
//    the climb below could be coming from anywhere and the gate would not know.
const control = await autopilot(page, 3000, { pressKeys: false });
metrics.controlMaxIdx = control.maxIdx;
metrics.controlBestY = +control.end.bestY.toFixed(2);
record('input:control-run-does-not-move', control.maxIdx === 0 && control.end.bestY < 0.01,
  control.maxIdx === 0 && control.end.bestY < 0.01
    ? `3s of steering with the keyboard muted: still on platform 0 at ${control.end.bestY.toFixed(2)}m over ${control.samples} samples ⇒ the climb below is the key path, not something else`
    : `the animal moved with NO keys pressed: idx ${control.maxIdx}, best ${control.end.bestY.toFixed(2)}m — something other than input is driving it`);

// 5. the real thing: climb a real stretch of the actual tower
const run = await autopilot(page, 20000, { pressKeys: true });
metrics.autopilotMaxIdx = run.maxIdx;
metrics.autopilotBestY = +run.end.bestY.toFixed(2);
metrics.autopilotFalls = run.end.falls;
metrics.autopilotJumpPolls = run.jumpPolls;
metrics.autopilotSamples = run.samples;
metrics.autopilotPollMs = Math.round(20000 / Math.max(1, run.samples));
// MEASURED, not guessed: an offline replay of this exact controller against the
// pure core reaches platform 20 / 19.55m in 20s with zero falls, and holds ~20
// from 20ms to 90ms polling. Floors are set at half that. It degrades hard past
// ~140ms per poll, so if this ever goes red check autopilotPollMs first.
const CLIMB_IDX_FLOOR = 10;
const CLIMB_Y_FLOOR = 9;
const climbed = run.maxIdx >= CLIMB_IDX_FLOOR && run.end.bestY >= CLIMB_Y_FLOOR;
record('input:autopilot-climbs-the-tower', climbed,
  `reached platform #${run.maxIdx} / ${run.end.bestY.toFixed(2)}m in 20s via real keys ` +
  `(Space asked for on ${run.jumpPolls} polls, ${run.end.falls} falls, ${run.samples} samples \u2248 ${Math.round(20000 / Math.max(1, run.samples))}ms per poll). ` +
  `Floors idx ${CLIMB_IDX_FLOOR} / ${CLIMB_Y_FLOOR}m = half the offline-measured 20 / 19.55.`);

const after = await page.evaluate(() => ({ fps: window.__game.fps }));
metrics.fps = +after.fps.toFixed(1);
record('loop:fps-alive', after.fps > 5,
  `${after.fps.toFixed(1)} fps (floor 5 = dead-loop detector only, NOT a benchmark; CI is software-rendered)`);

// 6. HUD is wired to state, not just decorative
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

// 7. falling costs height, from wherever the autopilot got to
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
  `walked off from ${fell.start.toFixed(2)}m → ${fell.end.toFixed(2)}m (no checkpoint caught it)`);

// 8. species switch through the real key path
const sp = await page.evaluate(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  return window.__game.state.speciesId;
});
record('input:species-switch', sp === 'chicken', `Digit2 → speciesId "${sp}"`);

// 9. screenshot exists at all. Deliberately left loose at 9000 bytes: a flat
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
