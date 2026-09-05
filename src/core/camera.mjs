// Camera + projection. PURE (no DOM, no canvas) so the fast gate can assert where
// things land on screen. v1.0 kept this in the shell where nothing could test it,
// carried a comment claiming it was "derived, not guessed", and was wrong.

export const CAM_FOV = 0.52;           // half-angle, radians
export const CAM_TARGET_LIFT = 1.25;
export const CAM_DIST_MIN = 5;
export const CAM_DIST_MAX = 16;
export const CAM_DIST_DEFAULT = 9.2;

// Pitch is how far ABOVE the target the eye sits, so the eye always looks DOWN by
// that angle. v2.1 clamped it to [0.02, 1.15] and that is why the view could never
// tilt up: the horizon sits at H/2 - focal*tan(pitch), so pitch 0.02 was the most
// sky you could ever get (48% of the frame) and the 0.30 default gave 23%. Above
// horizontal was simply unreachable.
//
// NEGATIVE pitch (eye BELOW the target, looking up) is now allowed. But there is a
// hard geometric limit that no clamp constant can wish away: with the eye orbiting
// at `dist`, looking up far enough puts it UNDERGROUND. So the floor is computed
// per frame from the target height (see pitchFloorFor) and the constant below is
// only the outer bound. On flat ground that floor is around -0.05 rad, which is
// why FIRST PERSON exists -- it is the only way to look at the sky from ground
// level, not a cosmetic extra.
export const CAM_PITCH_MIN = -0.55;
export const CAM_PITCH_MAX = 1.30;
export const CAM_PITCH_DEFAULT = 0.26;

// First person pitches freely: the eye is at the animal's head, so there is no
// orbit arm to swing underground.
export const FP_PITCH_MIN = -1.25;
export const FP_PITCH_MAX = 1.25;

export const MOUSE_SENS_X = 0.0024;
export const MOUSE_SENS_Y = 0.0018;

/**
 * Which way a pointer delta turns the camera. d/dyaw of the forward vector's
 * horizontal part is (cos yaw, 0, -sin yaw), which projects to SCREEN RIGHT, so
 * increasing yaw pans right and mouse-right must ADD. v2.0 subtracted and felt
 * inverted while Q/E were correct -- two paths for one action disagreeing.
 */
export const YAW_PER_PIXEL = MOUSE_SENS_X;
export const PITCH_PER_PIXEL = MOUSE_SENS_Y;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clampDist = (d) => clamp(d, CAM_DIST_MIN, CAM_DIST_MAX);
export const focalFor = (h) => (h / 2) / Math.tan(CAM_FOV);

/**
 * How far up you may tilt before the orbiting eye would sink below `groundY`.
 * Keeping the eye above ground preserves the dead-centre invariant (the orbit stays
 * exact) instead of shoving the eye and silently decentring the animal, which is
 * what a naive "clamp the eye height" fix does.
 */
export function pitchFloorFor(targetY, dist, groundY, margin = 0.45) {
  const s = (groundY + margin - targetY) / Math.max(dist, 1e-6);
  if (s <= -1) return CAM_PITCH_MIN;
  if (s >= 1) return CAM_PITCH_MAX;
  return Math.max(CAM_PITCH_MIN, Math.asin(s));
}

export function clampPitch(p, lo = CAM_PITCH_MIN, hi = CAM_PITCH_MAX) {
  return clamp(p, lo, hi);
}

/** Screen y of the horizon. The number that proves whether you can look up at all. */
export function horizonY(pitch, h) {
  return h / 2 - focalFor(h) * Math.tan(pitch);
}

export function cameraEye(tx, ty, tz, yaw, pitch, dist) {
  const cp = Math.cos(pitch);
  return {
    x: tx - Math.sin(yaw) * cp * dist,
    y: ty + Math.sin(pitch) * dist,
    z: tz - Math.cos(yaw) * cp * dist,
  };
}

