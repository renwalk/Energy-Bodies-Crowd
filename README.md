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
- **The visual no longer represents a body at all, and there's no emotion mapping.** Each tracked person gets
  one abstract, colorless wireframe orb: a point-cloud sphere (`TUNE.orb.rings` × `TUNE.orb.segments` grid,
  built once and shared by everyone). The 17 raw PoseNet keypoints are mapped onto 17 fixed points spread
  evenly around that sphere (an arbitrary, non-anatomical assignment via a Fibonacci lattice — see
  `KEYPOINT_POLE_DIR` in `js/sketch.js`). Each keypoint's live velocity locally bulges the sphere surface around
  its assigned point, so the orb morphs with movement — a raised hand or a stomping foot deforms one region of
  the globe — without ever reading as a human silhouette. The orb slowly auto-rotates so it reads as a volume
  even when still.
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
- `TUNE.orb.screenRadiusFrac` / `rotSpeed` — orb size (as a fraction of canvas height) and auto-rotation speed.

These defaults haven't been tuned against a live multi-person feed — start here and adjust after testing with
an actual crowd on the venue's camera and hardware.

## Where this could go next

This is intentionally the simplest possible version of the orb concept: a plain wireframe sphere, no color,
deformed only by raw per-keypoint velocity. Natural next steps, if/when wanted:
- Re-introduce some derived signal (e.g. overall movement energy) to drive orb color, glow, or point size,
  without going back to the full emotion-mapping model.
- Scale orb size by how close the person is to the camera (currently every orb is the same size regardless of
  depth).
- Depth-sort or clip back-facing mesh lines instead of just dimming them, for a cleaner 3D read at close range.

---

Adapted from the original single-person [Energy Bodies](https://github.com/renwalk/Energy-Bodies) project.
