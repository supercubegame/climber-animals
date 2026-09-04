import { fnv1a } from './rng.mjs';
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

export const SPECIES = [
  { id: 'cow',     name: 'Cow',     body: '#f6f2ea', spot: '#3b3630', face: '#f9b4c0' },
  { id: 'chicken', name: 'Chicken', body: '#f7e07a', spot: '#e0a52c', face: '#e5493a' },
  { id: 'sheep',   name: 'Sheep',   body: '#efe9df', spot: '#c9bfae', face: '#4a423b' },
  { id: 'pig',     name: 'Pig',     body: '#f4a7b4', spot: '#d97e91', face: '#e8879a' },
];

function approach(cur, target, maxDelta) {
  if (target > cur) return Math.min(cur + maxDelta, target);
  return Math.max(cur - maxDelta, target);
}

// Feet contact box. The 0.35 grace lets you keep a toe on the edge, which is what
// makes an Only Up climb feel fair instead of cruel. It is NOT a collision hull:
// platform SIDES are intentionally non-solid (see AGENTS.md invariants).
function insideXZ(x, z, p, playerR) {
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
    speciesId,
  };
}

/**
 * Pure: no I/O, no Date, no Math.random. Always advances exactly FIXED_DT.
 * Returns a NEW state object, so a state stack gives you undo/replay for free.
 * `phys` override exists for the gate's mutants only.
 */
export function stepPlayer(s, input, level, phys) {
  const P = phys ? { ...DEFAULT_PHYS, ...phys } : DEFAULT_PHYS;
  const dt = P.FIXED_DT;

  let { x, y, z, vx, vy, vz, onGround, groundIdx, bestY, falls, t, steps, won } = s;

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
  if (ry < P.FLOOR_Y) {
    rx = level.spawn.x; rz = level.spawn.z; ry = level.platforms[0].y;
    vx = 0; vy = 0; vz = 0; onGround = true; groundIdx = 0; falls += 1;
  }

  if (onGround && groundIdx === level.topIndex) won = true;

  return {
    x: rx, y: ry, z: rz, vx, vy, vz,
    onGround, groundIdx,
    bestY: ry > bestY ? ry : bestY,
    falls, t: t + dt, steps: steps + 1, won,
    speciesId: s.speciesId,
  };
}

const q = (n) => Math.round(n * 1e4) / 1e4;

export function hashState(s) {
  return fnv1a([
    q(s.x), q(s.y), q(s.z), q(s.vx), q(s.vy), q(s.vz),
    s.onGround ? 1 : 0, s.groundIdx, q(s.bestY), s.falls, s.steps, s.won ? 1 : 0,
  ].join('|'));
}

export function isFinitePlayer(s) {
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'bestY', 't']) {
    if (!Number.isFinite(s[k])) return false;
  }
  return true;
}
