import { fnv1a } from './rng.mjs';
import { SPECIES } from './animal.mjs';
import {
  GRAVITY, JUMP_V, MOVE_SPEED, GROUND_ACCEL, AIR_ACCEL,
  TERMINAL_V, PLAYER_R, FIXED_DT, FLOOR_Y,
} from './constants.mjs';

export const DEFAULT_PHYS = {
  GRAVITY, JUMP_V, MOVE_SPEED, GROUND_ACCEL, AIR_ACCEL,
  TERMINAL_V, PLAYER_R, FIXED_DT, FLOOR_Y,
};
export { SPECIES };

// How tall the collision body is, and how big a lip you can walk straight over
// without jumping. STEP_UP is what stops side collision turning every 0.7m hay bale
// into a wall you have to jump; anything shorter you just walk onto.
export const BODY_H = 1.05;
export const STEP_UP = 0.34;

function approach(cur, target, maxDelta) {
  if (target > cur) return Math.min(cur + maxDelta, target);
  return Math.max(cur - maxDelta, target);
}

/**
 * Feet contact test. The 0.35 grace lets you keep a toe on the edge, which is what
 * makes an Only Up climb feel fair. `p.infinite` is the ground plane: solid at every
 * x/z, so there is no invisible cliff at the farmyard edge. It has to be a flag
 * rather than a huge w/d, because w/d is also the scenery footprint and the box the
 * reachability scan launches hop 0 from.
 */
function insideXZ(x, z, p, playerR) {
  if (p.infinite) return true;
  const g = playerR * 0.35;
  return Math.abs(x - p.x) <= p.w / 2 + g && Math.abs(z - p.z) <= p.d / 2 + g;
}

/**
 * SIDE COLLISION. Until v2.1 only the TOP face of a platform was solid, so you
 * could walk straight into a box and stand inside its volume -- which is what makes
 * a screenshot look like the animal is standing on a crate while the HUD reads 0.0m.
 *
 * The body is a square of half-width playerR (not a circle: the boxes are
 * axis-aligned, so a square keeps the push-out exact and cheap). A box only blocks
 * if its top is more than STEP_UP above your feet AND its bottom is below your head:
 * lower lips you walk over, and a platform overhead does not shove you sideways.
 *
 * Push-out is along the axis of SMALLEST penetration, which is the standard
 * resolution and the only one that does not teleport you around corners.
 */
function resolveSides(x, y, z, level, playerR) {
  const feet = y;
  const head = y + BODY_H;
  let px = x, pz = z;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (let i = 0; i < level.platforms.length; i++) {
      const p = level.platforms[i];
      if (p.infinite) continue;
      const top = p.y, bottom = p.y - p.h;
      if (top <= feet + STEP_UP) continue;   // a lip you can step over
      if (bottom >= head) continue;          // above your head
      const ox = p.w / 2 + playerR - Math.abs(px - p.x);
      if (ox <= 0) continue;
      const oz = p.d / 2 + playerR - Math.abs(pz - p.z);
      if (oz <= 0) continue;
      if (ox < oz) px += (px < p.x ? -ox : ox);
      else pz += (pz < p.z ? -oz : oz);
      moved = true;
    }
    if (!moved) break;
  }
  return { x: px, z: pz };
}

export function makePlayer(level, speciesId = 'cow') {
  const ground = level.platforms[0];
  return {
    x: level.spawn.x, y: ground.y, z: level.spawn.z,
    vx: 0, vy: 0, vz: 0,
    onGround: true, groundIdx: 0,
    bestY: ground.y, falls: 0, t: 0, steps: 0, won: false,
    airFromY: ground.y, lastDrop: 0, dist: 0, bumped: 0,
    speciesId,
  };
}

// A landing counts as a FALL only if it cost real height. With an infinite ground
// plane nothing teleports, so the old "went below FLOOR_Y" rule would read 0 forever
// and a stat frozen at zero looks like a broken HUD.
export const FALL_METRES = 2.0;

