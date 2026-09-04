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
  single hop is physically possible with a perfect steering controller. It does
  not prove the sequence is humanly comfortable.
- **Actions minutes burned.** Billing pages are not readable from here; any
  number quoted for cost is an estimate, not a measurement.
