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
- **One mirrored image for the whole room, and no emotion mapping.** A vertical mirror line runs down the middle
  of the screen. Everything is drawn on one side and reflected onto the other — as one exact mirror image — and the
  whole image always fits inside the screen. **Each person is a column** of shapes stacked down the screen: the
  first person detected is the column against the mirror line, and every additional person adds a column further
  out. The columns re-space as people come and go. Nothing rotates.

  | Property | Driven by |
  |---|---|
  | **Columns** | One per person detected |
  | **Shapes in a column** | That person's number of tracked body points (of PoseNet's 17), rounded up to an even number and split across the two sides — a full body is 9 per side, an upper body 6 |
  | **Form** | That person's **body shape**, not their movement — as a continuous blend of three forms: **round** = soft and relaxed (slumped, leaning, bent limbs), **boxy** = rigid and upright (vertical spine, level shoulders, straight arms and legs), **wedge** = asymmetrical (left and right sides don't mirror each other — an arm raised, a shoulder dropped) |
  | **Color** | Stillness vs. motion: blue when still, through violet, to red when moving |

  **Every shape is one continuous line** — a spiral that starts on the outer edge and winds inward. The round, boxy
  and wedge forms are three versions of the same spiral with the same number of points, so any mix of the three is
  also a valid spiral. That is what lets a person's shapes *morph* from one form to another as their body shape
  changes, gliding over several seconds, instead of one shape disappearing and another appearing. A slow drifting
  wobble runs through every line even when the person is perfectly still, so the whole image is in constant, gentle
  flux. Shapes are translucent so overlapping ones show through each other, and each form is rescaled to fill its
  cell exactly, which is what guarantees nothing can poke off the screen.

  The number of shapes in a column glides too: when body points are gained or lost, the shapes slide to their new
  spacing and a shape being gained grows from nothing (or one being lost shrinks away) rather than popping.

  Movement is tuned to be calm: columns, spacing, color, form and shape count all glide with a critically damped
  spring (starts gently, no lurch, no overshoot), and the movement reading behind the color is quick to notice
  motion but slow to let go. Posture is read slowly too, so a passing gesture doesn't change the form. People fade
  in and out rather than popping.

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
  reads as "fully activated." Lower this if people barely register as moving (everything stays blue squares);
  raise it if small movements already read as fully in motion.
- `TUNE.kaleido.reflectionsFrom` — `'bodyPoints'` (default): the number of shapes in a column comes from that
  person's tracked body points. `'people'`: one per person detected instead.
- `TUNE.kaleido.asymThreshold` / `rigidThreshold` / `formSoftness` — where the form is half-way to a wedge (by
  asymmetry) and half-way to boxy (by rigidity), and how wide those transitions are. **These are estimates, not
  calibrated against real people** — if everyone comes out boxy, raise `rigidThreshold`; if relaxed people drift
  toward wedges, raise `asymThreshold`. `symDeadzone` / `symFull` set how much left/right mismatch counts, and
  `spineFullDeg` / `shoulderFullDeg` / `bentDeg` / `straightDeg` set what counts as tilted, un-level, bent and
  straight.
- `TUNE.kaleido.wobble` / `flux` — how far each line's outline wanders and how fast (the "constant flux").
- `TUNE.kaleido.motionFullMean` — how much movement reads as fully "in motion" (fully red). Movement now only affects color.
- `TUNE.kaleido.hueStill` / `hueMoving` / `saturation` / `brightness` / `opacity` — the color range and look.
- `TUNE.kaleido.overlap` — how much bigger each shape is than its cell (1.0 = neighbors just touch; higher = more
  overlap). Together with `opacity` (lower = more see-through, but murkier color on black) this sets how much
  overlap you see.
- `TUNE.kaleido.maxBandFrac` — how wide a shape may get, as a fraction of the screen height. It keeps shapes from
  stretching into flat ovals when only a few people are present; with many people the columns simply share the
  width. `margin` is the empty border around the image.
- `TUNE.kaleido.smooth` — **the main calm/lively dial.** Roughly how many seconds each of these takes to glide to a
  new value: a column moving, the spacing between columns, the color, the overall fit, how fast a shape morphs
  between forms (`form`), and how fast a column gains or loses a shape (`count`). Bigger = slower and calmer.
- `TUNE.kaleido.motionAttack` / `motionRelease` — how quickly the movement reading rises when someone starts moving
  and falls when they stop. Lower release = color and shape linger longer before settling back.
- `TUNE.kaleido.countDebounceMs` / `fadeInMs` — how long a new shape count must hold before the column starts
  gliding to it, and how slowly a new person fades in.

These defaults haven't been tuned against a live multi-person feed — start here and adjust after testing with
an actual crowd on the venue's camera and hardware.

## Where this could go next

- Two-tone: the sketches often use a different color on each side of the mirror — e.g. still on one side, moving on
  the other.
- More kinds of form (ears, lips, bowls, zigzags like in the sketches) — the forms are just per-point radius
  profiles for the spiral (`SPIRAL` in `js/sketch.js`), so adding one means adding a profile and a posture cue to
  blend it in with.
- Use a person's position or distance from the camera (both are tracked) to place or size their column.
- Add motion back in (a slow drift or breathing in the strokes, for example).

The earlier versions are on other branches and tags: `multiple` holds a kaleidoscope of 3D orbs per person, and the
tag `v4-kaleidoscope-orbs` marks its final state. The circular, one-ring-per-person kaleidoscope that preceded this
mirrored layout is in this branch's git history (commit `0c2c806`).

---

Adapted from the original single-person [Energy Bodies](https://github.com/renwalk/Energy-Bodies) project.
