/* ============================================================================
   ENERGY BODIES — CROWD EDITION — DISPLAY SKETCH (v6: one mirrored image)
   One image for the whole room. A vertical mirror line runs down the middle of
   the screen; everything is drawn on one side and reflected onto the other,
   and the whole image always fits inside the screen.
     - PoseNet runs in 'multiple' detection mode and a lightweight nearest-neighbor
       tracker gives each person a stable id across frames
     - Each person is one COLUMN of shapes stacked down the screen. The first
       person hugs the mirror line and every additional person adds a column
       further out; the columns re-space so they always fit.
     - A column holds that person's number of tracked body points (rounded up to
       an even number), split across the two sides — a full body is 9 per side
     - The shapes are organic forms (wobbly outlines, nested inner loops or a
       spiral, each leaning a little differently). Which form comes from that
       person's movement: still = boxy bowl, a few body parts moving = pointed
       wedge, whole-body movement = round loop with a spiral
     - Stillness vs motion sets the color: blue (still) → violet → red (moving)
     - Nothing rotates; changes glide in slowly
   IMPORTANT: Load eb-init.js BEFORE this file!
   ============================================================================ */

if (typeof window.beginSession !== 'function') {
  console.error('[SKETCH] ERROR: eb-init.js must be loaded first!');
}

/* =============================
   0) MASTER TUNING CONSTANTS
   ============================= */
const TUNE = {
  tracking: {
    maxPeople: 12,          // PoseNet maxPoseDetections — also the most rings there can be
    scoreThreshold: 0.4,
    matchRadiusFrac: 0.3,   // fraction of video diagonal — how far a skeleton can drift frame-to-frame and still count as the same person before falling back to nearest-available matching (see matchPeopleToPoses)
    personTimeoutMs: 1000   // how long a person can go undetected before their ring is dropped
  },
  point: {
    kpMinScore: 0.4,      // ignore keypoints PoseNet isn't confident about
    posSmoothing: 0.22,   // how quickly a point's tracked position catches up to the raw detection (lower = smoother, more lag)
    velEMA: 0.18,          // smoothing on each point's own velocity reading (lower = smoother, more lag)
    velDeadzone: 0.0025,  // raw per-frame velocity below this is treated as 0 — absorbs PoseNet's baseline detection jitter on a still body
    velNormMin: 0.0,      // velocity (normalized by video diagonal per frame) that reads as "still"
    velNormMax: 0.05,     // velocity that reads as "fully activated"
    presenceInRate: 0.3,  // how fast a keypoint fades IN once PoseNet is confident about it again
    presenceOutRate: 0.12 // how fast a keypoint fades OUT when lost — slow, so a borderline/flickering detection doesn't pop on and off
  },
  kaleido: {
    // --- layout: a vertical mirror line down the middle of the screen ---
    overlap: 1.25,          // shapes are this much bigger than the cell they sit in, so neighbors overlap (1.0 = just touch)
    maxBandFrac: 0.15,      // widest a shape may get, as a fraction of the screen height — keeps them from stretching into flat ovals when few people are present
    margin: 0.03,           // empty border around the image, as a fraction of the screen
    opacity: 0.5,           // translucent, so overlapping shapes show through each other (lower = more see-through, but murkier color on black)
    // --- how many shapes are in a person's column (across both sides of the mirror) ---
    reflectionsFrom: 'bodyPoints', // 'bodyPoints': that person's number of tracked body points, rounded up to even
                                   // 'people':     one per person detected instead
    // --- movement → which organic form ---
    motionFullMean: 0.3,    // mean keypoint activation that reads as "fully in motion"
    stillThreshold: 0.08,   // motion below this = still → boxy bowl
    wholeBodyFrac: 0.45,    // share of visible body points moving at once that counts as whole-body → round loop (fewer = localized → pointed wedge)
    // --- stillness vs motion → color (hue in degrees: 215 = blue, 360 = red, passing through violet) ---
    hueStill: 215, hueMoving: 360,
    saturation: 80, brightness: 95,
    // --- calm, flowing motion: everything below trades responsiveness for smoothness ---
    motionAttack: 0.12,     // per pose event: how fast the movement reading rises when someone starts moving...
    motionRelease: 0.04,    // ...and how slowly it falls when they stop, so color and shape settle gently instead of snapping back
    layoutDebounceMs: 1200, // a new layout (copy count / shape) must hold this long before it's applied...
    layoutFadeFrames: 50,   // ...and then cross-fades in over this many frames
    fadeInMs: 1200,         // how slowly a newly detected person fades in
    // how long (seconds, roughly) each of these takes to glide to a new value — bigger = slower, calmer:
    // a column moving to a new position, the spacing between columns, the color, and the overall fit to the screen
    smooth: { rank: 1.4, crowd: 1.4, motion: 1.6, fit: 1.2 }
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
   3) PERSON — one tracked body in the crowd (= one ring)
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
      // so a keypoint flickering near the confidence threshold doesn't make the ring jump around.
      this.points[name] = { x: cx, y: cy, vel: 0, score: 0, presence: 0 };
    }

    // Movement summary, recomputed on every pose event (see updatePersonMetrics).
    this.m = { bodyPoints: 0, motion: 0, movingFrac: 0 };

    // What this ring draws: how many copies and which shape. A change must hold for
    // layoutDebounceMs and then cross-fades in, so detection flicker never makes the ring jump.
    const start = { refl: 2, shape: 'square' };
    this.layoutCur = start; this.layoutPrev = start; this.layoutPending = start;
    this.pendingSince = 0;
    this.layoutFade = 1;

    // Values actually drawn, eased toward their targets every frame.
    this.d = { rank: new Smooth(1), motion: new Smooth(0) };
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

  // Pass 1: match existing people to the nearest unused detection within the normal radius.
  for (const person of people.values()) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < detections.length; i++) {
      if (used[i]) continue;
      const d = dist(person.tx, person.ty, detections[i].center.x, detections[i].center.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD < matchRadius) {
      used[best] = true;
      updatePersonPoints(person, detections[best].pose, now);
    } else {
      unmatchedPeople.push(person);
    }
  }

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
      pt.score = k.score;
      pt.presence = lerp(pt.presence, 1, P.presenceInRate);

      visible++;
      sumVel += pt.vel;
    } else {
      pt.vel = lerp(pt.vel, 0, P.velEMA); // decay toward still when not seen
      pt.score = 0;
      pt.presence = lerp(pt.presence, 0, P.presenceOutRate);
    }
  }

  person.avgVel = visible ? sumVel / visible : 0;
  person.poseEvents++;
  updatePersonMetrics(person, now);
}