/**
 * World -> camera space. Yaw about +Y then pitch about +X, chosen so the forward
 * vector (sin yaw cos p, -sin p, cos yaw cos p) lands exactly on (0, 0, dist).
 *
 * Pitch: y2 = dy*cos p + z1*sin p,  z2 = -dy*sin p + z1*cos p
 * THE PITCH SIGNS ARE THE v1.0 BUG. Flip them and the camera still sits above the
 * target but tilts further UP, throwing it off the bottom of the viewport while the
 * scene still looks plausible.
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

/** Third person: eye orbits a target, target lands dead centre. */
export function makeView(tx, ty, tz, yaw, pitch, dist, w, h, lift) {
  const L = lift === undefined ? CAM_TARGET_LIFT : lift;
  return {
    eye: cameraEye(tx, ty + L, tz, yaw, pitch, dist),
    yaw, pitch, dist, w, h, lift: L, firstPerson: false,
    focal: focalFor(h),
    target: { x: tx, y: ty + L, z: tz },
  };
}

/**
 * First person: the eye is placed exactly, and the "target" is one unit along
 * forward purely so the same centre-of-screen assertion applies to both modes.
 * dist is 0, which is why nothing here can put the eye underground.
 */
export function makeEyeView(ex, ey, ez, yaw, pitch, w, h) {
  const cp = Math.cos(pitch);
  return {
    eye: { x: ex, y: ey, z: ez },
    yaw, pitch, dist: 0, lift: 0, firstPerson: true,
    focal: focalFor(h), w, h,
    target: { x: ex + Math.sin(yaw) * cp, y: ey - Math.sin(pitch), z: ez + Math.cos(yaw) * cp },
  };
}

const _v = [0, 0, 0];

export function projectPoint(px, py, pz, view, out) {
  toCameraSpace(px, py, pz, view.eye, view.yaw, view.pitch, _v);
  if (_v[2] < NEAR_Z) return false;
  out[0] = view.w / 2 + (_v[0] * view.focal) / _v[2];
  out[1] = view.h / 2 - (_v[1] * view.focal) / _v[2];
  out[2] = _v[2];
  return true;
}

// ---------------------------------------------------------------------------
// Box geometry. A box's TOP face sits at y and it extends DOWN by h, so anything
// resting on the ground needs y = its own height. Getting that backwards buries
// the object; it buried every tree, fence and barn once already.
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
  // BOTTOM. v2.1 had five faces and no bottom, so looking UP at a platform showed
  // you straight through it into its interior -- half of the "see inside the model"
  // report. In a climbing game you are underneath platforms constantly, so a
  // five-faced box is only watertight from a viewpoint the player never has.
  { idx: [4, 5, 6, 7], n: [0, -1, 0], lit: 0.46 },
];

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
    let vis;
    if (n[1] === 1) vis = eye.y > y;
    else if (n[1] === -1) vis = eye.y < y - h;
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

