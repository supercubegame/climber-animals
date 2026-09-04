import { fnv1a } from './rng.mjs';
import { SPECIES } from './animal.mjs';
import {
  GRAVITY, JUMP_V, MOVE_SPEED, GROUND_ACCEL, AIR_ACCEL,
  TERMINAL_V, PLAYER_R, FIXED_DT, FLOOR_Y,
} from './constants.mjs';

// Namespace imports (`import * as C`) are deliberately avoided across the whole
// core: tools/build.mjs inlines these files by stripping import lines, and a
// `C.GRAVITY` reference would survive the strip and blow up at runtime.
export const DEFAULT_PHYS = {
  GRAVITY, JUMP_V, MOVE_SPEED, GROUND_ACCEL, AIR_ACCEL,
  TERMINAL_V, PLAYER_R, FIXED_DT, FLOOR_Y,
};

// The roster lives in animal.mjs with the models. Re-exported so the gate and the
// shell keep one import site.
export { SPECIES };

function approach(cur, target, maxDelta) {
  if (target > cur) return Math.min(cur + maxDelta, target);
  return Math.max(cur - maxDelta, target);
}

// Feet contact box. The 0.35 grace lets you keep a toe on the edge, which is what
// makes an Only Up climb feel fair instead of cruel. It is NOT a collision hull:
// platform SIDES are intentionally non-solid (see AGENTS.md invariants).
//
// `p.infinite` is the ground plane: solid at every x/z, so there is no invisible
// cliff at the edge of the farmyard. Its w/d still describe the scenery footprint
// and are used by the level generator, which is exactly why this has to be a flag
// rather than a very large w/d -- a huge w/d would also move platform 1 miles out.
function insideXZ(x, z, p, playerR) {
  if (p.infinite) return true;
  const g = playerR * 0.35;
  return Math.abs(x - p.x) <= p.w / 2 + g && Math.abs(z - p.z) <= p.d / 2 + g;
}

export function makePlayer(level, speciesId = 'cow') {
  const ground = level.platforms[0];
  return {
    x: level.spawn.x, y: ground.y, z: level.spawn.z,
    vx: 0, vy: 0, vz: 0,
    onGround: true, groundIdx: 0,
    bestY: ground.y, falls: 0, t: 0, steps: 0, won: false,
    airFromY: ground.y,   // height at the last takeoff, for measuring a fall
    lastDrop: 0,          // metres lost by the most recent landing
    dist: 0,              // horizontal distance walked, drives the walk cycle
    speciesId,
  };
}

// A landing only counts as a FALL if it cost you real height. With an infinite
// ground plane nothing teleports any more, so the old "went below FLOOR_Y" rule
// would have counted zero forever -- a stat frozen at 0 looks like a broken HUD.
export const FALL_METRES = 2.0;

/**
 * Pure: no I/O, no Date, no Math.random. Always advances exactly FIXED_DT.
 * Returns a NEW state object, so a state stack gives you undo/replay for free.
 * `phys` override exists for the gate's mutants only.
 */
export function stepPlayer(s, input, level, phys) {
  const P = phys ? { ...DEFAULT_PHYS, ...phys } : DEFAULT_PHYS;
  const dt = P.FIXED_DT;

  let { x, y, z, vx, vy, vz, onGround, groundIdx, bestY, falls, t, steps, won } = s;
  let airFromY = s.airFromY === undefined ? y : s.airFromY;
  let lastDrop = 0;
  let dist = s.dist || 0;
  const wasOnGround = onGround;

  let ix = input.mx || 0, iz = input.mz || 0;
  const l = Math.hypot(ix, iz);
  if (l > 1) { ix /= l; iz /= l; }
  const accel = (onGround ? P.GROUND_ACCEL : P.AIR_ACCEL) * dt;
  vx = approach(vx, ix * P.MOVE_SPEED, accel);
  vz = approach(vz, iz * P.MOVE_SPEED, accel);

  if (input.jump && onGround) { vy = P.JUMP_V; onGround = false; }

  const nx = x + vx * dt;
  const nz = z + vz * dt;
  let ny = y;

  if (onGround) {
    const p = level.platforms[groundIdx];
    if (p && insideXZ(nx, nz, p, P.PLAYER_R)) { ny = p.y; vy = 0; }
    else { onGround = false; vy = 0; }   // walked off the edge: start falling here
  }

  if (!onGround) {
    vy -= P.GRAVITY * dt;
    if (vy < -P.TERMINAL_V) vy = -P.TERMINAL_V;
    ny = y + vy * dt;

    // Swept landing against the TOP PLANE of every platform: we test whether the
    // segment y -> ny crossed p.y, not whether ny is inside a box. That is why
    // terminal-velocity falls cannot tunnel through a thin hay bale.
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
  // Safety net only. With an infinite ground plane this is unreachable, and it is
  // kept for the case where platform 0's `infinite` flag is off (the gate's own
  // negative control does exactly that). It no longer counts a fall itself: the
  // landing bookkeeping below also sees onGround go true, so incrementing here too
  // would double-count every rescue.
  let rescued = false;
  if (ry < P.FLOOR_Y) {
    rx = level.spawn.x; rz = level.spawn.z; ry = level.platforms[0].y;
    vx = 0; vy = 0; vz = 0; onGround = true; groundIdx = 0; rescued = true;
  }

  if (onGround && groundIdx === level.topIndex) won = true;

  // Takeoff / landing bookkeeping, so "falls" and the metres lost are facts the
  // core owns rather than something the renderer guesses at.
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
    airFromY, lastDrop, dist,
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
