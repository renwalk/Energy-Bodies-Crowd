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
     - Every shape is ONE continuous line — a spiral that starts on the outer
       edge and winds inward — so a person's shapes MORPH between forms rather
       than switching. The form comes from their BODY SHAPE, not their movement,
       blended continuously: soft and relaxed = round, rigid and upright =
       boxy, asymmetrical = wedge. A slow drifting wobble keeps every line in
       constant flux, and the number of shapes in a column glides up and down.
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
    overlap: 2,          // shapes are this much bigger than the cell they sit in, so neighbors overlap (1.0 = just touch)
    maxBandFrac: 0.15,      // widest a shape may get, as a fraction of the screen height — keeps them from stretching into flat ovals when few people are present
    margin: 0.03,           // empty border around the image, as a fraction of the screen
    opacity: 0.25,           // translucent, so overlapping shapes show through each other (lower = more see-through, but murkier color on black)
    // --- how many shapes are in a person's column (across both sides of the mirror) ---
    reflectionsFrom: 'bodyPoints', // 'bodyPoints': that person's number of tracked body points, rounded up to even
                                   // 'people':     one per person detected instead
    // --- body shape → form: asymmetrical = wedge, else rigid/upright = boxy, else soft/relaxed = round. These are
    //     the centers of smooth transitions, not hard switches — a body between two shapes gets a blend of both. ---
    asymThreshold: 0.5,     // asymmetry score (0 = perfect mirror, 1 = very lopsided) at which the form is half-way to a wedge
    rigidThreshold: 0.75,   // rigidity score (0 = slumped and bent, 1 = stiff and upright) at which the form is half-way to boxy
    formSoftness: 0.15,     // how wide each transition is (bigger = the forms blend over a wider range of posture)
    symDeadzone: 0.12,      // left/right mismatch (in shoulder-widths) forgiven as symmetric — nobody's posture is perfect
    symFull: 0.9,           // mismatch that reads as "fully asymmetric"
    spineFullDeg: 25,       // spine (or head-over-shoulders) tilt from vertical that counts as fully un-upright
    shoulderFullDeg: 15,    // shoulder-line tilt that counts as fully un-level
    bentDeg: 100, straightDeg: 175, // elbow/knee angle that counts as fully bent (0) and fully straight (1)
    postureSmoothing: 0.06, // per pose event: posture is read slowly, so a passing gesture doesn't change the form
    // --- constant flux: each line's outline drifts slowly and endlessly, even when the body is still ---
    wobble: 0.11,           // how far the outline wanders from its base form (fraction of its size)
    flux: 1.2,              // how fast it wanders (radians/second at the base rate) — about 5px/second of drift on a ~100px shape
    // --- movement → color only ---
    motionFullMean: 0.3,    // mean keypoint activation that reads as "fully in motion"
    // --- stillness vs motion → color (hue in degrees: 215 = blue, 360 = red, passing through violet) ---
    hueStill: 215, hueMoving: 360,
    saturation: 80, brightness: 95,
    // --- calm, flowing motion: everything below trades responsiveness for smoothness ---
    motionAttack: 0.12,     // per pose event: how fast the movement reading rises when someone starts moving...
    motionRelease: 0.04,    // ...and how slowly it falls when they stop, so color and shape settle gently instead of snapping back
    countDebounceMs: 1200,  // a new shape count in a column must hold this long before the column starts growing/shrinking to it
    fadeInMs: 1200,         // how slowly a newly detected person fades in
    // how long (seconds, roughly) each of these takes to glide to a new value — bigger = slower, calmer:
    // a column moving to a new position, the spacing between columns, the color, the overall fit to the screen,
    // how fast a shape morphs between forms, and how fast a column gains or loses a shape
    smooth: { rank: 1.4, crowd: 1.4, motion: 1.6, fit: 1.2, form: 2.2, count: 1.6 }
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
    this.bodyScale = 0;   // apparent shoulder-width-equivalent in video px — normalizes the posture measurements
    this.m = { bodyPoints: 0, motion: 0, asym: 0, rigid: 0.5 };
    this.countTarget = 0; this.countPending = 0; this.pendingSince = 0;

    // Values actually drawn, each gliding toward its target: column position, color, how many shapes the column
    // holds, and the mix of the three forms (round / boxy / wedge).
    this.d = { rank: new Smooth(1), motion: new Smooth(0), count: new Smooth(1), wC: new Smooth(1), wS: new Smooth(0), wT: new Smooth(0) };
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

  // How many body points are tracked, and how much the body is moving overall (still vs. moving).
  let visible = 0, sum = 0;
  for (const name of KEYPOINT_NAMES) {
    if (P[name].presence <= 0.5) continue;
    visible++; sum += vNorm(P[name].vel);
  }
  m.bodyPoints = visible;
  // Movement only drives COLOR now. Low-passed: quick to notice motion, slow to let go, so color drifts rather than flickers.
  const motionNow = visible ? clamp01((sum / visible) / K.motionFullMean) : 0;
  m.motion = lerp(m.motion, motionNow, motionNow > m.motion ? K.motionAttack : K.motionRelease);

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
  const K = TUNE.kaleido, soft = K.formSoftness;
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
  const K = TUNE.kaleido, P = person.points;
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
  const K = TUNE.kaleido, P = person.points;
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

