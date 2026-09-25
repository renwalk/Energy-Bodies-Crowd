/* ============================================================================
   ENERGY BODIES — CROWD EDITION — DISPLAY SKETCH (v4: kaleidoscope orbs)
   No emotion mapping, and the visual doesn't represent a human body:
     - PoseNet runs in 'multiple' detection mode (one skeleton per person)
     - A lightweight nearest-neighbor tracker assigns each skeleton a stable
       Person id across frames (PoseNet itself gives no identity)
     - Each person's base form is an abstract wireframe point-cloud orb. The 17
       keypoints are mapped onto 17 fixed points around the sphere (arbitrary,
       not anatomical); each keypoint's velocity bulges the surface locally.
     - Around that base orb, each person gets a kaleidoscope, ported from the
       moonflower sketch (rings of mirrored copies of the motif). Its
       parameters are driven by that person's body:
         x, y         torso-weighted body center on screen
         z (size)     apparent body size — closer to the camera = bigger orb
         reflections  visible body regions (head, neck, arms/hands, chest,
                      abdomen, legs/feet) × 2, mirrored left/right
         angle        left/right asymmetry of the pose (0 = symmetric)
         rings        total movement energy (sum of every keypoint's activation)
         opacity      stillness (faint) vs. motion (solid)
         speed        velocity of the moving keypoints → rotation rate
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
    maxPeople: 12,          // PoseNet maxPoseDetections — tune down on slower hardware
    scoreThreshold: 0.4,
    matchRadiusFrac: 0.3,   // fraction of video diagonal — how far a skeleton can drift frame-to-frame and still count as the same person before falling back to nearest-available matching (see matchPeopleToPoses)
    personTimeoutMs: 1000   // how long a person can go undetected before their orb is dropped
  },
  point: {
    kpMinScore: 0.4,      // ignore keypoints PoseNet isn't confident about
    posSmoothing: 0.22,   // how quickly a point's tracked position catches up to the raw detection (lower = smoother, more lag)
    velEMA: 0.18,          // smoothing on each point's own velocity reading (lower = smoother, more lag)
    velDeadzone: 0.0025,  // raw per-frame velocity below this is treated as 0 — absorbs PoseNet's baseline detection jitter on a still body
    velNormMin: 0.0,      // velocity (normalized by video diagonal per frame) that reads as "still"
    velNormMax: 0.05,     // velocity that reads as "fully activated"
    presenceInRate: 0.3,  // how fast a keypoint fades IN once PoseNet is confident about it again
    presenceOutRate: 0.12 // how fast a keypoint fades OUT when lost — slow, so a borderline/flickering detection doesn't pop the bump on and off
  },
  orb: {
    rings: 12,             // latitude rings in the sphere grid (the motif is small now, so a lighter mesh than before)
    segments: 20,          // longitude segments in the sphere grid
    bumpScale: 1.1,        // how far a fully-activated keypoint bulges the surface, relative to the base radius
    bumpSigma: 0.6,        // angular falloff width (radians) of each keypoint's influence on the surface
    bumpSmoothing: 0.12,   // per-vertex radius smoothing rate (lower = smoother morph, more lag)
    minRadiusMult: 0.55, maxRadiusMult: 1.9,
    dotAlphaBase: 0.30, dotAlphaBoost: 0.7,
    lineAlphaBase: 0.03, lineAlphaBoost: 0.22
  },
  kaleido: {
    // --- geometry ---
    baseRadiusFrac: 0.035,  // resting radius of the base orb at baseline distance, as a fraction of canvas height
    ringSpacing: 1.8,       // distance between rings, in multiples of the base orb radius
    maxRings: 5,            // cap on the flower's size — a near person at full energy still has to share the screen
    // --- rings ← total movement energy ---
    energyToRings: 1.0,     // rings per 1.0 of energy (energy = sum of every keypoint's 0..1 activation; 17 keypoints max)
    // --- opacity ← stillness vs motion ---
    motionFullMean: 0.3,    // mean keypoint activation that reads as "fully in motion"
    opacityStill: 0.45,     // opacity of a motionless body (kept above 0 so people never disappear)
    opacityMoving: 1.0,
    invertOpacity: false,   // true = solid when still, translucent when moving
    // --- angle ← left/right asymmetry ---
    angleMax: Math.PI,      // a fully asymmetric pose rotates each copy in place by this much (radians)
    symDeadzone: 0.12,      // mirror error (in shoulder-widths) treated as symmetric — natural posture isn't perfect
    symFull: 0.9,           // mirror error that reads as "fully asymmetric"
    // --- speed ← velocity of the moving keypoints ---
    idleSpin: 0.0025,       // orb's own 3D spin when still (rad/frame) — keeps the sphere reading as a volume
    spinGain: 0.04,         // extra orb spin at full speed
    idleRingSpin: 0.0012,   // kaleidoscope rotation when still (rad/frame)
    ringSpinGain: 0.018,    // extra kaleidoscope rotation at full speed
    // --- reflections ← visible body regions ---
    regionOn: 0.65,         // a region counts as present once its keypoints' presence passes this...
    regionOff: 0.35,        // ...and stays present until it drops below this (hysteresis)
    reflDebounceMs: 600,    // a new reflection count must hold this long before it's applied
    reflFadeFrames: 20,     // cross-fade between the old and new reflection layouts
    // --- z (distance) → size ---
    baselineShoulderFrac: 0.09, // shoulder width (fraction of video width) that reads as baseline distance
    sizeMin: 0.45, sizeMax: 2.4,
    zSmoothing: 0.15,       // smoothing on the apparent-body-size estimate
    // --- per-frame easing toward the pose-derived targets (higher = snappier) ---
    ease: { pos: 0.15, size: 0.06, rings: 0.05, opacity: 0.08, speed: 0.06, angle: 0.08 }
  }
};

// The 17 keypoints PoseNet detects.
const KEYPOINT_NAMES = [
  'nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar',
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'
];

// The six body regions from the original Energy Bodies. PoseNet has no neck/chest/abdomen
// keypoints, so a region counts as "present" when the keypoints that define it are visible.
const REGION_NAMES = ['head', 'neck', 'armsHands', 'chest', 'abdomen', 'legsFeet'];
const FACE_POINTS = ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar'];
const TORSO_POINTS = ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'];

// Left/right pairs compared (mirrored across the body's own axis) to measure symmetry.
const SYMMETRY_PAIRS = [
  ['leftEye', 'rightEye'], ['leftEar', 'rightEar'],
  ['leftShoulder', 'rightShoulder'], ['leftElbow', 'rightElbow'], ['leftWrist', 'rightWrist'],
  ['leftHip', 'rightHip'], ['leftKnee', 'rightKnee'], ['leftAnkle', 'rightAnkle']
];

/* =============================
   0b) SHARED SPHERE MESH + KEYPOINT→SPHERE MAPPING (built once)
   ============================= */

