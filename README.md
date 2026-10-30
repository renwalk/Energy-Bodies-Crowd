# Energy Bodies — Crowd Edition

A multi-person variant of [Energy Bodies](https://github.com/renwalk/Energy-Bodies), the p5.js + ml5 PoseNet
installation that translates movement into a living visual form. This version tracks **everyone in frame at
once** and turns the room into one sheet of marbled ink, with each person shaping their own band of it, instead of
following a single participant.

## What changed from the single-person version

- **PoseNet runs in `detectionType: 'multiple'` mode**, returning one skeleton per detected person each frame.
- **A lightweight nearest-neighbor tracker** ([js/sketch.js](js/sketch.js), `matchPeopleToPoses`) assigns each
  skeleton a stable id across frames — PoseNet itself has no concept of identity, so this is what keeps one
  person's band of water from swapping with someone else's as poses shuffle order frame to frame. (Matching takes the
  closest person/skeleton pairs first, so when someone leaves it is the right person's band that goes.) A tracked person who
  isn't matched to a skeleton for `personTimeoutMs` (default 1s) is dropped.
- **Ink marbling.** The whole screen is a tray of water with ink floating on it: two translucent inks, dark and light grey, in soft bands that
  roll, fold and swirl, with a faint sheen where the waves catch the light. The dark ink is blue and the light ink is pink,
  and movement slides each along its own blue-to-pink range. Each person's waves are the *contours* of the ink; a storm drags the
  whole sheet into folds and whirlpools, like a comb pulled through it.
  A vertical mirror line runs down the middle, and the image is an exact mirror across it. **Each person owns a
  horizontal band** of the water running the full width of the screen: the first person is the bottom band and every
  additional person adds a band above it. The bands are spread evenly down the screen, so they always fill it
  whether there is one person or twelve, and they blend smoothly into one another.

  | Property | Driven by |
  |---|---|
  | **Bands** | One per person detected, spread evenly down the screen |
  | **Roughness** | That person's movement (see below): glassy when still, long smooth rolling waves for calm, slow movement, a storm of fine, fast, swirling texture for fast and abrupt movement |
  | **Number of waves** | That person's number of tracked body points (of PoseNet's 17): a full body gives about 5 waves up the screen, an upper body about 3. A storm packs in more, finer waves |
  | **Wave profile** | That person's **body shape**: **round** swells = soft and relaxed (slumped, leaning, bent limbs), **flat-topped** = rigid and upright (vertical spine, level shoulders, straight arms and legs), **pointed and leaning** = asymmetrical (an arm raised, a shoulder dropped). A continuous blend of the three — nothing switches |
  | **Color** | Stillness vs. motion: blue when still, through violet, to rose when moving |

  **What makes water stormy.** Three things roughen a band, and slow, steady movement — however large — triggers none
  of them: vigorous movement that keeps going; a *burst* (this moment's speed running well ahead of its own recent
  average, so a jolt roughens the water even from a standstill); and *jerk* (how erratically the speed changes — a
  smooth, flowing dance has a speed that rises and falls evenly, abrupt jabbing movement doesn't). A storm builds
  steadily and settles slowly. It changes the water in four ways at once: taller, steeper, more tightly packed waves;
  crossing wave trains that break straight crests into irregular peaks; a swirl that bends the water's own
  coordinates into turbulent currents; and brighter, finer caustics.

  **How it's drawn.** (Written for the earlier water version; the marbling reads the same wave field as contour lines
  of ink and then drags the coordinates around — a few slow sinusoidal currents plus up to three drifting whirlpools
  whose twist grows with the storm. Lines stay an exact mirror because everything depends on |x|.)
 The image is rendered on the GPU (WebGL), one pixel at a time: the water's height at each point
  is a blend of every person's waves weighted by how close the point is to that person's band; its slope gives the
  soft relief and its curvature gives the caustics. Every wave's height is its *slope* times its wavelength, so a
  storm can pack in as many fine waves as it likes without the surface ever getting steeper than the chosen
  steepness — that bound is what keeps it looking like water instead of spikes.

  Movement is tuned to be calm: band positions, color, wave profile, wave size and speed all glide with a critically
  damped spring (starts gently, no lurch, no overshoot), and a storm builds steadily and dies slowly. Wave phase only
  ever moves forward, so a change of speed can never make the water jump. A storm builds over a couple of seconds and
  fades over several, and its surge is only gently uneven, so even rough water rolls rather than jerks. The fastest storm
  texture moves at about 1 cycle per second, so it never gets strobe-like. People fade in and out rather than popping.
- **No manual sliders, no emotion/region dashboard.** The single-person project let a facilitator hand-tune one
  participant's emotion/region values from an iPad. There's no equivalent concept here — `control.html` is a
  read-only dashboard: live headcount, average crowd movement, and a simple "crowd map" showing one dot per
  tracked person. Start / Stop / Reset / Print still work the same way.
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

The water needs **WebGL**, which every current browser on a Mac supports. If it can't start, the display says so on
screen. Rendering happens on the GPU at `TUNE.water.resolution` of the screen size (default 0.75) and is stretched to
fit — lower it on slow hardware.

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
- **`TUNE.water.speed` and `TUNE.water.contrast` — the two master dials.** `speed` (default 1) scales how fast
  everything moves: waves, ripples and ink drift (0.5 = half speed). `contrast` (default 1) sets how bold the ink is:
  how far apart the dark and light inks are (default 0.55 = soft, translucent; up to 1.6 = deep charcoal on near-white). **Both can be changed live on the display machine:** press `,` / `.` for slower /
  faster and `-` / `=` for softer / bolder contrast — a small readout appears for a couple of seconds. Live changes
  last until reload, so copy the value you like into `TUNE.water`.
- `TUNE.water.resolution` — GPU render size relative to the screen (0.75 default). The biggest performance lever.
- `TUNE.water.steepness` — how steep a full-size wave is. The main "how rough can it get" dial: higher = rougher,
  brighter caustics. Water stays believable below about 1.
- `TUNE.water.ampCalm` / `ampSwell` / `stormAmpBoost` and `freqCalm` / `freqSwell` / `stormFreqBoost` — wave size and
  how often a crest passes, for still / vigorous / extra-in-a-storm. These set how different calm and stormy water look.
- `TUNE.water.chop` / `crestSharpen` / `gust` / `texture` — the crossing chop waves, how much a storm sharpens
  crests, how much a storm makes the surge uneven, and the fine ripple texture that is always present (0 = perfectly
  smooth when calm).
- `TUNE.water.inkDensity` / `inkLayers` / `inkLine` — how many ink bands follow each wave, how many even layers fill the
  screen height (more = finer stripes), and how wide the dark band is (0.25 = half dark, half light).
- `TUNE.water.dropSize` / `dropRing` / `ripples` / `rippleReach` — **one drop of ink per person**, living *inside* the flowing water: the
  currents carry and bend each drop (so its rim is never a perfect shape and drifts), the ink bands wrap and crowd around its rim as if
  it had been pushed aside, and each drop sends out its own concentric ripples (more body points = more ripples). Where drops overlap
  their ripples interfere, so every extra person adds a new set of overlapping waves; drops that run together become one pool. Each
  drop has its own place (off to one side of the mirror line, in their band), size and stretch, and — because the picture is mirrored —
  a twin on the other side, like butterfly wings. A drop grows slowly and a little with movement, and fades with the person.
  `dropSize` 0 = no drops; `ripples` 0 = no concentric waves.
- `TUNE.water.darkHueStill` / `darkHueMoving` / `darkSat` and `lightHueStill` / `lightHueMoving` / `lightSat` — **the colors**: the dark and light inks each have
  their own hue (degrees: 0 red, 215 blue, 270 violet, 320 rose, 340 pink) and strength (0 = grey, 1 = vivid). Movement slides each ink from
  its still hue to its moving hue; set the two equal for a fixed color.
- `TUNE.water.sheen` / `grain` — how much the waves catch soft light on the surface (0 = flat), and optional paper speckle (0 = none).
- `TUNE.water.dragCalm` / `dragStorm` / `flowCalm` / `flowStorm` — how far the ink is dragged (and how strongly the
  whirlpools twist) when calm / in a storm, and how fast those currents drift. Lower `dragStorm` for fewer whirlpools.
- `TUNE.water.bandOverlap` — how softly one person's band blends into the next.
- `TUNE.water.crestsPerPoint` / `stormCrestBoost` — waves up the screen per tracked body point, and how many more a
  storm packs in. `reflectionsFrom: 'people'` makes every band use one count per person instead.
- `TUNE.water.stormStart` / `burstFull` / `jerkFull` / `stormSustainedWeight` / `stormJerkWeight` / `stormBurstWeight`
  — how a storm is detected: how much sustained movement, sudden bursts and erratic speed each contribute, and what
  counts as a full burst or fully erratic. `stormAttack` / `stormRelease` set how quickly a storm builds and fades.
  **These are estimates, not calibrated against real people** — if everything is stormy, raise `stormStart` and
  `jerkFull`; if nothing ever gets rough, lower them.
- `TUNE.water.asymThreshold` / `rigidThreshold` / `formSoftness` — where a wave is half-way to pointed (by
  asymmetry) and half-way to flat-topped (by rigidity), and how wide those transitions are. Also uncalibrated: if
  every wave comes out flat-topped, raise `rigidThreshold`; if relaxed people drift toward pointed, raise
  `asymThreshold`. `symDeadzone` / `symFull` set how much left/right mismatch counts, and `spineFullDeg` /
  `shoulderFullDeg` / `bentDeg` / `straightDeg` set what counts as tilted, un-level, bent and straight.
- `TUNE.water.motionFullMean` — how much movement reads as fully "in motion". Drives color and wave size.
- `TUNE.water.smooth` — **the main calm/lively dial for transitions.** Roughly how many seconds each takes to glide
  to a new value: a band moving, the color, how fast the wave profile morphs (`form`), how fast the wave count
  changes (`count`), and how fast wave size, speed and storm rise (`ampUp` / `freqUp` / `stormUp`) and settle
  (`ampDown` / `freqDown` / `stormDown`). Bigger = slower and calmer.
- `TUNE.water.motionAttack` / `motionRelease` — how quickly the movement reading rises when someone starts moving
  and falls when they stop.
- `TUNE.water.countDebounceMs` / `fadeInMs` — how long a new wave count must hold before the water starts changing to
  it, and how slowly a new person's band builds.

These defaults haven't been tuned against a live multi-person feed — start here and adjust after testing with
an actual crowd on the venue's camera and hardware.

## Where this could go next

- Use a person's position in the frame to place their band (today bands are stacked in the order people were
  detected, so a person's place in the water doesn't follow where they stand).
- Currents that follow a person's actual limb movement, for example the direction a hand sweeps.
- Another stage of color beyond the blue-to-rose shift, if wanted.

Earlier versions are kept in git: the tag `v9-water` is the flowing-water version, the tag `v6-mirror-columns` is the mirrored image of columns of organic shapes
(one continuous morphing line each), the branch `multiple` is a kaleidoscope of 3D orbs per person, and the tag
`v4-kaleidoscope-orbs` marks that branch's final state.

---

Adapted from the original single-person [Energy Bodies](https://github.com/renwalk/Energy-Bodies) project.
