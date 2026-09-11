# Energy Bodies — Crowd Edition

A multi-person variant of [Energy Bodies](https://github.com/renwalk/Energy-Bodies), the p5.js + ml5 PoseNet
installation that translates movement into a living visual form. This version tracks **everyone in frame at
once** and gives each person their own Energy Body, instead of following a single participant.

## What changed from the single-person version

- **PoseNet runs in `detectionType: 'multiple'` mode**, returning one skeleton per detected person each frame.
- **A lightweight nearest-neighbor tracker** ([js/sketch.js](js/sketch.js), `matchPeopleToPoses`) assigns each
  skeleton a stable id across frames — PoseNet itself has no concept of identity, so this is what keeps one
  person's Energy Body from swapping with someone else's as poses shuffle order frame to frame. A tracked
  person who isn't matched to a skeleton for `personTimeoutMs` (default 1s) is dropped.
- **Every tracked person gets their own Energy Body**: their own smoothed emotion/region values, their own pair
  of offscreen drawing buffers, drawn at their real position and depth (near/far) in the frame.
- **No manual sliders.** The single-person project let a facilitator hand-tune one participant's emotion/region
  values from an iPad. With an untracked crowd there's no single person to puppet, so `control.html` is now a
  read-only dashboard: live headcount, crowd-averaged emotion/motion bars, and a simple "crowd map" showing one
  dot per tracked person (sized by distance, colored by their strongest emotion). Start / Stop / Reset / Print
  still work the same way.
- **Session averaging and the print receipt are crowd-level.** A session tracks peak/average headcount plus the
  crowd's averaged emotion and motion readings over the session; Print captures the current display plus that
  summary.

Everything else — the pose→emotion math (velocity, structure, balance, posture lean → anxiety/calm/sadness/
fear/joy/anger), the region-coupling math (how much each body part widens), and the body-shape/emotion-texture
rendering — is the same approach as the original, just running once per tracked person instead of once globally.

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
the same machine's IP (not two different `localhost`s) they'll find each other.

## Tuning for a venue

Everything performance/visual-related lives in the `TUNE` object at the top of `js/sketch.js`:

- `TUNE.tracking.maxPeople` — hard cap on simultaneously tracked people (also passed to PoseNet as
  `maxPoseDetections`). Lower this on slower hardware.
- `TUNE.tracking.matchRadiusFrac` / `personTimeoutMs` — how forgiving the tracker is about people moving
  quickly or briefly occluding each other.
- `TUNE.visuals.anxiety.maxStrokes` / `TUNE.visuals.marbles.gridSpacing` — the biggest per-person GPU/CPU cost.
  Since these now run once per tracked person, turn them down first if frame rate drops with a full room.
- `TUNE.body` — each person's Energy Body size (`baseHeightFrac`) and proportions (`widthScale`/`heightScale`).

These defaults haven't been tuned against a live multi-person feed — start here and adjust after testing with
an actual crowd on the venue's camera and hardware.

---

Adapted from the original single-person [Energy Bodies](https://github.com/renwalk/Energy-Bodies) project.
