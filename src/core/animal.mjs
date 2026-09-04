// Animal models. PURE: posed body parts in the animal's own local space
// (+x right, +y up, +z forward), so the shell only picks colours and fills paths
// and the gate can assert proportions and animation without a browser.
//
// Everything here is COSMETIC. The collision box is PLAYER_R for every species, so
// a chicken lands on exactly the ledges a cow does.
//
// SHAPING RULE, and it is a correctness rule not a style one: every decoration is
// SURFACE MOUNTED, never nested inside the part it decorates. Painter's algorithm
// sorts by centre depth, which resolves a box sitting ON a surface (near side sorts
// later, far side sorts earlier -- both correct) but CANNOT resolve a box buried
// inside another. v2.1 put the cow's patches at x=-0.13 with width 0.26 inside a
// body of half-width 0.28, i.e. fully interior, and the udder inside the barrel.
// That is the "you can see into the model" report: the interior box surfaced and
// vanished depending on the angle. Decorations now protrude by SURFACE_PROUD.
export const SURFACE_PROUD = 0.02;

export const SPECIES = [
  {
    id: 'cow', name: 'Cow', key: '1', scale: 1.15,
    body: '#f7f3ec', spot: '#332e2a', hoof: '#2a2522', face: '#f6b8c2',
    horn: '#e6dcc4', udder: '#f0a9b4',
  },
  {
    id: 'sheep', name: 'Sheep', key: '3', scale: 0.98,
    body: '#f2ece1', spot: '#cdbfa8', hoof: '#3b342e', face: '#4a423b',
    horn: '#d8cbb2', udder: '#e8dccb',
  },
  {
    id: 'pig', name: 'Pig', key: '4', scale: 0.94,
    body: '#f2a7b2', spot: '#d97e91', hoof: '#8d5560', face: '#e8879a',
    horn: '#f2a7b2', udder: '#e8879a',
  },
  {
    id: 'chicken', name: 'Chicken', key: '2', scale: 0.78,
    body: '#f8e79a', spot: '#e3a92c', hoof: '#e0a52c', face: '#e5493a',
    horn: '#e5493a', udder: '#f8e79a',
  },
];

export function speciesById(id) {
  for (let i = 0; i < SPECIES.length; i++) if (SPECIES[i].id === id) return SPECIES[i];
  return SPECIES[0];
}

/**
 * Pose parameters, all from state the CORE owns so a replay looks identical:
 *   gait    0..1 walk phase, advanced by DISTANCE not time, so legs never skate
 *   speed01 0..1 for stride amplitude
 *   air     0 grounded, 1 airborne
 *   squash  0 rest, 1 compressed (landing), negative stretched (rising)
 */
export function makePose(gait, speed01, air, squash) {
  return { gait, speed01, air, squash };
}

const TAU = Math.PI * 2;

