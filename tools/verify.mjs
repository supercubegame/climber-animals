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
import { makeLevel, rayExitXZ, GROUND_SIZE } from '../src/core/level.mjs';
import * as CAM from '../src/core/camera.mjs';
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

/**
 * The formula that used to do BOTH jobs in the level generator and got both
 * wrong: an axis-aligned box's projection width along a direction. It is not
 * exported by the core any more -- it lives here purely as a negative control, so
 * two checks can prove they would still catch the bug they were written for.
 */
const legacyProjectionWidth = (w, d, dx, dz) => (w / 2) * Math.abs(dx) + (d / 2) * Math.abs(dz);

/** Real AABB separation: two boxes miss if they are apart on x OR on z. */
function aabbSlack(a, b) {
  return Math.max(Math.abs(b.x - a.x) - (a.w + b.w) / 2, Math.abs(b.z - a.z) - (a.d + b.d) / 2);
}

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
  // Real AABB separation, not a projection width. The old version of this check
  // shared its formula with the placement code, so the two agreed with each other
  // and neither was compared against reality -- a tautology, not a test.
  let worst = Infinity, worstAt = '';
  for (const s of SEEDS) {
    const ps = makeLevel(s).platforms;
    for (let i = 1; i < ps.length; i++) {
      const slack = aabbSlack(ps[i - 1], ps[i]);
      if (slack < worst) { worst = slack; worstAt = `seed ${s} #${i}`; }
    }
  }
  metrics.minAabbSlack = +worst.toFixed(4);
  // Discrimination: two boxes that genuinely overlap must be caught.
  const overlapping = aabbSlack({ x: 0, z: 0, w: 4, d: 4 }, { x: 1, z: 1, w: 4, d: 4 });
  if (overlapping > 0) return { ok: false, detail: `aabbSlack says two clearly overlapping boxes are ${overlapping} apart — the test is broken` };
  return worst > 0.05
    ? { ok: true, detail: `min AABB slack ${worst.toFixed(3)} at ${worstAt}; a deliberately overlapping pair scores ${overlapping.toFixed(2)} (caught)` }
    : { ok: false, detail: `platforms touch or overlap: slack ${worst.toFixed(4)} at ${worstAt}` };
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

check('reach:launch-point-is-standable', () => {
  // The scan launches every hop from the far edge of the platform. If that point
  // is not actually ON the platform, the scan has been measuring hops that start
  // in mid-air, closer to the target than any player could get. It did exactly
  // that until 2026-09-04: a projection width was used where the ray-box exit
  // distance was needed.
  let off = 0, total = 0;
  for (const sd of SEEDS) {
    for (const seg of scanReachability(makeLevel(sd)).segments) {
      const L = seg.launch;
      total++;
      if (Math.abs(L.dx * L.offset) > L.hw + 1e-9 || Math.abs(L.dz * L.offset) > L.hd + 1e-9) off++;
    }
  }
  // Discrimination test: the old formula must be caught by this very check,
  // otherwise it is not measuring anything.
  const ref = scanReachability(makeLevel(K.DEFAULT_SEED)).segments;
  let wouldCatch = 0;
  for (const seg of ref) {
    const L = seg.launch;
    const alt = legacyProjectionWidth(L.hw * 2, L.hd * 2, L.dx, L.dz);
    if (Math.abs(L.dx * alt) > L.hw + 1e-9 || Math.abs(L.dz * alt) > L.hd + 1e-9) wouldCatch++;
  }
  metrics.offPlatformLaunches = off;
  metrics.oldFormulaWouldBeCaught = `${wouldCatch}/${ref.length}`;
  if (off > 0) return { ok: false, detail: `${off}/${total} hops launch from a point outside the platform footprint` };
  if (wouldCatch === 0) return { ok: false, detail: 'this check cannot even catch the projection-width bug it exists for — it is vacuous' };
  return { ok: true, detail: `${total} launch points all within the platform footprint; the old projection-width formula would be caught on ${wouldCatch}/${ref.length} of them` };
});