// 17 points spread evenly around a unit sphere (Fibonacci lattice) — an
// arbitrary, non-anatomical assignment of keypoint → "pole" on the orb.
function fibonacciSphere(n) {
  const pts = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = n > 1 ? 1 - (i / (n - 1)) * 2 : 0;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;
    pts.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return pts;
}

const KEYPOINT_POLE_DIR = {};
(function assignPoles() {
  const poles = fibonacciSphere(KEYPOINT_NAMES.length);
  KEYPOINT_NAMES.forEach((name, i) => { KEYPOINT_POLE_DIR[name] = poles[i]; });
})();

// A UV-sphere grid: (rings+1) latitude rows × segments longitude columns.
// This is what gives the visual its literal "grid mesh" look.
let SPHERE_VERTS = [];   // [{x,y,z}] unit-sphere directions
let SPHERE_EDGES = [];   // [[i,j], ...] indices into SPHERE_VERTS

function buildSphereMesh(rings, segments) {
  const verts = [];
  const idx = (ring, seg) => ring * segments + (((seg % segments) + segments) % segments);

  for (let ring = 0; ring <= rings; ring++) {
    const theta = Math.PI * ring / rings; // 0 (top pole) .. PI (bottom pole)
    const y = Math.cos(theta);
    const ringR = Math.sin(theta);
    for (let seg = 0; seg < segments; seg++) {
      const phi = TWO_PI * seg / segments;
      verts.push({ x: ringR * Math.cos(phi), y, z: ringR * Math.sin(phi) });
    }
  }

  const edges = [];
  for (let ring = 0; ring <= rings; ring++) {
    for (let seg = 0; seg < segments; seg++) {
      const i = idx(ring, seg);
      if (ring > 0 && ring < rings) edges.push([i, idx(ring, seg + 1)]); // latitude line
      if (ring < rings) edges.push([i, idx(ring + 1, seg)]);            // longitude line
    }
  }
  return { verts, edges };
}

