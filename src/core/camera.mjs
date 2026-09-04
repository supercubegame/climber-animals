// Camera + projection. Lives in the PURE CORE (no DOM, no canvas) precisely so
// the fast gate can assert where things land on screen. The previous version of
// this maths lived in the shell where nothing could test it, carried a comment
// claiming it was "derived, not guessed", and was wrong: see docs/PITFALLS.md.

export const CAM_FOV = 0.52;           // half-angle, radians
export const CAM_TARGET_LIFT = 1.25;   // aim above the animal's feet
export const CAM_DIST_MIN = 5;
export const CAM_DIST_MAX = 16;
export const CAM_DIST_DEFAULT = 9.2;
// Pitch is how far ABOVE the target the camera sits. 0 = level with it.
// Upper bound stops short of straight down, where yaw becomes meaningless.
export const CAM_PITCH_MIN = 0.02;
export const CAM_PITCH_MAX = 1.15;
export const CAM_PITCH_DEFAULT = 0.30;
export const MOUSE_SENS_X = 0.0024;    // radians per pixel of pointer movement
export const MOUSE_SENS_Y = 0.0018;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clampPitch = (p) => clamp(p, CAM_PITCH_MIN, CAM_PITCH_MAX);
export const clampDist = (d) => clamp(d, CAM_DIST_MIN, CAM_DIST_MAX);
export const focalFor = (h) => (h / 2) / Math.tan(CAM_FOV);

/**
 * Orbit position: `dist` away from the target, `pitch` above it, `yaw` around it.
 * The forward unit vector eye->target is therefore
 *     (sin yaw · cos pitch, -sin pitch, cos yaw · cos pitch)
 * which is what the rotation below has to map onto +Z.
 */
export function cameraEye(tx, ty, tz, yaw, pitch, dist) {
  const cp = Math.cos(pitch);
  return {
    x: tx - Math.sin(yaw) * cp * dist,
    y: ty + Math.sin(pitch) * dist,
    z: tz - Math.cos(yaw) * cp * dist,
  };
}

/**
 * World -> camera space. Yaw about +Y, then pitch about +X, chosen so that the
 * forward vector above lands exactly on (0, 0, dist).
 *
 * Yaw:   x1 = dx·cos y − dz·sin y      z1 = dx·sin y + dz·cos y
 *   forward gives x1 = cp(sin y cos y − cos y sin y) = 0, z1 = cp = cos pitch.
 * Pitch: y2 = dy·cos p + z1·sin p      z2 = −dy·sin p + z1·cos p
 *   with dy = −sin p·dist: y2 = dist(−sin p cos p + cos p sin p) = 0
 *                          z2 = dist(sin²p + cos²p) = dist
 *
 * THE PITCH SIGNS ARE THE WHOLE BUG. Flip them (y2 = dy·cos p − z1·sin p) and
 * the camera still sits above the target but tilts further UP, throwing the
 * target off the bottom of the viewport while the scene still looks plausible.
 * `camera:target-lands-dead-centre` pins this down; a mutant proves it fails.
 */
export function toCameraSpace(px, py, pz, eye, yaw, pitch, out) {
  const dx = px - eye.x, dy = py - eye.y, dz = pz - eye.z;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = dx * cy - dz * sy;
  const z1 = dx * sy + dz * cy;
  const cpp = Math.cos(pitch), spp = Math.sin(pitch);
  out[0] = x1;
  out[1] = dy * cpp + z1 * spp;
  out[2] = -dy * spp + z1 * cpp;
  return out;
}

export const NEAR_Z = 0.12;

/** Builds everything a frame needs, so the shell keeps no camera maths of its own. */
export function makeView(tx, ty, tz, yaw, pitch, dist, w, h) {
  return {
    eye: cameraEye(tx, ty + CAM_TARGET_LIFT, tz, yaw, pitch, dist),
    yaw, pitch, dist, w, h,
    focal: focalFor(h),
    target: { x: tx, y: ty + CAM_TARGET_LIFT, z: tz },
  };
}

const _v = [0, 0, 0];

/** Returns false when the point is at or behind the near plane. */
export function projectPoint(px, py, pz, view, out) {
  toCameraSpace(px, py, pz, view.eye, view.yaw, view.pitch, _v);
  if (_v[2] < NEAR_Z) return false;
  out[0] = view.w / 2 + (_v[0] * view.focal) / _v[2];
  out[1] = view.h / 2 - (_v[1] * view.focal) / _v[2];
  out[2] = _v[2];
  return true;
}