check('geom:rayexit-is-not-the-old-projection-width', () => {
  // Guards against someone "simplifying" rayExitXZ back into the formula it
  // replaced. First draft of this check compared a 7x7 box at exactly 45 degrees
  // and printed 4.950 vs 4.950: on a square at 45 degrees the two genuinely
  // coincide, so of every angle available it picked the one that proves nothing.
  let worstGap = 0, worstAt = '';
  for (let deg = 0; deg <= 90; deg += 1) {
    const rad = (deg * Math.PI) / 180;
    const dx = Math.sin(rad), dz = Math.cos(rad);
    for (const [w, d] of [[26, 26], [7, 7], [6, 2], [2.2, 1.7], [3.4, 3.2]]) {
      const legacy = legacyProjectionWidth(w, d, dx, dz), r = rayExitXZ(w, d, dx, dz);
      if (r > legacy + 1e-9) return { ok: false, detail: `rayExit ${r} > projection width ${legacy} on ${w}x${d} at ${deg}deg — impossible` };
      if (legacy - r > worstGap) { worstGap = legacy - r; worstAt = `${w}x${d} at ${deg}deg (${legacy.toFixed(2)} vs ${r.toFixed(2)})`; }
    }
  }
  const ae = legacyProjectionWidth(26, 26, 1, 0), ar = rayExitXZ(26, 26, 1, 0);
  metrics.worstLegacyVsRayGap = +worstGap.toFixed(3);
  if (Math.abs(ae - ar) > 1e-9) return { ok: false, detail: `axis-aligned they must agree, got ${ae} vs ${ar}` };
  if (worstGap < 0.3) return { ok: false, detail: `they never diverge by more than ${worstGap.toFixed(3)} across the sweep — rayExitXZ has been collapsed back into the old formula` };
  return { ok: true, detail: `swept 91 angles x 5 box shapes: agree on axis (${ae}), diverge by up to ${worstGap.toFixed(2)} at ${worstAt}` };
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
  let s = airborneAt(level, 300, 0, 0);   // straight above the middle of the farmyard
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

// ---------------------------------------------------------------- A2. camera
// v1.0 shipped with the pitch rotation inverted. Nothing could catch it because
// the maths lived in the shell, untestable; a comment claimed it was "derived,
// not guessed". These checks exist so that class of bug cannot ship again.
const VIEWPORTS = [[1280, 800], [1048, 852], [1920, 1080], [800, 600], [420, 900]];
const YAWS = [0, 0.6, 1.9, 3.4, -1.2, 5.9];
const PITCHES = [CAM.CAM_PITCH_MIN, 0.12, CAM.CAM_PITCH_DEFAULT, 0.7, CAM.CAM_PITCH_MAX];

/** The inverted-pitch transform that shipped in v1.0, as a negative control. */
function brokenToCameraSpace(px, py, pz, eye, yaw, pitch, out) {
  const dx = px - eye.x, dy = py - eye.y, dz = pz - eye.z;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = dx * cy - dz * sy, z1 = dx * sy + dz * cy;
  const cpp = Math.cos(pitch), spp = Math.sin(pitch);
  out[0] = x1; out[1] = dy * cpp - z1 * spp; out[2] = dy * spp + z1 * cpp;
  return out;
}

check('camera:target-lands-dead-centre', () => {
  const out = [0, 0, 0];
  let worst = 0, worstAt = '';
  let n = 0;
  for (const [w, h] of VIEWPORTS) {
    for (const yaw of YAWS) {
      for (const pitch of PITCHES) {
        for (const dist of [CAM.CAM_DIST_MIN, CAM.CAM_DIST_DEFAULT, CAM.CAM_DIST_MAX]) {
          const v = CAM.makeView(3.5, 21.25, -8.25, yaw, pitch, dist, w, h);
          if (!CAM.projectPoint(v.target.x, v.target.y, v.target.z, v, out)) {
            return { ok: false, detail: `target behind the near plane at yaw ${yaw} pitch ${pitch} dist ${dist}` };
          }
          const err = Math.max(Math.abs(out[0] - w / 2), Math.abs(out[1] - h / 2), Math.abs(out[2] - dist));
          if (err > worst) { worst = err; worstAt = `${w}x${h} yaw ${yaw} pitch ${pitch} dist ${dist}`; }
          n++;
        }
      }
    }
  }
  metrics.camCentreErrPx = +worst.toExponential(2);
  metrics.camCasesChecked = n;
  if (worst > 1e-9) return { ok: false, detail: `target drifted ${worst} px from centre at ${worstAt}` };

  // Negative control: the v1.0 transform must fail this, and at the default view
  // it must miss the viewport entirely.
  const v = CAM.makeView(0, 0, 0, 0.6, CAM.CAM_PITCH_DEFAULT, CAM.CAM_DIST_DEFAULT, 1048, 852);
  const b = [0, 0, 0];
  brokenToCameraSpace(v.target.x, v.target.y, v.target.z, v.eye, v.yaw, v.pitch, b);
  const by = 852 / 2 - (b[1] * v.focal) / b[2];
  metrics.v1AimPixelY = +by.toFixed(1);
  if (Math.abs(by - 426) < 1) return { ok: false, detail: 'the inverted-pitch transform also centres the target — this check cannot see the bug it exists for' };
  return { ok: true, detail: `${n} view combinations, max centre error ${worst.toExponential(1)}px and depth == dist. The v1.0 transform puts the aim point at y=${by.toFixed(0)} on an 852px viewport (${(by - 852).toFixed(0)}px past the bottom edge), so it is caught.` };
});

check('camera:animal-fits-on-screen', () => {
  // A bounding box around the animal, generous enough to include ears and snout.
  const AW = 0.9, AH = 1.35, AD = 0.9;
  const out = [0, 0, 0];
  let worstMargin = Infinity, worstAt = '';
  const level = makeLevel(K.DEFAULT_SEED);
  const spots = [level.platforms[0], level.platforms[1], level.platforms[37], level.platforms[level.topIndex]];
  for (const [w, h] of VIEWPORTS) {
    for (const p of spots) {
      for (const pitch of PITCHES) {
        const v = CAM.makeView(p.x, p.y, p.z, 0.6, pitch, CAM.CAM_DIST_DEFAULT, w, h);
        for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
          if (!CAM.projectPoint(p.x + sx * AW / 2, p.y + sy * AH, p.z + sz * AD / 2, v, out)) {
            return { ok: false, detail: `an animal corner fell behind the near plane on platform ${p.i} at pitch ${pitch}` };
          }
          const m = Math.min(out[0], w - out[0], out[1], h - out[1]);
          if (m < worstMargin) { worstMargin = m; worstAt = `${w}x${h} platform ${p.i} pitch ${pitch}`; }
        }
      }
    }
  }
  metrics.animalEdgeMarginPx = +worstMargin.toFixed(1);
  return worstMargin > 40
    ? { ok: true, detail: `across ${VIEWPORTS.length} viewports x ${spots.length} spots x ${PITCHES.length} pitches, the animal's box stays at least ${worstMargin.toFixed(0)}px inside every edge (tightest: ${worstAt})` }
    : { ok: false, detail: `animal only ${worstMargin.toFixed(0)}px from a screen edge at ${worstAt}` };
});

check('render:near-plane-clip-keeps-the-farmyard', () => {
  // The farmyard's near corners sit behind the eye at spawn. v1.0 dropped any box
  // with a corner behind the camera, so the entire ground vanished and the animal
  // appeared to float in the sky. Small platforms never tripped it.
  const level = makeLevel(K.DEFAULT_SEED);
  const g = level.platforms[0];
  let worst = 1;
  for (const [w, h] of VIEWPORTS) {
    for (const pitch of PITCHES) {
      const v = CAM.makeView(0, 0, 0, 0.6, pitch, CAM.CAM_DIST_DEFAULT, w, h);
      worst = Math.min(worst, CAM.screenCoverage(CAM.boxScreenFaces(g.x, g.y, g.z, g.w, g.h, g.d, v), w, h));
    }
  }
  metrics.groundCoverageMin = +(worst * 100).toFixed(1);

  // Negative control: the all-or-nothing rule v1.0 used.
  const v = CAM.makeView(0, 0, 0, 0.6, CAM.CAM_PITCH_DEFAULT, CAM.CAM_DIST_DEFAULT, 1280, 800);
  const out = [0, 0, 0];
  let allCornersInFront = true;
  for (const c of CAM.BOX_CORNERS) {
    if (!CAM.projectPoint(c[0] * g.w / 2, g.y + c[1] * g.h, c[2] * g.d / 2, v, out)) allCornersInFront = false;
  }
  if (allCornersInFront) return { ok: false, detail: 'every farmyard corner is in front of the camera, so this check no longer exercises near-plane clipping at all' };
  return worst > 0.20
    ? { ok: true, detail: `farmyard covers at least ${(worst * 100).toFixed(0)}% of the viewport across every tested view; v1.0's drop-if-any-corner-behind rule would have discarded it entirely (it has corners behind the eye)` }
    : { ok: false, detail: `farmyard covers only ${(worst * 100).toFixed(1)}% of the viewport at worst — you are standing on something you cannot see` };
});

check('render:clipper-self-test', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  if (Math.abs(CAM.polygonArea(sq) - 100) > 1e-9) return { ok: false, detail: `area of a 10x10 square came out as ${CAM.polygonArea(sq)}` };
  if (Math.abs(CAM.polygonArea(CAM.clipToRect(sq, 5, 5)) - 25) > 1e-9) return { ok: false, detail: 'clipping a 10x10 square to a 5x5 rect did not give 25' };
  if (CAM.clipToRect([[-9, -9], [-5, -9], [-5, -5]], 100, 100).length !== 0) return { ok: false, detail: 'a fully off-screen polygon survived rect clipping' };
  const front = [[0, 0, 5], [1, 0, 5], [1, 1, 5]];
  if (CAM.clipNearZ(front).length !== 3) return { ok: false, detail: 'a polygon fully in front of the near plane was altered' };
  if (CAM.clipNearZ([[0, 0, -5], [1, 0, -5], [1, 1, -5]]).length !== 0) return { ok: false, detail: 'a polygon fully behind the camera survived clipping' };
  const strad = CAM.clipNearZ([[0, 0, -3], [4, 0, 5], [4, 4, 5], [0, 4, -3]]);
  if (strad.length < 3) return { ok: false, detail: 'a straddling polygon was thrown away instead of clipped' };
  for (const v of strad) if (v[2] < CAM.NEAR_Z - 1e-12) return { ok: false, detail: `clipped polygon still has a vertex at z=${v[2]}, behind the near plane ${CAM.NEAR_Z}` };
  if (!(CAM.polygonArea(strad.map((v) => [v[0], v[1]])) > 0)) return { ok: false, detail: 'clipped straddling polygon has zero area' };
  return { ok: true, detail: `areas exact, off-screen -> empty, fully-behind -> empty, straddling -> ${strad.length} vertices all at z >= ${CAM.NEAR_Z}` };
});