/* =============================
   1) RUNTIME STATE
   ============================= */
console.log('✅ sketch.js (crowd edition — keypoint blobs) loading...');

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
   3) PERSON — one tracked body in the crowd
   ============================= */
class Person {
  constructor(id, cx, cy) {
    this.id = id;
    this.hue = (id * 63) % 360; // used by the Control dashboard's crowd map only — the orb itself has no color
    this.tx = cx; this.ty = cy; // torso-weighted body center in video pixels (also used for frame-to-frame matching)
    this.born = millis();
    this.lastSeen = 0;
    this.poseEvents = 0;
    this.avgVel = 0;

    this.points = {};
    for (const name of KEYPOINT_NAMES) {
      // presence fades smoothly in/out instead of snapping with the raw PoseNet score,
      // so a keypoint flickering near the confidence threshold doesn't pop the orb's bump on/off.
      this.points[name] = { x: cx, y: cy, vel: 0, score: 0, presence: 0 };
    }

    // Smoothed per-vertex radius multiplier for this person's orb (1 = resting sphere).
    this.orbRadii = new Float32Array(SPHERE_VERTS.length).fill(1);

    // Kaleidoscope targets, recomputed on every pose event (see updatePersonMetrics).
    this.bodyScale = 0;            // apparent shoulder-width-equivalent in video px — the z-distance cue
    this.m = { sizeScale: 1, z: 1, energy: 0, rings: 0, motion: 0, speed: 0, asym: 0 };
    this.regionOn = {};
    for (const r of REGION_NAMES) this.regionOn[r] = false;
    this.reflCurrent = 2; this.reflPrev = 2; this.reflTarget = 2; this.reflSince = 0; this.reflFade = 1;

    // Values actually drawn — eased toward the targets every frame so nothing jumps at pose-event rate.
    this.d = { x: cx, y: cy, size: 1, rings: 0, opacity: TUNE.kaleido.opacityStill, speed: 0, angle: 0 };
    this.dInit = false;
    this.spin = 0;                 // integrated orb spin (rad) — integrating means a speed change never causes a jump
    this.ringPhase = 0;            // integrated kaleidoscope rotation (rad)

    // Offscreen buffer holding this person's orb, rendered once per frame and stamped for every reflection.
    this.gfx = null;
    this.bufPx = 0;
  }

