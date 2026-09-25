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
- **One image for the whole room, and no emotion mapping.** Instead of a visual per person, the display shows a
  single kaleidoscope (layout ported from the moonflower sketch) centered on the screen and spanning its full
  width. **Each person is one ring** — the first person detected is the innermost ring and every additional
  person adds a ring outward. Rings re-space themselves as people come and go, so the outermost always reaches
  the screen edges. Nothing rotates.

  | Kaleidoscope property | Driven by |
  |---|---|
  | **Rings** | One per person detected |
  | **Reflections** (copies around a ring) | That person's number of tracked body points (of PoseNet's 17), rounded up to an even number so the mirrored copies close up — a full body gives 18, an upper body 12 |
  | **Shape** | That person's movement: **square** = still, **triangle** = a few body parts moving (a waving hand), **circle** = most of the body moving |
  | **Color** | Stillness vs. motion: blue when still, through violet, to red when moving |

  Every other copy on a ring is mirrored and every other ring is offset half a segment, as in moonflower. A
  change to a ring's copy count or shape must hold for 600ms and then cross-fades in, so detection flicker never
  makes the image jump. People fade in and out rather than popping.
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
- `TUNE.kaleido.reflectionsFrom` — `'bodyPoints'` (default): each ring's copy count comes from that person's
  tracked body points. `'people'`: every ring gets one copy per person detected instead.
- `TUNE.kaleido.stillThreshold` / `wholeBodyFrac` — where "still" ends (square) and how much of the body has to be
  moving at once to count as whole-body (circle) rather than localized (triangle).
- `TUNE.kaleido.motionFullMean` — how much movement reads as fully "in motion" (fully red).
- `TUNE.kaleido.hueStill` / `hueMoving` / `saturation` / `brightness` / `opacity` — the color range and look.
- `TUNE.kaleido.ringFill` / `arcFill` — how large the shapes get relative to the gap between rings / between
  neighbors on a ring (1.0 / 0.5 = they just touch; raise for overlap).
- `TUNE.kaleido.layoutDebounceMs` / `layoutFadeFrames` — how long a new copy count or shape must hold, and how
  long the cross-fade takes.
- `TUNE.kaleido.ease` — how quickly rings glide into place and colors shift.

These defaults haven't been tuned against a live multi-person feed — start here and adjust after testing with
an actual crowd on the venue's camera and hardware.

## Where this could go next

- Decide what each shape should mean — the shape/movement mapping lives in one function (`classifyShape`).
- Use a person's position or distance from the camera (both are tracked) to place or size their ring.
- Add motion back in (rotation driven by velocity, for example).

The previous version — one kaleidoscope of 3D wireframe orbs per person — is preserved under the git tag
`v4-kaleidoscope-orbs`.

---

Adapted from the original single-person [Energy Bodies](https://github.com/renwalk/Energy-Bodies) project.