// ---------------------------------------------------------------- A3. decor
check('decor:nothing-buried-and-nothing-floating', () => {
  // A box hangs DOWN from its y, so scenery standing on the ground needs
  // y = its own height. The first version passed y = 0 and buried every tree,
  // fence and barn under the farmyard. Cheap check, whole class of bug.
  let worstBelow = 0, worstAbove = 0, whichB = '', whichA = '', total = 0;
  for (const sd of SEEDS) {
    for (const d of makeLevel(sd).decor) {
      total++;
      const bottom = d.y - d.h;
      if (bottom < -worstBelow) { worstBelow = -bottom; whichB = `${d.kind} seed ${sd}`; }
      if (d.base === 0 && bottom > worstAbove) { worstAbove = bottom; whichA = `${d.kind} seed ${sd}`; }
    }
  }
  metrics.decorItems = total;
  metrics.decorWorstBelowGround = +worstBelow.toFixed(4);
  if (worstBelow > 1e-9) return { ok: false, detail: `${whichB} sinks ${worstBelow.toFixed(2)} below the farmyard — its y is being used as a base instead of a top` };
  if (worstAbove > 1e-9) return { ok: false, detail: `${whichA} floats ${worstAbove.toFixed(2)} above the ground` };
  return { ok: true, detail: `${total} scenery boxes across ${SEEDS.length} seeds: every ground-level item rests exactly on y=0, nothing buried, nothing hovering` };
});

