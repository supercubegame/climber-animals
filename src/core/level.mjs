import { mulberry32 } from './rng.mjs';
import {
  GAP_Y_MIN, GAP_Y_MAX, GAP_XZ_MIN, GAP_XZ_MAX,
  PLATFORM_COUNT, REST_EVERY, DEFAULT_SEED,
} from './constants.mjs';

/**
 * How far you can WALK from a box centre along (dx,dz) before your feet leave it:
 * the ray-box exit distance. THE one horizontal distance measure in this game.
 * It replaced a projection width that was inflating every gap by up to 2.9 units.
 */
export function rayExitXZ(w, d, dx, dz) {
  const ax = Math.abs(dx), az = Math.abs(dz);
  const tx = ax > 1e-9 ? (w / 2) / ax : Infinity;
  const tz = az > 1e-9 ? (d / 2) / az : Infinity;
  return Math.min(tx, tz);
}

// The FARMYARD FOOTPRINT: where scenery is placed and the box hop 0 launches from.
// NOT the edge of the world -- platform 0 is `infinite` and solid at every x/z.
export const GROUND_SIZE = 26;

const KINDS = {
  ground:     [GROUND_SIZE, GROUND_SIZE, 0.8, 0.8, '#87c163'],
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
  silo:       [3.2, 3.4, 1.6, 2.2, '#cf5a44'],
  windmill:   [3.2, 3.4, 1.2, 1.6, '#f3e6c8'],
  watertower: [3.2, 3.4, 1.4, 1.8, '#6aa9d6'],
  barnroof:   [3.3, 3.4, 1.0, 1.4, '#9e3b2f'],
};

const GROUND_KINDS = ['hay', 'crate', 'barrel', 'trough', 'pumpkin', 'cabbage', 'milkcan', 'fence'];
const SKY_KINDS = ['cloud', 'kite', 'fence', 'hay'];
const LANDMARKS = ['silo', 'windmill', 'watertower', 'barnroof'];

export const SKY_Y = 42;

function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length) % arr.length];
}

/**
 * Scenery. NOT collidable and never read by stepPlayer.
 *
 * Same non-nesting rule as the animals: a box buried inside another box cannot be
 * depth-sorted, so roofs sit ON walls, rails sit OUTSIDE posts, water sits INSIDE a
 * trough's rim but below its top, and every stack is built from `base` upward.
 * Buildings are assembled from tapering stacks so a roof reads as a pitch rather
 * than a lid, and a silo as a cylinder rather than a slab.
 */
