import { rayExitXZ } from './level.mjs';
import { stepPlayer, DEFAULT_PHYS } from './player.mjs';

const MAX_FLIGHT_STEPS = 600;

/**
 * For every consecutive platform pair, actually PLAY the jump with the real step
 * function. Couples JUMP_V / GRAVITY / MOVE_SPEED / AIR_ACCEL / gaps / sizes / the
 * collision code all at once; a formula would couple two of them and keep agreeing
 * with itself after the collision code changed. That mattered when side collision
 * landed: it is exactly the kind of change a formula would not have noticed.
 *
 * Running start plus a steering controller: arrive at the launch edge at MOVE_SPEED
 * aimed at B, jump on the first step, steer toward B's centre, ease off on top.
 * Launch from the RAY EXIT, the furthest point a player can actually stand -- using
 * the projection width put every launch outside the platform, in mid-air, closer to
 * the target than anyone could get.
 *
 * `bumps` counts wall contacts during the hop. Side collision could in principle
 * shave a jump; reporting the number means that shows up as a measurement rather
 * than as a mysterious unreachable segment.
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

    const edge = Math.max(0, rayExitXZ(a.w, a.d, dx, dz) - 0.05);
    const launchX = a.x + dx * edge, launchZ = a.z + dz * edge;
    let s = {
      x: launchX, y: a.y, z: launchZ,
      vx: dx * P.MOVE_SPEED, vy: 0, vz: dz * P.MOVE_SPEED,
      onGround: true, groundIdx: i,
      bestY: a.y, falls: 0, t: 0, steps: 0, won: false,
      airFromY: a.y, lastDrop: 0, dist: 0, bumped: 0, speciesId: 'cow',
    };

    let ok = false, steps = 0, peak = a.y, landedOn = -1, bumps = 0;
    for (let k = 0; k < MAX_FLIGHT_STEPS; k++) {
      let sx = b.x - s.x, sz = b.z - s.z;
      const sd = Math.hypot(sx, sz);
      if (sd > 0.2) { sx /= sd; sz /= sd; } else { sx = 0; sz = 0; }
      s = stepPlayer(s, { mx: sx, mz: sz, jump: k === 0 }, level, P);
      steps = k + 1;
      if (s.bumped) bumps++;
      if (s.y > peak) peak = s.y;
      if (k > 0 && s.onGround) { landedOn = s.groundIdx; ok = s.groundIdx >= i + 1; break; }
      if (s.falls > 0) { landedOn = -2; break; }
    }

    segments.push({
      from: i, to: i + 1, ok, steps, landedOn, bumps,
      launch: { x: launchX, z: launchZ, dx, dz, offset: edge, hw: a.w / 2, hd: a.d / 2 },
      gapY: +(b.y - a.y).toFixed(4),
      gapXZ: +b.gapXZ.toFixed(4),
      peakClearance: +(peak - b.y).toFixed(4),
    });
  }

  const failed = segments.filter((s) => !s.ok);
  const clearances = segments.map((s) => s.peakClearance);
  return {
    total: segments.length, failed,
    minClearance: Math.min(...clearances),
    maxGapY: Math.max(...segments.map((s) => s.gapY)),
    maxGapXZ: Math.max(...segments.map((s) => s.gapXZ)),
    totalBumps: segments.reduce((n, s) => n + s.bumps, 0),
    segments,
  };
}