check('decor:does-not-affect-physics', () => {
  // Scenery is walk-through. Proven behaviourally, not by reading the code: run
  // the same scripted 12000 steps on the real level and on one with decor
  // stripped, and require identical state hashes.
  const run = (level) => {
    const rnd = mulberry32(31337);
    let s = makePlayer(level);
    for (let i = 0; i < 12000; i++) s = stepPlayer(s, scriptedInput(rnd), level);
    return hashState(s);
  };
  const real = makeLevel(K.DEFAULT_SEED);
  const stripped = { ...real, decor: [] };
  const a = run(real), b = run(stripped);
  if (a !== b) return { ok: false, detail: `decor changed the outcome: ${a} vs ${b} — something in the physics is reading level.decor` };

  // Discrimination: if the same boxes WERE collidable, the run must diverge.
  // Without this, the check would also pass on a build that ignored geometry.
  const collidable = {
    ...real,
    platforms: real.platforms.concat(real.decor.map((d, i) => ({ ...d, i: real.platforms.length + i, gapY: 0, gapXZ: 0, label: '' }))),
  };
  const c = run(collidable);
  if (c === a) return { ok: false, detail: 'making every scenery box collidable produced an identical run — this check cannot tell collidable geometry from scenery, so it proves nothing' };
  metrics.decorPhysicsHash = a;
  return { ok: true, detail: `12000 scripted steps: hash ${a} with and without ${real.decor.length} scenery boxes; promoting them to platforms changes it to ${c}, so the test really can see collision` };
});

