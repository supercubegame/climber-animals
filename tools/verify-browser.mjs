#!/usr/bin/env node
// SLOW GATE. Loads the shipped single file over file:// in headless Chromium,
// drives it with REAL keyboard events, and reads state back through window.__game.
//   npm i puppeteer && node tools/verify-browser.mjs [--log=browser-gate.log]
//
// Runs in CI only (needs a browser download). Every threshold marked GUESS below
// was picked without a measured baseline because this cannot run in the authoring
// sandbox; the log prints the live measurement so the next round can tighten it.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'shots');
const lines = [];
const metrics = {};
let pass = 0, fail = 0;
const log = (s) => { lines.push(s); console.log(s); };
function record(name, ok, detail) {
  if (ok) { pass++; log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function finish() {
  log('');
  log('--- measured values (GUESS thresholds above should be tightened from these) ---');
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

// 1. boot clean
const info = await page.evaluate(() => ({
  version: window.__game.version, ...window.__game.level,
  ticks: window.__game.ticks, inner: window.__game.errors.length,
}));
metrics.platformCount = info.count;
metrics.topY = Math.round(info.topY);
record('boot:no-errors', consoleErrors.length === 0 && info.inner === 0,
  consoleErrors.length ? consoleErrors.slice(0, 4).join(' | ') : `clean boot, v${info.version}, ${info.count} platforms, top ${Math.round(info.topY)}m`);
record('boot:loop-running', info.ticks > 30, `${info.ticks} fixed steps within the first load`);

// 2. canvas actually painted (GUESS: >=12 distinct quantised colours over a 40x25 grid)
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
record('render:canvas-not-blank', paint.distinct >= 12,
  `${paint.distinct} distinct colours across ${paint.samples} samples at ${paint.w}x${paint.h} (floor 12 = GUESS)`);

// 3. real keys make the animal climb
const climb = async (ms) => {
  await page.keyboard.down('KeyW');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await page.keyboard.press('Space', { delay: 30 }); await new Promise((r) => setTimeout(r, 90)); }
  await page.keyboard.up('KeyW');
};
const before = await page.evaluate(() => window.__game.state.y);
await climb(6000);
const after = await page.evaluate(() => ({ y: window.__game.state.y, best: window.__game.state.bestY, ticks: window.__game.ticks, fps: window.__game.fps }));
metrics.climbedTo = +after.best.toFixed(2);
metrics.fps = +after.fps.toFixed(1);
record('input:real-keys-climb', after.best > before + 0.8,
  `W+Space via real KeyboardEvents for 6s: best height ${before.toFixed(2)}m → ${after.best.toFixed(2)}m`);
record('loop:fps-alive', after.fps > 5, `${after.fps.toFixed(1)} fps (floor 5 = dead-loop detector only, NOT a benchmark; CI is software-rendered)`);

// 4. HUD is wired to state, not just decorative
const hud = await page.evaluate(() => ({
  cur: document.getElementById('h-cur').textContent,
  best: document.getElementById('h-best').textContent,
  stateY: window.__game.state.y, stateBest: window.__game.state.bestY,
}));
const hudOk = Math.abs(parseFloat(hud.best) - hud.stateBest) < 0.15;
record('hud:reflects-state', hudOk, `HUD best "${hud.best}" vs state ${hud.stateBest.toFixed(2)}`);

// 5. falling costs height, in the real build
await page.screenshot({ path: join(SHOTS, 'climbed.png') });
const fell = await page.evaluate(async () => {
  const start = window.__game.state.y;
  const ev = (t, code) => window.dispatchEvent(new KeyboardEvent(t, { code, bubbles: true }));
  ev('keydown', 'KeyD');
  await new Promise((r) => setTimeout(r, 3500));
  ev('keyup', 'KeyD');
  return { start, end: window.__game.state.y, falls: window.__game.state.falls };
});
metrics.fellFrom = +fell.start.toFixed(2);
metrics.fellTo = +fell.end.toFixed(2);
record('genre:falling-costs-height', fell.end < fell.start - 0.3,
  `walked off: ${fell.start.toFixed(2)}m → ${fell.end.toFixed(2)}m (no checkpoint caught it)`);

// 6. species switch through the real key path
const sp = await page.evaluate(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  return window.__game.state.speciesId;
});
record('input:species-switch', sp === 'chicken', `Digit2 → speciesId "${sp}"`);

// 7. screenshot is a real frame (GUESS floor 9000 bytes; a flat-colour 1280x800
//    PNG compresses to ~12-19KB, so do not raise this without a measurement)
await page.screenshot({ path: join(SHOTS, 'final.png') });
const { statSync } = await import('node:fs');
const shot = statSync(join(SHOTS, 'final.png')).size;
metrics.screenshotBytes = shot;
record('artifact:screenshot-captured', shot > 9000, `final.png ${shot} bytes (floor 9000 = GUESS, catches an empty capture only)`);

record('boot:still-no-errors', consoleErrors.length === 0,
  consoleErrors.length ? consoleErrors.slice(0, 4).join(' | ') : 'zero console errors across the whole session');

await browser.close();
finish();
