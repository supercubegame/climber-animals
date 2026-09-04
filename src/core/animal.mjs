// Animal models. PURE: returns posed body parts in the animal's own local space
// (+x right, +y up, +z forward), so the shell only picks colours and fills paths
// and the gate can assert proportions and animation without a browser.
//
// Everything here is COSMETIC. The collision box is PLAYER_R for every species --
// swapping animals must not change a single physics step, which
// `animal:species-are-cosmetic-only` proves by comparing state hashes.
//
// Shaping without new primitives: these are boxes, but a rounded body is a short
// STACK of boxes whose width and depth taper, and a snout is a small box set
// forward and low. That reads as a creature at gameplay distance; three cubes in a
// row does not. Cost is ~20-30 boxes per animal, which is nothing next to the
// tower.

// `scale` is the only size knob. The shell scales CAMERA DISTANCE by the model
// height so a chicken is not a speck; see updateCamera().
export const SPECIES = [
  {
    id: 'cow', name: 'Cow', key: '1',
    scale: 1.15,
    body: '#f7f3ec', spot: '#332e2a', hoof: '#2a2522', face: '#f6b8c2',
    horn: '#e6dcc4', udder: '#f0a9b4',
  },
  {
    id: 'sheep', name: 'Sheep', key: '3',
    scale: 0.98,
    body: '#f2ece1', spot: '#cdbfa8', hoof: '#3b342e', face: '#4a423b',
    horn: '#d8cbb2', udder: '#e8dccb',
  },
  {
    id: 'pig', name: 'Pig', key: '4',
    scale: 0.94,
    body: '#f2a7b2', spot: '#d97e91', hoof: '#8d5560', face: '#e8879a',
    horn: '#f2a7b2', udder: '#e8879a',
  },
  {
    id: 'chicken', name: 'Chicken', key: '2',
    scale: 0.78,
    body: '#f8e79a', spot: '#e3a92c', hoof: '#e0a52c', face: '#e5493a',
    horn: '#e5493a', udder: '#f8e79a',
  },
];

export function speciesById(id) {
  for (let i = 0; i < SPECIES.length; i++) if (SPECIES[i].id === id) return SPECIES[i];
  return SPECIES[0];
}

/**
 * Pose parameters, all derived from state the CORE owns so a replay looks
 * identical:
 *   gait    0..1 phase of the walk cycle, advanced by DISTANCE not time, so the
 *           legs never skate when speed changes
 *   speed01 0..1 how fast, for stride amplitude
 *   air     0 grounded, 1 airborne
 *   squash  0 rest, 1 fully compressed (landing) or negative (stretched, rising)
 */
export function makePose(gait, speed01, air, squash) {
  return { gait, speed01, air, squash };
}

const TAU = Math.PI * 2;