/* =============================
   5b) BODY → RING TARGETS (per pose event)
   ============================= */
const vNorm = v => clamp01(map(v, TUNE.point.velNormMin, TUNE.point.velNormMax, 0, 1));
const evenUp = n => 2 * Math.ceil(n / 2);

function updatePersonMetrics(person, now) {
  const K = TUNE.kaleido, P = person.points, m = person.m;

  // Torso-weighted center, used only to match this person to the next frame's skeletons. Weighted by
  // presence so a hip or shoulder fading in/out glides the center rather than jumping it.
  let wx = 0, wy = 0, ws = 0;
  for (const n of TORSO_POINTS) { wx += P[n].x * P[n].presence; wy += P[n].y * P[n].presence; ws += P[n].presence; }
  if (ws < 0.5) {
    wx = wy = ws = 0;
    for (const n of KEYPOINT_NAMES) { wx += P[n].x * P[n].presence; wy += P[n].y * P[n].presence; ws += P[n].presence; }
  }
  if (ws > 0.01) { person.tx = wx / ws; person.ty = wy / ws; }

  // Movement: how many body points are tracked, how much the body is moving overall (still vs. moving),
  // and how much of it is moving at once (a waving hand vs. a dancing body).
  let visible = 0, sum = 0, movingN = 0;
  for (const name of KEYPOINT_NAMES) {
    if (P[name].presence <= 0.5) continue;
    const v = vNorm(P[name].vel);
    visible++; sum += v;
    if (v > 0.03) movingN++;
  }
  m.bodyPoints = visible;
  // Low-pass the readings: quick to notice movement, slow to let go. This is what makes color and shape
  // drift rather than flicker with every jittery pose event (and keeps the shape rule from flapping).
  const motionNow = visible ? clamp01((sum / visible) / K.motionFullMean) : 0;
  const fracNow = visible ? movingN / visible : 0;
  m.motion = lerp(m.motion, motionNow, motionNow > m.motion ? K.motionAttack : K.motionRelease);
  m.movingFrac = lerp(m.movingFrac, fracNow, fracNow > m.movingFrac ? K.motionAttack : K.motionRelease);

  const refl = K.reflectionsFrom === 'people' ? Math.max(2, evenUp(people.size)) : Math.max(2, evenUp(visible));
  commitLayout(person, { refl, shape: classifyShape(m) }, now);
}

