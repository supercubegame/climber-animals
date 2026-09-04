#!/usr/bin/env node
// FAST GATE. Zero dependencies, no network, no browser. One command, one exit code.
//   node tools/verify.mjs [--log=fast-gate.log]
// Writes its own log file. Deliberately NOT `| tee`: a pipeline hides the exit
// code of the left-hand side unless pipefail is set, and that is a factory for
// green runs that verified nothing.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mulberry32 } from '../src/core/rng.mjs';
import { makeLevel, extentAlong } from '../src/core/level.mjs';
import { makePlayer, stepPlayer, hashState, isFinitePlayer, DEFAULT_PHYS, SPECIES } from '../src/core/player.mjs';
import { scanReachability } from '../src/core/reach.mjs';
import * as K from '../src/core/constants.mjs';
import { buildHtml, OUT_FILE, INLINE_ORDER } from './build.mjs';
import { scanShippedHtml, stripJsComments, scriptBodies } from './scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEEDS = [1, 7, 42, 999, K.DEFAULT_SEED, 123456];
const lines = [];
const metrics = {};
let pass = 0, fail = 0;

function log(s) { lines.push(s); console.log(s); }
function check(name, fn) {
  let ok = false, detail = '';
  try { const r = fn(); ok = r.ok; detail = r.detail || ''; }
  catch (e) { ok = false; detail = `threw: ${e && e.message}`; }
  if (ok) { pass++; log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- helpers
function scriptedInput(rnd) {
  const a = rnd() * Math.PI * 2;
  return { mx: Math.cos(a), mz: Math.sin(a), jump: rnd() < 0.12 };
}
function airborneAt(level, y, x = 1000, z = 1000) {
  return { x, y, z, vx: 0, vy: 0, vz: 0, onGround: false, groundIdx: -1,
    bestY: y, falls: 0, t: 0, steps: 0, won: false, speciesId: 'cow' };
}
function standOn(level, idx) {
  const p = level.platforms[idx];
  return { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, onGround: true, groundIdx: idx,
    bestY: p.y, falls: 0, t: 0, steps: 0, won: false, speciesId: 'cow' };
}

log('=== Climber Animals — fast gate ===');
log(`node ${process.version} · seeds ${SEEDS.join(',')}`);
log('');

// ---------------------------------------------------------------- A. core
check('level:determinism', () => {
  for (const s of SEEDS) {
    if (JSON.stringify(makeLevel(s)) !== JSON.stringify(makeLevel(s))) {
      return { ok: false, detail: `seed ${s} produced two different levels` };
    }
  }
  if (JSON.stringify(makeLevel(1)) === JSON.stringify(makeLevel(2))) {
    return { ok: false, detail: 'seeds 1 and 2 produced the SAME level — seeding is a no-op' };
  }
  return { ok: true, detail: `${SEEDS.length} seeds stable, distinct across seeds` };
});

check('level:monotonic-rise', () => {
  for (const s of SEEDS) {
    const ps = makeLevel(s).platforms;
    for (let i = 1; i < ps.length; i++) {
      if (!(ps[i].y > ps[i - 1].y)) return { ok: false, detail: `seed ${s} platform ${i}: y ${ps[i].y} <= ${ps[i - 1].y}` };
    }
  }
  return { ok: true, detail: 'every platform strictly above the previous one' };
});

check('level:no-overlap', () => {
  let worst = Infinity, worstAt = '';
  for (const s of SEEDS) {
    const ps = makeLevel(s).platforms;
    for (let i = 1; i < ps.length; i++) {
      const a = ps[i - 1], b = ps[i];
      let dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
      const gap = len - extentAlong(a.w, a.d, dx, dz) - extentAlong(b.w, b.d, dx, dz);
      if (gap < worst) { worst = gap; worstAt = `seed ${s} #${i}`; }
    }
  }
  metrics.minEdgeGap = +worst.toFixed(4);
  return worst > 0.01
    ? { ok: true, detail: `min edge gap ${worst.toFixed(3)} at ${worstAt} (>0 ⇒ separated)` }
    : { ok: false, detail: `platforms touch/overlap: gap ${worst.toFixed(4)} at ${worstAt}` };
});

check('level:gap-bounds', () => {
  let mxY = -Infinity, mxXZ = -Infinity, mnY = Infinity;
  for (const s of SEEDS) {
    for (const p of makeLevel(s).platforms.slice(1)) {
      mxY = Math.max(mxY, p.gapY); mnY = Math.min(mnY, p.gapY); mxXZ = Math.max(mxXZ, p.gapXZ);
    }
  }
  metrics.maxGapY = +mxY.toFixed(4); metrics.maxGapXZ = +mxXZ.toFixed(4);
  const bad = mxY > K.GAP_Y_MAX + 1e-9 || mnY < K.GAP_Y_MIN - 1e-9 || mxXZ > K.GAP_XZ_MAX + 1e-9;
  return { ok: !bad, detail: `gapY ${mnY.toFixed(3)}..${mxY.toFixed(3)} (max ${K.GAP_Y_MAX.toFixed(3)}), gapXZ max ${mxXZ.toFixed(3)} (max ${K.GAP_XZ_MAX})` };
});

check('phys:jump-gap-coupling-band', () => {
  // Two-sided on purpose. The upper side is what the mutants below prove is real;
  // the lower side catches "someone made the tower a staircase".
  const ratio = K.GAP_Y_MAX / K.MAX_JUMP_HEIGHT;
  metrics.gapYRatio = +ratio.toFixed(4);
  metrics.maxJumpHeight = +K.MAX_JUMP_HEIGHT.toFixed(4);
  const ok = ratio >= 0.35 && ratio <= 0.75;
  return { ok, detail: `GAP_Y_MAX/MAX_JUMP_HEIGHT = ${ratio.toFixed(3)} (band 0.35–0.75), jump height ${K.MAX_JUMP_HEIGHT.toFixed(3)}` };
});

check('reach:every-segment-playable', () => {
  const bad = [];
  let minClr = Infinity, maxSteps = 0, total = 0;
  for (const s of SEEDS) {
    const r = scanReachability(makeLevel(s));
    total += r.total;
    minClr = Math.min(minClr, r.minClearance);
    maxSteps = Math.max(maxSteps, ...r.segments.map((x) => x.steps));
    for (const f of r.failed) bad.push(`seed ${s} ${f.from}→${f.to} gapY=${f.gapY} gapXZ=${f.gapXZ} landedOn=${f.landedOn} steps=${f.steps}`);
  }
  metrics.reachSegments = total;
  metrics.minPeakClearance = +minClr.toFixed(4);
  metrics.maxFlightSteps = maxSteps;
  if (bad.length) {
    return { ok: false, detail: `${bad.length}/${total} segments unreachable. First few:\n      ` + bad.slice(0, 5).join('\n      ') };
  }
  return { ok: true, detail: `${total} segments, all landed. min peak clearance ${minClr.toFixed(3)}, longest flight ${maxSteps} steps of ${600} cap` };
});

check('reach:mutants-turn-it-red', () => {
  const mutants = [
    ['gapY = 1.05× jump height', { gapYMin: K.MAX_JUMP_HEIGHT * 1.05, gapYMax: K.MAX_JUMP_HEIGHT * 1.05 }, null],
    ['gapXZ = 6.0 (beyond air time)', { gapXZMin: 6, gapXZMax: 6 }, null],
    ['MOVE_SPEED = 2.0', {}, { MOVE_SPEED: 2 }],
    ['JUMP_V = 6.0', {}, { JUMP_V: 6 }],
  ];
  const green = [];
  for (const [name, lv, ph] of mutants) {
    const r = scanReachability(makeLevel(K.DEFAULT_SEED, lv), ph);
    if (r.failed.length === 0) green.push(name);
  }
  metrics.mutantsRed = `${mutants.length - green.length}/${mutants.length}`;
  return green.length === 0
    ? { ok: true, detail: `all ${mutants.length} impossible variants rejected ⇒ the scan is load-bearing, not decorative` }
    : { ok: false, detail: `these impossible variants passed: ${green.join('; ')}` };
});

check('phys:determinism', () => {
  const level = makeLevel(K.DEFAULT_SEED);
  const run = (seed) => {
    const rnd = mulberry32(seed);
    let s = makePlayer(level);
    for (let i = 0; i < 4000; i++) s = stepPlayer(s, scriptedInput(rnd), level);
    return hashState(s);
  };
  const a = run(11), b = run(11), c = run(12);
  metrics.stateHash = a;
  if (a !== b) return { ok: false, detail: `same input gave ${a} then ${b}` };
  if (a === c) return { ok: false, detail: `different input gave the same hash ${a} — the hash is constant, i.e. this check is a decoration` };
  return { ok: true, detail: `hash ${a} reproducible; different input ⇒ different hash (${c})` };
});

check('phys:stress-60k-steps-finite', () => {
  const level = makeLevel(K.DEFAULT_SEED);
  const rnd = mulberry32(4242);
  let s = makePlayer(level);
  for (let i = 0; i < 60000; i++) {
    s = stepPlayer(s, scriptedInput(rnd), level);
    if (!isFinitePlayer(s)) return { ok: false, detail: `non-finite state at step ${i}: ${JSON.stringify(s)}` };
  }
  metrics.stressFalls = s.falls;
  return { ok: true, detail: `60000 steps (${(60000 * K.FIXED_DT).toFixed(0)}s sim), finite throughout, ${s.falls} falls, best ${s.bestY.toFixed(1)}m` };
});

check('phys:terminal-velocity-clamped-and-reached', () => {
  const level = makeLevel(K.DEFAULT_SEED);
  let s = airborneAt(level, 600);
  let minVy = 0;
  for (let i = 0; i < 1200; i++) { s = stepPlayer(s, { mx: 0, mz: 0, jump: false }, level); minVy = Math.min(minVy, s.vy); }
  metrics.minVy = +minVy.toFixed(4);
  if (minVy < -K.TERMINAL_V - 1e-6) return { ok: false, detail: `vy reached ${minVy} past the ${-K.TERMINAL_V} clamp` };
  if (minVy > -K.TERMINAL_V + 1e-3) return { ok: false, detail: `vy only reached ${minVy}; the clamp was never exercised, so this check proves nothing` };
  return { ok: true, detail: `vy bottomed out at ${minVy.toFixed(4)} = clamp ${-K.TERMINAL_V} (reached AND respected)` };
});

check('phys:no-tunneling-from-300m', () => {
  const level = makeLevel(K.DEFAULT_SEED);
  let s = airborneAt(level, 300, 0, 0);   // straight above the 7×7 farm yard
  let lowest = 300;
  for (let i = 0; i < 20000 && !s.onGround; i++) { s = stepPlayer(s, { mx: 0, mz: 0, jump: false }, level); lowest = Math.min(lowest, s.y); }
  if (!s.onGround) return { ok: false, detail: 'never landed in 20000 steps' };
  if (lowest < K.FLOOR_Y) return { ok: false, detail: `passed through to ${lowest} (below FLOOR_Y ${K.FLOOR_Y})` };
  const groundTop = level.platforms[s.groundIdx].y;
  return near(s.y, groundTop, 1e-9)
    ? { ok: true, detail: `fell 300m at terminal velocity, landed exactly on platform #${s.groundIdx} top y=${groundTop} (swept top-plane test holds)` }
    : { ok: false, detail: `landed at ${s.y} but platform top is ${groundTop}` };
});

check('phys:falling-costs-you-height', () => {
  const level = makeLevel(K.DEFAULT_SEED);
  const idx = 60;
  let s = standOn(level, idx);
  const startY = s.y;
  const p = level.platforms[idx];
  // Walk straight off the edge, away from the tower's next platform.
  for (let i = 0; i < 900; i++) s = stepPlayer(s, { mx: 1, mz: 1, jump: false }, level);
  metrics.fallFromY = +startY.toFixed(2);
  metrics.fallToY = +s.y.toFixed(2);
  return s.y < startY - 1
    ? { ok: true, detail: `walked off ${startY.toFixed(1)}m → ended at ${s.y.toFixed(1)}m (lost ${(startY - s.y).toFixed(1)}m, falls=${s.falls}). No checkpoints.` }
    : { ok: false, detail: `walked off ${startY.toFixed(1)}m but ended at ${s.y.toFixed(1)}m — falling is free, the whole genre is broken` };
});

check('phys:no-double-jump', () => {
  const level = makeLevel(K.DEFAULT_SEED);
  let s = stepPlayer(makePlayer(level), { mx: 0, mz: 0, jump: true }, level);
  let prevVy = s.vy, rises = 0, peakVy = s.vy, airborne = 0;
  for (let i = 0; i < 400; i++) {
    s = stepPlayer(s, { mx: 0, mz: 0, jump: true }, level);
    // Break BEFORE counting: the landing step legitimately sets vy back to 0, and
    // counting it produced a false red on the first run. Ruler, not product.
    if (s.onGround) break;
    airborne++;
    if (s.vy > prevVy + 1e-9) rises++;
    peakVy = Math.max(peakVy, s.vy);
    prevVy = s.vy;
  }
  metrics.airborneStepsObserved = airborne;
  if (airborne < 50) return { ok: false, detail: `only ${airborne} airborne steps observed — too few for this check to mean anything` };
  return rises === 0 && peakVy <= K.JUMP_V + 1e-9
    ? { ok: true, detail: `jump held for ${airborne} airborne steps: vy never increased, peak ${peakVy.toFixed(3)} ≤ JUMP_V ${K.JUMP_V}` }
    : { ok: false, detail: `${rises} mid-air vy increases over ${airborne} steps, peak vy ${peakVy} — jump is not gated on being grounded` };
});

check('phys:species-roster-intact', () => {
  const ids = SPECIES.map((s) => s.id);
  const want = ['cow', 'chicken', 'sheep', 'pig'];
  const missing = want.filter((w) => !ids.includes(w));
  return missing.length === 0 && SPECIES.every((s) => s.name && s.body && s.spot && s.face)
    ? { ok: true, detail: `${ids.join(', ')} — each with name + 3 colours` }
    : { ok: false, detail: `missing ${missing.join(',')} or a species is missing colours` };
});

// ---------------------------------------------------------------- B. deliverable
check('build:shipped-html-matches-src', () => {
  const rebuilt = buildHtml();
  const shipped = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
  metrics.shippedBytes = shipped.length;
  if (!shipped) return { ok: false, detail: 'climber-animals.html is missing entirely' };
  return shipped === rebuilt
    ? { ok: true, detail: `byte-identical to a rebuild from src/core (${shipped.length} bytes, inlining ${INLINE_ORDER.join(' + ')})` }
    : { ok: false, detail: `STALE: shipped ${shipped.length} bytes vs rebuilt ${rebuilt.length}. Run: node tools/build.mjs` };
});

check('ship:offline-safe', () => {
  const r = scanShippedHtml(read('climber-animals.html'));
  metrics.shippedCodeBytes = r.codeBytes;
  return r.hits.length === 0
    ? { ok: true, detail: `${r.codeBytes} bytes of script contain no url / module / fetch / require ⇒ double-click over file:// is self-sufficient` }
    : { ok: false, detail: r.hits.map((h) => `${h.pattern} in ${h.where} (${h.why}) …${h.excerpt || ''}…`).join(' | ') };
});

check('ship:scanner-self-test', () => {
  const html = read('climber-animals.html');
  const bodies = scriptBodies(html);
  if (bodies.length === 0) return { ok: false, detail: 'scriptBodies() found no <script> — the whole offline scan was scanning nothing' };
  const raw = bodies.join('\n');
  const stripped = stripJsComments(raw);
  const ratio = stripped.length / raw.length;
  metrics.stripRatio = +ratio.toFixed(3);
  if (ratio < 0.4) return { ok: false, detail: `comment strip kept only ${(ratio * 100).toFixed(0)}% of the script; anything left could pass by accident` };
  if (!stripped.includes('function ')) return { ok: false, detail: 'stripped output has no "function " left — it ate the code' };
  // false-green mutant: url inside a string literal MUST be caught
  const m1 = html.replace('var BUILD_VERSION = "1.0.0";', 'var BUILD_VERSION = "1.0.0"; var cdn = "https://cdn.example.com/three.js";');
  if (scanShippedHtml(m1).hits.length === 0) return { ok: false, detail: 'mutant with a url in a string literal was NOT flagged — the offline scan is decorative' };
  // false-red mutant: url inside a comment must NOT be caught
  const m2 = html.replace('var BUILD_VERSION = "1.0.0";', '// see https://example.com/notes\nvar BUILD_VERSION = "1.0.0";');
  if (scanShippedHtml(m2).hits.length !== 0) return { ok: false, detail: 'a url mentioned only in a comment was flagged — false red, people will start deleting comments to appease it' };
  return { ok: true, detail: `strip keeps ${(ratio * 100).toFixed(0)}% of script; string-literal url caught, comment-only url ignored (both directions proven)` };
});

check('ship:browser-gate-hooks-present', () => {
  const html = read('climber-animals.html');
  const need = ['id="view"', 'id="h-cur"', 'id="h-best"', 'id="h-falls"', 'window.__game'];
  const missing = need.filter((n) => !html.includes(n));
  return missing.length === 0
    ? { ok: true, detail: `all read points the browser gate depends on exist: ${need.join(', ')}` }
    : { ok: false, detail: `missing ${missing.join(', ')} — the browser gate would fail for the wrong reason` };
});

// ---------------------------------------------------------------- C. project rules
const AGENTS_MAX_LINES = 200;
check('docs:agents-under-line-limit', () => {
  const n = read('AGENTS.md').split('\n').length;
  metrics.agentsLines = n;
  return n <= AGENTS_MAX_LINES
    ? { ok: true, detail: `${n}/${AGENTS_MAX_LINES} lines` }
    : { ok: false, detail: `${n} lines > ${AGENTS_MAX_LINES}. Compress wording or move an archive section to docs/. Do NOT raise the limit.` };
});

check('docs:claude-mirrors-agents', () => {
  const a = read('AGENTS.md'), c = read('CLAUDE.md');
  return a === c ? { ok: true, detail: 'byte-identical' } : { ok: false, detail: `differ: ${a.length} vs ${c.length} bytes` };
});

check('docs:archive-actually-split-out', () => {
  const agents = read('AGENTS.md');
  const arch = read('docs/PITFALLS.md');
  if (arch.trim().length < 400) return { ok: false, detail: `docs/PITFALLS.md is only ${arch.trim().length} chars — an empty archive passes an existence check and teaches nobody` };
  if (!agents.includes('docs/PITFALLS.md')) return { ok: false, detail: 'AGENTS.md never points at docs/PITFALLS.md, so nobody will read it' };
  const headings = arch.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
  if (headings.length < 3) return { ok: false, detail: `only ${headings.length} archive sections; expected at least 3` };
  const dup = headings.filter((h) => agents.includes(h));
  return dup.length === 0
    ? { ok: true, detail: `${headings.length} archive sections live only in docs/PITFALLS.md (no "kept a copy in both" drift)` }
    : { ok: false, detail: `these sections exist in BOTH files: ${dup.join('; ')} — that is two copies free to rot apart` };
});

check('ci:writeback-has-both-channels-and-fails-loud', () => {
  const wf = read('.github/workflows/gate.yml');
  const need = [
    ['MARKER', 'a dedupe marker'],
    ['createComment', 'PR comment path'],
    ['createCommitComment', 'commit comment path'],
    ['core.setFailed', 'a step that actually fails the job'],
    ['attest', 'a job that confirms the comment really landed'],
  ];
  const missing = need.filter(([k]) => !wf.includes(k)).map(([k, why]) => `${k} (${why})`);
  return missing.length === 0
    ? { ok: true, detail: 'PR + commit writeback, marker dedupe, loud failure, and a delivery attest job all present' }
    : { ok: false, detail: `workflow missing: ${missing.join(', ')}` };
});

// ---------------------------------------------------------------- summary
log('');
log('--- measured values (use these to tighten thresholds next round) ---');
for (const [k, v] of Object.entries(metrics)) log(`  ${k} = ${v}`);
log('');
const total = pass + fail;
log(`${pass}/${total} checks passed${fail ? `, ${fail} FAILED` : ''}`);

const logArg = process.argv.find((a) => a.startsWith('--log='));
if (logArg) writeFileSync(join(ROOT, logArg.slice(6)), lines.join('\n') + '\n');
process.exit(fail ? 1 : 0);