/** Returns [{ x,y,z,w,h,d,color,tag }] in local space, y measured up from the feet. */
export function animalParts(sp, pose) {
  const k = sp.scale;
  const S = (n) => n * k;
  const out = [];
  const add = (x, y, z, w, h, d, color, tag) =>
    out.push({ x: S(x), y: S(y), z: S(z), w: S(w), h: S(h), d: S(d), color, tag: tag || '' });

  const swing = Math.sin(pose.gait * TAU) * 0.34 * pose.speed01;
  const swingB = Math.sin(pose.gait * TAU + Math.PI) * 0.34 * pose.speed01;
  // Airborne: front legs reach forward, back legs trail. Reads as a leap rather
  // than a statue that happens to be off the ground.
  const legF = pose.air ? 0.30 : swing;
  const legB = pose.air ? -0.26 : swingB;
  // squash>0 compresses vertically and spreads horizontally, conserving bulk.
  const sq = 1 - pose.squash * 0.22;
  const sp_ = 1 + pose.squash * 0.16;
  const bob = pose.air ? 0 : Math.sin(pose.gait * TAU * 2) * 0.018 * pose.speed01;

  if (sp.id === 'chicken') {
    const legLen = 0.30;
    // y is a box's TOP (see camera.mjs), so a leg of length legLen has its top at
    // legLen and its foot at exactly 0. Drawing it at y=0 buries the whole leg.
    add(-0.11, legLen, legF * 0.22, 0.07, legLen, 0.07, sp.hoof, 'legFL');
    add(0.11, legLen, legB * 0.22, 0.07, legLen, 0.07, sp.hoof, 'legBR');
    add(-0.11, 0.05, legF * 0.22 + 0.09, 0.16, 0.05, 0.05, sp.hoof, 'footL');
    add(0.11, 0.05, legB * 0.22 + 0.09, 0.16, 0.05, 0.05, sp.hoof, 'footR');
    const by = legLen + bob;
    // body: three tapered slices, widest in the middle -> reads as a plump bird
    add(0, by + 0.16 * sq, -0.02, 0.30 * sp_, 0.16 * sq, 0.34, sp.body, 'body');
    add(0, by + 0.30 * sq, -0.01, 0.36 * sp_, 0.14 * sq, 0.40, sp.body, 'body');
    add(0, by + 0.40 * sq, 0.00, 0.30 * sp_, 0.10 * sq, 0.34, sp.body, 'body');
    add(-0.19, by + 0.30 * sq, -0.01, 0.06, 0.22, 0.30, sp.spot, 'wingL');
    add(0.19, by + 0.30 * sq, -0.01, 0.06, 0.22, 0.30, sp.spot, 'wingR');
    // fanned tail, three feathers of decreasing height
    add(0, by + 0.44 * sq, -0.24, 0.05, 0.20, 0.14, sp.spot, 'tail');
    add(-0.07, by + 0.40 * sq, -0.22, 0.05, 0.16, 0.12, sp.spot, 'tail');
    add(0.07, by + 0.40 * sq, -0.22, 0.05, 0.16, 0.12, sp.spot, 'tail');
    const hy = by + 0.62 * sq;
    add(0, hy, 0.10, 0.10, 0.16, 0.10, sp.body, 'neck');
    add(0, hy + 0.16, 0.12, 0.20, 0.18, 0.20, sp.body, 'head');
    add(0, hy + 0.24, 0.12, 0.06, 0.09, 0.05, sp.face, 'comb');
    add(0, hy + 0.09, 0.22, 0.07, 0.06, 0.08, '#f0a72c', 'beak');
    add(0, hy + 0.03, 0.19, 0.05, 0.06, 0.04, sp.face, 'wattle');
    return { parts: out, eye: { x: 0.075, y: S(hy + 0.13), z: 0.10 }, height: S(hy + 0.24) };
  }

  // --- quadrupeds: cow, sheep, pig share a skeleton and differ in dressing ---
  const isPig = sp.id === 'pig';
  const isSheep = sp.id === 'sheep';
  const legLen = isPig ? 0.26 : isSheep ? 0.30 : 0.40;
  const bodyLen = isPig ? 0.82 : isSheep ? 0.78 : 0.90;
  const bodyW = isPig ? 0.52 : isSheep ? 0.54 : 0.56;
  const legW = isPig ? 0.15 : 0.13;

  const lz = bodyLen * 0.30;
  for (const [sx, sz, ph, tag] of [
    [-1, 1, legF, 'legFL'], [1, 1, legB, 'legFR'],
    [-1, -1, legB, 'legBL'], [1, -1, legF, 'legBR'],
  ]) {
    add(sx * bodyW * 0.34, legLen, sz * lz + ph * 0.20, legW, legLen, legW, sp.spot, tag);
    add(sx * bodyW * 0.34, 0.07, sz * lz + ph * 0.20, legW + 0.02, 0.07, legW + 0.03, sp.hoof, tag + 'Hoof');
  }

  const by = legLen + bob;
  // barrel: five slices, tapering at both ends, so the silhouette is a rounded
  // body rather than one slab
  const slices = isSheep
    ? [[0.10, 0.86, 0.80], [0.26, 1.00, 1.00], [0.42, 1.00, 0.98], [0.55, 0.84, 0.84], [0.64, 0.58, 0.62]]
    : [[0.09, 0.84, 0.86], [0.24, 1.00, 1.00], [0.40, 0.98, 0.98], [0.52, 0.82, 0.86], [0.60, 0.56, 0.64]];
  for (const [yy, ww, dd] of slices) {
    add(0, by + yy * sq, 0, bodyW * ww * sp_, 0.17 * sq, bodyLen * dd, sp.body, 'body');
  }
  if (isSheep) {
    // wool clumps break up the straight back
    add(-0.16, by + 0.70 * sq, 0.16, 0.24, 0.16, 0.24, sp.body, 'wool');
    add(0.17, by + 0.68 * sq, -0.10, 0.22, 0.15, 0.22, sp.body, 'wool');
    add(0, by + 0.70 * sq, -0.26, 0.26, 0.14, 0.20, sp.body, 'wool');
  } else {
    add(-0.13, by + 0.50 * sq, 0.16, 0.26, 0.13, 0.24, sp.spot, 'patch');
    add(0.16, by + 0.34 * sq, -0.14, 0.22, 0.12, 0.22, sp.spot, 'patch');
  }
  if (!isPig && !isSheep) add(0, by + 0.05, -0.02, 0.26, 0.14, 0.22, sp.udder, 'udder');

  // tail: segmented so it can curl (pig) or hang with a tuft (cow)
  const tz = -bodyLen * 0.52;
  const wag = Math.sin(pose.gait * TAU + 1.1) * 0.10 * (0.4 + pose.speed01);
  if (isPig) {
    add(wag * 0.5, by + 0.46 * sq, tz - 0.04, 0.07, 0.07, 0.08, sp.spot, 'tail');
    add(0.06 + wag * 0.5, by + 0.52 * sq, tz - 0.09, 0.07, 0.07, 0.07, sp.spot, 'tail');
    add(-0.01 + wag * 0.5, by + 0.56 * sq, tz - 0.05, 0.06, 0.06, 0.07, sp.spot, 'tail');
  } else {
    add(wag, by + 0.44 * sq, tz - 0.03, 0.08, 0.34, 0.08, sp.spot, 'tail');
    add(wag * 1.4, by + 0.14, tz - 0.05, 0.11, 0.13, 0.11, sp.spot, 'tailTuft');
  }

  // head, carried a little lower and further forward when moving fast
  const lean = pose.speed01 * 0.05;
  const hz = bodyLen * 0.50 + 0.10;
  const hy = by + (isPig ? 0.44 : isSheep ? 0.50 : 0.52) * sq - lean;
  add(0, hy + 0.18, hz - 0.14, 0.30, 0.22, 0.24, sp.body, 'neck');
  add(0, hy + 0.30, hz, 0.40, 0.32, 0.34, sp.body, 'head');
  if (isPig) {
    add(0, hy + 0.16, hz + 0.15, 0.26, 0.14, 0.12, sp.face, 'snout');
    add(-0.14, hy + 0.34, hz + 0.04, 0.13, 0.14, 0.10, sp.spot, 'earL');
    add(0.14, hy + 0.34, hz + 0.04, 0.13, 0.14, 0.10, sp.spot, 'earR');
  } else if (isSheep) {
    add(0, hy + 0.22, hz + 0.10, 0.24, 0.20, 0.14, sp.face, 'muzzle');
    add(0, hy + 0.38, hz - 0.02, 0.34, 0.12, 0.24, sp.body, 'woolCap');
    add(-0.20, hy + 0.26, hz - 0.02, 0.12, 0.08, 0.16, sp.face, 'earL');
    add(0.20, hy + 0.26, hz - 0.02, 0.12, 0.08, 0.16, sp.face, 'earR');
  } else {
    add(0, hy + 0.20, hz + 0.13, 0.28, 0.17, 0.12, sp.face, 'muzzle');
    add(-0.20, hy + 0.30, hz - 0.04, 0.11, 0.11, 0.14, sp.spot, 'earL');
    add(0.20, hy + 0.30, hz - 0.04, 0.11, 0.11, 0.14, sp.spot, 'earR');
    add(-0.13, hy + 0.40, hz - 0.02, 0.09, 0.09, 0.09, sp.horn, 'hornL');
    add(0.13, hy + 0.40, hz - 0.02, 0.09, 0.09, 0.09, sp.horn, 'hornR');
  }

  return {
    parts: out,
    eye: { x: S(0.10), y: S(hy + 0.26), z: S(hz + 0.17) },
    height: S(hy + 0.40),
  };
}