  destroy() {
    if (this.gfx) { this.gfx.remove(); this.gfx = null; }
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
      person.destroy();
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
   5b) BODY → KALEIDOSCOPE TARGETS (per pose event)
   ============================= */
const vNorm = v => clamp01(map(v, TUNE.point.velNormMin, TUNE.point.velNormMax, 0, 1));

function updatePersonMetrics(person, now) {
  const K = TUNE.kaleido, P = person.points, m = person.m;
  const vis = n => P[n].presence > 0.5;

  // x, y — weighted by presence so a hip or shoulder fading in/out glides the center instead of jumping it,
  // and anchored on the torso so raising an arm doesn't drag the whole kaleidoscope sideways.
  let wx = 0, wy = 0, ws = 0;
  for (const n of TORSO_POINTS) { wx += P[n].x * P[n].presence; wy += P[n].y * P[n].presence; ws += P[n].presence; }
  if (ws < 0.5) {
    wx = wy = ws = 0;
    for (const n of KEYPOINT_NAMES) { wx += P[n].x * P[n].presence; wy += P[n].y * P[n].presence; ws += P[n].presence; }
  }
  if (ws > 0.01) { person.tx = wx / ws; person.ty = wy / ws; }

  // z — PoseNet has no depth, so use apparent body size: shoulder width, or torso length when hips are
  // visible too (torso is less affected by the person turning sideways). Bigger in frame = closer.
  let est = 0;
  const shouldersVis = vis('leftShoulder') && vis('rightShoulder');
  const torsoVis = shouldersVis && vis('leftHip') && vis('rightHip');
  if (shouldersVis) est = Math.hypot(P.leftShoulder.x - P.rightShoulder.x, P.leftShoulder.y - P.rightShoulder.y);
  if (torsoVis) {
    const sx = (P.leftShoulder.x + P.rightShoulder.x) / 2, sy = (P.leftShoulder.y + P.rightShoulder.y) / 2;
    const hx = (P.leftHip.x + P.rightHip.x) / 2, hy = (P.leftHip.y + P.rightHip.y) / 2;
    est = Math.max(est, Math.hypot(hx - sx, hy - sy) / 1.25); // torso ≈ 1.25 shoulder-widths
  }
  if (est > 1) person.bodyScale = person.bodyScale ? lerp(person.bodyScale, est, K.zSmoothing) : est;
  if (person.bodyScale) {
    const baseline = (video?.width || 960) * K.baselineShoulderFrac;
    m.sizeScale = constrain(person.bodyScale / baseline, K.sizeMin, K.sizeMax);
    m.z = baseline / person.bodyScale; // relative distance from the screen: 1 = baseline, >1 = farther
  }

  // Movement: energy is the TOTAL across the body (more parts moving = more), motion is the body-wide
  // average (still vs. moving, independent of how many keypoints are visible), and speed is how fast the
  // parts that ARE moving are going (so one fast-waving hand still reads as fast).
  let energy = 0, sum = 0, n = 0, movingSum = 0, movingN = 0;
  for (const name of KEYPOINT_NAMES) {
    if (!vis(name)) continue;
    const v = vNorm(P[name].vel);
    energy += v; sum += v; n++;
    if (v > 0.03) { movingSum += v; movingN++; }
  }
  m.energy = energy;
  m.rings = constrain(energy * K.energyToRings, 0, K.maxRings);
  m.motion = n ? clamp01((sum / n) / K.motionFullMean) : 0;
  m.speed = movingN ? movingSum / movingN : 0;

  // Symmetry → angle. If the body can't be measured this frame, relax slowly toward "symmetric".
  const asym = computeAsymmetry(person);
  m.asym = asym === null ? lerp(m.asym, 0, 0.03) : lerp(m.asym, asym, 0.1);

  // Reflections ← body regions present, mirrored left/right (so always even = true mirror symmetry).
  const pr = n => P[n].presence;
  const head = Math.max(...FACE_POINTS.map(pr));
  const shoulders = (pr('leftShoulder') + pr('rightShoulder')) / 2;
  const hips = (pr('leftHip') + pr('rightHip')) / 2;
  const scores = {
    head,
    neck: Math.min(head, shoulders),
    chest: shoulders,
    armsHands: Math.max(pr('leftElbow'), pr('rightElbow'), pr('leftWrist'), pr('rightWrist')),
    abdomen: hips,
    legsFeet: Math.max(pr('leftKnee'), pr('rightKnee'), pr('leftAnkle'), pr('rightAnkle'))
  };
  let count = 0;
  for (const r of REGION_NAMES) {
    if (person.regionOn[r] ? scores[r] < K.regionOff : scores[r] > K.regionOn) person.regionOn[r] = !person.regionOn[r];
    if (person.regionOn[r]) count++;
  }
  commitReflections(person, Math.max(2, count * 2), now);
}

// A change in region count only takes effect once it has held for reflDebounceMs, then cross-fades in —
// a keypoint flickering at the edge of visibility must not make the whole layout jump around.
function commitReflections(person, target, now) {
  if (person.poseEvents < 5) { // presence is still ramping up on a brand-new person; settle silently
    person.reflCurrent = person.reflPrev = person.reflTarget = target;
    return;
  }
  if (target !== person.reflTarget) {
    person.reflTarget = target;
    person.reflSince = now;
  } else if (target !== person.reflCurrent && now - person.reflSince >= TUNE.kaleido.reflDebounceMs) {
    person.reflPrev = person.reflCurrent;
    person.reflCurrent = target;
    person.reflFade = 0;
  }
}

// 0 = the left and right sides mirror each other perfectly; 1 = strongly asymmetric. Each left joint is
// reflected across the body's own axis (through the shoulders, along the spine when the hips are visible)
// and compared to its right counterpart, so leaning or turning alone doesn't count as asymmetry but
// one arm raised, or one shoulder dropped, does. Returns null if too little of the body is visible.
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
    const s = mid('leftShoulder', 'rightShoulder'), h = mid('leftHip', 'rightHip');
    const len = Math.hypot(h.x - s.x, h.y - s.y);
    if (len > 1e-3) { ax = (h.x - s.x) / len; ay = (h.y - s.y) / len; }
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

/* =============================
   6) P5 SETUP / DRAW
   ============================= */
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  angleMode(RADIANS);

