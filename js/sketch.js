/* ============================================================================
   ENERGY BODIES — CROWD EDITION — DISPLAY SKETCH (v12: ink floating on water)
   One image for the whole room: the screen is a sheet of ink floating on water — bands of a dark and a
   light translucent ink that flow, fold and swirl into each other.
     - PoseNet runs in 'multiple' detection mode and a lightweight nearest-neighbor
       tracker gives each person a stable id across frames
     - Each person owns a HORIZONTAL BAND of the sheet, running the full width of the
       screen. The first person is the bottom band; every additional person adds a band
       above it. The bands are spread evenly down the screen, so they always fill it,
       and they blend smoothly into one another. A vertical mirror line runs down the
       middle of the screen
     - Movement sets how disturbed the ink is. Still = long, smooth, gently waving lines;
       calm, slow movement = rolling marbled ripples; fast and abrupt movement = ink dragged
       into folds and whirlpools, building steadily and settling slowly
     - Body shape sets the wave profile (which shapes the ink's lines): soft and relaxed =
       rounded, rigid and upright = flat-topped, asymmetrical = pointed and leaning
     - The number of body points sets how many waves there are; stillness vs motion
       sets the color: blue (calm) -> violet -> rose (stormy)
     - Rendered on the GPU (WebGL). The wave field is the same as the earlier water version
       (tag v9-water); the marbling reads it as contour lines of ink
   IMPORTANT: Load eb-init.js BEFORE this file!
   ============================================================================ */

if (typeof window.beginSession !== 'function') {
  console.error('[SKETCH] ERROR: eb-init.js must be loaded first!');
}

/* =============================
   0) MASTER TUNING CONSTANTS
   ============================= */
const TUNE = {
  // Run on its own: start tracking as soon as the display loads, and ignore Stop / Reset from the control page, so the water just keeps
  // running. Set to false to go back to starting and stopping it from the control page.
  autoRun: true,
  tracking: {
    maxPeople: 12,          // PoseNet maxPoseDetections — also the most rings there can be
    scoreThreshold: 0.4,
    matchRadiusFrac: 0.3,   // fraction of video diagonal — how far a skeleton can drift frame-to-frame and still count as the same person before falling back to nearest-available matching (see matchPeopleToPoses)
    personTimeoutMs: 1000   // how long a person can go undetected before their ring is dropped
  },
  point: {
    kpMinScore: 0.4,      // ignore keypoints PoseNet isn't confident about
    posSmoothing: 0.02,   // how quickly a point's tracked position catches up to the raw detection (lower = smoother, more lag)
    velEMA: 0.18,          // smoothing on each point's own velocity reading (lower = smoother, more lag)
    velDeadzone: 0.0025,  // raw per-frame velocity below this is treated as 0 — absorbs PoseNet's baseline detection jitter on a still body
    velNormMin: 0.0,      // velocity (normalized by video diagonal per frame) that reads as "still"
    velNormMax: 0.05,     // velocity that reads as "fully activated"
    presenceInRate: 0.3,  // how fast a keypoint fades IN once PoseNet is confident about it again
    presenceOutRate: 0.12 // how fast a keypoint fades OUT when lost — slow, so a borderline/flickering detection doesn't pop on and off
  },
  water: {
    // --- the water: a flowing texture filling the screen. Each person owns a horizontal band of it. ---
    resolution: 0.75,       // GPU render size relative to the screen (1 = full; lower is faster and a little softer)
    maxPixels: 800000,      // never render more than this many pixels, however big the screen (the cost grows with pixels; a big display at 0.75 can be several million)
    autoQuality: true,      // if the display can't keep up (under ~45 fps for a few seconds) it lowers its own render size until it can, so the motion stays fluid
    speed: .02,             // MASTER SPEED: scales how fast everything moves (waves, ripples, ink drift). 0.5 = half speed. Live: , and .
    contrast: 0.55,         // MASTER CONTRAST: how far apart the dark and light inks are (0 = nearly the same, 0.55 = soft, translucent ink on water, 1.6 = deep charcoal on near-white). Live: - and =
    bandOverlap: 0.9,       // how softly one person's band blends into the next (bigger = wider blend)
    steepness: 0.6,         // how steep a full-size wave is (slope: height / half-wavelength). Higher = rougher, brighter caustics
    hMax: 1.5,              // soft ceiling on wave height, so even a violent storm stays sane
    wavelengthSpan: 2.0,    // the height of the screen in the shader's units; crests are counted across this
    caustics: 0.05,         // how strongly waves focus light into bright webs (0 = none)
    glow: 1.0,              // brightness of the caustic webs
    texture: 0.1,          // fine ripple texture that is always present, even in glassy-calm water (0 = perfectly smooth)
    // --- how a wave responds to its person: calm = smooth rolling swell, storm = steep, choppy, fast ---
    ampCalm: 1, ampSwell: 1.25, stormAmpBoost: 0.5,     // wave height: still / vigorous / extra in a storm
    freqCalm: 0.10, freqSwell: 0.30, stormFreqBoost: 0.35, // how often a crest passes (per second): still / vigorous / extra in a storm
    crestsPerPoint: 0.55,   // waves up the screen per tracked body point (a full body of 17 points = 5 across the screen, 11 points = 3)
    stormCrestBoost: 0.9,   // a storm packs in more, finer waves
    inkDensity: 1.1,        // ink layers (contour lines) per wave height: more = finer, busier lines
    inkLayers: 26,         // even layers of ink across the whole screen height: more = finer, busier bands (even where the water is flat)
    // --- the two inks: dark = blue, light = white (with pink coming in as people move). Each has its own hue (degrees: 0 red, 215 blue, 270 violet, 320 rose, 340 pink) and strength.
    //     Movement slides each ink from its "still" hue to its "moving" hue. Set a still and moving hue equal for a fixed color.
    darkHueStill: 215, darkHueMoving: 245, darkSat: 0.62,    // dark ink: blue when still, toward indigo when moving
    lightHueStill: 205, lightHueMoving: 335, lightSat: 0.05, lightSatMoving: 0.20,   // light ink: near-white (a breath of blue) when still, warming to pink as people move
    grain: 0,              // optional paper speckle on the ink (0 = none: smooth, like water)
    dropSize: 0.62,        // size of each person's circular drop of ink, as a fraction of their band's height (0 = no circles)
    ripples: 1.0,          // how strongly each drop sends out its own concentric waves (0 = none; they overlap and interfere between drops)
    rippleReach: 1.0,      // how far those ripples reach, in drop-radii
    dropHue: 330, dropSat: 0.15,           // color of the pool inside each drop (hue degrees: 335 = pink, 215 = blue) and how strong it is
    dropCoreHue: 228, dropCoreSat: 0.80,   // color of the dense ink at the drop's heart as it first touches down
    dropRing: 0.009,       // weight of the dark ring around each drop
    sheen: 0.4,            // how much the waves catch soft light and glints on the water's surface (0 = flat)
    inkLine: 0.29,          // width of the dark ink bands as a fraction of a layer (0.25 = half dark, half light)
    dragCalm: 0.09,         // how far the ink is dragged around when calm: gentle S-curves...
    dragStorm: 0.22,        // ...and in a full storm: folds and whirlpools
    flowCalm: 0.12, flowStorm: 0.4,  // how fast the drag currents drift (radians per second) when calm / in a storm
    chop: 1.0,              // slope of the crossing chop waves that roughen the surface, at full storm
    crestSharpen: 0.2,      // how much a storm sharpens crests and widens troughs
    gust: 0.25,             // how much a storm makes the waves surge and stall instead of rolling steadily
    curve: 0.5,             // how much wave crests bow toward the sides of the screen
    crossSwell: 0.15,       // slope of a gentle, slower second swell, so even calm water isn't perfectly regular
    // --- reading a storm: vigorous movement that keeps going + sudden bursts + erratic, abrupt movement ---
    stormStart: 0.4,        // movement level (0-1) above which sustained movement starts to roughen the water
    burstFull: 0.25,        // size of a sudden burst of speed that counts as a full storm
    jerkFull: 0.9,          // how erratically the speed changes (0-1) that counts as fully abrupt
    stormSustainedWeight: 0.4, stormJerkWeight: 0.6, stormBurstWeight: 0.6, // how much each of the three contributes (capped at 1 together)
    stormAttack: 0.06,      // per pose event: how fast the storm reading builds (quick, so abrupt movement hits hard)...
    stormRelease: 0.015,     // ...and how slowly it dies away (slow, so the sea settles gently)
    // --- body shape -> wave profile: asymmetrical = pointed, else rigid/upright = flat-topped, else soft/relaxed = rounded. These
    //     are the centers of smooth transitions, not hard switches — a body between two shapes gets a blend of both. ---
    asymThreshold: 0.5,     // asymmetry score (0 = perfect mirror, 1 = very lopsided) at which the wave is half-way to pointed
    rigidThreshold: 0.75,   // rigidity score (0 = slumped and bent, 1 = stiff and upright) at which the wave is half-way to flat-topped
    formSoftness: 0.15,     // how wide each transition is (bigger = the profiles blend over a wider range of posture)
    symDeadzone: 0.12,      // left/right mismatch (in shoulder-widths) forgiven as symmetric — nobody's posture is perfect
    symFull: 0.9,           // mismatch that reads as "fully asymmetric"
    spineFullDeg: 25,       // spine (or head-over-shoulders) tilt from vertical that counts as fully un-upright
    shoulderFullDeg: 15,    // shoulder-line tilt that counts as fully un-level
    bentDeg: 100, straightDeg: 175, // elbow/knee angle that counts as fully bent (0) and fully straight (1)
    postureSmoothing: 0.04, // per pose event: posture is read slowly, so a passing gesture doesn't change the wave
    // --- how many crests: the number of tracked body points ---
    reflectionsFrom: 'bodyPoints', // 'bodyPoints': that person's number of tracked body points, rounded up to even
                                   // 'people':     one per person detected instead
    // --- movement -> color (hue in degrees: 215 = blue, 270 = violet, 320 = rose/magenta, 360 = red) ---
    motionFullMean: 0.3,    // mean keypoint activation that reads as "fully in motion"
    // --- calm, flowing motion: everything below trades responsiveness for smoothness ---
    motionAttack: 0.06,     // per pose event: how fast the movement reading rises when someone starts moving...
    motionRelease: 0.02,    // ...and how slowly it falls when they stop, so color and waves settle gently instead of snapping back
    countDebounceMs: 2500,  // a new crest count must hold this long before the water starts changing to it
    fadeInMs: 1200,         // how slowly a newly detected person's wave builds
    // how long (seconds, roughly) each of these takes to glide to a new value — bigger = slower, calmer. "Up" is
    // growing/speeding up, "Down" is settling; a storm builds fast and dies slowly.
    smooth: { rank: 3.0, crowd: 3.0, motion: 3.5, form: 3.5, count: 4.0,
              ampUp: 3.0, ampDown: 4.0, freqUp: 3.0, freqDown: 4.0, stormUp: 3.0, stormDown: 5.0, dropUp: 0.2, dropDown: 0.5 }
  }
};