// Shape from movement: still → square (grounded), a few body parts moving → triangle (pointed, directed),
// most of the body moving → circle (flowing).
function classifyShape(m) {
  const K = TUNE.kaleido;
  if (m.motion < K.stillThreshold) return 'square';
  return m.movingFrac >= K.wholeBodyFrac ? 'circle' : 'triangle';
}

function commitLayout(person, target, now) {
  const same = (a, b) => a.refl === b.refl && a.shape === b.shape;
  if (person.poseEvents < 5) { // presence is still ramping up on a brand-new person; settle silently
    person.layoutCur = person.layoutPrev = person.layoutPending = target;
    return;
  }
  if (!same(target, person.layoutPending)) {
    person.layoutPending = target;
    person.pendingSince = now;
  } else if (!same(target, person.layoutCur) && now - person.pendingSince >= TUNE.kaleido.layoutDebounceMs) {
    person.layoutPrev = person.layoutCur;
    person.layoutCur = target;
    person.layoutFade = 0;
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

  fill(255);
  noStroke();
  textSize(14);
  text(`people: ${people.size} | tracking: ${trackingStarted}`, 12, 20);
  if (window.__ebSession?.active) text(`Recording: ${window.__ebSession.samples} samples`, 12, 40);
  text(`[${displayOrientation}]`, 12, 60);

  if (!trackingStarted) return;
  drawCrowdMirror(millis());
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

/* =============================
   7) DRAWING — one mirrored image for the whole room
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
}

const crowdS = new Smooth(1), fitS = new Smooth(0); // eased number of people (columns glide apart/together) and the width of one column
let crowdInit = false, fitInit = false;

// Fade a person in when first detected and out as they go missing, rather than popping.
function lifeAlpha(person, now) {
  const fadeIn = clamp01((now - person.born) / TUNE.kaleido.fadeInMs);
  const missing = now - person.lastSeen;
  const fadeStart = 250;
  const fadeOut = missing > fadeStart ? clamp01(1 - (missing - fadeStart) / (TUNE.tracking.personTimeoutMs - fadeStart)) : 1;
  return fadeIn * fadeOut;
}

/* --- organic shapes ---------------------------------------------------------------------
   Each form lives in a unit box: x runs from -0.5 (the side facing the mirror line) to +0.5 (outward), y from
   -0.5 to 0.5. A form is a few strokes — an outline plus nested inner loops or a spiral —
   generated once from a seed (so it never shimmers) and cached. */
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// HSB (hue 0-360, saturation/brightness 0-100) → CSS hsl() string, since the shapes are drawn on the raw canvas.
function hsbToCss(h, sat, bri) {
  const s = sat / 100, v = bri / 100;
  const l = v * (1 - s / 2);
  const sl = (l === 0 || l === 1) ? 0 : (v - l) / Math.min(l, 1 - l);
  return `hsl(${Math.round(h) % 360}, ${(sl * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%)`;
}

// Chaikin corner-cutting: turns a rough closed polygon into a soft, rounded loop.
function chaikin(pts, iterations) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    p = q;
  }
  return p;
}

const blobCache = new Map();
function blobFor(kind, seed) {
  const key = kind + ':' + seed;
  let g = blobCache.get(key);
  if (!g) {
    if (blobCache.size > 1500) blobCache.clear();
    g = makeBlob(kind, seed);
    blobCache.set(key, g);
  }
  return g;
}

