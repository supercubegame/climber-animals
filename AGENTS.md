# AGENTS.md — Climber Animals: Together

Cute farm-themed Only Up style 3D vertical climber. Ships as **one HTML file**
that runs by double-clicking on Windows 11. No install, no internet, no build
step for the player.

The same content lives in `CLAUDE.md`; the gate byte-compares them, so edit both
or copy one onto the other.

## The one rule

**Never commit without a green gate.**

```
node tools/build.mjs          # regenerate climber-animals.html from src/
node tools/verify.mjs         # fast gate: zero deps, ~1s. It prints its own count.
node tools/verify-browser.mjs # slow gate: headless Chromium, needs puppeteer
```

CI runs both on every push and writes the per-check results back as a PR comment
and a commit comment. Read that comment; the raw CI log is not readable from the
agent side.

## Layout

```
climber-animals.html     GENERATED. Never hand-edit. The shipped deliverable.
src/core/rng.mjs         seeded PRNG + FNV-1a state hash
src/core/constants.mjs   every tunable, with the coupling groups spelled out
src/core/level.mjs       deterministic tower generator
src/core/player.mjs      the physics step
src/core/reach.mjs       reachability scanner (verification only, not shipped)
src/shell/template.html  renderer, input, HUD. Holds /* @INLINE:CORE */
tools/build.mjs          inlines core into the template; --check compares bytes
tools/verify.mjs         fast gate
tools/verify-browser.mjs slow gate
tools/scan.mjs           comment-aware scanner used by the offline-safety check
docs/PITFALLS.md         war stories: read this when the gate goes red
```

## Invariants

**The core is pure.** `src/core/*.mjs` must not touch the DOM, the filesystem,
the network, `Date`, or unseeded `Math.random`. `stepPlayer` returns a new state
object and always advances exactly `FIXED_DT`. This is what buys determinism
assertions, 60k-step stress runs in milliseconds, and free undo/replay if that
is ever wanted.

**Named imports only in the core.** `import * as X` breaks the inliner.

**`extentAlong` and `rayExitXZ` are not interchangeable.** The first is a
projection width, used to keep two platforms apart. The second is how far you can
walk before falling off. Using one where the other belongs is how every hop in
the reachability scan came to launch from mid-air; see `docs/PITFALLS.md`.

**`window.__game.nav()` returns raw numbers only.** No steering helper in shipped
code: the gate does the maths and sends real key events, so the input path is
under test instead of being graded against a helper written for it.

**Platform sides are deliberately not solid.** Only the top surface collides,
via a swept top-plane test between the previous and next `y`. That is why a
terminal-velocity fall cannot tunnel through a thin hay bale, and why brushing a
crate mid-jump does not kill your run. Do not "fix" this into a full AABB hull
without redoing the reachability numbers.

**There are no checkpoints.** Falling costs real height and that is the genre.
`phys:falling-costs-you-height` guards it.

**Jumping requires being grounded.** No double jump. Guarded.

## Coupled parameters — change one, recompute the group

| group | members | guard |
|---|---|---|
| jump arc vs vertical spacing | `GRAVITY`, `JUMP_V`, `MAX_JUMP_HEIGHT`, `GAP_Y_RATIO`, `GAP_Y_MAX` | `reach:every-segment-playable` + `phys:jump-gap-coupling-band` |
| air time vs horizontal spacing | `MOVE_SPEED`, `AIR_ACCEL`, `GAP_XZ_MAX`, platform size ranges | `reach:every-segment-playable` |
| fall speed vs step size | `TERMINAL_V`, `FIXED_DT` | `phys:no-tunneling-from-300m` |
| tab stall clamp | `MAX_SUBSTEPS`, `FIXED_DT` | shell loop clamp |
| HUD ids vs browser gate | `h-cur`, `h-best`, `h-falls`, `view`, `window.__game`, `camYaw`, `nav()` | `ship:browser-gate-hooks-present` |
| standing room vs separation | `rayExitXZ` (walkable), `extentAlong` (box separation) | `reach:launch-point-is-standable` + `geom:rayexit-differs-from-extent` |
| autopilot tuning vs physics | `EASE_RADIUS`, `EDGE_MARGIN`, `POLL_MS`, `MOVE_SPEED`, `JUMP_V` | `input:autopilot-climbs-the-tower` |

`MAX_JUMP_HEIGHT` and `GAP_Y_MAX` are **derived in code** on purpose. A
hand-typed copy of `JUMP_V²/2G` is a number that drifts in silence.

Note the guard for the first two groups is a simulation, not a formula. It
replays every hop with the real step function, so it also catches changes to the
collision code and the platform size tables. Deliberately impossible variants
(`reach:mutants-turn-it-red`) must make it go red, which is what stops it from
quietly becoming a decoration.

## Thresholds and where they came from

Every number below is a **measured** value with margin, not a guess. The gate
prints the live measurement each run; tighten from those, and if one has to be
loosened, say so out loud.

| threshold | measured | note |
|---|---|---|
| min peak clearance over target platform | ~0.89 | arc apex above the next top surface |
| longest flight | 95 steps | against a 600-step cap, so the cap never truncates |
| comment-strip retention | ~0.75 | floor is 0.40; below that the scan proves little |
| autopilot climb in 20s | platform 20 / 19.55m | offline replay against the core; floors set at half |
| browser tick rate | 72 per 600ms | implied by 60.0 fps in CI; floor is a third of it |
| `AGENTS.md` | see gate | hard cap 200 lines. Compress or split; do not raise it. |

## Adding a check

Any new verifiable behaviour gets an assertion in the same push. Before trusting
a new one, break the thing on purpose and confirm it goes red — an assertion that
has never failed has never been tested. If a rule here gets violated twice, it
belongs in the gate rather than in this file.

## Do not write counts into prose

No "N checks", no file counts, no job counts anywhere in this file, the README or
docs/. A number in prose does not get updated when the thing it describes changes,
and a stale explanation is worse than no explanation. The gate prints its own
totals and its own measured values; quote those instead.

## Known gaps

`docs/PITFALLS.md` ends with the list of things this project genuinely cannot
verify. Read it before adding a heuristic that claims to cover one of them.