// The 17 keypoints PoseNet detects.
const KEYPOINT_NAMES = [
  'nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar',
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'
];
const TORSO_POINTS = ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'];

/* =============================
   1) RUNTIME STATE
   ============================= */
console.log('✅ sketch.js (crowd edition — one shared kaleidoscope) loading...');

let displayOrientation = 'landscape';
let video, poseNet, latestPoses = [];
let trackingStarted = false;

let people = new Map(); // id -> Person
let nextPersonId = 1;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

/* =============================
   2) SESSION AVERAGING (crowd-level)
   ============================= */
class OnlineMean {
  constructor() { this.mean = 0; this.n = 0; }
  add(x) {
    if (!Number.isFinite(x)) return;
    this.n++;
    this.mean += (x - this.mean) / this.n;
  }
}

class SessionAverager {
  constructor() { this.reset(); }

  reset() {
    this.active = false;
    this.startTs = 0;
    this.samples = 0;
    this.peakHeadcount = 0;
    this.headcount = new OnlineMean();
    this.velocity = new OnlineMean();
  }

  begin() {
    this.reset();
    this.active = true;
    this.startTs = performance.now();
    console.log('[SESSION] Started averaging');
  }

  add(sample) {
    if (!this.active) return;
    this.headcount.add(sample.headcount ?? 0);
    this.peakHeadcount = Math.max(this.peakHeadcount, sample.headcount ?? 0);
    this.velocity.add(sample.velocity ?? 0);
    this.samples++;
  }

  end() {
    const out = {
      durationMs: performance.now() - this.startTs,
      samples: this.samples,
      peakHeadcount: this.peakHeadcount,
      avgHeadcount: this.headcount.mean,
      velocity: this.velocity.mean
    };
    this.active = false;
    console.log('[SESSION] Ended:', out);
    return out;
  }
}

window.__ebSession = null;

window.beginSession = function () {
  if (!window.__ebSession) window.__ebSession = new SessionAverager();
  window.__ebSession.begin();
};

window.onPrint = function () {
  console.log('[PRINT] Triggered');
  onPrintAverageThenSnapshot();
};

/* =============================
   3) PERSON — one tracked body in the crowd (= one wave)
   ============================= */
class Person {
  constructor(id, cx, cy) {
    this.id = id;
    this.hue = (id * 63) % 360; // used by the Control dashboard's crowd map only
    this.tx = cx; this.ty = cy; // torso-weighted body center in video pixels — used for frame-to-frame matching
    this.born = millis();
    this.lastSeen = 0;
    this.poseEvents = 0;
    this.avgVel = 0;

    this.points = {};
    for (const name of KEYPOINT_NAMES) {
      // presence fades smoothly in/out instead of snapping with the raw PoseNet score,
      // so a keypoint flickering near the confidence threshold doesn't make the wave jump around.
      this.points[name] = { x: cx, y: cy, vel: 0, raw: 0, rawPrev: 0, score: 0, presence: 0 };
    }

    // Movement summary, recomputed on every pose event (see updatePersonMetrics).
    this.bodyScale = 0;   // apparent shoulder-width-equivalent in video px — normalizes the posture measurements
    this.m = { bodyPoints: 0, motion: 0, asym: 0, rigid: 0.5, fast: 0, slow: 0, jerk: 0, storm: 0 };
    this.countTarget = 0; this.countPending = 0; this.pendingSince = 0;

    // Values actually drawn, each gliding toward its target: this person's patch of water, color, how many crests,
    // the mix of wave profiles (round / flat-topped / pointed), wave height, how often crests pass, and the storm.
    this.d = { rank: new Smooth(1), motion: new Smooth(0), count: new Smooth(1), wC: new Smooth(1), wS: new Smooth(0), wT: new Smooth(0),
               amp: new Smooth(0), freq: new Smooth(0), storm: new Smooth(0), drop: new Smooth(0) };
    // Wave phases only ever move forward (integrated), so changing speed can't make the water jump. The chop phases
    // start at fixed random offsets so every person's crossing waves differ.
    const r = mulberry32(id * 7919 + 13);
    this.phase = r() * Math.PI * 2;
    this.chopPh = [r() * Math.PI * 2, r() * Math.PI * 2, r() * Math.PI * 2];
    this.dInit = false;
  }
}

