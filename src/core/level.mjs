import { mulberry32 } from './rng.mjs';
import {
  GAP_Y_MIN, GAP_Y_MAX, GAP_XZ_MIN, GAP_XZ_MAX,
  PLATFORM_COUNT, REST_EVERY, DEFAULT_SEED,
} from './constants.mjs';

/**
 * How far you can WALK from the centre of a box along (dx,dz) before your feet
 * leave it: the ray-box exit distance. THE one measure of horizontal distance in
 * this game, used for placement, for the reachability scan's launch point, and by
 * the browser autopilot.
 *
 * It replaced a projection width (`(w/2)|dx| + (d/2)|dz|`) that was doing both
 * jobs badly. For two boxes whose ray exit picks the same world axis -- which is
 * every same-ish-aspect pair, including all of this level's -- the sum of their
 * ray exits IS the exact touching distance on that axis, so `rayExit + gap +
 * rayExit` separates them correctly AND makes `gap` the real walkable gap. The
 * projection width is strictly larger on diagonals, so using it inflated the true
 * gap by up to 2.9 units on the 26-unit farmyard: far past anything the jump arc
 * was tuned for. See docs/PITFALLS.md.
 */
export function rayExitXZ(w, d, dx, dz) {
  const ax = Math.abs(dx), az = Math.abs(dz);
  const tx = ax > 1e-9 ? (w / 2) / ax : Infinity;
  const tz = az > 1e-9 ? (d / 2) / az : Infinity;
  return Math.min(tx, tz);
}

// The farmyard you spawn on. Big enough to read as a place rather than a pad,
// which also means the tower's first platform is generated ~half its width out,
// so you walk across the farm to reach the base. GROUND_SIZE is coupled to that
// walk: the reachability scan launches hop 0 from the ground's ray exit.
export const GROUND_SIZE = 26;