function makeBlob(kind, seed) {
  const TAU = Math.PI * 2;
  const rnd = mulberry32(seed);
  const between = (lo, hi) => lo + (hi - lo) * rnd();
  // A smooth random wobble around a loop: a few low-frequency waves with random phases.
  const wobble = amp => {
    const ph = [rnd() * TAU, rnd() * TAU, rnd() * TAU];
    const am = [amp * (0.6 + 0.4 * rnd()), amp * 0.6 * (0.6 + 0.4 * rnd()), amp * 0.35 * (0.6 + 0.4 * rnd())];
    return th => am[0] * Math.sin(2 * th + ph[0]) + am[1] * Math.sin(3 * th + ph[1]) + am[2] * Math.sin(5 * th + ph[2]);
  };
  const loop = (fn, n = 44) => Array.from({ length: n }, (_, j) => fn(TAU * j / n));
  const raw = [];
  const add = (pts, closed, fill, w, a) => raw.push({ pts, closed, fill, w, a });

  if (kind === 'circle') {
    // Whole-body movement: a round, lopsided loop with an inward spiral inside it.
    const wb = wobble(0.09);
    add(loop(th => { const r = 0.42 * (1 + wb(th)); return [r * Math.cos(th), r * Math.sin(th)]; }), true, true, 1, 1);
    const turns = between(1.5, 2.2), start = rnd() * TAU, spiral = [];
    for (let j = 0; j <= 34; j++) {
      const t = j / 34, ph = start + t * turns * TAU, r = 0.34 * (1 - t) + 0.03;
      spiral.push([0.02 + r * Math.cos(ph), r * Math.sin(ph)]);
    }
    add(spiral, false, false, 0.8, 0.9);
  } else if (kind === 'square') {
    // Stillness: a soft, boxy bowl with smaller, differently-wobbling boxes nested inside it.
    const e = 2 / between(2.6, 3.6);
    const box = (k, dx) => {
      const wb = wobble(0.08);
      return loop(th => {
        const c = Math.cos(th), s = Math.sin(th), r = 0.44 * k * (1 + wb(th));
        return [dx + r * Math.sign(c) * Math.pow(Math.abs(c), e), r * Math.sign(s) * Math.pow(Math.abs(s), e)];
      });
    };
    add(box(1, 0), true, true, 1, 1);
    add(box(0.64, between(0, 0.06)), true, false, 0.8, 0.9);
    add(box(0.32, between(0.02, 0.08)), true, false, 0.65, 0.8);
  } else {
    // A few body parts moving: a pointed, leaf-like wedge — flat side against the mirror line, tip reaching outward,
    // edges bowed rather than straight — with smaller wedges nested inside it.
    const wedge = k => {
      const wb = wobble(0.07), corners = [[-0.48, -0.46], [0.5, between(-0.06, 0.06)], [-0.48, 0.46]], pts = [];
      for (let e = 0; e < 3; e++) {
        const a = corners[e], b = corners[(e + 1) % 3];
        const nx = -(b[1] - a[1]), ny = b[0] - a[0], len = Math.hypot(nx, ny), bow = between(-0.05, 0.12);
        for (let j = 0; j < 7; j++) {
          const t = j / 7, push = bow * Math.sin(Math.PI * t) / len;
          pts.push([a[0] + (b[0] - a[0]) * t + nx * push, a[1] + (b[1] - a[1]) * t + ny * push]);
        }
      }
      const cx = -0.16, cy = 0;
      const wobbled = pts.map(([x, y]) => { const f = 1 + wb(Math.atan2(y - cy, x - cx)); return [cx + (x - cx) * f, cy + (y - cy) * f]; });
      // nest by scaling toward the flat side, so the inner wedges stay anchored to the mirror line
      return chaikin(wobbled, 2).map(([x, y]) => [-0.48 + (x + 0.48) * k, y * k]);
    };
    add(wedge(1), true, true, 1, 1);
    add(wedge(0.56), true, false, 0.8, 0.9);
    add(wedge(0.28), true, false, 0.65, 0.8);
  }

  // Make the whole form less regular: a random lean and tilt.
  const tilt = between(-0.16, 0.16), lean = between(-0.2, 0.2), cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const st of raw) {
    st.pts = st.pts.map(([x, y]) => {
      const px = x * cosT - y * sinT + lean * y, py = x * sinT + y * cosT;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      return [px, py];
    });
  }
  // Rescale so the finished form fills its cell exactly: however much it wobbles or leans it can never poke
  // outside its cell, which is what keeps the whole image inside the screen. Its edge still touches the mirror line.
  const sx = 1 / (maxX - minX), sy = 1 / (maxY - minY);
  const strokes = raw.map(st => ({
    pts: Float32Array.from(st.pts.flatMap(([x, y]) => [(x - minX) * sx - 0.5, (y - minY) * sy - 0.5])),
    closed: st.closed, fill: st.fill, w: st.w, a: st.a
  }));
  return { strokes };
}