function personCenter(pose) {
  const get = part => {
    const k = pose.keypoints.find(p => p.part === part && p.score > TUNE.point.kpMinScore);
    return k ? k.position : null;
  };
  const ls = get('leftShoulder'), rs = get('rightShoulder');
  const lh = get('leftHip'), rh = get('rightHip');
  if (ls && rs && lh && rh) {
    return { x: (ls.x + rs.x + lh.x + rh.x) / 4, y: (ls.y + rs.y + lh.y + rh.y) / 4 };
  }
  if (ls && rs) return { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const nose = get('nose');
  return nose;
}

/* =============================
   4) TRACKING — match this frame's skeletons to known people
   ============================= */
function matchPeopleToPoses(poses, now) {
  const vw = video?.width || 960, vh = video?.height || 540;
  const matchRadius = Math.hypot(vw, vh) * TUNE.tracking.matchRadiusFrac;

  const detections = poses
    .map(r => ({ pose: r.pose, center: personCenter(r.pose) }))
    .filter(d => d.center);

  const used = new Array(detections.length).fill(false);
  const unmatchedPeople = [];

  // Pass 1: match people to detections within the normal radius, CLOSEST PAIRS FIRST. (Letting each person in turn grab
  // whichever detection is nearest to them gets identities wrong: when someone leaves, the next person in the list
  // would take a neighbour's skeleton and it would be the wrong person who disappears.)
  const pairs = [];
  for (const person of people.values()) {
    for (let i = 0; i < detections.length; i++) {
      const d = dist(person.tx, person.ty, detections[i].center.x, detections[i].center.y);
      if (d < matchRadius) pairs.push([d, person, i]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const matched = new Set();
  for (const [, person, i] of pairs) {
    if (used[i] || matched.has(person)) continue;
    used[i] = true;
    matched.add(person);
    updatePersonPoints(person, detections[i].pose, now);
  }
  for (const person of people.values()) if (!matched.has(person)) unmatchedPeople.push(person);

  // Pass 2: fallback matching, no radius limit. If a tracked person moved fast enough (or their
  // centroid jumped because a different set of keypoints was visible this frame) to miss the radius
  // check above, that's still the same person — there's no other explanation for a leftover detection
  // when we already have a leftover person expecting one. Without this pass, fast movement would drop
  // the old Person (only after personTimeoutMs) while a brand new one spawns in its place, which is
  // exactly what "the blob keeps multiplying as I move" looks like. Pair whatever's left over by
  // nearest distance, so real duplicates/departures still only come from a genuine detection-count
  // mismatch, not from a single person outrunning the match radius.
  let remaining = [];
  for (let i = 0; i < detections.length; i++) if (!used[i]) remaining.push(i);

  while (unmatchedPeople.length && remaining.length) {
    let bp = -1, bi = -1, bd = Infinity;
    for (let pi = 0; pi < unmatchedPeople.length; pi++) {
      const person = unmatchedPeople[pi];
      for (let di = 0; di < remaining.length; di++) {
        const d = dist(person.tx, person.ty, detections[remaining[di]].center.x, detections[remaining[di]].center.y);
        if (d < bd) { bd = d; bp = pi; bi = di; }
      }
    }
    const person = unmatchedPeople[bp];
    const detIdx = remaining[bi];
    used[detIdx] = true;
    updatePersonPoints(person, detections[detIdx].pose, now);
    unmatchedPeople.splice(bp, 1);
    remaining.splice(bi, 1);
  }

  // Any detections still left over are genuinely new people.
  for (const i of remaining) {
    if (people.size >= TUNE.tracking.maxPeople) break;
    const person = new Person(nextPersonId++, detections[i].center.x, detections[i].center.y);
    people.set(person.id, person);
    updatePersonPoints(person, detections[i].pose, now);
  }

  // Drop anyone we haven't seen in a while (genuinely gone — occluded too long, or left frame).
  for (const [id, person] of people) {
    if (now - person.lastSeen > TUNE.tracking.personTimeoutMs) {
      people.delete(id);
    }
  }
}

/* =============================
   5) POSE → PER-POINT POSITION + VELOCITY
   ============================= */
function updatePersonPoints(person, pose, now) {
  if (!pose || !pose.keypoints) return;
  person.lastSeen = now;

  const P = TUNE.point;
  const diag = Math.hypot(video?.width || 960, video?.height || 540) || 1;

  let visible = 0, sumVel = 0;

  for (const name of KEYPOINT_NAMES) {
    const k = pose.keypoints.find(p => p.part === name);
    const pt = person.points[name];

    if (k && k.score > P.kpMinScore) {
      // A keypoint that's new (or has been missing for a while) has no meaningful "previous position": it starts
      // at the person's center, or wherever it was last seen. Measuring velocity from there would read the jump to
      // its real position as violent movement — a still person would look like they were thrashing for seconds.
      if (pt.presence < 0.15) { pt.x = k.position.x; pt.y = k.position.y; }
      const dx = (k.position.x - pt.x) / diag;
      const dy = (k.position.y - pt.y) / diag;
      const rawVel = Math.max(0, Math.hypot(dx, dy) - P.velDeadzone); // absorb baseline detection jitter before it ever reaches the smoothing

      pt.x = lerp(pt.x, k.position.x, P.posSmoothing);
      pt.y = lerp(pt.y, k.position.y, P.posSmoothing);
      pt.vel = lerp(pt.vel, rawVel, P.velEMA);
      pt.rawPrev = pt.raw;
      pt.raw = rawVel; // this event's own speed (not smoothed) — what a sudden burst, and jerkiness, are measured from
      pt.score = k.score;
      pt.presence = lerp(pt.presence, 1, P.presenceInRate);

      visible++;
      sumVel += pt.vel;
    } else {
      pt.vel = lerp(pt.vel, 0, P.velEMA); // decay toward still when not seen
      pt.rawPrev = pt.raw;
      pt.raw = 0;
      pt.score = 0;
      pt.presence = lerp(pt.presence, 0, P.presenceOutRate);
    }
  }

  person.avgVel = visible ? sumVel / visible : 0;
  person.poseEvents++;
  updatePersonMetrics(person, now);
}

/* =============================
   5b) BODY → WAVE TARGETS (per pose event)
   ============================= */
const vNorm = v => clamp01(map(v, TUNE.point.velNormMin, TUNE.point.velNormMax, 0, 1));
const evenUp = n => 2 * Math.ceil(n / 2);

function updatePersonMetrics(person, now) {
  const K = TUNE.water, P = person.points, m = person.m;

  // Torso-weighted center, used only to match this person to the next frame's skeletons. Weighted by
  // presence so a hip or shoulder fading in/out glides the center rather than jumping it.
  let wx = 0, wy = 0, ws = 0;
  for (const n of TORSO_POINTS) { wx += P[n].x * P[n].presence; wy += P[n].y * P[n].presence; ws += P[n].presence; }
  if (ws < 0.5) {
    wx = wy = ws = 0;
    for (const n of KEYPOINT_NAMES) { wx += P[n].x * P[n].presence; wy += P[n].y * P[n].presence; ws += P[n].presence; }
  }
  if (ws > 0.01) { person.tx = wx / ws; person.ty = wy / ws; }

  // How many body points are tracked, and how much the body is moving overall (still vs. moving).
  let visible = 0, sum = 0, rawSum = 0, jerkSum = 0;
  for (const name of KEYPOINT_NAMES) {
    if (P[name].presence <= 0.5) continue;
    visible++; sum += vNorm(P[name].vel);
    const r = vNorm(P[name].raw);
    rawSum += r; jerkSum += Math.abs(r - vNorm(P[name].rawPrev)); // each point's own change in speed — averaging the changes (not the speeds) keeps erratic movement visible
  }
  m.bodyPoints = visible;
  // How much the body is moving overall. Low-passed: quick to notice motion, slow to let go, so the water drifts
  // between states rather than flickering.
  const motionNow = visible ? clamp01((sum / visible) / K.motionFullMean) : 0;
  m.motion = lerp(m.motion, motionNow, motionNow > m.motion ? K.motionAttack : K.motionRelease);

  // How stormy. Three things roughen the water, none of which a slow, steady movement — however large — triggers:
  //   sustained  vigorous movement that keeps going
  //   burst      this moment's speed running well ahead of its own recent average (the same fast-vs-slow idea the original
  //              Energy Bodies used for anger), so a flick or a jolt roughens the water even from a standstill
  //   jerk       how erratically the speed changes from one moment to the next: a smooth, flowing dance has a speed that
  //              rises and falls evenly, abrupt, jabbing movement doesn't
  const rawNow = visible ? rawSum / visible : 0;
  m.fast = lerp(m.fast, rawNow, 0.5);
  m.slow = lerp(m.slow, rawNow, 0.05);
  m.jerk = lerp(m.jerk, visible ? jerkSum / visible : 0, 0.3);
  const burst = clamp01(Math.max(0, m.fast - m.slow) / K.burstFull);
  const jerkN = clamp01(m.jerk / K.jerkFull);
  const sustained = (() => { const x = clamp01((motionNow - K.stormStart) / (1 - K.stormStart)); return x * x * (3 - 2 * x); })();
  const stormNow = clamp01(K.stormSustainedWeight * sustained + K.stormJerkWeight * jerkN + K.stormBurstWeight * burst);
  m.storm = lerp(m.storm, stormNow, stormNow > m.storm ? K.stormAttack : K.stormRelease);

  // Body shape drives the FORM. Read slowly, and held when the body can't be measured this frame.
  updateBodyScale(person);
  const posture = computePosture(person);
  if (posture.asym !== null) m.asym = lerp(m.asym, posture.asym, K.postureSmoothing);
  if (posture.rigid !== null) m.rigid = lerp(m.rigid, posture.rigid, K.postureSmoothing);

  const refl = K.reflectionsFrom === 'people' ? Math.max(2, evenUp(people.size)) : Math.max(2, evenUp(visible));
  commitCount(person, refl / 2, now);
}

// How much of each form a body is: [round, boxy, wedge], summing to 1. Asymmetry pulls toward the wedge; whatever is
// left is split between boxy (stiff, upright) and round (soft, relaxed). All smooth — nothing switches.
function formWeights(m) {
  const K = TUNE.water, soft = K.formSoftness;
  const ss = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const wT = ss((m.asym - (K.asymThreshold - soft)) / (2 * soft));
  const wS = (1 - wT) * ss((m.rigid - (K.rigidThreshold - soft)) / (2 * soft));
  return [1 - wT - wS, wS, wT];
}

// PoseNet has no depth, so use apparent body size to normalize posture measurements: shoulder width, or torso length
// when the hips are visible too (torso is less affected by the person turning sideways).
function updateBodyScale(person) {
  const P = person.points, vis = n => P[n].presence > 0.5;
  let est = 0;
  const shouldersVis = vis('leftShoulder') && vis('rightShoulder');
  if (shouldersVis) est = Math.hypot(P.leftShoulder.x - P.rightShoulder.x, P.leftShoulder.y - P.rightShoulder.y);
  if (shouldersVis && vis('leftHip') && vis('rightHip')) {
    const sx = (P.leftShoulder.x + P.rightShoulder.x) / 2, sy = (P.leftShoulder.y + P.rightShoulder.y) / 2;
    const hx = (P.leftHip.x + P.rightHip.x) / 2, hy = (P.leftHip.y + P.rightHip.y) / 2;
    est = Math.max(est, Math.hypot(hx - sx, hy - sy) / 1.25); // torso ≈ 1.25 shoulder-widths
  }
  if (est > 1) person.bodyScale = person.bodyScale ? lerp(person.bodyScale, est, 0.15) : est;
}

// Two independent readings of the body's shape, each null when too little of the body is visible to measure:
//   asym  0..1  how far the left side is from a mirror image of the right (0 = symmetric)
//   rigid 0..1  how stiff and upright the body is: vertical spine (or head over the shoulders), level shoulders, and
//               straight arms and legs. Slumped, tilted, or bent = low; standing tall and straight = high.
function computePosture(person) {
  const K = TUNE.water, P = person.points;
  const vis = n => P[n].presence > 0.6;
  const both = (a, b) => vis(a) && vis(b);
  const mid = (a, b) => ({ x: (P[a].x + P[b].x) / 2, y: (P[a].y + P[b].y) / 2 });
  const deg = r => r * 180 / Math.PI;
  const tiltFromUp = (dx, dy) => dy > 0 ? deg(Math.atan2(Math.abs(dx), dy)) : 90; // dy > 0 = pointing upward in the picture

  const terms = [];
  const S = both('leftShoulder', 'rightShoulder') ? mid('leftShoulder', 'rightShoulder') : null;
  if (S && both('leftHip', 'rightHip')) {
    const Hm = mid('leftHip', 'rightHip');
    terms.push(1 - clamp01(tiltFromUp(S.x - Hm.x, Hm.y - S.y) / K.spineFullDeg));   // spine: hips → shoulders
  } else if (S && vis('nose')) {
    terms.push(1 - clamp01(tiltFromUp(P.nose.x - S.x, S.y - P.nose.y) / K.spineFullDeg)); // upper body only: head over shoulders
  }
  if (S) {
    const dx = Math.abs(P.rightShoulder.x - P.leftShoulder.x), dy = Math.abs(P.rightShoulder.y - P.leftShoulder.y);
    terms.push(1 - clamp01(deg(Math.atan2(dy, dx)) / K.shoulderFullDeg));            // shoulders level
  }
  const limbs = [];
  for (const [a, b, c] of [['leftShoulder', 'leftElbow', 'leftWrist'], ['rightShoulder', 'rightElbow', 'rightWrist'],
                            ['leftHip', 'leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee', 'rightAnkle']]) {
    if (!(vis(a) && vis(b) && vis(c))) continue;
    const ux = P[a].x - P[b].x, uy = P[a].y - P[b].y, vx = P[c].x - P[b].x, vy = P[c].y - P[b].y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1 || lv < 1) continue;
    const angle = deg(Math.acos(constrain((ux * vx + uy * vy) / (lu * lv), -1, 1))); // 180° = straight limb
    limbs.push(clamp01((angle - K.bentDeg) / (K.straightDeg - K.bentDeg)));
  }
  if (limbs.length) terms.push(limbs.reduce((x, y) => x + y, 0) / limbs.length);     // limbs count as one term, not four
  return { asym: computeAsymmetry(person), rigid: terms.length >= 2 ? terms.reduce((x, y) => x + y, 0) / terms.length : null };
}

// 0 = the left and right sides mirror each other perfectly; 1 = strongly lopsided. Each left joint is reflected across
// the body's own axis (through the shoulders, along the spine when the hips are visible) and compared to its right
// counterpart, so leaning or turning alone doesn't count as asymmetry but one arm raised, or one shoulder dropped, does.
const SYMMETRY_PAIRS = [
  ['leftEye', 'rightEye'], ['leftEar', 'rightEar'],
  ['leftShoulder', 'rightShoulder'], ['leftElbow', 'rightElbow'], ['leftWrist', 'rightWrist'],
  ['leftHip', 'rightHip'], ['leftKnee', 'rightKnee'], ['leftAnkle', 'rightAnkle']
];
function computeAsymmetry(person) {
  const K = TUNE.water, P = person.points;
  if (!person.bodyScale) return null;
  const vis = n => P[n].presence > 0.6;
  const mid = (a, b) => ({ x: (P[a].x + P[b].x) / 2, y: (P[a].y + P[b].y) / 2 });

  let origin = null;
  if (vis('leftShoulder') && vis('rightShoulder')) origin = mid('leftShoulder', 'rightShoulder');
  else if (vis('leftHip') && vis('rightHip')) origin = mid('leftHip', 'rightHip');
  else if (vis('leftEye') && vis('rightEye')) origin = mid('leftEye', 'rightEye');
  if (!origin) return null;

  let ax = 0, ay = 1; // default axis: straight up/down in the image
  if (vis('leftShoulder') && vis('rightShoulder') && vis('leftHip') && vis('rightHip')) {
    const sm = mid('leftShoulder', 'rightShoulder'), hm = mid('leftHip', 'rightHip');
    const len = Math.hypot(hm.x - sm.x, hm.y - sm.y);
    if (len > 1e-3) { ax = (hm.x - sm.x) / len; ay = (hm.y - sm.y) / len; }
  } else if (vis('leftShoulder') && vis('rightShoulder')) {
    // Upper body only: the spine isn't visible, so run the axis from the head down through the shoulders. (A vertical
    // axis would read every lean as lopsided.)
    const head = (vis('leftEar') && vis('rightEar')) ? mid('leftEar', 'rightEar')
               : (vis('leftEye') && vis('rightEye')) ? mid('leftEye', 'rightEye') : (vis('nose') ? P.nose : null);
    if (head) {
      const sm = mid('leftShoulder', 'rightShoulder'), len = Math.hypot(sm.x - head.x, sm.y - head.y);
      if (len > 1e-3) { ax = (sm.x - head.x) / len; ay = (sm.y - head.y) / len; }
    }
  }

  let sum = 0, n = 0;
  for (const [l, r] of SYMMETRY_PAIRS) {
    if (!vis(l) || !vis(r)) continue;
    const along = (P[l].x - origin.x) * ax + (P[l].y - origin.y) * ay;
    const mirroredX = 2 * (origin.x + ax * along) - P[l].x;
    const mirroredY = 2 * (origin.y + ay * along) - P[l].y;
    sum += Math.hypot(mirroredX - P[r].x, mirroredY - P[r].y) / person.bodyScale;
    n++;
  }
  if (n < 2) return null;
  return clamp01((sum / n - K.symDeadzone) / (K.symFull - K.symDeadzone));
}

// A change in a person's crest count only takes effect once it has held for a moment, so a body point flickering at
// the edge of visibility doesn't make the water keep re-arranging itself. (The change itself then glides in.)
function commitCount(person, raw, now) {
  if (person.poseEvents < 5 || !person.countTarget) { // presence is still ramping up on a brand-new person; settle silently
    person.countTarget = person.countPending = raw;
    person.pendingSince = now;
    return;
  }
  if (raw !== person.countPending) {
    person.countPending = raw;
    person.pendingSince = now;
  } else if (raw !== person.countTarget && now - person.pendingSince >= TUNE.water.countDebounceMs) {
    person.countTarget = raw;
  }
}

/* =============================
   6) P5 SETUP / DRAW
   ============================= */
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  angleMode(RADIANS);

  window.__ebSession = new SessionAverager();

  const constraints = {
    audio: false,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'environment' // crowd installs typically use a room-facing camera, not a selfie cam
    }
  };

  video = createCapture(constraints, () => console.log('🎥 Webcam ready'));
  video.size(960, 540); // wider frame than the single-person build so more of the room is in view
  video.elt.playsInline = true;
  video.hide();

  poseNet = ml5.poseNet(video, {
    detectionType: 'multiple',
    maxPoseDetections: TUNE.tracking.maxPeople,
    scoreThreshold: TUNE.tracking.scoreThreshold
  }, () => console.log('🧠 PoseNet model loaded (multi-pose)'));

  if (TUNE.autoRun) startTrackingImpl();   // (a function declaration further down, so it is already available here)

  poseNet.on('pose', results => {
    latestPoses = results || [];
    if (!trackingStarted) return;
    matchPeopleToPoses(latestPoses, millis());
    emitToControl();
    accumulateSession();
  });

  window.addEventListener('eb:orientation', (ev) => {
    const mode = ev.detail?.value;
    if (mode && mode !== displayOrientation) displayOrientation = mode;
  });

  window.resetAll = resetAll;
}

function draw() {
  background(0);
  if (trackingStarted) drawCrowdWater(millis());

  fill(255);
  noStroke();
  textSize(14);
  text(`people: ${people.size} | tracking: ${trackingStarted}`, 12, 20);
  if (window.__ebSession?.active) text(`Recording: ${window.__ebSession.samples} samples`, 12, 40);
  text(`[${displayOrientation}]`, 12, 60);
  if (debugOn) drawDebug();
  if (millis() < dialShownUntil) {   // brief readout after adjusting speed / contrast
    const K = TUNE.water;
    text(`speed ${K.speed.toFixed(1)}   contrast ${K.contrast.toFixed(1)}      ( , .  speed    - =  contrast )`, 12, height - 16);
  }
}

// Diagnostic readout (press d): frame rate and the worst frame in the last second (a stutter reads as flicker), how many people exist and how
// many ids have been created (if that number keeps climbing, the tracker keeps losing and re-finding people — each re-find replays the ink touch),
// and each person's live readings.
let debugOn = false, dbgFrames = [], dbgWorst = 0, dbgWorstAt = 0;
function drawDebug() {
  const now = millis();
  dbgFrames.push([now, deltaTime]);
  while (dbgFrames.length && now - dbgFrames[0][0] > 1000) dbgFrames.shift();
  const worst = Math.max(...dbgFrames.map(f => f[1]));
  if (worst > dbgWorst || now - dbgWorstAt > 5000) { dbgWorst = worst; dbgWorstAt = now; }
  const lines = [
    `fps ${Math.round(frameRate())}   worst frame (1s) ${Math.round(worst)} ms   worst (5s) ${Math.round(dbgWorst)} ms   render ${WaterGL.w}x${WaterGL.h} (quality ${WaterGL.quality.toFixed(2)})`,
    `people ${people.size}   ids created ${nextPersonId - 1}   poses this frame ${latestPoses.length}`
  ];
  for (const p of Array.from(people.values()).sort((a, b) => a.id - b.id)) {
    lines.push(`#${p.id}  points ${p.m.bodyPoints}  motion ${p.m.motion.toFixed(2)}  storm ${p.m.storm.toFixed(2)}  amp ${p.d.amp.v.toFixed(2)}  waves ${p.d.count.v.toFixed(1)}  age ${(p.inkAge || 0).toFixed(1)}s`);
  }
  push(); noStroke(); fill(0, 150); rect(8, 76, 640, 18 * lines.length + 10); fill(255); textSize(12);
  lines.forEach((l, i) => text(l, 14, 94 + 18 * i));
  pop();
}

// Live dials: , and . slow down / speed up everything; - and = soften / strengthen the ink contrast.
let dialShownUntil = 0;
function keyPressed() {
  const K = TUNE.water;
  if (key === 'd' || key === 'D') { debugOn = !debugOn; return; }
  const step = (v, d, lo, hi) => Math.round(constrain(v + d, lo, hi) * 10) / 10;
  if (key === ',' || key === '<') K.speed = step(K.speed, -0.1, 0.1, 3);
  else if (key === '.' || key === '>') K.speed = step(K.speed, 0.1, 0.1, 3);
  else if (key === '-' || key === '_') K.contrast = step(K.contrast, -0.1, 0, 1.6);
  else if (key === '=' || key === '+') K.contrast = step(K.contrast, 0.1, 0, 1.6);
  else return;
  dialShownUntil = millis() + 2500;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

/* =============================
   7) DRAWING — lit 3D water, rendered on the GPU
   ============================= */

// A critically damped spring ("smooth damp"). Unlike lerp-toward-target every frame — which is fastest at the very
// start, so anything that changes lurches into motion — this starts from a standstill, accelerates gently, then
// settles with no overshoot. It also uses real elapsed time, so it feels the same at 30 or 60 fps.
class Smooth {
  constructor(v = 0) { this.v = v; this.vel = 0; }
  snap(v) { this.v = v; this.vel = 0; }
  update(target, smoothTime, dt) {
    const omega = 2 / Math.max(0.0001, smoothTime);
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.v - target;
    const temp = (this.vel + omega * change) * dt;
    this.vel = (this.vel - omega * temp) * decay;
    this.v = target + (change + temp) * decay;
    return this.v;
  }
  // Same, but with one glide time for rising and another for falling — a storm builds fast and dies slowly.
  ud(target, tUp, tDown, dt) { return this.update(target, target > this.v ? tUp : tDown, dt); }
}

const crowdS = new Smooth(1); // eased number of people, so the bands of water glide apart/together when someone joins or leaves
let crowdInit = false;

// Fade a person in when first detected and out as they go missing, rather than popping.
function lifeAlpha(person, now) {
  const fadeIn = clamp01((now - person.born) / TUNE.water.fadeInMs);
  const missing = now - person.lastSeen;
  const fadeStart = 250;
  const fadeOut = missing > fadeStart ? clamp01(1 - (missing - fadeStart) / (TUNE.tracking.personTimeoutMs - fadeStart)) : 1;
  return fadeIn * fadeOut;
}

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WTAU = Math.PI * 2;
const CHOP_RATE = [0.4, 0.6, 0.85]; // how fast each crossing chop wave moves, in cycles per second at full storm (x1.35) — kept under ~3 so the shimmer never gets strobe-like
const MAX_WAVES = 12; // must match the shader's array size (and TUNE.tracking.maxPeople)

/* --- the water shader ----------------------------------------------------------------------------------------------
   The screen is a flat field of water: for every pixel the shader works out the water's height there (a blend of every
   person's waves, weighted by how close the pixel is to that person's horizontal band), then its slope and curvature,
   and lights it — soft relief from the slope, bright caustic webs from the curvature. There is no camera, perspective,
   sky or horizon. Each person's wave data arrives as four vec4s per person (see drawCrowdWater). Everything about a
   wave's shape lives in heightAt(). */
const WATER_VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const WATER_FRAG = `
precision highp float;
#define MAXW 12
uniform vec2 uRes;
uniform int uCount;
uniform float uN, uSig, uSpan, uSteep, uHMax, uCurve, uCross, uChop, uSharpen, uCaus, uGlow, uTexture;
uniform float uDropHue, uDropSat, uCoreHue, uCoreSat;
uniform float uContrast, uDH0, uDH1, uLH0, uLH1, uDSat, uLSat, uLSat1, uGrain, uSheen, uDrop, uDropRing, uRipple, uRippleLen;   // drops: size (fraction of a band's height, 0 = none), ring weight
uniform float uLayers, uDens, uWarp0, uWarp1, uWT, uLine;   // ink: contour density, how much the ink is dragged (calm / storm), drag phase, line weight
uniform vec4 uP0[MAXW];   // amp, crests, storm, phase
uniform vec4 uP1[MAXW];   // weight round, weight flat-topped, weight pointed, life
uniform vec4 uP2[MAXW];   // hue (0-1), rank (1 = the bottom band), chop phase 0, chop phase 1
uniform vec4 uP3[MAXW];   // chop phase 2, this person's three fixed random numbers
uniform vec4 uP4[MAXW];   // how grown this person's drop of ink is (0-1)
const float TAU = 6.2831853;

float tanhf(float x) { x = clamp(x, -9.0, 9.0); float e = exp(2.0 * x); return (e - 1.0) / (e + 1.0); }

// One wave's shape from three profiles blended by w (round, flat-topped, pointed); a storm (cp > 1) sharpens crests and
// widens troughs. About -1 (trough) .. +1 (crest).
float prof(float th, vec3 w, float cp) {
  float s = sin(th);
  float v = w.x * s;
  if (w.y > 0.001) v += w.y * tanhf(1.5 * s) / 0.9051;
  if (w.z > 0.001) v += w.z * 0.8553 * asin(clamp(0.92 * sin(th + 0.8 * s), -1.0, 1.0));   // corners rounded a little: a perfect point would focus all the light into one hairline
  if (cp > 1.001) { float c = (cp - 1.0) * 1.2; v = (exp(c * v) - 1.0) / (exp(c) - 1.0); }   // smooth: sharper crests, broader shallower troughs, no corner anywhere
  return v;
}

// The water's height at q (q.x across the screen, q.y up it, -1..1), as a flat field — there is no perspective and no
// distance. Mirror-symmetric: only |q.x| matters.
// Every wave's height is its SLOPE times its wavelength / 2pi, so however many fine waves a storm packs in, the surface
// can never get steeper than the slopes chosen here.
float heightAt(vec2 q) {
  float ax = sqrt(q.x * q.x + 0.0016) - 0.04;                     // |x|, rounded off at 0 so the mirror line has no crease
  float tau = clamp((q.y + 1.0) * 0.5, 0.0, 1.0);                 // where this is up the screen: 0 = the bottom, 1 = the top
  float num = 0.0, den = 0.0;
  for (int k = 0; k < MAXW; k++) {
    if (k >= uCount) break;
    float d = (tau - (uP2[k].y - 0.5) / uN) / uSig;               // how far this point is from the centre of person k's band
    if (abs(d) > 3.2) continue;
    float w = exp(-0.5 * d * d) * (1.0 - smoothstep(2.4, 3.2, abs(d)));   // fades to exactly zero at the edge of a band's reach, so there is never a step (a step would focus light into a hairline)
    vec4 p0 = uP0[k];
    vec4 p1 = uP1[k];
    float lam = uSpan / p0.y;                                     // this person's wavelength
    // swirl: a storm bends the water's own coordinates, turning straight waves into turbulent currents (symmetric in x)
    float sw = max(p0.z, 1.8 * uTexture);
    float wy = q.y + 0.10 * sw * sin(ax * 3.7 - p0.w * 0.45 + q.y * 2.0) + 0.06 * sw * sin(ax * 8.3 + q.y * 6.1 + p0.w * 0.8);
    float wx = ax + 0.12 * sw * sin(q.y * 4.7 + p0.w * 0.6 + ax * 1.7);
    float yl = wy / lam;
    float xl = wx / lam;
    float th = TAU * yl + p0.w + uCurve * ax * ax * (0.4 + p0.z);
    float hk = uSteep * p0.x * (lam / TAU) * prof(th, p1.xyz, 1.0 + uSharpen * p0.z);
    hk += uCross * (lam / 1.4 / TAU) * sin(TAU * 1.4 * (yl * 0.94 + xl * 0.34) + p0.w * 0.6 + 1.1);
    float cs = max(p0.z, uTexture);                               // even calm water has a little fine texture
    {
      // three crossing wave trains, each travelling at its own angle (about 38, -52 and 25 degrees off the main swell)
      float ch = 0.30 * (lam / 2.7 / TAU) * sin(TAU * 2.7 * (yl * 0.79 + xl * 0.62) + uP2[k].z)
               + 0.28 * (lam / 4.4 / TAU) * sin(TAU * 4.4 * (yl * 0.62 - xl * 0.79) + uP2[k].w)
               + 0.24 * (lam / 7.2 / TAU) * sin(TAU * 7.2 * (yl * 0.91 + xl * 0.42) + uP3[k].x);
      hk += uChop * cs * ch;
    }
    float wl = w * p1.w;                                          // weighted by how present the person is: a leaving band melts into its neighbours and has exactly no weight when it is removed, so nothing jumps
    num += wl * hk;
    den += wl;
  }
  float h = num / (den + 0.2);                                    // the +0.2 lets a band fade in and out smoothly rather than being re-normalised to full height
  return uHMax * tanhf(h / uHMax);
}

// The look of the water at height tau up the screen: blended hue, storm and wave size of the nearby bands.
vec3 lookAt(float tau) {
  float hue = 0.0, st = 0.0, am = 0.0, den = 0.0;
  for (int k = 0; k < MAXW; k++) {
    if (k >= uCount) break;
    float d = (tau - (uP2[k].y - 0.5) / uN) / uSig;
    float w = exp(-0.5 * d * d) * (1.0 - smoothstep(2.4, 3.2, abs(d)));
    w = (w + 0.002) * uP1[k].w;                                   // weighted by how present the person is; every band has a faint reach everywhere, so when someone leaves
                                                                  // the part of the screen only they covered takes on the others' look smoothly instead of jumping
    hue += w * uP2[k].x; st += w * uP0[k].z; am += w * uP0[k].x * uSteep * (uSpan / uP0[k].y) / TAU; den += w;
  }
  return vec3(hue, st, am) / max(den, 0.000001);
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// The ink field at q: the waves' height (normalised by wave size, so about -1..1 per wave) read AFTER the whole surface has
// been dragged around, like a comb pulled through ink. The drag is a few layers of slow sinusoidal currents of growing
// frequency, built from |x| so the picture stays an exact mirror. x = field, y = where up the screen this ink really is.
// A person's drop of ink. Each has its own place (somewhere in their band, off to one side — the mirror gives it a twin), its own size
// and a slightly irregular, slowly breathing outline, all drifting gently. The size grows a little with movement and fades with the person.
// A sumi brush touching the water: the ink spreads out fast, overshoots a touch, and settles.
float inkGrow(float age) { return (1.0 - exp(-age / 0.4)) * (1.0 + 0.10 * exp(-age * 0.9) * sin(age * 5.0)); }
float dropCy(float rank) { return 2.0 * (rank - 0.5) / uN - 1.0; }
void dropAt(vec2 pa, float rank, float sA, float sB, float sC, float life, float age, float amp, out vec2 d, out float R, out float Rb) {
  float asp = uRes.x / uRes.y;
  float bandH = 2.0 / uN;
  float sD = fract(sA * 7.31 + sB * 3.17);                         // two more fixed random numbers per person
  float sE = fract(sB * 5.73 + sC * 9.41);
  float base = uDrop * bandH * 0.5 * (0.6 + 0.8 * sC) * (0.8 + 0.25 * amp) * life * inkGrow(age);
  float cx = max((0.10 + 0.72 * sD) * asp + 0.06 * sin(0.17 * uWT + sB * TAU), base * 1.6 + 0.12);    // anywhere across the half-screen, never reaching the mirror line
  float cy = dropCy(rank) + (sB - 0.5) * 1.1 * bandH + 0.06 * sin(0.13 * uWT + sA * TAU);       // and may wander toward the neighbouring bands
  d = pa - vec2(cx, cy);
  Rb = base;
  float th = atan(d.y, d.x);
  // not a perfect circle: a smooth oval, stretched a little in its own direction, turning very slowly
  float e = 0.07 + 0.13 * sE;
  R = base * (1.0 + e * cos(2.0 * (th - sB * 3.1416 - 0.06 * uWT))
                  + exp(-age / 1.5) * (0.035 * sin(5.0 * th + sA * TAU) + 0.03 * sin(9.0 * th + 1.7 * sB * TAU) + 0.02 * sin(13.0 * th + sC * TAU)));   // wet ink feathers irregularly at the edge at first, then smooths out
}

// The currents: a few slowly drifting whirlpools plus layers of sinusoidal drag, built from |x| so the picture stays an exact mirror.
// Returns the place the ink at q was before the currents moved it.
vec2 dragP(vec2 q, float wa, float wt) {
  vec2 p = vec2(sqrt(q.x * q.x + 0.0016) - 0.04, q.y);
  // whirlpools: a few slowly drifting vortices twist the ink around themselves (a calm sea barely turns, a storm winds spirals)
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = vec2(0.15 + 0.85 * (0.5 + 0.5 * sin(0.31 * wt + fi * 2.1)), 0.9 * sin(0.23 * wt + fi * 1.3 + 0.7));
    vec2 d = p - c;
    float ang = (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0) * wa * 6.0 * exp(-dot(d, d) / 0.14);
    float cs = cos(ang), sn = sin(ang);
    p = c + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
  }
  p += wa * vec2(sin(p.y * 2.3 + wt + 1.0), sin(p.x * 2.9 - 0.8 * wt));
  p += 0.55 * wa * vec2(sin(p.y * 4.6 - 1.3 * wt + 2.0), sin(p.x * 5.3 + 0.9 * wt + 4.0));
  p += 0.30 * wa * vec2(sin(p.y * 8.9 + 1.7 * wt), sin(p.x * 9.7 - 1.1 * wt + 1.0));
  return p;
}

// The ink at q: x = the waves' height (normalised by wave size, about -1..1 per wave) read after the whole surface has been moved
// around; y = where up the screen this ink really is; z = extra ink layers from the drops' own ripples.
// The drops sit INSIDE the currents: the currents carry and bend them (so their rims are never perfect, and drift), each drop pushes the
// ink outward so the waves wrap and crowd around its rim, and each sends out its own concentric ripples. Where drops overlap the ripples
// add together into interference — each extra person adds new waves.
vec3 inkAt(vec2 q, float wa, float wt) {
  vec2 pd = dragP(q, wa, wt);
  vec2 p = pd;
  float ripple = 0.0;
  for (int k = 0; k < MAXW; k++) {
    if (k >= uCount) break;
    vec2 d; float R, Rb;
    dropAt(pd, uP2[k].y, uP3[k].y, uP3[k].z, uP3[k].w, uP4[k].x, uP4[k].y, uP0[k].x, d, R, Rb);
    float r = max(length(d), 0.0001);
    p += (sqrt(max(r * r - R * R, 0.0)) / r - 1.0) * d;             // the push: the ink is sampled from where it was before the drop pushed it aside
    float s = max(r / max(R, 0.02) - 1.0, 0.0);                      // how many drop-radii out from the rim
    float E = exp(-s / uRippleLen);
    float nR = clamp(1.1 * uP0[k].y, 3.0, 10.0);                     // more body points = more waves = more ripples
    ripple -= uP1[k].w * (nR * uRippleLen + 0.6 * sin(0.35 * wt + uP3[k].y * TAU)) * E;
    // the touch: a ring of ripples runs outward from the drop, strongest at first and dying away, and drags the ink lines with it as it passes
    float age = uP4[k].y;
    float front = 0.4 + 1.7 * age;                                   // how far out the wavefront has got, in drop radii
    float wave = exp(-s / 1.6) * exp(-age / 2.2) * (1.0 - smoothstep(front - 0.5, front, s)) * smoothstep(0.0, 0.15, age);
    ripple += uP1[k].w * uP4[k].x * 0.9 * wave * sin(TAU * (1.1 * s - 0.9 * age));   // closely spaced at the rim, spreading out and fading to exactly nothing with distance (so the far water never shifts); breathing slowly
  }
  float tau = clamp((p.y + 1.0) * 0.5, 0.0, 1.0);
  float h = heightAt(p);
  return vec3(h / (lookAt(tau).z + 0.02), tau, ripple * uRipple);
}

void main() {
  vec2 q = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y);       // y: -1..1, x: -aspect..aspect, symmetric about the middle
  float e = 1.6 / uRes.y;
  float pix = 2.0 / uRes.y;                                        // one pixel, in the same units

  vec3 lk0 = lookAt(clamp((q.y + 1.0) * 0.5, 0.0, 1.0));
  float wa = uWarp0 + uWarp1 * lk0.y;                              // a storm drags the ink much further
  vec3 f0 = inkAt(q, wa, uWT);
  vec3 fxp = inkAt(q + vec2(e, 0.0), wa, uWT), fxm = inkAt(q - vec2(e, 0.0), wa, uWT);
  vec3 fyp = inkAt(q + vec2(0.0, e), wa, uWT), fym = inkAt(q - vec2(0.0, e), wa, uWT);
  vec2 g = vec2(fxp.x - fxm.x, fyp.x - fym.x) / (2.0 * e);         // slope of the water surface (for the sheen)
  // ink layers (u): the waves' own contours + even layers poured down the screen + the drops' ripples, all moved around together
  vec2 gu = vec2((fxp.x - fxm.x) * uDens + (fxp.y - fxm.y) * uLayers + (fxp.z - fxm.z),
                 (fyp.x - fym.x) * uDens + (fyp.y - fym.y) * uLayers + (fyp.z - fym.z)) / (2.0 * e);

  vec3 lk = lookAt(f0.y);
  float mot = lk.x;                                                // how much movement there is here (0 = still, 1 = moving): slides both inks along their blue -> pink ranges
  float hueD = mix(uDH0, uDH1, mot) / 360.0;
  float hueL = mix(uLH0, uLH1, mot) / 360.0;

  float u = f0.x * uDens + f0.y * uLayers + f0.z;
  float aa = clamp(length(gu) * pix * 0.8, 0.05, 0.35);            // never sharp: ink spreads softly into the water
  float s0 = fract(u);
  float d0 = min(s0, 1.0 - s0);                                    // distance (in layers) to the nearest whole layer

  // ink floating on water: a translucent dark ink over a pale light one, thickest in the middle of each band and thinning
  // softly to its edges. uContrast sets how far apart the two tones are; each ink has its own color.
  float lumD = clamp(0.62 - 0.26 * uContrast, 0.0, 1.0);
  float lumL = clamp(0.80 + 0.20 * uContrast, 0.0, 1.0);
  vec3 dark  = hsv2rgb(vec3(hueD, uDSat, lumD));                  // the dark ink: blue
  vec3 light = hsv2rgb(vec3(hueL, mix(uLSat, uLSat1, mot), lumL)); // the light ink: white, warming to pink as people move
  float duty = uLine * (0.8 + 0.3 * sin(TAU * 0.37 * u + 2.0 * f0.y));                          // ink band width, varying a little so it isn't mechanical
  float darkW = 1.0 - smoothstep(duty - aa, duty + aa, d0);
  float thick = 1.0 - clamp(d0 / max(duty, 0.02), 0.0, 1.0);                                    // 1 in the middle of a band, 0 at its edge
  vec3 col = mix(light, dark, darkW * (0.72 + 0.28 * thick));

  // the drops themselves, seen in the same moving water: a soft ring at the rim and clear, still water inside
  vec2 pd = dragP(q, wa, uWT);
  float px = pix * 1.8;
  float fillM = 0.0, ringM = 0.0, coreM = 0.0;
  for (int k = 0; k < MAXW; k++) {
    if (k >= uCount) break;
    vec2 d; float R, Rb;
    dropAt(pd, uP2[k].y, uP3[k].y, uP3[k].z, uP3[k].w, uP4[k].x, uP4[k].y, uP0[k].x, d, R, Rb);
    float r = length(d);
    float edge = r - R;
    float fk = 1.0 - smoothstep(-px, px, edge);
    fillM = max(fillM, fk);
    coreM = max(coreM, fk * max(exp(-uP4[k].y / 2.6), 0.14) * (1.0 - 0.55 * clamp(r / max(R, 0.02), 0.0, 1.0)));   // (a faint blue wash stays at the heart)   // the brush's dense ink, bleeding thinner from the rim inward
    ringM = max(ringM, smoothstep(-px, px, edge) * (1.0 - smoothstep(uDropRing - px, uDropRing + px, edge)));
  }
  vec3 ringC = hsv2rgb(vec3(hueD, min(uDSat * 1.1, 1.0), max(lumD - 0.12, 0.0)));
  vec3 inner = hsv2rgb(vec3(uDropHue / 360.0, uDropSat, 0.97));          // the drop's own color: a soft pink pool...
  vec3 coreC = hsv2rgb(vec3(uCoreHue / 360.0, uCoreSat, 0.34));          // ...with the brush's deep blue ink in the middle
  ringM *= 1.0 - smoothstep(0.55, 0.95, fillM);                    // where two drops run together they become one pool: no rim inside it
  col = mix(col, ringC, ringM * 0.8);
  col = mix(col, inner, fillM);
  col = mix(col, coreC, coreM * 0.92);                             // the brush's dense ink, bleeding thinner from the rim inward

  // the water's surface: the waves tilt it, so it catches soft light and the odd glint, like the window reflected in a tray of water
  vec3 n = normalize(vec3(-g.x * 0.12, -g.y * 0.12, 1.0));
  float tilt = dot(n, normalize(vec3(0.0, 0.6, 0.8)));
  float onWater = 1.0 - fillM;                                     // the drops themselves are flat, still water: no tilt shading inside them
  col *= 1.0 + onWater * uSheen * 0.22 * (tilt - 0.8);
  col += onWater * uSheen * 0.22 * pow(max(dot(n, normalize(vec3(0.0, 0.35, 0.94))), 0.0), 90.0);
  col += (hash12(vec2(abs(gl_FragCoord.x - 0.5 * uRes.x) * 1.3, gl_FragCoord.y * 1.3 + 17.0)) - 0.5) * (0.04 + 0.1 * darkW) * uGrain;   // optional speckle (grain 0 = none)

  col += (hash12(vec2(abs(gl_FragCoord.x - 0.5 * uRes.x), gl_FragCoord.y)) - 0.5) / 255.0;   // dither (mirrored, like everything else)
  gl_FragColor = vec4(col, 1.0);
}`;

const WaterGL = {
  quality: 1, qAcc: 0, qN: 0, qWarm: 0,
  tried: false, ok: false, canvas: null, gl: null, prog: null, u: {}, w: 0, h: 0, error: '',
  p0: new Float32Array(MAX_WAVES * 4), p1: new Float32Array(MAX_WAVES * 4), p2: new Float32Array(MAX_WAVES * 4), p3: new Float32Array(MAX_WAVES * 4), p4: new Float32Array(MAX_WAVES * 4),

  init() {
    if (this.tried) return this.ok;
    this.tried = true;
    try {
      this.canvas = document.createElement('canvas');
      const gl = this.canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false });
      if (!gl) throw new Error('WebGL is not available');
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, WATER_VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, WATER_FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      // one big triangle that covers the whole screen
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const n of ['uRes', 'uCount', 'uN', 'uSig', 'uSpan', 'uSteep', 'uHMax', 'uCurve', 'uCross', 'uChop', 'uSharpen', 'uCaus', 'uGlow', 'uTexture', 'uDropHue', 'uDropSat', 'uCoreHue', 'uCoreSat', 'uContrast', 'uDH0', 'uDH1', 'uLH0', 'uLH1', 'uDSat', 'uLSat', 'uLSat1', 'uGrain', 'uSheen', 'uDrop', 'uDropRing', 'uRipple', 'uRippleLen', 'uLayers', 'uDens', 'uWarp0', 'uWarp1', 'uWT', 'uLine', 'uP0', 'uP1', 'uP2', 'uP3', 'uP4']) {
        this.u[n] = gl.getUniformLocation(prog, n);
      }
      this.gl = gl; this.prog = prog; this.ok = true;
    } catch (e) {
      this.error = String(e.message || e);
      console.error('[WATER] could not start the GPU water renderer:', this.error);
    }
    return this.ok;
  },

  // Watches the real frame rate and, if it stays low, steps the render size down (and never back up, so it can't flip-flop). Frames right after
  // a change, and the first seconds while the camera and PoseNet model are loading, are ignored.
  adapt(ms) {
    if (!TUNE.water.autoQuality || millis() < 5000) return;
    if (this.qWarm > 0) { this.qWarm--; return; }
    this.qAcc += ms; this.qN++;
    if (this.qN < 90) return;
    const avg = this.qAcc / this.qN;
    this.qAcc = 0; this.qN = 0;
    if (avg > 22 && this.quality > 0.35) { this.quality = Math.max(0.35, this.quality * 0.82); this.qWarm = 45; console.log('[WATER] running slow (' + Math.round(1000 / avg) + ' fps): render quality now ' + this.quality.toFixed(2)); }
  },

  // Renders the water for this frame into the p5 canvas.
  render(f) {
    if (!this.init()) return false;
    const K = TUNE.water, gl = this.gl, u = this.u;
    let sc = K.resolution * this.quality;
    let w = width * sc, h = height * sc;
    if (w * h > K.maxPixels) { const k = Math.sqrt(K.maxPixels / (w * h)); w *= k; h *= k; }
    w = Math.max(64, Math.round(w / 2) * 2); h = Math.max(64, Math.round(h / 2) * 2);
    if (w !== this.w || h !== this.h) { this.canvas.width = this.w = w; this.canvas.height = this.h = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1i(u.uCount, f.count);
    gl.uniform1f(u.uN, f.N); gl.uniform1f(u.uSig, f.sig);
    gl.uniform1f(u.uSpan, K.wavelengthSpan); gl.uniform1f(u.uSteep, K.steepness); gl.uniform1f(u.uHMax, K.hMax);
    gl.uniform1f(u.uCurve, K.curve); gl.uniform1f(u.uCross, K.crossSwell); gl.uniform1f(u.uChop, K.chop); gl.uniform1f(u.uSharpen, K.crestSharpen);
    gl.uniform1f(u.uDropHue, K.dropHue); gl.uniform1f(u.uDropSat, K.dropSat); gl.uniform1f(u.uCoreHue, K.dropCoreHue); gl.uniform1f(u.uCoreSat, K.dropCoreSat);
    gl.uniform1f(u.uContrast, K.contrast); gl.uniform1f(u.uDH0, K.darkHueStill); gl.uniform1f(u.uDH1, K.darkHueMoving); gl.uniform1f(u.uLH0, K.lightHueStill); gl.uniform1f(u.uLH1, K.lightHueMoving); gl.uniform1f(u.uDSat, K.darkSat); gl.uniform1f(u.uLSat, K.lightSat); gl.uniform1f(u.uLSat1, K.lightSatMoving); gl.uniform1f(u.uGrain, K.grain); gl.uniform1f(u.uSheen, K.sheen); gl.uniform1f(u.uDrop, K.dropSize); gl.uniform1f(u.uDropRing, K.dropRing); gl.uniform1f(u.uRipple, K.ripples); gl.uniform1f(u.uRippleLen, K.rippleReach); gl.uniform1f(u.uLayers, K.inkLayers); gl.uniform1f(u.uDens, K.inkDensity); gl.uniform1f(u.uWarp0, K.dragCalm); gl.uniform1f(u.uWarp1, K.dragStorm); gl.uniform1f(u.uWT, f.wt); gl.uniform1f(u.uLine, K.inkLine);
    gl.uniform1f(u.uCaus, K.caustics); gl.uniform1f(u.uGlow, K.glow); gl.uniform1f(u.uTexture, K.texture);
    gl.uniform4fv(u.uP0, this.p0); gl.uniform4fv(u.uP1, this.p1); gl.uniform4fv(u.uP2, this.p2); gl.uniform4fv(u.uP3, this.p3); gl.uniform4fv(u.uP4, this.p4);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    drawingContext.drawImage(this.canvas, 0, 0, width, height);   // same frame, so the GPU buffer is still valid
    return true;
  }
};