export function clipToRect(pts, w, h) {
  const edges = [(p) => p[0] >= 0, (p) => p[0] <= w, (p) => p[1] >= 0, (p) => p[1] <= h];
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

export function screenCoverage(faces, w, h) {
  let a = 0;
  for (let i = 0; i < faces.length; i++) {
    const c = clipToRect(faces[i].pts, w, h);
    if (c.length >= 3) a += polygonArea(c);
  }
  return a / (w * h);
}

// ---------------------------------------------------------------------------
// Rotated boxes, so a body part can belong to an animal that FACES somewhere.
// +x is the animal's right, +z its forward, +y up.
// local -> world:  wx = ox + lx*c + lz*s,  wz = oz - lx*s + lz*c
//
// Checked against the axis-aligned path two ways: at yaw 0 the output is
// byte-identical, and at 90 degrees a 4x1 box gives the same screen SILHOUETTE as
// an axis-aligned 1x4. Do not compare face `lit` values -- under rotation a local
// +x face legitimately becomes a world -z face, so shading should differ.
// ---------------------------------------------------------------------------

export function makeFrame(x, y, z, yaw) {
  return { x, y, z, yaw, c: Math.cos(yaw), s: Math.sin(yaw) };
}

export function localToWorld(frame, lx, ly, lz, out) {
  out[0] = frame.x + lx * frame.c + lz * frame.s;
  out[1] = frame.y + ly;
  out[2] = frame.z - lx * frame.s + lz * frame.c;
  return out;
}

const _lw = [0, 0, 0];
const _c2 = [0, 0, 0];

export function localBoxScreenFaces(lx, ly, lz, w, h, d, frame, view) {
  const eye = view.eye;
  const dx = eye.x - frame.x, dz = eye.z - frame.z;
  const elx = dx * frame.c - dz * frame.s;
  const ely = eye.y - frame.y;
  const elz = dx * frame.s + dz * frame.c;
  const hw = w / 2, hd = d / 2;

  const cam = [];
  for (let i = 0; i < 8; i++) {
    const cn = BOX_CORNERS[i];
    localToWorld(frame, lx + cn[0] * hw, ly + cn[1] * h, lz + cn[2] * hd, _lw);
    toCameraSpace(_lw[0], _lw[1], _lw[2], eye, view.yaw, view.pitch, _c2);
    cam.push([_c2[0], _c2[1], _c2[2]]);
  }

  const faces = [];
  for (let f = 0; f < BOX_FACES.length; f++) {
    const face = BOX_FACES[f], n = face.n;
    let vis;
    if (n[1] === 1) vis = ely > ly;
    else if (n[1] === -1) vis = ely < ly - h;
    else if (n[0] !== 0) vis = (elx - lx) * n[0] > hw;
    else vis = (elz - lz) * n[2] > hd;
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

// ---------------------------------------------------------------------------
// CAMERA COLLISION.
//
// The orbit arm is ~12 units long and swings straight through the tree line and
// the fence. When the eye ends up inside a box you see that box's INNER faces
// filling the frame -- which is exactly the "I can see through into the model"
// report. It is a camera problem, not a mesh problem, and no amount of remodelling
// fixes it. Measured on the default spawn view: tilting up put the eye inside
// `houseWall` AND a fence `rail` at once.
//
// Fix: march out from the target and stop short of the first obstruction, which is
// what every third-person camera does. Pulling IN keeps the target dead centre (the
// invariant the whole camera suite rests on) -- shoving the eye sideways would not.
// ---------------------------------------------------------------------------

export const CAM_PROBE_R = 0.34;   // clearance kept around the eye
export const CAM_MIN_PULL = 1.6;   // never closer, or you are inside the animal

function pointClearOf(x, y, z, boxes, r) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.infinite) continue;
    if (Math.abs(x - b.x) > b.w / 2 + r) continue;
    if (Math.abs(z - b.z) > b.d / 2 + r) continue;
    if (y > b.y + r || y < b.y - b.h - r) continue;
    return false;
  }
  return true;
}

/**
 * Largest usable orbit distance <= wantDist whose eye is clear of `boxes`.
 * Marches outward in fixed steps and returns the last clear sample, so the result
 * is monotone in wantDist and cannot jitter between frames the way a binary search
 * over a non-convex union can.
 */
export function clearOrbitDist(tx, ty, tz, yaw, pitch, wantDist, boxes, r = CAM_PROBE_R) {
  // Check the FULL distance first and return it exactly when clear. Marching in 0.3
  // steps alone left the camera permanently 0.3 short of what you asked for -- a
  // quantisation artifact that reported as "144 of 144 views needed a pull-in" when
  // the real answer was that none of them did.
  const full = cameraEye(tx, ty, tz, yaw, pitch, wantDist);
  if (pointClearOf(full.x, full.y, full.z, boxes, r)) return wantDist;

  const step = 0.3;
  let best = Math.min(CAM_MIN_PULL, wantDist);
  for (let dd = best; dd <= wantDist; dd += step) {
    const e = cameraEye(tx, ty, tz, yaw, pitch, dd);
    if (!pointClearOf(e.x, e.y, e.z, boxes, r)) break;
    best = dd;
  }
  return best;
}

/** Which box the eye is inside, or null. Must be null after a pull-in. */
export function eyeInsideBox(view, boxes, r = 0) {
  const e = view.eye;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.infinite) continue;
    if (Math.abs(e.x - b.x) <= b.w / 2 + r && Math.abs(e.z - b.z) <= b.d / 2 + r &&
        e.y <= b.y + r && e.y >= b.y - b.h - r) return b.kind || ('platform' + b.i);
  }
  return null;
}