check('decor:walk-out-lane-is-clear', () => {
  // You spawn in the middle of the yard and walk out to the tower. Scenery is
  // walk-through, so the one place it must never sit is that lane -- walking
  // through a barn is the kind of thing that reads as a broken game.
  let worst = Infinity, worstAt = '';
  for (const sd of SEEDS) {
    const L = makeLevel(sd);
    const p1 = L.platforms[1];
    const tl = Math.hypot(p1.x, p1.z) || 1;
    const dx = p1.x / tl, dz = p1.z / tl;
    const exit = rayExitXZ(GROUND_SIZE, GROUND_SIZE, dx, dz);
    for (const d of L.decor) {
      const along = d.x * dx + d.z * dz;
      if (along < -1.5 || along > exit + 2) continue;          // not in the lane's span
      const lateral = Math.abs(-d.x * dz + d.z * dx) - Math.max(d.w, d.d) / 2;
      if (lateral < worst) { worst = lateral; worstAt = `${d.kind} on seed ${sd}`; }
    }
  }
  metrics.walkLaneClearance = +worst.toFixed(3);
  return worst > 1.5
    ? { ok: true, detail: `narrowest scenery clearance beside the spawn-to-tower lane is ${worst.toFixed(2)} units (${worstAt}); the lane is walkable without clipping through anything` }
    : { ok: false, detail: `${worstAt} sits ${worst.toFixed(2)} units from the walk-out lane — you would walk through it` };
});

