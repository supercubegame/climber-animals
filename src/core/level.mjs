import { mulberry32 } from './rng.mjs';
import {
  GAP_Y_MIN, GAP_Y_MAX, GAP_XZ_MIN, GAP_XZ_MAX,
  PLATFORM_COUNT, REST_EVERY, DEFAULT_SEED,
} from './constants.mjs';

// Support function of an axis-aligned box along a unit direction. Exact, so the
// centre-line edge gap between two consecutive platforms is exactly `gapXZ`
// (separating axis theorem), never a diagonal surprise. Getting this wrong is
// how you end up with platforms that silently overlap and a "climb" you can walk.
export function extentAlong(w, d, dx, dz) {
  return (w / 2) * Math.abs(dx) + (d / 2) * Math.abs(dz);
}

/**
 * How far you can actually WALK from the centre of a platform along (dx,dz)
 * before your feet leave it: the ray-box exit distance.
 *
 * This is NOT extentAlong(). On a 7x7 pad heading 20 degrees off axis the
 * projection width says 4.49 while the ray exits at 3.72, and the reachability
 * scan used to launch every hop from the projection width -- i.e. from a point
 * outside the pad, hanging in mid-air, closer to the target than any player can
 * stand. Use extentAlong for SEPARATION, this for STANDING ROOM.
 *
 * They coincide on axis AND at exactly 45 degrees on a square, so never sanity
 * check the pair with a single angle. Worst divergence found by sweeping: 1.41
 * on a 6x2 box at 45 degrees.
 */
export function rayExitXZ(w, d, dx, dz) {
  const ax = Math.abs(dx), az = Math.abs(dz);
  const tx = ax > 1e-9 ? (w / 2) / ax : Infinity;
  const tz = az > 1e-9 ? (d / 2) / az : Infinity;
  return Math.min(tx, tz);
}

// kind -> [minSize, maxSize, minThickness, maxThickness, colour]
const KINDS = {
  ground:     [7.0, 7.0, 0.8, 0.8, '#8fc866'],
  hay:        [1.7, 2.6, 0.7, 1.1, '#e0b962'],
  crate:      [1.6, 2.2, 0.7, 1.0, '#b3773d'],
  barrel:     [1.6, 2.0, 0.9, 1.3, '#c2543f'],
  trough:     [1.8, 2.8, 0.4, 0.6, '#9aa3ab'],
  pumpkin:    [1.6, 2.1, 0.8, 1.0, '#e58330'],
  cabbage:    [1.6, 2.0, 0.6, 0.9, '#7fc06a'],
  milkcan:    [1.6, 1.9, 1.0, 1.4, '#d4dbe0'],
  fence:      [2.2, 3.0, 0.3, 0.4, '#f2ece0'],
  cloud:      [2.2, 3.0, 0.5, 0.8, '#ffffff'],
  kite:       [1.7, 2.2, 0.3, 0.4, '#f2749a'],
  // landmarks (rest platforms)
  silo:       [3.2, 3.4, 1.6, 2.2, '#cf5a44'],
  windmill:   [3.2, 3.4, 1.2, 1.6, '#f3e6c8'],
  watertower: [3.2, 3.4, 1.4, 1.8, '#6aa9d6'],
  barnroof:   [3.3, 3.4, 1.0, 1.4, '#9e3b2f'],
};

const GROUND_KINDS = ['hay', 'crate', 'barrel', 'trough', 'pumpkin', 'cabbage', 'milkcan', 'fence'];
const SKY_KINDS = ['cloud', 'kite', 'fence', 'hay'];
const LANDMARKS = ['silo', 'windmill', 'watertower', 'barnroof'];

// Height at which the farmyard gives way to the sky section.
export const SKY_Y = 42;

function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length) % arr.length];
}

/**
 * Pure. makeLevel(seed) is fully determined by seed; no Date, no Math.random.
 * `opts` exists only so the gate can build deliberately broken levels (mutants)
 * and prove the reachability scan turns red. Never pass opts from the shell.
 */
export function makeLevel(seed = DEFAULT_SEED, opts = {}) {
  const gapYMin = opts.gapYMin ?? GAP_Y_MIN;
  const gapYMax = opts.gapYMax ?? GAP_Y_MAX;
  const gapXZMin = opts.gapXZMin ?? GAP_XZ_MIN;
  const gapXZMax = opts.gapXZMax ?? GAP_XZ_MAX;
  const count = opts.count ?? PLATFORM_COUNT;

  const rnd = mulberry32(seed);
  const platforms = [];

  const g = KINDS.ground;
  platforms.push({
    i: 0, kind: 'ground', color: g[4],
    x: 0, y: 0, z: 0, w: g[0], d: g[1], h: g[2],
    gapY: 0, gapXZ: 0, label: 'Farm Yard',
  });

  let angle = rnd() * Math.PI * 2;

  for (let i = 1; i <= count; i++) {
    const prev = platforms[i - 1];
    const isRest = i % REST_EVERY === 0;
    const kind = isRest
      ? pick(rnd, LANDMARKS)
      : pick(rnd, prev.y > SKY_Y ? SKY_KINDS : GROUND_KINDS);
    const k = KINDS[kind];

    const w = k[0] + rnd() * (k[1] - k[0]);
    const d = k[0] + rnd() * (k[1] - k[0]);
    const h = k[2] + rnd() * (k[3] - k[2]);

    // Rest platforms are a breather: minimum vertical gap, minimum horizontal gap.
    const gapY = isRest ? gapYMin : gapYMin + rnd() * (gapYMax - gapYMin);
    const gapXZ = isRest ? gapXZMin : gapXZMin + rnd() * (gapXZMax - gapXZMin);

    // Gentle spiral. Turning too hard makes the next platform land behind the
    // camera, which reads as "the game hid the path from me".
    angle += (rnd() - 0.5) * 1.7;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const dist = extentAlong(prev.w, prev.d, dx, dz) + extentAlong(w, d, dx, dz) + gapXZ;

    platforms.push({
      i, kind, color: k[4],
      x: prev.x + dx * dist,
      y: prev.y + gapY,
      z: prev.z + dz * dist,
      w, d, h, gapY, gapXZ,
      label: isRest ? `${kind} @ ${Math.round(prev.y + gapY)}m` : '',
    });
  }

  const top = platforms[platforms.length - 1];
  return {
    seed,
    platforms,
    spawn: { x: 0, y: 0, z: 0 },
    topY: top.y,
    topIndex: top.i,
  };
}