// A change in a column's shape count only takes effect once it has held for a moment, so a body point flickering at
// the edge of visibility doesn't make the column keep growing and shrinking. (The change itself then glides in.)
function commitCount(person, raw, now) {
  if (person.poseEvents < 5 || !person.countTarget) { // presence is still ramping up on a brand-new person; settle silently
    person.countTarget = person.countPending = raw;
    person.pendingSince = now;
    return;
  }
  if (raw !== person.countPending) {
    person.countPending = raw;
    person.pendingSince = now;
  } else if (raw !== person.countTarget && now - person.pendingSince >= TUNE.kaleido.countDebounceMs) {
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

/* --- the shape: ONE continuous line ---------------------------------------------------------------------------------
   Every shape is a single spiral: a line that starts on the outer edge and winds inward. The round, boxy and wedge
   forms are three versions of that same spiral with the same number of points, so any mix of the three is just
   another spiral — which is what lets a person's shapes morph smoothly between forms as their body shape changes,
   instead of one shape disappearing and another appearing. Forms live in a unit box (x, y from -0.5 to 0.5); the
   wedge's flat side is on the -x side, against the mirror line. */
const SP_N = 120, SP_TURNS = 2.1, SP_WOBBLE_ORDERS = [2, 3, 4, 5];
const SPIRAL = (function buildSpiral() {
  const TAU = Math.PI * 2;
  const phi = new Float32Array(SP_N), scale = new Float32Array(SP_N);
  for (let j = 0; j < SP_N; j++) { const t = j / (SP_N - 1); phi[j] = TAU * SP_TURNS * t; scale[j] = 1 - 0.93 * t; }

  // Distance from a form's center to its outline, in direction th.
  const roundR = () => 0.5;
  const boxyR = th => 0.5 / Math.pow(Math.pow(Math.abs(Math.cos(th)), 3.2) + Math.pow(Math.abs(Math.sin(th)), 3.2), 1 / 3.2);
  const tri = [[-0.5, -0.5], [0.5, 0], [-0.5, 0.5]], triC = [-1 / 6, 0];
  const cross = (px, py, qx, qy) => px * qy - py * qx;
  const rayTri = th => { // cast a ray from the triangle's centroid and find where it leaves the triangle
    const dx = Math.cos(th), dy = Math.sin(th);
    let best = Infinity;
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3], ex = b[0] - a[0], ey = b[1] - a[1];
      const den = cross(dx, dy, ex, ey);
      if (Math.abs(den) < 1e-9) continue;
      const t = cross(a[0] - triC[0], a[1] - triC[1], ex, ey) / den;
      const u = cross(a[0] - triC[0], a[1] - triC[1], dx, dy) / den;
      if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    return best;
  };
  // round off the triangle's corners by smoothing its radius around the full circle
  let table = Array.from({ length: 360 }, (_, i) => rayTri(TAU * i / 360));
  for (let pass = 0; pass < 8; pass++) table = table.map((v, i) => (table[(i + 359) % 360] + 2 * v + table[(i + 1) % 360]) / 4);
  const wedgeR = th => {
    const f = ((th % TAU) + TAU) % TAU / TAU * 360, i = Math.floor(f) % 360, k = f - Math.floor(f);
    return table[i] * (1 - k) + table[(i + 1) % 360] * k;
  };

  const forms = [{ c: [0, 0], r: roundR }, { c: [0, 0], r: boxyR }, { c: triC, r: wedgeR }]; // order: round, boxy, wedge
  const X = forms.map(() => new Float32Array(SP_N)), Y = forms.map(() => new Float32Array(SP_N));
  forms.forEach((f, k) => {
    for (let j = 0; j < SP_N; j++) {
      const r = f.r(phi[j]) * scale[j];
      X[k][j] = f.c[0] + r * Math.cos(phi[j]);
      Y[k][j] = f.c[1] + r * Math.sin(phi[j]);
    }
  });
  // for the wobble: cos/sin of each wobble order at every point along the spiral
  const hc = SP_WOBBLE_ORDERS.map(m => Float32Array.from(phi, p => Math.cos(m * p)));
  const hs = SP_WOBBLE_ORDERS.map(m => Float32Array.from(phi, p => Math.sin(m * p)));
  return { X, Y, hc, hs };
})();

// Each shape gets its own fixed personality from a seed — how much and how fast each wobble wanders, and a small
// lean and tilt — so neighbors in a column are all a little different.
const paramCache = new Map();
function shapeParams(seed) {
  let p = paramCache.get(seed);
  if (p) return p;
  const rnd = mulberry32(seed), TAU = Math.PI * 2;
  p = {
    amp: [1, 0.75, 0.5, 0.35].map(a => a * (0.6 + 0.4 * rnd())),
    ph: [0, 0, 0, 0].map(() => rnd() * TAU),
    om: [0, 0, 0, 0].map(() => (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd())),
    lean: (rnd() - 0.5) * 0.4,
    tilt: (rnd() - 0.5) * 0.32
  };
  p.cosT = Math.cos(p.tilt); p.sinT = Math.sin(p.tilt);
  if (paramCache.size > 3000) paramCache.clear();
  paramCache.set(seed, p);
  return p;
}

// Build one shape's spiral for this instant: blend the three forms by `w` = [round, boxy, wedge], let the outline
// wander by the slow drift at time `timeS`, lean/tilt it, then rescale to fill its cell exactly — however it
// wobbles or blends it can never poke outside its cell, which is what keeps the whole image inside the screen.
// Writes the normalized points (x, y pairs, each -0.5..0.5) into `out`.
function shapePoints(prm, w, timeS, out) {
  const K = TUNE.kaleido, S = SPIRAL, N = SP_N;
  const ca = [0, 0, 0, 0], sa = [0, 0, 0, 0];
  for (let m = 0; m < 4; m++) {
    const ang = prm.ph[m] + prm.om[m] * K.flux * timeS;
    ca[m] = Math.cos(ang) * prm.amp[m] * K.wobble;
    sa[m] = Math.sin(ang) * prm.amp[m] * K.wobble;
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < N; j++) {
    let x = w[0] * S.X[0][j] + w[1] * S.X[1][j] + w[2] * S.X[2][j];
    let y = w[0] * S.Y[0][j] + w[1] * S.Y[1][j] + w[2] * S.Y[2][j];
    let wob = 0; // sin(mφ + a) = sin(mφ)cos(a) + cos(mφ)sin(a)
    for (let m = 0; m < 4; m++) wob += S.hs[m][j] * ca[m] + S.hc[m][j] * sa[m];
    x *= 1 + wob; y *= 1 + wob;
    const rx = x * prm.cosT - y * prm.sinT + prm.lean * y, ry = x * prm.sinT + y * prm.cosT;
    out[2 * j] = rx; out[2 * j + 1] = ry;
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }
  const sx = 1 / (maxX - minX), sy = 1 / (maxY - minY);
  for (let j = 0; j < N; j++) { out[2 * j] = (out[2 * j] - minX) * sx - 0.5; out[2 * j + 1] = (out[2 * j + 1] - minY) * sy - 0.5; }
}
const SCRATCH = new Float32Array(SP_N * 2);

// Trace a shape AND its reflection as a single path. The reflection is the very same points mirrored across the
// vertical line at `axisX`. Doing both in one path (one fill, one stroke) means the two halves can never composite in a
// different order, so the image is an exact mirror even where translucent paint overlaps at the seam.
function tracePair(ctx, pts, axisX, off, cy, sw, sh) {
  for (const side of [1, -1]) {
    for (let i = 0; i < pts.length; i += 2) {
      const x = axisX + side * (off + pts[i] * sw), y = cy + pts[i + 1] * sh;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
}

function drawBlob(ctx, pts, axisX, off, cy, sw, sh, lineW, fillA, strokeA) {
  ctx.beginPath();
  tracePair(ctx, pts, axisX, off, cy, sw, sh);
  ctx.globalAlpha = fillA; ctx.fill();         // the open spiral fills as the whole form
  ctx.lineWidth = lineW;
  ctx.globalAlpha = strokeA; ctx.stroke();
}

const smooth01 = x => { x = clamp01(x); return x * x * (3 - 2 * x); };

// One person's column: a vertical stack of shapes, drawn on both sides of the mirror line. `bandPos` is how many
// columns out from the mirror line this one starts (0 = touching it); `bw` is the width of one column. The shape count
// is a smoothly gliding number: the shapes slide to their new spacing, and a shape that's being gained or lost grows
// from (or shrinks to) nothing instead of popping.
function drawColumn(ctx, person, bandPos, bw, alpha, css, timeS) {
  if (alpha <= 0.002) return;
  const K = TUNE.kaleido, d = person.d, W = width, H = height;
  const count = Math.max(1, d.count.v);
  const wsum = (d.wC.v + d.wS.v + d.wT.v) || 1;
  const w = [d.wC.v / wsum, d.wS.v / wsum, d.wT.v / wsum];
  const top = H * K.margin, bottom = H * (1 - K.margin);
  const step = (bottom - top) / (count - 1 + K.overlap); // the stack fills the screen height exactly, for any count
  const sh = step * K.overlap, sw = bw * K.overlap, inner = bandPos * bw;
  const lineW = constrain(sh * 0.085, 2, 11);
  ctx.fillStyle = css;
  ctx.strokeStyle = css;
  for (let i = 0, n = Math.ceil(count - 0.001); i < n; i++) {
    const g = smooth01(count - i);       // 1 for a full shape, <1 while it's being gained or lost
    if (g < 0.02) continue;
    const seed = person.id * 1009 + i * 31;
    const jr = mulberry32(seed ^ 0x9e3779b9); // every shape is a little different in size
    const jw = 0.82 + 0.18 * jr(), jh = 0.86 + 0.14 * jr();
    shapePoints(shapeParams(seed), w, timeS, SCRATCH);
    const shw = sw * jw * g, shh = sh * jh * g;
    const cy = Math.min(top + sh / 2 + i * step, bottom - shh / 2);
    drawBlob(ctx, SCRATCH, W / 2, inner + shw / 2, cy, shw, shh, lineW * (0.4 + 0.6 * g), alpha * 0.75 * g, Math.min(1, alpha * 1.7) * g);
  }
}

function drawCrowdMirror(now) {
  const K = TUNE.kaleido, T = K.smooth;
  // First person = the column against the mirror line. A new person only gets a column once their tracking has
  // settled (a few pose events) — before that their measurements are just placeholders.
  const list = Array.from(people.values()).filter(p => p.poseEvents >= 5).sort((a, b) => a.id - b.id);
  if (!list.length) return;
  const dt = Math.min(0.1, (typeof deltaTime === 'number' ? deltaTime : 16.7) / 1000); // seconds; capped so a stalled tab doesn't leap

  if (crowdInit) crowdS.update(list.length, T.crowd, dt); else { crowdS.snap(list.length); crowdInit = true; }
  const N = Math.max(1, crowdS.v);

  list.forEach((p, i) => {
    const fw = formWeights(p.m), d = p.d;
    if (!p.dInit) {
      d.rank.snap(i + 1); d.motion.snap(p.m.motion); d.count.snap(p.countTarget);
      d.wC.snap(fw[0]); d.wS.snap(fw[1]); d.wT.snap(fw[2]);
      p.dInit = true;
      return;
    }
    d.rank.update(i + 1, T.rank, dt);
    d.motion.update(p.m.motion, T.motion, dt);
    d.count.update(p.countTarget, T.count, dt);
    d.wC.update(fw[0], T.form, dt); d.wS.update(fw[1], T.form, dt); d.wT.update(fw[2], T.form, dt);
  });

  // Column width: as wide as will let every column fit in half the screen, but never so wide that the shapes
  // stretch into flat ovals. (The outer edge of the last column lands exactly on the margin.)
  const usableHalf = width / 2 - width * K.margin;
  const target = Math.min(usableHalf / (N - 1 + K.overlap), height * K.maxBandFrac / K.overlap);
  if (fitInit) fitS.update(target, T.fit, dt); else { fitS.snap(target); fitInit = true; }
  const bw = fitS.v;

  const ctx = drawingContext, timeS = now / 1000;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = list.length - 1; i >= 0; i--) { // outermost first, so inner columns sit on top
    const p = list[i];
    const css = hsbToCss(lerp(K.hueStill, K.hueMoving, p.d.motion.v), K.saturation, K.brightness);
    drawColumn(ctx, p, p.d.rank.v - 1, bw, K.opacity * lifeAlpha(p, now), css, timeS);
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
  paramCache.clear();
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