export function stepPlayer(s, input, level, phys) {
  const P = phys ? { ...DEFAULT_PHYS, ...phys } : DEFAULT_PHYS;
  const dt = P.FIXED_DT;

  let { x, y, z, vx, vy, vz, onGround, groundIdx, bestY, falls, t, steps, won } = s;
  let airFromY = s.airFromY === undefined ? y : s.airFromY;
  let lastDrop = 0;
  let dist = s.dist || 0;
  let bumped = 0;
  const wasOnGround = onGround;

  let ix = input.mx || 0, iz = input.mz || 0;
  const l = Math.hypot(ix, iz);
  if (l > 1) { ix /= l; iz /= l; }
  const accel = (onGround ? P.GROUND_ACCEL : P.AIR_ACCEL) * dt;
  vx = approach(vx, ix * P.MOVE_SPEED, accel);
  vz = approach(vz, iz * P.MOVE_SPEED, accel);

  if (input.jump && onGround) { vy = P.JUMP_V; onGround = false; }

  let nx = x + vx * dt;
  let nz = z + vz * dt;
  let ny = y;

  // Walls first, so the landing test below runs on a position that is already out
  // of any box we would otherwise be standing inside.
  const solved = resolveSides(nx, y, nz, level, P.PLAYER_R);
  if (solved.x !== nx || solved.z !== nz) {
    bumped = 1;
    if (solved.x !== nx) vx = 0;
    if (solved.z !== nz) vz = 0;
    nx = solved.x; nz = solved.z;
  }

  if (onGround) {
    const p = level.platforms[groundIdx];
    if (p && insideXZ(nx, nz, p, P.PLAYER_R)) { ny = p.y; vy = 0; }
    else { onGround = false; vy = 0; }
  }

  if (!onGround) {
    vy -= P.GRAVITY * dt;
    if (vy < -P.TERMINAL_V) vy = -P.TERMINAL_V;
    ny = y + vy * dt;

    // Swept against the TOP PLANE: did the segment y -> ny cross p.y? That is why a
    // terminal-velocity fall cannot tunnel through a thin hay bale.
    if (vy <= 0) {
      let hit = -1, hy = -Infinity;
      for (let i = 0; i < level.platforms.length; i++) {
        const p = level.platforms[i];
        if (y + 1e-9 >= p.y && ny <= p.y + 1e-9 && p.y > hy && insideXZ(nx, nz, p, P.PLAYER_R)) {
          hit = i; hy = p.y;
        }
      }
      if (hit >= 0) { ny = hy; vy = 0; onGround = true; groundIdx = hit; }
    }
  }

  let rx = nx, rz = nz, ry = ny;
  // Safety net only: unreachable with an infinite ground plane, kept for the case
  // where platform 0's `infinite` flag is off (the gate's negative control). It does
  // not count a fall itself -- the landing bookkeeping below already sees onGround
  // go true, so both firing would double-count every rescue.
  let rescued = false;
  if (ry < P.FLOOR_Y) {
    rx = level.spawn.x; rz = level.spawn.z; ry = level.platforms[0].y;
    vx = 0; vy = 0; vz = 0; onGround = true; groundIdx = 0; rescued = true;
  }

  if (onGround && groundIdx === level.topIndex) won = true;

  if (wasOnGround && !onGround) airFromY = y;
  if (!wasOnGround && onGround) {
    const drop = airFromY - ry;
    if (rescued || drop > FALL_METRES) { falls += 1; lastDrop = Math.max(drop, 0); }
  }
  if (onGround) dist += Math.hypot(rx - x, rz - z);

  return {
    x: rx, y: ry, z: rz, vx, vy, vz,
    onGround, groundIdx,
    bestY: ry > bestY ? ry : bestY,
    falls, t: t + dt, steps: steps + 1, won,
    airFromY, lastDrop, dist, bumped,
    speciesId: s.speciesId,
  };
}

const q = (n) => Math.round(n * 1e4) / 1e4;

export function hashState(s) {
  return fnv1a([
    q(s.x), q(s.y), q(s.z), q(s.vx), q(s.vy), q(s.vz),
    s.onGround ? 1 : 0, s.groundIdx, q(s.bestY), s.falls, s.steps, s.won ? 1 : 0,
    q(s.dist || 0),
  ].join('|'));
}

export function isFinitePlayer(s) {
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'bestY', 't']) {
    if (!Number.isFinite(s[k])) return false;
  }
  return true;
}

/** Which platform the body is inside, or -1. Must always be -1. */
export function insideAnyPlatform(s, level, playerR = PLAYER_R) {
  for (const p of level.platforms) {
    if (p.infinite) continue;
    const top = p.y, bottom = p.y - p.h;
    if (top <= s.y + 1e-6) continue;
    if (bottom >= s.y + BODY_H) continue;
    if (Math.abs(s.x - p.x) < p.w / 2 + playerR - 1e-6 &&
        Math.abs(s.z - p.z) < p.d / 2 + playerR - 1e-6) return p.i;
  }
  return -1;
}
