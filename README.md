# Climber Animals: Together — v1.0

A cute farm-themed **Only Up** style 3D vertical climber. Pick a cow, chicken,
sheep or pig and hop your way up a 140 m tower of hay bales, crates, barrels,
milk cans, silos and clouds. **There are no checkpoints.** Miss a jump and you
fall back down through the farm, exactly as far as gravity says.

## Play on Windows 11

1. Download **`climber-animals.html`**
2. Double-click it

That is the whole install. It opens in Edge (or Chrome / Firefox) and runs
offline — no server, no internet, no dependencies, nothing to build. Everything
including the 3D renderer lives in that one file.

### Controls

| key | action |
|---|---|
| `W A S D` / arrows | move, relative to the camera |
| `Space` | jump — only works with your feet on something |
| `Q` `E` or drag the mouse | turn the camera |
| mouse wheel | zoom |
| `1 2 3 4` | swap animal |
| `R` | back to the farm yard (your best height is kept) |

The HUD shows current height, best height, how many times you have fallen, and
how far the top is. The soft ellipse under you is your landing shadow — that is
how you judge a hop.

## How it looks under the hood

No WebGL, no three.js. The world is drawn with a **software 3D projection onto
Canvas2D**: every farm prop is a box, back faces are culled by comparing the
camera against each face plane, and everything is painted far-to-near. Two
reasons, both practical: a vendored engine would not fit the "one file, works
offline" promise, and CI runners have no GPU, so a WebGL build could not be
verified by machine at all.

Physics and level generation are a **pure core** (`src/core/`) — no DOM, no
network, no `Date`, no unseeded randomness, fixed 1/120 s timestep, immutable
state. The same seed always builds the same tower.

## Working on it

```bash
node tools/build.mjs     # regenerate climber-animals.html from src/
node tools/verify.mjs    # fast gate: 22 checks, zero dependencies, ~1s
npm i puppeteer && node tools/verify-browser.mjs   # slow gate: headless Chromium
```

`climber-animals.html` is **generated**. Edit `src/core/*.mjs` or
`src/shell/template.html` and rebuild; the gate byte-compares the shipped file
against a fresh build, so a hand-edit turns CI red.

The gate's load-bearing check is `reach:every-segment-playable`: it replays every
single hop in the tower with the real physics step and a steering controller, over
six seeds and 900 segments, and fails if any platform is unreachable. Four
deliberately impossible variants must make it fail, which is what keeps it from
degrading into a decoration.

See `AGENTS.md` for the invariants and coupled parameters, and `docs/PITFALLS.md`
for what went wrong on the way here and what this project genuinely cannot verify.