// kind -> [minSize, maxSize, minThickness, maxThickness, colour]
const KINDS = {
  ground:     [GROUND_SIZE, GROUND_SIZE, 0.8, 0.8, '#8fc866'],
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
 * Scenery. NOT collidable and never consulted by stepPlayer -- the physics loop
 * only ever iterates level.platforms. `decor:does-not-affect-physics` proves it
 * by hashing a long run with and without decor and requiring the hashes match,
 * plus a discrimination case where decor IS made collidable and the hash moves.
 *
 * Large items are pushed into the hemisphere AWAY from the tower's first
 * platform so the barn never grows through the climbing route.
 */
function makeDecor(rnd, towerDx, towerDz) {
  const items = [];
  const half = GROUND_SIZE / 2;
  // `add` takes the height and derives the TOP, because a box hangs DOWN from
  // its y. Passing y = 0 for something standing on the ground buries it: the
  // first version of this function did exactly that and every tree, fence and
  // barn ended up underground. See docs/PITFALLS.md.
  const add = (kind, x, z, w, h, d, color, base) =>
    items.push({ kind, x, y: (base || 0) + h, z, w, h, d, color, base: base || 0 });

  // Away-direction, used as the anchor for the big buildings.
  const ax = -towerDx, az = -towerDz;
  const px = -az, pz = ax;             // perpendicular, for spreading them out

  // Everything tall lives on the RIM, and the wedge the tower climbs through is
  // skipped, so the middle of the yard and the walk-out lane stay clear. Decor is
  // scenery you can walk through -- keeping it out of the route is what stops that
  // from being noticeable. `decor:walk-out-lane-is-clear` holds the line.
  // barn: body, roof slab sitting on top of it, and a pale door
  const bx = ax * (half - 3.4) + px * 2.6;
  const bz = az * (half - 3.4) + pz * 2.6;
  add('barn', bx, bz, 6.4, 4.2, 5.0, '#b5433a');
  add('barnroof', bx, bz, 7.0, 1.3, 5.6, '#7d2f2a', 4.2);
  add('barndoor', bx - ax * 2.4, bz - az * 2.4, 1.9, 2.7, 1.9, '#e8d9bb');

  // silo beside it, with a cap
  const sx = ax * (half - 2.6) - px * 5.0;
  const sz = az * (half - 2.6) - pz * 5.0;
  add('silo', sx, sz, 2.6, 7.0, 2.6, '#ded3bd');
  add('silocap', sx, sz, 2.9, 0.9, 2.9, '#9aa3ab', 7.0);

  // windmill on the far side, blades as a simple cross
  const wx = ax * (half - 2.2) + px * 8.8;
  const wz = az * (half - 2.2) + pz * 8.8;
  add('milltower', wx, wz, 1.5, 7.5, 1.5, '#f3e6c8');
  add('millblade', wx, wz, 6.4, 0.32, 0.55, '#d8b26a', 7.2);
  add('millblade', wx, wz, 0.55, 3.0, 0.32, '#d8b26a', 5.6);

  // pond sits almost flush, trough and hay stand on the grass
  add('pond', px * 8.0 - ax * 3.0, pz * 8.0 - az * 3.0, 5.4, 0.08, 4.0, '#5aa9d6');
  add('trough', px * 5.4 + ax * 6.6, pz * 5.4 + az * 6.6, 2.4, 0.55, 1.0, '#9aa3ab');
  // Haystacks are the only scenery scattered at random, so they are the only
  // scenery that can wander into the walk-out lane. Four of six seeds put one
  // there before this skip existed. Draw a new angle instead of nudging the
  // radius: nudging would just make it graze the lane at a different distance.
  for (let i = 0, tries = 0; i < 5 && tries < 60; tries++) {
    const a = rnd() * Math.PI * 2;
    const dxh = Math.cos(a), dzh = Math.sin(a);
    if (dxh * towerDx + dzh * towerDz > 0.40) continue;
    const r = 6.0 + rnd() * (half - 8.5);
    add('haystack', dxh * r, dzh * r,
      1.5 + rnd() * 0.6, 1.0 + rnd() * 0.4, 1.5 + rnd() * 0.6, '#e0b962');
    i++;
  }

  // trees around the rim, skipping the wedge the tower climbs through
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + rnd() * 0.2;
    const dx = Math.cos(a), dz = Math.sin(a);
    if (dx * towerDx + dz * towerDz > 0.55) continue;   // keep the route clear
    const r = half - 1.4 - rnd() * 1.6;
    const tx = dx * r, tz = dz * r;
    const th = 1.6 + rnd() * 0.9;
    add('trunk', tx, tz, 0.5, th, 0.5, '#6b4a2f');
    add('crown', tx, tz, 1.9 + rnd() * 0.7, 1.7 + rnd() * 0.6, 1.9 + rnd() * 0.7, '#4f9a52', th);
  }

  // fence posts + rails along the rim, same wedge skipped so you can walk out
  const N = 30;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    if (dx * towerDx + dz * towerDz > 0.62) continue;
    const r = half - 0.6;
    add('post', dx * r, dz * r, 0.2, 1.05, 0.2, '#efe7d6');
    add('rail', dx * r, dz * r, Math.abs(dz) * 1.9 + 0.16, 0.13, Math.abs(dx) * 1.9 + 0.16, '#efe7d6', 0.62);
  }
  return items;
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
    // Edge to edge, in walkable units: `gapXZ` is now literally the distance the
    // player must cross, not a number inflated by box diagonals.
    const dist = rayExitXZ(prev.w, prev.d, dx, dz) + rayExitXZ(w, d, dx, dz) + gapXZ;

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
  // Direction the tower leaves the farmyard in, so decor can dodge it.
  const p1 = platforms[1] || { x: 1, z: 0 };
  const tl = Math.hypot(p1.x, p1.z) || 1;

  return {
    seed,
    platforms,
    decor: makeDecor(rnd, p1.x / tl, p1.z / tl),
    spawn: { x: 0, y: 0, z: 0 },
    topY: top.y,
    topIndex: top.i,
  };
}
