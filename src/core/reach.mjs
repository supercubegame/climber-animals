import { rayExitXZ } from './level.mjs';
import { stepPlayer, DEFAULT_PHYS } from './player.mjs';

// Not inlined into the HTML shell (see tools/build.mjs INLINE_ORDER): this is a
// verification tool, not gameplay. Kept in src/core because it must be pure.

const MAX_FLIGHT_STEPS = 600;   // 5s at FIXED_DT; a 1.4m hop takes ~0.7s

/**
 * For every consecutive platform pair, actually PLAY the jump with the real
 * step function and check the player gets there. This is the assertion that
 * couples JUMP_V / GRAVITY / MOVE_SPEED / AIR_ACCEL / gap ranges / platform
 * sizes / the collision code all at once. A formula would only couple two of
 * them and would keep agreeing with itself after the collision code changed.
 *
 * Model: a running start plus a steering controller. The player arrives at the
 * edge of A already at MOVE_SPEED aimed at B, jumps on the first step, then
 * steers toward B's CENTRE and eases off once basically on top of it.
 *
 * The first version of this held full input for the whole flight and reported
 * 95/150 segments unreachable. The level was fine; the ruler was wrong -- full
 * throttle for 0.69s covers 4.28 units and sails clean past a 2-unit platform
 * sitting 1.8 units away. Red the ruler, not the product.
 */
export function scanReachability(level, phys) {
  const P = phys ? { ...DEFAULT_PHYS, ...phys } : DEFAULT_PHYS;
  const ps = level.platforms;
  const segments = [];

  for (let i = 0; i < ps.length - 1; i++) {
    const a = ps[i], b = ps[i + 1];
    let dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;

    // Launch from the furthest point a player can actually STAND on, not from the
    // box's projection width. See rayExitXZ() for why that distinction bit us.
    const edge = Math.max(0, rayExitXZ(a.w, a.d, dx, dz) - 0.05);
    const launchX = a.x + dx * edge, launchZ = a.z + dz * edge;
    let s = {
      x: launchX, y: a.y, z: launchZ,
      vx: dx * P.MOVE_SPEED, vy: 0, vz: dz * P.MOVE_SPEED,
      onGround: true, groundIdx: i,
      bestY: a.y, falls: 0, t: 0, steps: 0, won: false, speciesId: 'cow',
    };

    let ok = false, steps = 0, peak = a.y, landedOn = -1;
    for (let k = 0; k < MAX_FLIGHT_STEPS; k++) {
      let sx = b.x - s.x, sz = b.z - s.z;
      const sd = Math.hypot(sx, sz);
      if (sd > 0.2) { sx /= sd; sz /= sd; } else { sx = 0; sz = 0; }
      s = stepPlayer(s, { mx: sx, mz: sz, jump: k === 0 }, level, P);
      steps = k + 1;
      if (s.y > peak) peak = s.y;
      if (k > 0 && s.onGround) { landedOn = s.groundIdx; ok = s.groundIdx >= i + 1; break; }
      if (s.falls > 0) { landedOn = -2; break; }
    }

    segments.push({
      from: i, to: i + 1, ok, steps, landedOn,
      // reported so the gate can assert the launch point is somewhere a player
      // could actually stand, instead of re-deriving the formula and drifting
      launch: { x: launchX, z: launchZ, dx, dz, offset: edge, hw: a.w / 2, hd: a.d / 2 },
      gapY: +(b.y - a.y).toFixed(4),
      gapXZ: +b.gapXZ.toFixed(4),
      peakClearance: +(peak - b.y).toFixed(4),   // >0 means the arc cleared the target top
    });
  }

  const failed = segments.filter((s) => !s.ok);
  const clearances = segments.map((s) => s.peakClearance);
  return {
    total: segments.length,
    failed,
    minClearance: Math.min(...clearances),
    maxGapY: Math.max(...segments.map((s) => s.gapY)),
    maxGapXZ: Math.max(...segments.map((s) => s.gapXZ)),
    segments,
  };
}
