// COUPLED PARAMETERS. Changing one member of a group means recomputing the rest.
// The guard is not an equality assertion here, it is the reachability scan in
// tools/verify.mjs (checks/reach) driven by the real step function, plus two
// mutants that must turn it red. See AGENTS.md.

// --- physics ---
// Feel pass, v2.1: gravity up and jump velocity up together, keeping
// MAX_JUMP_HEIGHT within a few percent of its old value so the whole tower stays
// reachable, but cutting AIR TIME. A 2.33m hop used to last 0.85s, which floats;
// it is now 0.72s, which snaps. Air time is 2*JUMP_V/GRAVITY, so the ratio is the
// knob and MAX_JUMP_HEIGHT (= JUMP_V^2/2G) is what the level depends on.
// `phys:jump-is-snappier-but-the-tower-still-fits` asserts both halves, because
// moving one without the other either breaks the level or does nothing.
export const GRAVITY = 37;          // units/s^2
export const JUMP_V = 13.2;         // launch velocity, coupled with GRAVITY + GAP_Y_MAX
export const MOVE_SPEED = 6.6;      // coupled with GAP_XZ_MAX
export const GROUND_ACCEL = 60;     // units/s^2 toward target velocity
export const AIR_ACCEL = 40;        // weaker mid-air control, coupled with GAP_XZ_MAX
export const TERMINAL_V = 40;       // downward speed cap; keeps the sweep test sane
export const PLAYER_R = 0.42;       // horizontal half-extent used for landing tests
export const FIXED_DT = 1 / 120;    // the core only ever advances by this
export const MAX_SUBSTEPS = 8;      // shell-side clamp so a stalled tab cannot warp

// Derived on purpose: a hand-typed copy of this number would drift silently.
export const MAX_JUMP_HEIGHT = (JUMP_V * JUMP_V) / (2 * GRAVITY);

// --- level shape ---
// GAP_Y_RATIO is the one knob. It is deliberately far below 1.0: at 1.0 a jump
// only just grazes the next top surface with zero margin and zero air time left
// to travel horizontally.
export const GAP_Y_RATIO = 0.6;
export const GAP_Y_MIN = 0.55;
export const GAP_Y_MAX = MAX_JUMP_HEIGHT * GAP_Y_RATIO;
export const GAP_XZ_MIN = 0.5;
export const GAP_XZ_MAX = 2.5;      // edge-to-edge, coupled with MOVE_SPEED/AIR_ACCEL
export const PLATFORM_COUNT = 150;
export const REST_EVERY = 12;       // landmark / breather platform cadence
export const FLOOR_Y = -4;          // below this you are put back in the farm yard
export const DEFAULT_SEED = 20260904;