// ---------------------------------------------------------------------------
// Box geometry. Lives here, not in the shell, so the gate can assert what ends
// up on screen instead of trusting a renderer nobody can test.
//
// Convention, shared with platforms: a box's TOP face sits at y, and it extends
// DOWN by h. Anything meant to rest on the ground therefore needs y = its own
// height, not y = 0. Getting that backwards buries the whole object; see
// docs/PITFALLS.md.
// ---------------------------------------------------------------------------

export const BOX_CORNERS = [
  [-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1],
  [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],
];
export const BOX_FACES = [
  { idx: [0, 1, 2, 3], n: [0, 1, 0], lit: 1.06 },
  { idx: [3, 2, 6, 7], n: [0, 0, 1], lit: 0.80 },
  { idx: [1, 0, 4, 5], n: [0, 0, -1], lit: 0.62 },
  { idx: [2, 1, 5, 6], n: [1, 0, 0], lit: 0.90 },
  { idx: [0, 3, 7, 4], n: [-1, 0, 0], lit: 0.70 },
];

/**
 * Sutherland-Hodgman clip of a camera-space polygon against z >= NEAR_Z.
 *
 * This exists because the obvious alternative -- "if any corner is behind the
 * camera, skip the box" -- silently deletes exactly the geometry you are standing
 * on. A 26-unit farmyard viewed from 9 units up has its near corners behind the
 * eye, so the entire ground plane vanished and the animal appeared to float in
 * the sky. Small boxes never triggered it, which is why it hid through v1.0.
 */
export function clipNearZ(poly, near = NEAR_Z) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ain = a[2] >= near, bin = b[2] >= near;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (near - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]);
    }
  }
  return out;
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

const _corner = [0, 0, 0];

/**
 * Screen polygons for the visible faces of an axis-aligned box, near-plane
 * clipped. Returns [{ lit, pts:[[x,y],...] }, ...]; empty when nothing shows.
 */
export function boxScreenFaces(x, y, z, w, h, d, view) {
  const hw = w / 2, hd = d / 2;
  const eye = view.eye;
  const cam = [];
  for (let i = 0; i < 8; i++) {
    const c = BOX_CORNERS[i];
    toCameraSpace(x + c[0] * hw, y + c[1] * h, z + c[2] * hd, eye, view.yaw, view.pitch, _corner);
    cam.push([_corner[0], _corner[1], _corner[2]]);
  }
  const faces = [];
  for (let f = 0; f < BOX_FACES.length; f++) {
    const face = BOX_FACES[f], n = face.n;
    // Back-face cull in WORLD space: cheaper than a normal transform and exact
    // for axis-aligned boxes.
    let vis;
    if (n[1] === 1) vis = eye.y > y;
    else if (n[0] !== 0) vis = (eye.x - x) * n[0] > hw;
    else vis = (eye.z - z) * n[2] > hd;
    if (!vis) continue;
    const clipped = clipNearZ([cam[face.idx[0]], cam[face.idx[1]], cam[face.idx[2]], cam[face.idx[3]]]);
    if (clipped.length < 3) continue;
    const pts = [];
    for (let k = 0; k < clipped.length; k++) {
      const v = clipped[k];
      pts.push([view.w / 2 + (v[0] * view.focal) / v[2], view.h / 2 - (v[1] * view.focal) / v[2]]);
    }
    faces.push({ lit: face.lit, pts });
  }
  return faces;
}

/** Sutherland-Hodgman clip of a 2D polygon to the viewport rectangle. */
export function clipToRect(pts, w, h) {
  const edges = [
    (p) => p[0] >= 0, (p) => p[0] <= w, (p) => p[1] >= 0, (p) => p[1] <= h,
  ];
  const cross = [
    (a, b) => (0 - a[0]) / (b[0] - a[0]), (a, b) => (w - a[0]) / (b[0] - a[0]),
    (a, b) => (0 - a[1]) / (b[1] - a[1]), (a, b) => (h - a[1]) / (b[1] - a[1]),
  ];
  let poly = pts;
  for (let e = 0; e < 4; e++) {
    const inside = edges[e], at = cross[e];
    const next = [];
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const ain = inside(a), bin = inside(b);
      if (ain) next.push(a);
      if (ain !== bin) {
        const t = at(a, b);
        next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = next;
    if (poly.length === 0) return poly;
  }
  return poly;
}

/**
 * Fraction of the viewport a box actually paints, 0..1. Clipping to the rect
 * matters: a face clipped to the near plane projects to coordinates thousands of
 * pixels wide, so raw polygon area is meaningless as a measure of what you see.
 */
export function screenCoverage(faces, w, h) {
  let a = 0;
  for (let i = 0; i < faces.length; i++) {
    const c = clipToRect(faces[i].pts, w, h);
    if (c.length >= 3) a += polygonArea(c);
  }
  return a / (w * h);
}