function makeDecor(rnd, towerDx, towerDz) {
  const items = [];
  const half = GROUND_SIZE / 2;
  const add = (kind, x, z, w, h, d, color, base) =>
    items.push({ kind, x, y: (base || 0) + h, z, w, h, d, color, base: base || 0 });

  const ax = -towerDx, az = -towerDz;      // away from the tower
  const px = -az, pz = ax;                 // perpendicular

  // ---- BARN: walls, gambrel roof as three narrowing slabs, doors, hayloft ----
  const bx = ax * (half - 3.6) + px * 2.4;
  const bz = az * (half - 3.6) + pz * 2.4;
  add('barnWall', bx, bz, 6.6, 4.0, 5.2, '#b5433a');
  add('barnCorner', bx - ax * 3.2, bz - az * 3.2, 0.34, 4.2, 0.34, '#8e332c');
  add('barnCorner', bx + ax * 3.2, bz + az * 3.2, 0.34, 4.2, 0.34, '#8e332c');
  add('barnRoof', bx, bz, 7.2, 0.55, 5.8, '#7d2f2a', 4.0);
  add('barnRoof', bx, bz, 5.9, 0.55, 4.8, '#89342d', 4.55);
  add('barnRoof', bx, bz, 4.2, 0.55, 3.5, '#96392f', 5.10);
  add('barnRidge', bx, bz, 2.2, 0.30, 1.9, '#6d2924', 5.65);
  add('barnDoor', bx - ax * 2.66, bz - az * 2.66, 2.0, 2.8, 2.0, '#e8d9bb');
  add('barnDoorFrame', bx - ax * 2.70, bz - az * 2.70, 2.34, 0.24, 2.34, '#f4e9d2', 2.8);
  add('hayloft', bx - ax * 2.72, bz - az * 2.72, 1.0, 0.9, 1.0, '#3d2c22', 3.05);
  const chx = bx + px * 2.1, chz = bz + pz * 2.1;
  add('chimney', chx, chz, 0.72, 1.6, 0.72, '#8a4b3c', 5.20);
  add('chimneyCap', chx, chz, 0.92, 0.16, 0.92, '#6d3a2e', 6.80);
  // The smoke anchor is the top of the CAP, i.e. the highest chimney box, so the
  // plume leaves the brickwork rather than starting inside it.
  items.chimney = { x: chx, z: chz, top: 6.80 + 0.16 };

  // ---- FARMHOUSE, a separate smaller building with a pitched roof ----
  const hx = ax * (half - 4.0) - px * 7.4;
  const hz = az * (half - 4.0) - pz * 7.4;
  add('houseWall', hx, hz, 4.6, 2.9, 4.0, '#f0e2c6');
  add('housePlinth', hx, hz, 4.8, 0.28, 4.2, '#c9b795');
  add('houseRoof', hx, hz, 5.2, 0.50, 4.6, '#7a5a4a', 2.9);
  add('houseRoof', hx, hz, 4.0, 0.50, 3.5, '#875f4c', 3.40);
  add('houseRoof', hx, hz, 2.4, 0.45, 2.1, '#94674f', 3.90);
  add('houseDoor', hx - ax * 1.86, hz - az * 1.86, 0.95, 1.9, 0.95, '#6b4a2f');
  add('houseWin', hx - ax * 1.88 + px * 1.3, hz - az * 1.88 + pz * 1.3, 0.85, 0.8, 0.85, '#8fc4d8', 1.5);
  add('houseWin', hx - ax * 1.88 - px * 1.3, hz - az * 1.88 - pz * 1.3, 0.85, 0.8, 0.85, '#8fc4d8', 1.5);

  // ---- SILO: tapering stack + stepped dome, not one slab ----
  const sx = ax * (half - 2.8) - px * 4.2;
  const sz = az * (half - 2.8) - pz * 4.2;
  add('silo', sx, sz, 2.7, 3.4, 2.7, '#ded3bd');
  add('silo', sx, sz, 2.6, 3.4, 2.6, '#d6cab2', 3.4);
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    add('siloDome', sx, sz, 2.5 - t * 1.5, 0.34, 2.5 - t * 1.5, '#9aa3ab', 6.8 + i * 0.34);
  }
  for (let b = 1; b <= 3; b++) add('siloBand', sx, sz, 2.78, 0.14, 2.78, '#c3b79c', b * 1.7);

  // ---- WINDMILL: tapering tower, hub, four blades ----
  const wx = ax * (half - 2.4) + px * 8.6;
  const wz = az * (half - 2.4) + pz * 8.6;
  add('millTower', wx, wz, 1.9, 3.6, 1.9, '#f3e6c8');
  add('millTower', wx, wz, 1.5, 3.4, 1.5, '#e9dbba', 3.6);
  add('millCap', wx, wz, 1.9, 0.5, 1.9, '#8a6a4f', 7.0);
  add('millHub', wx + ax * 0.9, wz + az * 0.9, 0.5, 0.5, 0.5, '#6b4a2f', 6.3);
  for (const [bw, bh] of [[5.6, 0.34], [0.34, 5.6]]) {
    add('millBlade', wx + ax * 1.05, wz + az * 1.05,
      Math.abs(pz) * bw + Math.abs(ax) * bh + 0.3, bh === 0.34 ? 0.34 : 5.6,
      Math.abs(px) * bw + Math.abs(az) * bh + 0.3, '#d8b26a', bh === 0.34 ? 6.45 : 9.2);
  }

  // ---- POND with a raised rim so the water is not a decal on the grass ----
  const pdx = px * 8.2 - ax * 3.2, pdz = pz * 8.2 - az * 3.2;
  add('pondRim', pdx, pdz, 6.2, 0.22, 4.8, '#6f6152');
  add('pondWater', pdx, pdz, 5.4, 0.16, 4.0, '#5aa9d6', 0.02);

  // ---- TROUGH: four rim walls plus water below the rim, not a solid block ----
  const trx = px * 5.6 + ax * 6.4, trz = pz * 5.6 + az * 6.4;
  add('troughLeg', trx - px * 1.0, trz - pz * 1.0, 0.22, 0.34, 0.22, '#6b5a48');
  add('troughLeg', trx + px * 1.0, trz + pz * 1.0, 0.22, 0.34, 0.22, '#6b5a48');
  add('troughFloor', trx, trz, 2.4, 0.14, 1.0, '#9aa3ab', 0.34);
  for (const s of [-1, 1]) {
    add('troughSide', trx + px * s * 1.13, trz + pz * s * 1.13, Math.abs(pz) * 2.4 + 0.18, 0.44, Math.abs(px) * 2.4 + 0.18, '#aab3ba', 0.48);
    add('troughEnd', trx + ax * s * 1.13, trz + az * s * 1.13, Math.abs(az) * 1.0 + 0.18, 0.44, Math.abs(ax) * 1.0 + 0.18, '#aab3ba', 0.48);
  }
  add('troughWater', trx, trz, 2.1, 0.20, 0.78, '#5aa9d6', 0.48);

  // ---- CART: bed, side walls, tailboard, two wheels, shaft ----
  const cx0 = bx - ax * 5.0 - px * 1.4, cz0 = bz - az * 5.0 - pz * 1.4;
  add('cartAxle', cx0, cz0, 0.2, 0.16, 1.5, '#4a3524', 0.42);
  add('cartBed', cx0, cz0, 2.0, 0.24, 1.25, '#a9793f', 0.58);
  for (const s of [-1, 1]) {
    add('cartSide', cx0 + px * s * 0.71, cz0 + pz * s * 0.71,
      Math.abs(pz) * 2.0 + 0.16, 0.46, Math.abs(px) * 2.0 + 0.16, '#b98a4d', 0.82);
  }
  add('cartTail', cx0 - ax * 1.08, cz0 - az * 1.08, Math.abs(az) * 1.25 + 0.16, 0.42, Math.abs(ax) * 1.25 + 0.16, '#b98a4d', 0.82);
  add('cartWheel', cx0 - px * 0.78, cz0 - pz * 0.78, 0.62, 0.62, 0.18, '#6b4a2f');
  add('cartWheel', cx0 + px * 0.78, cz0 + pz * 0.78, 0.62, 0.62, 0.18, '#6b4a2f');
  add('cartShaft', cx0 + ax * 1.5, cz0 + az * 1.5, Math.abs(az) * 1.6 + 0.14, 0.14, Math.abs(ax) * 1.6 + 0.14, '#8a6a4f', 0.56);

  // ---- HAYSTACKS: two tapering tiers, and kept out of the walk-out lane ----
  for (let i = 0, tries = 0; i < 5 && tries < 60; tries++) {
    const a = rnd() * Math.PI * 2;
    const dxh = Math.cos(a), dzh = Math.sin(a);
    if (dxh * towerDx + dzh * towerDz > 0.40) continue;
    const r = 6.0 + rnd() * (half - 8.5);
    const w0 = 1.7 + rnd() * 0.6;
    add('haystack', dxh * r, dzh * r, w0, 0.78, w0, '#e0b962');
    add('haystack', dxh * r, dzh * r, w0 * 0.72, 0.55, w0 * 0.72, '#d6ad55', 0.78);
    i++;
  }

  // ---- TREES: trunk plus three tapering crowns, so they read as canopies ----
  for (let i = 0; i < 15; i++) {
    const a = (i / 15) * Math.PI * 2 + rnd() * 0.22;
    const dx = Math.cos(a), dz = Math.sin(a);
    if (dx * towerDx + dz * towerDz > 0.55) continue;
    const r = half - 1.4 - rnd() * 1.8;
    const tx = dx * r, tz = dz * r;
    const th = 1.7 + rnd() * 1.0;
    const cw = 2.0 + rnd() * 0.7;
    add('trunk', tx, tz, 0.46, th, 0.46, '#6b4a2f');
    add('crown', tx, tz, cw, 0.85, cw, '#4f9a52', th - 0.15);
    add('crown', tx, tz, cw * 0.84, 0.72, cw * 0.84, '#57a558', th + 0.70);
    add('crown', tx, tz, cw * 0.55, 0.55, cw * 0.55, '#60b060', th + 1.42);
  }

  // ---- CROP ROWS ----
  // Rows run ALONG THE PERPENDICULAR and are anchored firmly in the away
  // hemisphere (ax * positive). The first version anchored them at
  // `-ax * (half - 6)`, which is 7 units TOWARD the tower, so a 8.4-unit furrow
  // reached across the walk-out lane -- on seed 42 it genuinely overlapped it by
  // 0.14. Running them across the away side instead makes "in the lane" impossible
  // by construction rather than by a tuned margin.
  for (let row = 0; row < 3; row++) {
    const rowAway = 6.4 + row * 1.7;
    const fx = ax * rowAway, fz = az * rowAway;
    add('furrow', fx, fz, Math.abs(px) * 8.4 + Math.abs(ax) * 0.95, 0.10,
      Math.abs(pz) * 8.4 + Math.abs(az) * 0.95, '#6d5334');
    for (let i = -2; i <= 2; i++) {
      const cx = fx + px * i * 1.6, cz = fz + pz * i * 1.6;
      const ch = 0.5 + rnd() * 0.22;
      add('crop', cx, cz, 0.42, ch, 0.42, row === 1 ? '#6fae54' : '#7cbb5e', 0.10);
      add('cropTop', cx, cz, 0.26, 0.2, 0.26, '#93c96b', 0.10 + ch);
    }
  }

  // ---- FENCE: posts with caps, two rails mounted OUTSIDE the posts, real gate ----
  const N = 34;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    const towardTower = dx * towerDx + dz * towerDz;
    if (towardTower > 0.62) continue;
    const r = half - 0.6;
    const postW = 0.22;
    add('post', dx * r, dz * r, postW, 1.10, postW, '#efe7d6');
    add('postCap', dx * r, dz * r, postW + 0.10, 0.10, postW + 0.10, '#d9cfb8', 1.10);
    // rails pushed to the OUTSIDE face of the post so they are not buried in it
    const rr = r + postW / 2 + 0.05;
    for (const [rh, rb] of [[0.13, 0.72], [0.12, 0.36]]) {
      add('rail', dx * rr, dz * rr, Math.abs(dz) * 1.95 + 0.14, rh, Math.abs(dx) * 1.95 + 0.14, '#f6efdd', rb);
    }
    if (towardTower > 0.50) {
      add('gatePost', dx * r, dz * r, 0.36, 1.80, 0.36, '#d8cbaf');
      add('gateCap', dx * r, dz * r, 0.54, 0.20, 0.54, '#b59a72', 1.80);
    }
  }
  return items;
}