let inkDragPhase = 0;
let frameDt = 1 / 60;
function drawCrowdWater(now) {
  const K = TUNE.water, T = K.smooth;
  // First person = the band nearest the viewer. A new person only gets a wave once their tracking has settled (a few
  // pose events) — before that their measurements are just placeholders.
  const list = Array.from(people.values()).filter(p => p.poseEvents >= 5).sort((a, b) => a.id - b.id).slice(0, MAX_WAVES);
  if (!list.length) return;
  // Frame time, smoothed: when PoseNet briefly hogs the GPU and a frame arrives late, the water carries on at an even pace instead of lurching
  // to catch up (a late frame is spread over the next several).
  const dtRaw = Math.min(0.1, (typeof deltaTime === 'number' ? deltaTime : 16.7) / 1000);
  frameDt += (dtRaw - frameDt) * 0.08;
  const dt = Math.max(0.004, Math.min(0.04, frameDt));
  const timeS = now / 1000;

  if (crowdInit) crowdS.update(list.length, T.crowd, dt); else { crowdS.snap(list.length); crowdInit = true; }
  const N = Math.max(1, crowdS.v);

  // ---- each person's wave for this frame ----
  const W = WaterGL;
  W.p0.fill(0); W.p1.fill(0); W.p2.fill(0); W.p3.fill(0); W.p4.fill(0);
  list.forEach((p, i) => {
    const d = p.d, m = p.m, fw = formWeights(m);
    const life = lifeAlpha(p, now);
    const missed = now - p.lastSeen, outA = missed > 250 ? clamp01(1 - (missed - 250) / (TUNE.tracking.personTimeoutMs - 250)) : 1;   // fade-out part of life only
    const mo = d.motion.v;
    const targets = {
      motion: m.motion, count: p.countTarget,
      amp: lerp(K.ampCalm, K.ampSwell, mo) * (1 + K.stormAmpBoost * d.storm.v),
      freq: lerp(K.freqCalm, K.freqSwell, mo) + K.stormFreqBoost * d.storm.v,
      storm: m.storm
    };
    if (!p.dInit) {
      d.rank.snap(i + 1); d.motion.snap(targets.motion); d.count.snap(targets.count);
      d.wC.snap(fw[0]); d.wS.snap(fw[1]); d.wT.snap(fw[2]);
      d.amp.snap(targets.amp); d.freq.snap(targets.freq); d.storm.snap(targets.storm); d.drop.snap(1); p.inkAge = 0;
      p.dInit = true;
    } else {
      d.rank.update(i + 1, T.rank, dt);
      d.motion.update(targets.motion, T.motion, dt);
      d.count.update(targets.count, T.count, dt);
      d.wC.update(fw[0], T.form, dt); d.wS.update(fw[1], T.form, dt); d.wT.update(fw[2], T.form, dt);
      d.amp.ud(targets.amp, T.ampUp, T.ampDown, dt);
      d.freq.ud(targets.freq, T.freqUp, T.freqDown, dt);
      d.storm.ud(targets.storm, T.stormUp, T.stormDown, dt);
      d.drop.ud(outA, T.dropUp, T.dropDown, dt);
    }
    const st = d.storm.v;
    p.inkAge += dt * Math.sqrt(K.speed);                                // seconds since this person's ink touched the water (runs with the speed dial, gently)
    // Phase only ever moves forward. A storm makes the surge uneven (gusts) — the phase still never jumps.
    const gust = 1 + K.gust * st * Math.sin(WTAU * 0.15 * timeS + p.id * 1.7);
    p.phase += WTAU * d.freq.v * gust * dt * K.speed;
    for (let j = 0; j < 3; j++) p.chopPh[j] += WTAU * CHOP_RATE[j] * (0.3 + 0.7 * st) * dt * K.speed;

    const wsum = (d.wC.v + d.wS.v + d.wT.v) || 1;
    const hue = d.motion.v;                                           // (the shader turns movement into the two inks' colors)
    const o = i * 4;
    W.p0[o] = d.amp.v; W.p0[o + 1] = constrain(d.count.v * K.crestsPerPoint * (1 + K.stormCrestBoost * st), 1.5, 20); W.p0[o + 2] = st; W.p0[o + 3] = p.phase;
    W.p1[o] = d.wC.v / wsum; W.p1[o + 1] = d.wS.v / wsum; W.p1[o + 2] = d.wT.v / wsum; W.p1[o + 3] = life;
    W.p2[o] = hue; W.p2[o + 1] = d.rank.v; W.p2[o + 2] = p.chopPh[0]; W.p2[o + 3] = p.chopPh[1];
    W.p4[o] = Math.min(outA, Math.max(0, d.drop.v)); W.p4[o + 1] = p.inkAge;   // how present the drop is (exactly 0 as its person is removed) and how long ago it touched down
    W.p3[o] = p.chopPh[2];
    const hs = n => { const x = Math.sin((n + 1) * 12.9898 + p.id * 78.233) * 43758.5453; return x - Math.floor(x); };   // this person's own, fixed random numbers: where their drop sits, how big, what shape
    W.p3[o + 1] = hs(1); W.p3[o + 2] = hs(2); W.p3[o + 3] = hs(3);
  });

  // The ink's drag currents drift forward at a pace set by the crowd's average storm — phase only ever advances, so a change of pace never jumps
  const stAvg = list.reduce((a, p) => a + p.d.storm.v, 0) / list.length;
  inkDragPhase += lerp(K.flowCalm, K.flowStorm, stAvg) * dt * K.speed;

  W.adapt(typeof deltaTime === 'number' ? deltaTime : 16.7);
  const ok = W.render({ count: list.length, N, sig: K.bandOverlap * 0.5 / N, wt: inkDragPhase });
  if (!ok) { // no WebGL: say so on screen rather than showing nothing
    drawingContext.save(); drawingContext.fillStyle = '#fff'; drawingContext.font = '16px sans-serif';
    drawingContext.fillText('The water needs WebGL: ' + W.error, 12, 90); drawingContext.restore();
  }
}