check('level:farmyard-is-a-place', () => {
  const L = makeLevel(K.DEFAULT_SEED);
  const g = L.platforms[0];
  // Straight-line walk from spawn to the rim, in the direction the tower goes.
  const p1 = L.platforms[1];
  const tl = Math.hypot(p1.x, p1.z) || 1;
  const walk = rayExitXZ(g.w, g.d, p1.x / tl, p1.z / tl);
  metrics.groundSize = g.w;
  metrics.walkToRim = +walk.toFixed(2);
  if (g.w !== GROUND_SIZE || g.d !== GROUND_SIZE) return { ok: false, detail: `farmyard is ${g.w}x${g.d}, expected ${GROUND_SIZE}` };
  if (g.y !== 0) return { ok: false, detail: `farmyard top is at y=${g.y}, spawn assumes 0` };
  return walk > 8
    ? { ok: true, detail: `${g.w}x${g.d} at y=0; ${walk.toFixed(1)} units of walking from spawn to the rim before the first jump` }
    : { ok: false, detail: `only ${walk.toFixed(1)} units from spawn to the rim — that is a pad, not a farmyard` };
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
  // Mutants are injected at a STRUCTURAL anchor, not at a version literal. The
  // first version keyed off `var BUILD_VERSION = "1.0.0";`, so bumping to 2.0.0
  // turned both replaces into no-ops and the "mutant" became a copy of the
  // original. It went red rather than green, which is luck, not design -- hence
  // the identity guard below. Every mutant must prove it changed something.
  const inject = (code) => html.replace('</script>', code + '\n</script>');
  const m1 = inject('var cdn = "https://cdn.example.com/three.js";');
  const m2 = inject('// see https://example.com/notes');
  if (m1 === html || m2 === html) {
    return { ok: false, detail: 'mutant came out identical to the original — the injection anchor went stale, so this check was testing nothing' };
  }
  if (scanShippedHtml(m1).hits.length === 0) return { ok: false, detail: 'mutant with a url in a string literal was NOT flagged — the offline scan is decorative' };
  if (scanShippedHtml(m2).hits.length !== 0) return { ok: false, detail: 'a url mentioned only in a comment was flagged — false red, people will start deleting comments to appease it' };
  return { ok: true, detail: `strip keeps ${(ratio * 100).toFixed(0)}% of script; string-literal url caught, comment-only url ignored (both directions proven)` };
});

check('ship:shell-does-not-borrow-core-scratch', () => {
  // The build inlines the core into one file, which makes the core's private
  // scratch vectors reachable from shell code. Borrowing `_v` works right up
  // until something projects a point between the write and the read, and then it
  // fails as a rendering glitch with no obvious cause.
  //
  // Comments are stripped FIRST. The first version of this check searched raw
  // text and flagged the sentence above, which mentions `_v` while explaining not
  // to use it. Strip in the scanner; never contort the prose to please a scan.
  const shell = read('src/shell/template.html');
  const raw = shell.slice(shell.indexOf('END PURE CORE'));
  const body = stripJsComments(raw);
  if (body.length < raw.length * 0.4 || !body.includes('function drawBox')) {
    return { ok: false, detail: `comment strip left ${body.length} of ${raw.length} bytes and lost drawBox — it ate the code, so any pass here is meaningless` };
  }
  const find = (name) => body.match(new RegExp('(?<![\\w$])' + name + '(?![\\w$])', 'g'));
  const hits = [];
  for (const name of ['_v', '_corner']) {
    const m = find(name);
    if (m) hits.push(`${name} x${m.length}`);
  }
  // Discrimination: plant a real reference in CODE and require it to be found.
  const planted = stripJsComments(raw.replace('var order = [];', 'var order = []; toCam(0,0,0,_v);'));
  if (!/(?<![\w$])_v(?![\w$])/.test(planted)) {
    return { ok: false, detail: 'a planted _v reference in real code was not detected — the scan is vacuous' };
  }
  metrics.shellStripRatio = +(body.length / raw.length).toFixed(3);
  return hits.length === 0
    ? { ok: true, detail: `shell code references none of the core's private scratch vectors; a planted reference IS detected, and the strip kept ${(100 * body.length / raw.length).toFixed(0)}% of the shell` }
    : { ok: false, detail: `shell borrows core-private scratch: ${hits.join(', ')} — give the shell its own buffer` };
});

check('ship:browser-gate-hooks-present', () => {
  const html = read('climber-animals.html');
  const need = ['id="view"', 'id="h-cur"', 'id="h-best"', 'id="h-falls"', 'id="lock"',
    'window.__game', 'get camYaw', 'get camPitch', 'nav: function', 'aimPixel: function',
    'requestPointerLock', 'pointerlockchange'];
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