/**
 * Drifting clouds. `x + drift * t` where t is the CORE's simulated time, so the sky
 * animates and stays deterministic. Date.now() here would break every replay
 * assertion. Wrapped modulo CLOUD_WRAP so the sky never slowly empties.
 */
export const CLOUD_WRAP = 340;

function makeClouds(rnd, topY) {
  const clouds = [];
  for (let i = 0; i < 34; i++) {
    const scale = 0.7 + rnd() * 1.9;
    clouds.push({
      x: rnd() * CLOUD_WRAP - CLOUD_WRAP / 2,
      y: 8 + rnd() * (topY + 40),
      z: (rnd() - 0.5) * 240,
      w: 7 * scale, h: 1.5 * scale, d: 4.2 * scale,
      drift: 0.5 + rnd() * 1.5,
      puffs: 2 + Math.floor(rnd() * 3),
    });
  }
  return clouds;
}

export function cloudX(cloud, t) {
  const span = CLOUD_WRAP;
  const x = cloud.x + cloud.drift * t;
  return ((x + span / 2) % span + span) % span - span / 2;
}

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
    infinite: true,
  });

  let angle = rnd() * Math.PI * 2;
  for (let i = 1; i <= count; i++) {
    const prev = platforms[i - 1];
    const isRest = i % REST_EVERY === 0;
    const kind = isRest ? pick(rnd, LANDMARKS) : pick(rnd, prev.y > SKY_Y ? SKY_KINDS : GROUND_KINDS);
    const k = KINDS[kind];
    const w = k[0] + rnd() * (k[1] - k[0]);
    const d = k[0] + rnd() * (k[1] - k[0]);
    const h = k[2] + rnd() * (k[3] - k[2]);
    const gapY = isRest ? gapYMin : gapYMin + rnd() * (gapYMax - gapYMin);
    const gapXZ = isRest ? gapXZMin : gapXZMin + rnd() * (gapXZMax - gapXZMin);
    angle += (rnd() - 0.5) * 1.7;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const dist = rayExitXZ(prev.w, prev.d, dx, dz) + rayExitXZ(w, d, dx, dz) + gapXZ;
    platforms.push({
      i, kind, color: k[4],
      x: prev.x + dx * dist, y: prev.y + gapY, z: prev.z + dz * dist,
      w, d, h, gapY, gapXZ,
      label: isRest ? `${kind} @ ${Math.round(prev.y + gapY)}m` : '',
    });
  }

  const top = platforms[platforms.length - 1];
  const p1 = platforms[1] || { x: 1, z: 0 };
  const tl = Math.hypot(p1.x, p1.z) || 1;
  const decor = makeDecor(rnd, p1.x / tl, p1.z / tl);

  return {
    seed, platforms, decor,
    chimney: decor.chimney || null,
    clouds: makeClouds(rnd, top.y),
    spawn: { x: 0, y: 0, z: 0 },
    topY: top.y, topIndex: top.i,
  };
}