/** [{ x,y,z,w,h,d,color,tag }] in local space, y measured up from the feet. */
export function animalParts(sp, pose) {
  const k = sp.scale;
  const S = (n) => n * k;
  const out = [];
  const add = (x, y, z, w, h, d, color, tag) =>
    out.push({ x: S(x), y: S(y), z: S(z), w: S(w), h: S(h), d: S(d), color, tag: tag || '' });

  const swing = Math.sin(pose.gait * TAU) * 0.34 * pose.speed01;
  const swingB = Math.sin(pose.gait * TAU + Math.PI) * 0.34 * pose.speed01;
  const legF = pose.air ? 0.30 : swing;
  const legB = pose.air ? -0.26 : swingB;
  const sq = 1 - pose.squash * 0.22;
  const sp_ = 1 + pose.squash * 0.16;
  const bob = pose.air ? 0 : Math.sin(pose.gait * TAU * 2) * 0.018 * pose.speed01;
  const P = SURFACE_PROUD;

  if (sp.id === 'chicken') {
    const legLen = 0.30;
    // y is a box's TOP, so a leg of length legLen has its top at legLen and its
    // foot at exactly 0. Authoring it at y=0 buries the whole leg.
    add(-0.11, legLen, legF * 0.22, 0.07, legLen, 0.07, sp.hoof, 'legL');
    add(0.11, legLen, legB * 0.22, 0.07, legLen, 0.07, sp.hoof, 'legR');
    add(-0.11, 0.05, legF * 0.22 + 0.09, 0.16, 0.05, 0.05, sp.hoof, 'footL');
    add(0.11, 0.05, legB * 0.22 + 0.09, 0.16, 0.05, 0.05, sp.hoof, 'footR');
    const by = legLen + bob;
    add(0, by + 0.16 * sq, -0.02, 0.30 * sp_, 0.16 * sq, 0.34, sp.body, 'body');
    add(0, by + 0.30 * sq, -0.01, 0.36 * sp_, 0.14 * sq, 0.40, sp.body, 'body');
    add(0, by + 0.40 * sq, 0.00, 0.30 * sp_, 0.10 * sq, 0.34, sp.body, 'body');
    // wings mounted OUTSIDE the widest slice (half-width 0.18) so they protrude
    add(-(0.18 + P), by + 0.30 * sq, -0.01, 0.07, 0.22, 0.30, sp.spot, 'wingL');
    add(0.18 + P, by + 0.30 * sq, -0.01, 0.07, 0.22, 0.30, sp.spot, 'wingR');
    add(0, by + 0.44 * sq, -0.24, 0.05, 0.20, 0.14, sp.spot, 'tail');
    add(-0.07, by + 0.40 * sq, -0.22, 0.05, 0.16, 0.12, sp.spot, 'tail');
    add(0.07, by + 0.40 * sq, -0.22, 0.05, 0.16, 0.12, sp.spot, 'tail');
    const hy = by + 0.62 * sq;
    add(0, hy, 0.10, 0.10, 0.16, 0.10, sp.body, 'neck');
    add(0, hy + 0.16, 0.12, 0.20, 0.18, 0.20, sp.body, 'head');
    add(0, hy + 0.16 + 0.07, 0.12, 0.06, 0.09, 0.05, sp.face, 'comb');
    add(0, hy + 0.09, 0.10 + 0.10 + P, 0.07, 0.06, 0.09, '#f0a72c', 'beak');
    add(0, hy + 0.03, 0.10 + 0.08 + P, 0.05, 0.06, 0.05, sp.face, 'wattle');
    return { parts: out, eye: { x: S(0.075), y: S(hy + 0.13), z: S(0.11) }, height: S(hy + 0.25) };
  }

  const isPig = sp.id === 'pig';
  const isSheep = sp.id === 'sheep';
  const legLen = isPig ? 0.26 : isSheep ? 0.30 : 0.40;
  const bodyLen = isPig ? 0.82 : isSheep ? 0.78 : 0.90;
  const bodyW = isPig ? 0.52 : isSheep ? 0.54 : 0.56;
  const legW = isPig ? 0.15 : 0.13;
  const halfW = bodyW / 2;

  const lz = bodyLen * 0.30;
  for (const [sx, sz, ph, tag] of [
    [-1, 1, legF, 'legFL'], [1, 1, legB, 'legFR'],
    [-1, -1, legB, 'legBL'], [1, -1, legF, 'legBR'],
  ]) {
    add(sx * bodyW * 0.34, legLen, sz * lz + ph * 0.20, legW, legLen, legW, sp.spot, tag);
    add(sx * bodyW * 0.34, 0.07, sz * lz + ph * 0.20, legW + 0.02, 0.07, legW + 0.03, sp.hoof, tag + 'Hoof');
  }

  const by = legLen + bob;
  const slices = isSheep
    ? [[0.10, 0.86, 0.80], [0.26, 1.00, 1.00], [0.42, 1.00, 0.98], [0.55, 0.84, 0.84], [0.64, 0.58, 0.62]]
    : [[0.09, 0.84, 0.86], [0.24, 1.00, 1.00], [0.40, 0.98, 0.98], [0.52, 0.82, 0.86], [0.60, 0.56, 0.64]];
  for (const [yy, ww, dd] of slices) {
    add(0, by + yy * sq, 0, bodyW * ww * sp_, 0.17 * sq, bodyLen * dd, sp.body, 'body');
  }

  if (isSheep) {
    // wool sits ON TOP of the back: base at the top slice, so it protrudes upward
    const backTop = by + 0.64 * sq;
    add(-0.13, backTop + 0.13, 0.16, 0.26, 0.15, 0.26, sp.body, 'wool');
    add(0.14, backTop + 0.12, -0.10, 0.24, 0.14, 0.24, sp.body, 'wool');
    add(0, backTop + 0.13, -0.26, 0.27, 0.14, 0.21, sp.body, 'wool');
  } else {
    // FLANK patches, mounted on the surface and protruding outward. v2.1 buried
    // these inside the barrel and they flickered through it.
    add(-(halfW + P - 0.03), by + 0.46 * sq, 0.16, 0.07, 0.20, 0.30, sp.spot, 'patchL');
    add(halfW + P - 0.03, by + 0.34 * sq, -0.13, 0.07, 0.18, 0.26, sp.spot, 'patchR');
    add(0.05, by + 0.62 * sq + 0.05, 0.10, 0.22, 0.06, 0.26, sp.spot, 'patchTop');
  }
  if (!isPig && !isSheep) {
    // udder HANGS BELOW the barrel: its top is the barrel's underside, so it is
    // outside the body volume instead of inside it.
    add(0, by + 0.09 * sq - 0.17 * sq, -0.02, 0.24, 0.13, 0.20, sp.udder, 'udder');
  }

  const tz = -bodyLen * 0.52;
  const wag = Math.sin(pose.gait * TAU + 1.1) * 0.10 * (0.4 + pose.speed01);
  if (isPig) {
    add(wag * 0.5, by + 0.46 * sq, tz - 0.05, 0.07, 0.07, 0.09, sp.spot, 'tail');
    add(0.06 + wag * 0.5, by + 0.52 * sq, tz - 0.10, 0.07, 0.07, 0.07, sp.spot, 'tail');
    add(-0.01 + wag * 0.5, by + 0.56 * sq, tz - 0.06, 0.06, 0.06, 0.07, sp.spot, 'tail');
  } else {
    add(wag, by + 0.44 * sq, tz - 0.04, 0.08, 0.34, 0.08, sp.spot, 'tail');
    add(wag * 1.4, by + 0.14, tz - 0.06, 0.11, 0.13, 0.11, sp.spot, 'tailTuft');
  }

  const lean = pose.speed01 * 0.05;
  const hz = bodyLen * 0.50 + 0.10;
  const hy = by + (isPig ? 0.44 : isSheep ? 0.50 : 0.52) * sq - lean;
  add(0, hy + 0.18, hz - 0.14, 0.30, 0.22, 0.24, sp.body, 'neck');
  add(0, hy + 0.30, hz, 0.40, 0.32, 0.34, sp.body, 'head');
  const headHalfW = 0.20, headFront = hz + 0.17;
  if (isPig) {
    add(0, hy + 0.16, headFront + P, 0.26, 0.14, 0.12, sp.face, 'snout');
    add(-(headHalfW + P), hy + 0.34, hz + 0.04, 0.09, 0.15, 0.12, sp.spot, 'earL');
    add(headHalfW + P, hy + 0.34, hz + 0.04, 0.09, 0.15, 0.12, sp.spot, 'earR');
  } else if (isSheep) {
    add(0, hy + 0.23, headFront + P, 0.24, 0.20, 0.14, sp.face, 'muzzle');
    add(0, hy + 0.30 + 0.09, hz - 0.02, 0.35, 0.11, 0.25, sp.body, 'woolCap');
    add(-(headHalfW + P), hy + 0.26, hz - 0.02, 0.10, 0.08, 0.16, sp.face, 'earL');
    add(headHalfW + P, hy + 0.26, hz - 0.02, 0.10, 0.08, 0.16, sp.face, 'earR');
  } else {
    add(0, hy + 0.21, headFront + P, 0.28, 0.17, 0.13, sp.face, 'muzzle');
    add(-(headHalfW + P), hy + 0.30, hz - 0.04, 0.09, 0.11, 0.14, sp.spot, 'earL');
    add(headHalfW + P, hy + 0.30, hz - 0.04, 0.09, 0.11, 0.14, sp.spot, 'earR');
    // horns sit ON the crown, base at the head top
    add(-0.13, hy + 0.30 + 0.09, hz - 0.02, 0.09, 0.09, 0.09, sp.horn, 'hornL');
    add(0.13, hy + 0.30 + 0.09, hz - 0.02, 0.09, 0.09, 0.09, sp.horn, 'hornR');
  }

  return {
    parts: out,
    eye: { x: S(0.10), y: S(hy + 0.26), z: S(headFront + P) },
    height: S(hy + 0.42),
  };
}

/**
 * The first-person eye, in local space. Set a hair FORWARD of the muzzle so the
 * animal's own head is behind the near plane rather than filling the screen: an
 * eye buried inside the skull renders the inside of the head, which is the same
 * missing-back-face artifact by another route.
 */
export function firstPersonEye(sp, pose) {
  const m = animalParts(sp, pose);
  return { x: 0, y: m.eye.y, z: m.eye.z + 0.10 * sp.scale };
}