  const built = buildSphereMesh(TUNE.orb.rings, TUNE.orb.segments);
  SPHERE_VERTS = built.verts;
  SPHERE_EDGES = built.edges;

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

  const vw = video?.width || 960, vh = video?.height || 540;
  let s, ox, oy;
  push();
  if (displayOrientation === 'portrait') {
    translate(0, height);
    rotate(-HALF_PI);
    s = Math.min(height / vw, width / vh);
    ox = (height - vw * s) / 2;
    oy = (width - vh * s) / 2;
  } else {
    s = Math.min(width / vw, height / vh);
    ox = (width - vw * s) / 2;
    oy = (height - vh * s) / 2;
  }

  const now = millis();
  for (const person of people.values()) {
    easeDisplayState(person);
    drawPersonKaleidoscope(person, ox + person.d.x * s, oy + person.d.y * s, now);
  }
  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

/* =============================
   7) DRAWING — a kaleidoscope of orbs, per person
   ============================= */

// Pose events arrive at PoseNet's (variable) frame rate; ease the drawn values toward the targets every
// render frame so the kaleidoscope glides instead of stepping.
function easeDisplayState(person) {
  const K = TUNE.kaleido, E = K.ease, d = person.d, m = person.m;
  const motion = K.invertOpacity ? 1 - m.motion : m.motion;
  const targets = {
    x: person.tx, y: person.ty,
    size: m.sizeScale,
    rings: m.rings,
    opacity: lerp(K.opacityStill, K.opacityMoving, motion),
    speed: m.speed,
    angle: m.asym * K.angleMax
  };
  if (!person.dInit) { Object.assign(d, targets); person.dInit = true; return; }
  d.x = lerp(d.x, targets.x, E.pos);
  d.y = lerp(d.y, targets.y, E.pos);
  d.size = lerp(d.size, targets.size, E.size);
  d.rings = lerp(d.rings, targets.rings, E.rings);
  d.opacity = lerp(d.opacity, targets.opacity, E.opacity);
  d.speed = lerp(d.speed, targets.speed, E.speed);
  d.angle = lerp(d.angle, targets.angle, E.angle);
}

// Fade a person in when first detected and out as they go missing, rather than popping.
function lifeAlpha(person, now) {
  const fadeIn = clamp01((now - person.born) / 300);
  const missing = now - person.lastSeen;
  const fadeStart = 250;
  const fadeOut = missing > fadeStart ? clamp01(1 - (missing - fadeStart) / (TUNE.tracking.personTimeoutMs - fadeStart)) : 1;
  return fadeIn * fadeOut;
}

// How much this person's tracked keypoints currently bulge the sphere at unit direction `dir`.
function orbBumpAt(person, dir) {
  const O = TUNE.orb;
  let bump = 0;
  for (const name of KEYPOINT_NAMES) {
    const p = person.points[name];
    if (p.presence <= 0.01) continue;
    const v = vNorm(p.vel);
    if (v <= 0) continue;
    const pole = KEYPOINT_POLE_DIR[name];
    const cosAngle = constrain(dir.x * pole.x + dir.y * pole.y + dir.z * pole.z, -1, 1);
    const angle = Math.acos(cosAngle);
    bump += v * p.presence * Math.exp(-(angle * angle) / (2 * O.bumpSigma * O.bumpSigma));
  }
  return bump;
}

// The orb is drawn once per frame into a per-person offscreen buffer, then stamped for the base form and
// every reflection. Drawing hundreds of vertices once and blitting the result N times is what keeps a
// kaleidoscope of dozens of copies per person affordable.
function ensureBuffer(person, needPx) {
  if (person.gfx && needPx <= person.bufPx && needPx >= person.bufPx * 0.6) return;
  if (person.gfx) person.gfx.remove();
  person.bufPx = Math.ceil((needPx * 1.15) / 32) * 32;
  person.gfx = createGraphics(person.bufPx, person.bufPx);
}

function renderOrbToBuffer(person, R, spin) {
  const O = TUNE.orb;
  ensureBuffer(person, 2 * R * O.maxRadiusMult + 8);
  const g = person.gfx, c = person.bufPx / 2;
  g.clear();

  const cosA = Math.cos(spin), sinA = Math.sin(spin);
  const tilt = -0.32;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);