/* =============================
   8) TRACKING TOGGLES
   ============================= */
function startTrackingImpl() {
  if (trackingStarted) return;
  trackingStarted = true;
  window.__ebTrackingStarted = true;

  if (window.__ebSession && window.__ebSessionReady) {
    if (!window.__ebSession.active) window.__ebSession.begin();
  }
  if (window.EnergyBodiesDisplay) EnergyBodiesDisplay.tracking(true);
}

function stopTrackingImpl() {
  if (TUNE.autoRun) { console.log('[DISPLAY] autoRun is on — ignoring stop'); return; }
  if (!trackingStarted) return;
  trackingStarted = false;
  window.__ebTrackingStarted = false;

  if (window.__ebSession && window.__ebSession.active) window.__ebSession.end();
  if (window.EnergyBodiesDisplay) EnergyBodiesDisplay.tracking(false);
}

window.__ebStartTrackingImpl = startTrackingImpl;
window.__ebStopTrackingImpl = stopTrackingImpl;
window.__ebTrackingReady = true;
window.__ebPrintImpl = onPrintAverageThenSnapshot;

function resetAll() {
  if (TUNE.autoRun) { console.log('[DISPLAY] autoRun is on — ignoring reset'); return; }
  try { stopTrackingImpl(); } catch (e) { }
  people.clear();
  nextPersonId = 1;
  crowdInit = false;
  latestPoses = [];
  if (window.EnergyBodiesDisplay) {
    try { EnergyBodiesDisplay.tracking(false); } catch (e) { }
  }
}

