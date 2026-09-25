# Energy Bodies — Crowd Edition

A multi-person variant of [Energy Bodies](https://github.com/renwalk/Energy-Bodies), the p5.js + ml5 PoseNet
installation that translates movement into a living visual form. This version tracks **everyone in frame at
once** and gives each person their own simple blob, instead of following a single participant.

## What changed from the single-person version

- **PoseNet runs in `detectionType: 'multiple'` mode**, returning one skeleton per detected person each frame.
- **A lightweight nearest-neighbor tracker** ([js/sketch.js](js/sketch.js), `matchPeopleToPoses`) assigns each
  skeleton a stable id across frames — PoseNet itself has no concept of identity, so this is what keeps one
  person's blob from swapping with someone else's as poses shuffle order frame to frame. A tracked person who
  isn't matched to a skeleton for `personTimeoutMs` (default 1s) is dropped.
- **The visual no longer represents a body, and there's no emotion mapping.** Each tracked person's base form
  is an abstract, colorless wireframe orb: a point-cloud sphere (`TUNE.orb.rings` × `TUNE.orb.segments` grid,
  built once and shared by everyone). The 17 raw PoseNet keypoints are mapped onto 17 fixed points spread
  evenly around that sphere (an arbitrary, non-anatomical assignment via a Fibonacci lattice — see
  `KEYPOINT_POLE_DIR` in `js/sketch.js`), and each keypoint's velocity bulges the surface around its point.
- **Each person's orb is the motif of a kaleidoscope**, ported from the moonflower sketch (rings of mirrored
  copies, alternate rings offset half a segment, alternate copies mirrored, each rotated in place). Every
  kaleidoscope parameter comes from that person's body:

  | Kaleidoscope property | Driven by |
  |---|---|
  | **x, y** | Torso-weighted body center (weighted by keypoint presence, so raising an arm doesn't drag the flower around) |
  | **z → size** | PoseNet has no depth, so apparent body size (shoulder width, or torso length when hips are visible) stands in for distance: closer = bigger orb. Ring spacing scales with it. |
  | **Reflections** | Visible body regions × 2, mirrored left/right. The six original regions — head, neck, arms/hands, chest, abdomen, legs/feet — count as present when the keypoints that define them are visible, so a full body gives 12 and an upper body only gives 8. A change must hold 600ms, then cross-fades in. |
  | **Angle** | Left/right asymmetry of the pose: each left joint is mirrored across the body's own axis (shoulders → spine) and compared to its right counterpart. Symmetric = 0°; a raised arm or dropped shoulder twists every copy (up to 180°). |
  | **Rings** | Total movement energy — the sum of every keypoint's 0–1 activation, so more body parts moving = more rings (capped at 5). The outermost ring fades in as energy climbs. Zero energy = just the base orb. |
  | **Opacity** | Stillness vs. motion: faint when still, solid when moving (`invertOpacity` flips this). |
  | **Speed** | Mean velocity of the keypoints that are actually moving → kaleidoscope rotation rate and the orb's own 3D spin. |

  Rendering: each orb is drawn once per frame into a per-person offscreen buffer and stamped for the base form
  and every reflection, which is what keeps dozens of copies per person cheap.
- **No manual sliders, no emotion/region dashboard.** The single-person project let a facilitator hand-tune one
  participant's emotion/region values from an iPad. There's no equivalent concept here — `control.html` is a
  read-only dashboard: live headcount, average crowd movement, and a simple "crowd map" showing one dot per
  tracked person (colored by their id — that per-person color is a dashboard-only convenience; the orb itself
  has no color). Start / Stop / Reset / Print still work the same way.
- **Session averaging and the print receipt are crowd-level and minimal.** A session tracks peak/average
  headcount plus average crowd movement over the session; Print captures the current display plus that summary.

## Architecture

Same shape as the original project:

- **`display.html`** — runs on the machine connected to the projector/screen and the room-facing camera. Loads
  `js/eb-init.js` then `js/sketch.js`, which does the actual webcam capture, PoseNet inference, and rendering.
- **`control.html`** — the facilitator's dashboard (iPad or any browser on the same network).
- **`server.js`** — a tiny WebSocket relay (`ws`) on port 8080 that broadcasts messages between Display and
  Control. Both pages connect to `ws://<host-ip>:8080`.

```
Control (dashboard)  <---- ws://host:8080 ---->  Display (camera + renderer)
```

## Running it

```bash
npm install
node server.js
```

Then serve the static files (any static server works — e.g. `npx http-server -p 8000`) and open:

- `display.html` on the machine driving the projector (grant camera access when prompted)
- `control.html` on the facilitator's device, pointed at the same host

Both pages find the WebSocket relay automatically using `location.hostname`, so as long as they're opened via
the same machine's IP (not two different `localhost`s) they'll find each other. If you're running everything
on one machine, open both pages via `http://<that machine's hostname or IP>:<port>/...` (not by double-clicking
the files) — a `file://` page can't resolve a hostname for the WebSocket and may also be blocked from the
camera.

## Tuning for a venue

Everything performance/visual-related lives in the `TUNE` object at the top of `js/sketch.js`:

- `TUNE.tracking.maxPeople` — hard cap on simultaneously tracked people (also passed to PoseNet as
  `maxPoseDetections`). Lower this on slower hardware.
- `TUNE.tracking.matchRadiusFrac` / `personTimeoutMs` — how forgiving the tracker is about people moving
  quickly or briefly occluding each other.
- `TUNE.point.posSmoothing` — how snappy vs. smoothed each tracked keypoint is relative to the raw detection.
  Higher = more responsive, but jitterier.
- `TUNE.point.velNormMax` — the keypoint speed (normalized per-frame, relative to the video's diagonal) that
  reads as "fully activated." Lower this if the orb isn't bulging enough; raise it if it looks maxed out from
  small movements.
- `TUNE.orb.rings` / `segments` — mesh density. More = a denser-looking grid, more GPU/CPU cost per person.
- `TUNE.orb.bumpScale` / `bumpSigma` — how far a fully-activated keypoint bulges the surface, and how wide
  (angularly) that bulge spreads across neighboring mesh points.
- `TUNE.orb.bumpSmoothing` — how snappy vs. smoothed the morph itself is.
- `TUNE.kaleido.baseRadiusFrac` / `ringSpacing` / `maxRings` — size of the base orb at baseline distance, how far
  apart the rings sit, and the cap on the flower's size (the biggest lever for how much of the screen one
  person takes up).
- `TUNE.kaleido.baselineShoulderFrac` / `sizeMin` / `sizeMax` — what apparent body size counts as "baseline
  distance", and how far the size can grow or shrink from it. **Set `baselineShoulderFrac` for your camera and
  room first** — it's the shoulder width, as a fraction of the video width, of someone at a typical distance.
- `TUNE.kaleido.energyToRings` — rings gained per unit of movement energy (1.0 = one fully-activated keypoint
  per ring).
- `TUNE.kaleido.motionFullMean` / `opacityStill` / `opacityMoving` / `invertOpacity` — how much movement reads as
  "fully in motion", and the opacity range between still and moving.
- `TUNE.kaleido.symDeadzone` / `symFull` / `angleMax` — how much left/right mismatch is forgiven as symmetric,
  what reads as fully asymmetric, and the maximum in-place rotation.
- `TUNE.kaleido.idleSpin` / `spinGain` / `idleRingSpin` / `ringSpinGain` — rotation rates when still and how
  much velocity adds.
- `TUNE.kaleido.regionOn` / `regionOff` / `reflDebounceMs` — how eagerly a body region counts as present, and
  how long a change must hold before the reflection count changes.
- `TUNE.kaleido.ease` — per-frame easing of each drawn value toward its pose-derived target.

These defaults haven't been tuned against a live multi-person feed — start here and adjust after testing with
an actual crowd on the venue's camera and hardware.

## Where this could go next

- Per-region modulation: each reflection segment currently just counts a body region; it could also respond to
  that region's own movement.
- Depth-sort or clip back-facing mesh lines instead of just dimming them, for a cleaner 3D read at close range.
- Re-introduce color (e.g. from energy or velocity) now that the structure is in place.

---

Adapted from the original single-person [Energy Bodies](https://github.com/renwalk/Energy-Bodies) project.