  const projected = new Array(SPHERE_VERTS.length);
  for (let i = 0; i < SPHERE_VERTS.length; i++) {
    const dir = SPHERE_VERTS[i];
    const target = 1 + O.bumpScale * orbBumpAt(person, dir);
    person.orbRadii[i] = lerp(person.orbRadii[i], constrain(target, O.minRadiusMult, O.maxRadiusMult), O.bumpSmoothing);
    const r = person.orbRadii[i];

    // Rotate around Y, then tilt around X.
    const x = dir.x * r, y0 = dir.y * r, z0 = dir.z * r;
    const rx = x * cosA + z0 * sinA;
    const rz1 = -x * sinA + z0 * cosA;
    const ry = y0 * cosT - rz1 * sinT;
    const rz = y0 * sinT + rz1 * cosT;

    projected[i] = {
      x: c + rx * R,
      y: c + ry * R,
      depth: (rz + O.maxRadiusMult) / (2 * O.maxRadiusMult) // roughly 0 (back) .. 1 (front)
    };
  }

  // Line/dot weights scale with the orb so it reads the same tiny (far away) or huge (up close).
  g.strokeWeight(constrain(R * 0.014, 0.8, 1.8));
  for (const [a, b] of SPHERE_EDGES) {
    const pa = projected[a], pb = projected[b];
    g.stroke(255, 255 * lerp(O.lineAlphaBase, O.lineAlphaBoost, (pa.depth + pb.depth) / 2));
    g.line(pa.x, pa.y, pb.x, pb.y);
  }

  g.noStroke();
  for (const p of projected) {
    g.fill(255, 255 * lerp(O.dotAlphaBase, O.dotAlphaBoost, p.depth));
    g.circle(p.x, p.y, constrain(R * 0.035 + p.depth * R * 0.03, 1.2, 5));
  }
}

// One kaleidoscope layout — a direct port of the moonflower draw loop: rings of `reflections` copies, every
// other ring offset half a segment (the "woven" look), every other copy mirrored, each then rotated in
// place by `angle`. A fractional ring count fades the outermost ring in instead of popping it.
function drawRingLayout(person, reflections, spacing, ringsFloat, angle, alpha) {
  if (alpha <= 0.002 || reflections < 2) return;
  const half = person.bufPx / 2;
  const seg = TWO_PI / reflections;
  const full = Math.floor(ringsFloat), frac = ringsFloat - full;
  const count = frac > 0.01 ? full + 1 : full;

  for (let r = 0; r < count; r++) {
    const ringAlpha = r < full ? 1 : frac;
    const weave = r % 2 === 1 ? seg / 2 : 0;
    for (let i = 0; i < reflections; i++) {
      push();
      rotate(i * seg + weave + person.ringPhase);
      translate(spacing * (r + 1), 0);
      if (i % 2 === 1) scale(-1, 1);
      rotate(angle);
      drawingContext.globalAlpha = alpha * ringAlpha;
      image(person.gfx, -half, -half);
      pop();
    }
  }
}

function drawPersonKaleidoscope(person, cx, cy, now) {
  const K = TUNE.kaleido, d = person.d;

  // Speed drives the rotation *rate*; integrating it (rather than multiplying by frameCount) means the
  // rate can change smoothly without the pattern ever jumping.
  person.spin += K.idleSpin + d.speed * K.spinGain;
  person.ringPhase += K.idleRingSpin + d.speed * K.ringSpinGain;

  const R = height * K.baseRadiusFrac * d.size;
  renderOrbToBuffer(person, R, person.spin + person.id * 0.7);

  const alpha = d.opacity * lifeAlpha(person, now);
  const half = person.bufPx / 2;
  const spacing = R * K.ringSpacing;
  const rings = constrain(d.rings, 0, K.maxRings);

  push();
  translate(cx, cy);

  // The base form: the person's own orb, at their position, sized by their distance.
  push();
  rotate(d.angle);
  drawingContext.globalAlpha = alpha;
  image(person.gfx, -half, -half);
  pop();

  // Reflections. When the region count changes, cross-fade from the old layout to the new one.
  if (person.reflFade < 1) person.reflFade = Math.min(1, person.reflFade + 1 / K.reflFadeFrames);
  if (person.reflFade < 1) drawRingLayout(person, person.reflPrev, spacing, rings, d.angle, alpha * (1 - person.reflFade));
  drawRingLayout(person, person.reflCurrent, spacing, rings, d.angle, alpha * person.reflFade);
  pop();
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
  for (const person of people.values()) person.destroy();
  people.clear();
  nextPersonId = 1;
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