/* =============================
   9) CROWD AGGREGATE → CONTROL PANEL
   ============================= */
function buildCrowdSample() {
  const arr = Array.from(people.values());
  const n = arr.length;
  const velocity = n ? arr.reduce((sum, p) => sum + p.avgVel, 0) / n : 0;
  return { headcount: n, velocity };
}

function accumulateSession() {
  if (trackingStarted && window.__ebSession?.active) {
    window.__ebSession.add(buildCrowdSample());
  }
}

let __lastEmitMs = 0;
const EMIT_MS = 100;
function emitToControl() {
  const now = millis();
  if (now - __lastEmitMs < EMIT_MS) return;
  __lastEmitMs = now;
  if (!window.EnergyBodiesDisplay) return;

  EnergyBodiesDisplay.crowd({ ...buildCrowdSample(), t: now });

  const vw = video?.width || 960, vh = video?.height || 540;
  const list = Array.from(people.values()).map(p => ({
    id: p.id,
    x: p.tx / vw,
    y: p.ty / vh,
    hue: p.hue,
    vel: p.avgVel
  }));
  EnergyBodiesDisplay.people(list);
}

/* =============================
   10) PRINT FLOW
   ============================= */
function captureEnergyBodyHiRes() {
  return get().canvas.toDataURL('image/png');
}