// Trace one stroke AND its reflection as a single path. The reflection is the very same points mirrored across
// the vertical line at `axisX`. Doing both in one path (one fill, one stroke) means the two halves can never
// composite in a different order, so the image is an exact mirror even where translucent paint overlaps at the seam.
function tracePair(ctx, pts, axisX, off, cy, sw, sh, closed) {
  for (const side of [1, -1]) {
    for (let i = 0; i < pts.length; i += 2) {
      const x = axisX + side * (off + pts[i] * sw), y = cy + pts[i + 1] * sh;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (closed) ctx.closePath();
  }
}

function drawBlob(ctx, geom, axisX, off, cy, sw, sh, lineW, fillA, strokeA) {
  for (const s of geom.strokes) {
    ctx.beginPath();
    tracePair(ctx, s.pts, axisX, off, cy, sw, sh, s.closed);
    if (s.fill) { ctx.globalAlpha = fillA; ctx.fill(); }
    ctx.lineWidth = lineW * s.w;
    ctx.globalAlpha = strokeA * s.a;
    ctx.stroke();
  }
}

// One person's column: a vertical stack of shapes, drawn on both sides of the mirror line. `bandPos` is how many
// columns out from the mirror line this one starts (0 = touching it); `bw` is the width of one column.
function drawColumn(ctx, person, bandPos, bw, layout, alpha, css) {
  if (alpha <= 0.002) return;
  const K = TUNE.kaleido, W = width, H = height;
  const perSide = Math.max(1, Math.round(layout.refl / 2));
  // Fit the stack exactly into the screen height: first shape's top and last shape's bottom land on the margins.
  const step = (H * (1 - 2 * K.margin)) / (perSide - 1 + K.overlap);
  const sh = step * K.overlap, sw = bw * K.overlap;
  const inner = bandPos * bw;
  const lineW = constrain(sh * 0.085, 2, 11);
  const fillA = alpha * 0.75, strokeA = Math.min(1, alpha * 1.7);
  ctx.fillStyle = css;
  ctx.strokeStyle = css;
  for (let i = 0; i < perSide; i++) {
    const seed = person.id * 1009 + i * 31;
    const jr = mulberry32(seed ^ 0x9e3779b9); // every shape is a little different in size
    const jw = 0.82 + 0.18 * jr(), jh = 0.86 + 0.14 * jr();
    const geom = blobFor(layout.shape, seed);
    const cy = H * K.margin + sh / 2 + i * step;
    const cx = inner + sw * jw / 2; // anchored by its inner edge, so the column stays snug against its neighbor
    drawBlob(ctx, geom, W / 2, cx, cy, sw * jw, sh * jh, lineW, fillA, strokeA); // draws it and its reflection
  }
}

function drawCrowdMirror(now) {
  const K = TUNE.kaleido, T = K.smooth;
  // First person = the column against the mirror line. A new person only gets a column once their tracking has
  // settled (a few pose events) — before that their layout is just a placeholder and would flash a wrong-sized shape.
  const list = Array.from(people.values()).filter(p => p.poseEvents >= 5).sort((a, b) => a.id - b.id);
  if (!list.length) return;
  const dt = Math.min(0.1, (typeof deltaTime === 'number' ? deltaTime : 16.7) / 1000); // seconds; capped so a stalled tab doesn't leap

  if (crowdInit) crowdS.update(list.length, T.crowd, dt); else { crowdS.snap(list.length); crowdInit = true; }
  const N = Math.max(1, crowdS.v);

  list.forEach((p, i) => {
    if (!p.dInit) { p.d.rank.snap(i + 1); p.d.motion.snap(p.m.motion); p.dInit = true; return; }
    p.d.rank.update(i + 1, T.rank, dt);
    p.d.motion.update(p.m.motion, T.motion, dt);
  });

  // Column width: as wide as will let every column fit in half the screen, but never so wide that the shapes
  // stretch into flat ovals. (The outer edge of the last column lands exactly on the margin.)
  const usableHalf = width / 2 - width * K.margin;
  const target = Math.min(usableHalf / (N - 1 + K.overlap), height * K.maxBandFrac / K.overlap);
  if (fitInit) fitS.update(target, T.fit, dt); else { fitS.snap(target); fitInit = true; }
  const bw = fitS.v;

  const ctx = drawingContext;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = list.length - 1; i >= 0; i--) { // outermost first, so inner columns sit on top
    const p = list[i];
    const bandPos = p.d.rank.v - 1;
    const css = hsbToCss(lerp(K.hueStill, K.hueMoving, p.d.motion.v), K.saturation, K.brightness);
    const alpha = K.opacity * lifeAlpha(p, now);
    if (p.layoutFade < 1) p.layoutFade = Math.min(1, p.layoutFade + 1 / K.layoutFadeFrames);
    const f = p.layoutFade * p.layoutFade * (3 - 2 * p.layoutFade); // smoothstep: eases in and out instead of a hard linear ramp
    if (f < 1) drawColumn(ctx, p, bandPos, bw, p.layoutPrev, alpha * (1 - f), css);
    drawColumn(ctx, p, bandPos, bw, p.layoutCur, alpha * f, css);
  }
  ctx.restore();
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
  try { stopTrackingImpl(); } catch (e) { }
  people.clear();
  nextPersonId = 1;
  crowdInit = false; fitInit = false;
  blobCache.clear();
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
