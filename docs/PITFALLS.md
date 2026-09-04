# Pitfalls archive

Grows over time. `AGENTS.md` holds the standing instructions; this file holds the
war stories. Read it when the gate turns red or before touching the renderer.

## The reachability scanner was wrong before the level ever was

First version of `scanReachability` held full movement input for the entire
flight and reported **95 of 150 segments unreachable**. The level was fine. Full
throttle for the ~0.69 s of air time covers 4.28 units and sails clean past a
2-unit platform sitting 1.8 units away, so the animal landed back on the farm
yard every time.

Fix was a steering controller: aim at the target platform's centre, ease off
inside 0.2 units. Lesson, and it is the first thing to try every time: **when the
gate goes red, suspect the ruler before the product.**

## Every hop in the reachability scan started in mid-air

Round two, and worse than round one. The scan launched each hop from
`extentAlong(...)` units out from the platform centre. That function is a
**projection width** (correct for separating two boxes, which is what the level
generator uses it for) and it is not the distance you can walk before your feet
leave the platform. On a 7x7 pad heading 20 degrees off axis it says 4.49 while
the ray actually exits at 3.72.

Net effect: **150 of 150 launch points were outside the platform footprint**,
hovering closer to the target than any player can stand. Every hop was graded
easier than it is.

Fix: `rayExitXZ()` alongside `extentAlong()`, and the scan launches from the
ray exit. The tower survived the stricter ruler with zero unreachable segments,
so this was a bad ruler rather than a bad level. Guarded by
`reach:launch-point-is-standable`, which also proves it would catch the old
formula (`150/150`) so it cannot rot into a vacuous check.

## Two checks that could not fail

Both shipped green in v1.0 and both were worthless.

`boot:loop-running` asserted `ticks > 30` immediately after *waiting for*
`ticks > 30`. Its replacement, `loop:advances-over-time`, samples ticks, sleeps
600 ms of wall clock, and samples again. Only the second version can tell a live
loop from a frozen one.

Then, while writing the guard for the `extentAlong` bug above, the first draft
compared the two formulas on a **7x7 box at exactly 45 degrees** and printed
`4.950 vs 4.950`. On a square at 45 degrees they genuinely coincide: of every
angle available, that draft picked the one where the check proves nothing. The
version that shipped sweeps 91 angles across 4 box shapes and asserts both a
maximum divergence and the axis-aligned equality.

Lesson for both: an assertion you have never seen fail has never been tested.

## The autopilot: bunny hopping lands you in the gap

The browser gate needed to prove the animal can actually *climb*, not just jump
once. First design held `W` plus `Space` for the whole run: the core gates
jumping on being grounded, so holding Space is a legal bunny hop and horizontal
velocity survives a landing, which looked like exactly the running start the
scan assumes.

It never reached platform 1. Replaying the controller offline against the pure
core, across easing radii and poll intervals, showed why: jumping from the
platform *centre* means the arc peaks while still over the pad, and the descent
crosses the target's height out in the gap, 7.12 units from a platform 1.7 units
wide. Best height stuck at 2.28 m (one arc) with a fall every two seconds.

Working controller: steer toward the target, **release the sticks inside 1.0
units** so you stop overshooting a 2-unit pad at 6.2 units/s, and **only jump
within 0.8 units of the far edge**. Offline that reaches platform 20 / 19.55 m in
20 s with zero falls, and holds ~20 anywhere from 20 ms to 90 ms per poll,
collapsing past ~140 ms. Gate floors are set at half the measured value, and the
log prints the observed poll interval so a slow runner is diagnosable instead of
mysterious.

The real lesson is cheaper than it sounds: **the pure core let me fail this
design four times in milliseconds** before it ever touched a browser. That is
what purity buys.

## Why the shipped file is a copy, and why that is dangerous

The deliverable has to run by double-clicking on Windows 11. That means
`file://`, and over `file://`:

- ES module `import` is blocked by CORS, so `<script type="module">` is out
- a CDN `<script src="https://...">` needs internet, which defeats the point

So `tools/build.mjs` inlines `src/core/*.mjs` into the HTML. The shipped file is
a **copy of the truth**, which is exactly the structure that stays green while
the original drifts. The only defence is `build:shipped-html-matches-src`, which
rebuilds and byte-compares. Never hand-edit `climber-animals.html`.

Related trap: `import * as C from './constants.mjs'` survives the import-stripper
and leaves `C.GRAVITY` references that explode at runtime. The core uses named
imports only, and the build throws if an import survives.

## The comment stripper has two failure directions, not one

`ship:offline-safe` hunts for `https://` in shipped script. A naive
`/\/\/.*$/` line-comment regex eats the `//` in `"https://cdn..."` and reports a
clean sweep: a false green, the dangerous direction. A stripper that keeps
strings but drops comments also has to not flag a url that only appears in a
comment: a false red, which teaches people to delete comments to appease CI.

`tools/scan.mjs` is a character scanner, not a regex, and
`ship:scanner-self-test` proves **both** directions with two mutants. Known
limit: a regex literal containing `//` would confuse it. There is none in the
shell today.

## No GPU in CI, so there is no WebGL

This was the deciding factor for the renderer. Headless Chromium on a CI runner
has no GPU; WebGL either falls back to software or is missing outright, and
"canvas is blank" then means nothing. The renderer is a software 3D projection
onto Canvas2D: painter's algorithm, back-face culling by comparing camera
position against each box's face planes. Consequence: the browser gate can
assert real pixels, and the whole thing is one file with zero dependencies.

Camera transform signs were derived, not guessed. `toCam` rotates the world so
the camera's pitched forward axis lands on `+Z`; check it against
`R·(sin y, 0, cos y) = (0,0,1)` before "simplifying" anything.

## Things this project cannot verify

Honest list. Do not add a heuristic that pretends to cover these.

- **Whether it is fun.** No machine judges game feel. Randy plays it.
- **Real Windows 11 + Edge/Chrome.** CI runs headless Chromium on Linux. The
  file:// double-click path itself is only verified by static scan plus a
  headless file:// load, not by a real desktop.
- **High-DPI / ultrawide layout.** The HUD is checked for existence, not looks.
- **Sustained frame rate on real hardware.** The gate's fps floor only catches a
  dead loop; CI is software-rendered and shared-CPU, so it is not a benchmark.
- **Whether a human can actually climb the tower.** The scanner proves each
  single hop is physically possible with a perfect steering controller, and the
  browser autopilot proves a machine can chain a stretch of them. Neither says
  anything about whether a human hand can.
- **Actions minutes burned.** Billing pages are not readable from here; any
  number quoted for cost is an estimate, not a measurement.