function generateReceiptHTML(imageDataURL, avg) {
  const timestamp = new Date().toLocaleString();
  const durationSec = (avg.durationMs / 1000).toFixed(1);
  const fmt = (val) => (typeof val === 'number' ? val.toFixed(2) : '0.00');

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Energy Bodies — Crowd Receipt</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body { background: #000; color: #fff; font-family: 'Courier New', monospace; font-size: 11px; }
          .receipt { width: 4in; margin: 0 auto; background: #000; padding: 0.25in; }
          .header { text-align: center; border-bottom: 2px dashed #fff; padding-bottom: 10px; margin-bottom: 15px; }
          .header h1 { font-size: 16px; font-weight: bold; margin-bottom: 5px; letter-spacing: 1px; }
          .header .timestamp { font-size: 9px; opacity: 0.8; }
          .image-container { width: 100%; margin: 15px 0; text-align: center; }
          .image-container img { width: 100%; height: auto; border: 1px solid #fff; }
          .section { margin: 15px 0; border-top: 1px dashed #666; padding-top: 10px; }
          .section-title { font-weight: bold; font-size: 12px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
          .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
          .meta-item { font-size: 10px; }
          .meta-item .label { opacity: 0.7; }
          .meta-item .value { font-weight: bold; }
          .core-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
          .metric { text-align: center; padding: 8px; border: 1px solid #444; }
          .metric .name { font-size: 9px; opacity: 0.7; margin-bottom: 3px; }
          .metric .val { font-size: 14px; font-weight: bold; }
          .footer { margin-top: 20px; padding-top: 10px; border-top: 2px dashed #fff; text-align: center; font-size: 9px; opacity: 0.6; }
          @page { size: 4in 6in; margin: 0; }
          @media print { body { background: #000; } .receipt { margin: 0; } }
        </style>
      </head>
      <body>
        <div class="receipt">
          <div class="header">
            <h1>ENERGY BODIES — GROUP</h1>
            <div class="timestamp">${timestamp}</div>
          </div>
          <div class="section">
            <div class="section-title">Session Summary</div>
            <div class="meta-grid">
              <div class="meta-item"><div class="label">Duration:</div><div class="value">${durationSec}s</div></div>
              <div class="meta-item"><div class="label">Samples:</div><div class="value">${avg.samples}</div></div>
              <div class="meta-item"><div class="label">Peak participants:</div><div class="value">${avg.peakHeadcount}</div></div>
              <div class="meta-item"><div class="label">Avg participants:</div><div class="value">${fmt(avg.avgHeadcount)}</div></div>
            </div>
          </div>
          <div class="image-container"><img src="${imageDataURL}" alt="Energy Bodies — Crowd"></div>
          <div class="section">
            <div class="section-title">Crowd Motion</div>
            <div class="core-metrics">
              <div class="metric"><div class="name">Avg Velocity</div><div class="val">${fmt(avg.velocity)}</div></div>
              <div class="metric"><div class="name">Peak Headcount</div><div class="val">${avg.peakHeadcount}</div></div>
            </div>
          </div>
          <div class="footer">Energy Bodies — Crowd Session ${Date.now().toString().slice(-6)}</div>
        </div>
      </body>
    </html>`;
}

function onPrintAverageThenSnapshot() {
  const s = window.__ebSession;
  if (!s || !s.active) {
    console.warn('[PRINT] No active session - using snapshot only');
    return onPrintSnapshotFallback();
  }

  const avg = s.end();
  if (!avg || avg.samples === 0) {
    console.warn('[PRINT] No samples - using snapshot only');
    return onPrintSnapshotFallback();
  }

  const dataURL = captureEnergyBodyHiRes();
  const html = generateReceiptHTML(dataURL, avg);
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
  w.onload = () => { w.focus(); w.print(); };
}

function onPrintSnapshotFallback() {
  const dataURL = captureEnergyBodyHiRes();
  const w = window.open('', '_blank');
  w.document.write(`
    <html><head><title>Print Energy Bodies</title>
      <style>
        html,body{margin:0;padding:0;background:#000;}
        img{width:100%;height:auto;display:block;}
        @page { size: 4in 6in; margin: 0; }
      </style>
    </head>
    <body><img src="${dataURL}"></body></html>
  `);
  w.document.close();
  w.onload = () => { w.focus(); w.print(); };
}
