/* ============================================================================
   ENERGY BODIES — CROWD EDITION — DISPLAY SKETCH
   Same ml5 PoseNet + pose→emotion math as the single-person project, but:
     - PoseNet runs in 'multiple' detection mode (one skeleton per person)
     - A lightweight nearest-neighbor tracker assigns each skeleton a stable
       Person id across frames (PoseNet itself gives no identity)
     - Each tracked Person gets its OWN Energy Body — its own smoothed
       emotion/region values and its own pair of offscreen buffers — drawn
       at that person's real position/scale in the frame
     - There are no manual sliders: every value here comes straight from
       that person's live pose. The Control dashboard is read-only.
   IMPORTANT: Load eb-init.js BEFORE this file!
   ============================================================================ */

if (typeof window.beginSession !== 'function') {
  console.error('[SKETCH] ERROR: eb-init.js must be loaded first!');
}

/* =============================
   0) MASTER TUNING CONSTANTS
   ============================= */
const TUNE = {
  velocity: {
    kpMinScore: 0.5,
    vNormInMin: 0.015,
    vNormInMax: 0.2,
    vBlend: 0.125,
    fastEMA: 0.8,
    slowEMA: 0.01,
    angerBurstMin: 0.02,
    angerBurstMax: 1
  },
  emotions: {
    // Smoothing rate toward the live pose-derived value each frame
    // (there's no slider to blend against anymore, just an EMA).
    smoothing: 0.30,
    anxietyFromVel: { inMin: 0.3, inMax: 1.5, outMin: 0, outMax: 5 },
    calmFromBalance: { inMin: 0.2, inMax: 50, outMin: 5, outMax: 0 },
    sadnessFromAvgY: { inMin: 0, inMax: null, outMin: 0, outMax: 5 },
    fearFromLean: { inMin: 0, inMax: 100, outMin: 0, outMax: 5 },
    joyFromStructure: { inMin: 0.25, inMax: 1.0, outMin: 0, outMax: 5 }
  },
  coupling: {
    armsHands: { wristSpreadMin: 2, wristSpreadMax: 5.0, lerp: 0.12 },
    spine: { swayRange: 1.0, lerp: 0.20 },
    head: { velMin: 0.035, velMax: 0.05, lerp: 0.10 },
    neck: { velMin: 0.0005, velMax: 0.015, lerp: 0.18 },
    chest: { velMin: 0.00005, velMax: 0.010, reachMin: 0.7, reachMax: 2.0, lerp: 0.20 },
    abdomen: { velMin: 0.025, velMax: 0.0325, torsoMin: 1.20, torsoMax: 1.40, lerp: 0.10 },
    legsFeet: { velMin: 0.0001, velMax: 0.012, ankleSpreadMin: 0.9, ankleSpreadMax: 3.0, lerp: 0.20 }
  },
  visuals: {
    fear: { baseScaleFrom: 1.15, baseScaleTo: 0.75, freqFrom: 0.1, freqTo: 5.0, pulseAmp: 0.04 },
    anxiety: {
      spacingChaotic: { from: 40, to: 8 },
      spacingCalm: { from: 50, to: 20 },
      lineLenChaotic: { from: 4, to: 12 },
      lineLenCalm: { from: 20, to: 100 },
      jitterMax: 25,
      irregularityMax: 0.4,
      angleScaleChaotic: 0.02,
      angleScaleCalm: 0.005,
      curlMax: 80,
      alphaMin: 20, alphaMax: 255,
      minSpacingPx: 12,
      maxStrokes: 1200 // per person, per frame — lower than the single-body version since this runs once per tracked person
    },
    marbles: { gridSpacing: 16, alphaPerUnit: 70 }
  },
  // How each person's Energy Body is drawn (local buffer space, independent of window size)
  body: {
    bufW: 480,
    bufH: 900,
    widthScale: 1.0,   // multiplies the raw region-width constants below
    heightScale: 2.3,  // multiplies the raw region-height constants below (bodies read as tall, not squat)
    baseHeightFrac: 0.34, // a depthScale===1 person's body height, as a fraction of canvas height
    domeOffset: 60,
    legTaper: 60,
    crotchPull: 300
  },
  tracking: {
    maxPeople: 12,          // PoseNet maxPoseDetections — tune down on slower hardware
    scoreThreshold: 0.4,
    matchRadiusFrac: 0.22,  // fraction of video diagonal — how far a skeleton can drift frame-to-frame and still count as the same person
    personTimeoutMs: 1000,  // how long a person can go undetected before their Energy Body is dropped
    baselineShoulderFrac: 220 / 640 // shoulder width (as a fraction of video width) that maps to depthScale === 1
  }
};

/* =============================
   1) RUNTIME STATE
   ============================= */
console.log('✅ sketch.js (crowd edition) loading...');

let displayOrientation = 'landscape';
let video, poseNet, latestPoses = [];
let trackingStarted = false;

const regionNames = ['head', 'neck', 'armsHands', 'chest', 'abdomen', 'legsFeet'];
const emotionNames = ['anxiety', 'sadness', 'joy', 'anger', 'fear', 'calm'];

const regionKeypoints = {
  head: ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar'],
  neck: ['leftShoulder', 'rightShoulder'],
  chest: ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist'],
  armsHands: ['leftWrist', 'rightWrist', 'leftElbow', 'rightElbow'],
  abdomen: ['leftHip', 'rightHip'],
  legsFeet: ['leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle']
};

// Raw region constants (K=1). widthScale/heightScale in TUNE.body stretch these.
const REGION_MAX_WIDTHS = { head: 60, neck: 20, chest: 50, armsHands: 150, abdomen: 80, legsFeet: 100, spine: 100 };
const REGION_BASE_HEIGHTS = { head: 30, neck: 20, armsHands: 60, chest: 15, abdomen: 20, legsFeet: 110 }; // armsHands/legsFeet already include their extra taper offsets from the original design

let people = new Map(); // id -> Person
let nextPersonId = 1;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

/* =============================
   2) AVERAGING CLASSES (crowd-level session stats)
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
    this.structure = new OnlineMean();
    this.balance = new OnlineMean();
    this.posture = new OnlineMean();
    this.emotions = {};
    for (const n of emotionNames) this.emotions[n] = new OnlineMean();
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
    this.structure.add(sample.structure ?? 0);
    this.balance.add(sample.balance ?? 0);
    this.posture.add(sample.posture ?? 0);
    if (sample.emotions) {
      for (const k of emotionNames) this.emotions[k].add(sample.emotions[k] ?? 0);
    }
    this.samples++;
  }

  end() {
    const out = {
      durationMs: performance.now() - this.startTs,
      samples: this.samples,
      peakHeadcount: this.peakHeadcount,
      avgHeadcount: this.headcount.mean,
      velocity: this.velocity.mean,
      structure: this.structure.mean,
      balance: this.balance.mean,
      posture: this.posture.mean,
      emotions: {}
    };
    for (const k of emotionNames) out.emotions[k] = this.emotions[k].mean;
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
    this.hue = (id * 47) % 360; // reserved for future per-person color variation; unused by default palette

    this.tx = cx; this.ty = cy;
    this.rot = 0;
    this.depthScale = 1;
    this.lastSeen = 0;

    this.prevKeypoints = null;
    this.prevByPart = new Map();

    this.movementVelocity = 0;
    this.fastVel = 0;
    this.slowVel = 0;
    this.structure = 0;
    this.balance = 0;
    this.postureLean = 0;
    this.avgY = 0;

    this.emotion = {};
    for (const n of emotionNames) this.emotion[n] = 0;

    this.region = {};
    for (const n of regionNames) this.region[n] = 0;
    this.region.spine = 0;

    const B = TUNE.body;
    this.mask = createGraphics(B.bufW, B.bufH);
    this.emoG = createGraphics(B.bufW, B.bufH);
    this.patG = createGraphics(B.bufW, B.bufH);
    [this.mask, this.emoG, this.patG].forEach(g => {
      g.colorMode(RGB);
      g.noFill();
      g.stroke(255);
      g.strokeWeight(2);
    });
  }

  destroy() {
    this.mask?.remove();
    this.emoG?.remove();
    this.patG?.remove();
  }
}

function personCenter(pose) {
  const get = part => {
    const k = pose.keypoints.find(p => p.part === part && p.score > TUNE.velocity.kpMinScore);
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
  const vw = video?.width || 640, vh = video?.height || 480;
  const matchRadius = Math.hypot(vw, vh) * TUNE.tracking.matchRadiusFrac;

  const detections = poses
    .map(r => ({ pose: r.pose, center: personCenter(r.pose) }))
    .filter(d => d.center);

  const used = new Array(detections.length).fill(false);

  // Match existing people to the nearest unused detection within range.
  for (const person of people.values()) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < detections.length; i++) {
      if (used[i]) continue;
      const d = dist(person.tx, person.ty, detections[i].center.x, detections[i].center.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD < matchRadius) {
      used[best] = true;
      updatePersonFromPose(person, detections[best].pose, now);
    }
  }

  // Any leftover detections are new people.
  for (let i = 0; i < detections.length; i++) {
    if (used[i]) continue;
    if (people.size >= TUNE.tracking.maxPeople) break;
    const person = new Person(nextPersonId++, detections[i].center.x, detections[i].center.y);
    people.set(person.id, person);
    updatePersonFromPose(person, detections[i].pose, now);
  }

  // Drop anyone we haven't seen in a while.
  for (const [id, person] of people) {
    if (now - person.lastSeen > TUNE.tracking.personTimeoutMs) {
      person.destroy();
      people.delete(id);
    }
  }
}

/* =============================
   5) POSE → EMOTION / REGION / TRANSFORM (per person)
   ============================= */
function updatePersonFromPose(person, pose, now) {
  if (!pose || !pose.keypoints) return;
  person.lastSeen = now;
  updatePersonFactors(person, pose);
  updatePersonRegions(person, pose);
  updatePersonTransform(person, pose);
}

function regionVelocityFor(person, pose, parts) {
  const diag = Math.hypot(video?.width || 640, video?.height || 480) || 1;
  let sum = 0, n = 0;
  for (const name of parts) {
    const k = pose.keypoints.find(p => p.part === name && p.score > TUNE.velocity.kpMinScore);
    if (!k) continue;
    const prev = person.prevByPart.get(name);
    if (prev) {
      const dx = (k.position.x - prev.x) / diag;
      const dy = (k.position.y - prev.y) / diag;
      sum += Math.hypot(dx, dy);
      n++;
    }
    person.prevByPart.set(name, { x: k.position.x, y: k.position.y });
  }
  return n > 0 ? (sum / n) : 0;
}

function updatePersonFactors(person, pose) {
  const kp = pose.keypoints.filter(k => k.score > TUNE.velocity.kpMinScore);
  if (!kp.length) return;

  let velAvg = 0;
  if (person.prevKeypoints) {
    const diag = Math.hypot(video?.width || 640, video?.height || 480) || 1;
    let sum = 0, n = 0;
    for (const k of kp) {
      const prev = person.prevKeypoints.find(p => p.part === k.part);
      if (!prev) continue;
      const dx = (k.position.x - prev.position.x) / diag;
      const dy = (k.position.y - prev.position.y) / diag;
      sum += Math.hypot(dx, dy);
      n++;
    }
    if (n > 0) velAvg = sum / n;
  }
  person.prevKeypoints = kp.map(k => ({ part: k.part, position: { x: k.position.x, y: k.position.y } }));

  const vNorm = clamp01(map(velAvg, TUNE.velocity.vNormInMin, TUNE.velocity.vNormInMax, 0, 1));
  person.movementVelocity = lerp(person.movementVelocity, vNorm, TUNE.velocity.vBlend);
  person.fastVel = lerp(person.fastVel, vNorm, TUNE.velocity.fastEMA);
  person.slowVel = lerp(person.slowVel, vNorm, TUNE.velocity.slowEMA);

  const burst = Math.max(0, person.fastVel - person.slowVel);
  const poseAnger = clamp01(map(burst, TUNE.velocity.angerBurstMin, TUNE.velocity.angerBurstMax, 0, 1)) * 5;

  const Ls = pose.leftShoulder, Rs = pose.rightShoulder;
  const Lw = pose.leftWrist, Rw = pose.rightWrist;

  let structure = 0;
  if (Ls && Rs && Lw && Rw) {
    const span = dist(Ls.x, Ls.y, Rs.x, Rs.y);
    const lw = dist(Ls.x, Ls.y, Lw.x, Lw.y) / span;
    const rw = dist(Rs.x, Rs.y, Rw.x, Rw.y) / span;
    structure = clamp01(map((lw + rw) * 0.5, 0.7, 2.0, 0, 1));
  }
  person.structure = lerp(person.structure, structure, 0.15);

  const shoulderDiff = Math.abs((Ls?.y ?? 0) - (Rs?.y ?? 0));
  const hipDiff = Math.abs((pose.leftHip?.y ?? 0) - (pose.rightHip?.y ?? 0));
  person.balance = lerp(person.balance, (shoulderDiff + hipDiff), 0.15);

  let lean = 0;
  if (Ls && Rs && pose.leftHip && pose.rightHip) {
    const sx = (Ls.x + Rs.x) / 2, sy = (Ls.y + Rs.y) / 2;
    const hx = (pose.leftHip.x + pose.rightHip.x) / 2, hy = (pose.leftHip.y + pose.rightHip.y) / 2;
    const ang = Math.atan2(hy - sy, hx - sx);
    lean = clamp01(map(Math.abs(ang), 0.0, Math.PI / 6, 0, 1));
  }
  person.postureLean = lerp(person.postureLean, lean, 0.15);

  if (Ls && Rs) {
    const avgY = (Ls.y + Rs.y) / 2;
    person.avgY = lerp(person.avgY, avgY, 0.1);
  }

  const E = TUNE.emotions;
  if (E.sadnessFromAvgY.inMax === null) E.sadnessFromAvgY.inMax = height;

  const poseAnxiety = constrain(map(person.movementVelocity, E.anxietyFromVel.inMin, E.anxietyFromVel.inMax, E.anxietyFromVel.outMin, E.anxietyFromVel.outMax), 0, 5);
  const poseCalm = constrain(map(person.balance, E.calmFromBalance.inMin, E.calmFromBalance.inMax, E.calmFromBalance.outMin, E.calmFromBalance.outMax), 0, 5);
  const poseSadness = constrain(map(person.avgY, E.sadnessFromAvgY.inMin, E.sadnessFromAvgY.inMax, E.sadnessFromAvgY.outMin, E.sadnessFromAvgY.outMax), 0, 5);
  const poseFear = constrain(map(person.postureLean, E.fearFromLean.inMin, E.fearFromLean.inMax, E.fearFromLean.outMin, E.fearFromLean.outMax), 0, 5);
  const poseJoy = constrain(map(person.structure, E.joyFromStructure.inMin, E.joyFromStructure.inMax, E.joyFromStructure.outMin, E.joyFromStructure.outMax), 0, 5);

  const S = E.smoothing;
  person.emotion.anxiety = lerp(person.emotion.anxiety, poseAnxiety, S);
  person.emotion.calm = lerp(person.emotion.calm, poseCalm, S);
  person.emotion.sadness = lerp(person.emotion.sadness, poseSadness, S);
  person.emotion.fear = lerp(person.emotion.fear, poseFear, S);
  person.emotion.joy = lerp(person.emotion.joy, poseJoy, S);
  person.emotion.anger = lerp(person.emotion.anger, poseAnger, S);
}

function updatePersonRegions(person, pose) {
  const C = TUNE.coupling;
  const get = part => {
    const k = pose.keypoints.find(p => p.part === part && p.score > TUNE.velocity.kpMinScore);
    return k ? k.position : null;
  };

  const ls = get('leftShoulder'), rs = get('rightShoulder');
  const lh = get('leftHip'), rh = get('rightHip');
  const lw = get('leftWrist'), rw = get('rightWrist');
  const la = get('leftAnkle'), ra = get('rightAnkle');

  {
    const v = regionVelocityFor(person, pose, regionKeypoints.head);
    const val = constrain(map(v, C.head.velMin, C.head.velMax, 0, 5), 0, 5);
    person.region.head = lerp(person.region.head, val, C.head.lerp);
  }
  {
    const v = regionVelocityFor(person, pose, regionKeypoints.neck);
    const val = constrain(map(v, C.neck.velMin, C.neck.velMax, 0, 5), 0, 5);
    person.region.neck = lerp(person.region.neck, val, C.neck.lerp);
  }
  if (lw && rw && ls && rs) {
    const span = dist(ls.x, ls.y, rs.x, rs.y);
    const wristSpread = dist(lw.x, lw.y, rw.x, rw.y) / Math.max(span, 1e-6);
    const base = constrain(map(wristSpread, C.armsHands.wristSpreadMin, C.armsHands.wristSpreadMax, 0, 5), 0, 5);
    const v = regionVelocityFor(person, pose, regionKeypoints.armsHands);
    const boost = constrain(map(v, C.head.velMin, C.chest.velMax, 0, 5), 0, 5) * 0.5;
    const armsVal = constrain(base + boost, 0, 5);
    person.region.armsHands = lerp(person.region.armsHands, armsVal, C.armsHands.lerp);
  }
  if (ls && rs) {
    const span = dist(ls.x, ls.y, rs.x, rs.y);
    let openness = 0;
    if (lw && rw) {
      const lwR = dist(ls.x, ls.y, lw.x, lw.y) / span;
      const rwR = dist(rs.x, rs.y, rw.x, rw.y) / span;
      openness = (lwR + rwR) * 0.5;
    }
    const openVal = constrain(map(openness, C.chest.reachMin, C.chest.reachMax, 0, 5), 0, 5);
    const v = regionVelocityFor(person, pose, regionKeypoints.chest);
    const vVal = constrain(map(v, C.chest.velMin, C.chest.velMax, 0, 5), 0, 5);
    const chestVal = constrain(0.6 * openVal + 0.4 * vVal, 0, 5);
    person.region.chest = lerp(person.region.chest, chestVal, C.chest.lerp);
  }
  if (ls && rs && lh && rh) {
    const span = dist(ls.x, ls.y, rs.x, rs.y);
    const scx = (ls.x + rs.x) / 2, scy = (ls.y + rs.y) / 2;
    const hcx = (lh.x + rh.x) / 2, hcy = (lh.y + rh.y) / 2;
    const torsoLen = dist(scx, scy, hcx, hcy) / Math.max(span, 1e-6);
    const torsoVal = 5 - constrain(map(torsoLen, C.abdomen.torsoMin, C.abdomen.torsoMax, 0, 5), 0, 5);
    const v = regionVelocityFor(person, pose, regionKeypoints.abdomen);
    const vVal = constrain(map(v, C.abdomen.velMin, C.abdomen.velMax, 0, 5), 0, 5);
    const abdVal = constrain(0.6 * torsoVal + 0.4 * vVal, 0, 5);
    person.region.abdomen = lerp(person.region.abdomen, abdVal, C.abdomen.lerp);
  }
  if (la && ra && lh && rh) {
    const hipSpan = dist(lh.x, lh.y, rh.x, rh.y);
    const stepW = dist(la.x, la.y, ra.x, ra.y) / Math.max(hipSpan, 1e-6);
    const spreadVal = constrain(map(stepW, C.legsFeet.ankleSpreadMin, C.legsFeet.ankleSpreadMax, 0, 5), 0, 5);
    const v = regionVelocityFor(person, pose, regionKeypoints.legsFeet);
    const vVal = constrain(map(v, C.legsFeet.velMin, C.legsFeet.velMax, 0, 5), 0, 5);
    const legsVal = constrain(0.5 * spreadVal + 0.5 * vVal, 0, 5);
    person.region.legsFeet = lerp(person.region.legsFeet, legsVal, C.legsFeet.lerp);
  }
  if (ls && rs) {
    const span = dist(ls.x, ls.y, rs.x, rs.y);
    const spineSway = ((ls.x + rs.x) * 0.5 - (video?.width || 640) / 2) / Math.max(span, 1e-6);
    const spineVal = map(spineSway, -C.spine.swayRange, C.spine.swayRange, 0, REGION_MAX_WIDTHS.spine);
    person.region.spine = lerp(person.region.spine, spineVal, C.spine.lerp);
  }
}

function updatePersonTransform(person, pose) {
  const get = part => {
    const k = pose.keypoints.find(p => p.part === part);
    return (k && k.score > TUNE.velocity.kpMinScore) ? k.position : null;
  };
  const ls = get('leftShoulder'), rs = get('rightShoulder');
  const lh = get('leftHip'), rh = get('rightHip');
  if (!(ls && rs && lh && rh)) return;

  const cx = (ls.x + rs.x + lh.x + rh.x) / 4;
  const cy = (ls.y + rs.y + lh.y + rh.y) / 4;
  const sx = (ls.x + rs.x) / 2, sy = (ls.y + rs.y) / 2;
  const hx = (lh.x + rh.x) / 2, hy = (lh.y + rh.y) / 2;
  const ang = Math.atan2(hy - sy, hx - sx) - Math.PI / 2;
  const shoulderW = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  const baseline = (video?.width || 640) * TUNE.tracking.baselineShoulderFrac;
  const s = constrain(shoulderW / baseline, 0.6, 1.8);

  person.tx = lerp(person.tx, cx, 0.20);
  person.ty = lerp(person.ty, cy, 0.20);
  person.rot = lerp(person.rot, ang, 0.18);
  person.depthScale = lerp(person.depthScale, s, 0.12);
}

/* =============================
   6) P5 SETUP / DRAW
   ============================= */
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  colorMode(RGB);
  angleMode(RADIANS);
  noFill();

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
  push();
  let s, ox, oy;
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

  for (const person of people.values()) {
    drawPersonBody(person, ox + person.tx * s, oy + person.ty * s);
  }
  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

/* =============================
   7) DRAWING — one Energy Body per person
   ============================= */
function drawPersonBodyShape(person) {
  const B = TUNE.body;
  const originX = B.bufW / 2, originY = B.bufH / 2;

  const spacings = regionNames.map(r => (REGION_BASE_HEIGHTS[r] || 60) * B.heightScale);
  const totalHeight = spacings.reduce((a, b) => a + b, 0);

  const FV = TUNE.visuals.fear;
  const fearAmt = person.emotion.fear / 5;
  const baseScale = lerp(FV.baseScaleFrom, FV.baseScaleTo, fearAmt);
  const fearFreq = lerp(FV.freqFrom, FV.freqTo, fearAmt);
  const pulse = FV.pulseAmp * Math.sin(frameCount * fearFreq + person.id);
  const fearScale = baseScale + pulse;

  let spacingAccumulator = -totalHeight / 2;
  let leftSide = [], rightSide = [], crotchPoints = [];
  const legTaper = B.legTaper, domeOffset = B.domeOffset;
  const stepsPerRegion = 2;

  for (let i = 0; i < regionNames.length; i++) {
    const region = regionNames[i];
    for (let s = 0; s < stepsPerRegion; s++) {
      const t = s / (stepsPerRegion - 1);
      let y = spacingAccumulator + t * spacings[i];

      if (region === 'chest') y -= 60 * B.heightScale;
      if (region === 'armsHands') y += map(t, 0, 1, 0, 40 * B.heightScale);
      if (region === 'legsFeet') y += map(t, 0, 1, 0, 80 * B.heightScale);

      const spineOffset = person.region.spine;
      const sliderVal = person.region[region];
      const maxWidth = (REGION_MAX_WIDTHS[region] || 80) * B.widthScale;
      let halfWidth = map(sliderVal, 0, 5, 0, maxWidth) * fearScale;

      if (region === 'legsFeet') halfWidth -= map(t, 0, 1, 0, legTaper * B.widthScale);

      leftSide.push(createVector(-halfWidth - spineOffset / 2 + originX, y + originY));
      rightSide.unshift(createVector(halfWidth + spineOffset / 2 + originX, y + originY));

      if (region === 'legsFeet' && s === stepsPerRegion - 1) {
        crotchPoints.push(createVector(originX, y + originY - B.crotchPull));
      }
    }
    spacingAccumulator += spacings[i];
  }

  const domeY = leftSide[0].y - domeOffset * B.heightScale;
  const leftAnchor = createVector(originX, domeY);
  const rightAnchor = createVector(originX, domeY);
  const fullShape = [leftAnchor, ...leftSide, ...crotchPoints, ...rightSide, rightAnchor];

  person.mask.noStroke();
  person.mask.fill(255);
  person.mask.curveTightness(-0.5);
  person.mask.beginShape();
  person.mask.curveVertex(fullShape[0].x, fullShape[0].y);
  for (const pt of fullShape) person.mask.curveVertex(pt.x, pt.y);
  person.mask.curveVertex(fullShape[fullShape.length - 1].x, fullShape[fullShape.length - 1].y);
  person.mask.endShape(CLOSE);
}

function drawEmotionLayers(pg, W, H, joyAmt, sadnessAmt, angerAmt) {
  const M = TUNE.visuals.marbles;
  const gridSpacing = M.gridSpacing, emotionAlpha = M.alphaPerUnit;

  const layer = (amt, hex, seed) => {
    if (amt <= 0) return;
    const c = color(hex);
    c.setAlpha(amt * emotionAlpha);
    pg.noStroke();
    pg.fill(c);
    for (let y = 0; y < H; y += gridSpacing) {
      for (let x = 0; x < W; x += gridSpacing) {
        const a = noise(x * 0.01 + seed, y * 0.01 + seed) * TWO_PI * 4;
        const dx = Math.cos(a) * gridSpacing * 2;
        const dy = Math.sin(a) * gridSpacing * 2;
        pg.ellipse(x + dx, y + dy, gridSpacing * 2, gridSpacing * 2);
      }
    }
  };

  layer(joyAmt, '#ffff00', 0);
  layer(sadnessAmt, '#2196F3', 100);
  layer(angerAmt, '#FF53BC', 200);
}

function drawAnxietyPattern(pg, W, H, val, calm) {
  const A = TUNE.visuals.anxiety;
  const alpha = lerp(A.alphaMax, A.alphaMin, calm);
  pg.stroke(255, alpha);
  pg.strokeWeight(2);
  pg.noFill();

  let baseSpacing = lerp(
    map(val, 0, 5, A.spacingChaotic.from, A.spacingChaotic.to),
    map(val, 0, 5, A.spacingCalm.from, A.spacingCalm.to),
    calm
  );
  baseSpacing = Math.max(baseSpacing, A.minSpacingPx);

  const lineLength = lerp(
    map(val, 0, 5, A.lineLenChaotic.from, A.lineLenChaotic.to),
    map(val, 0, 5, A.lineLenCalm.from, A.lineLenCalm.to),
    calm
  );

  const jitterAmount = lerp(map(val, 0, 5, 0, A.jitterMax), 0, calm);
  const irregularity = lerp(map(val, 0, 5, 0, A.irregularityMax), 0, calm);
  const angleScale = lerp(A.angleScaleChaotic, A.angleScaleCalm, calm);
  const curlStrength = lerp(0, A.curlMax, calm);

  const cols = Math.ceil(W / baseSpacing);
  const rows = Math.ceil(H / baseSpacing);
  const totalCells = cols * rows;
  const budget = Math.min(totalCells, A.maxStrokes || totalCells);
  const stride = Math.max(1, Math.ceil(Math.sqrt(totalCells / budget)));

  for (let yi = 0; yi < rows; yi += stride) {
    const y = yi * baseSpacing;
    for (let xi = 0; xi < cols; xi += stride) {
      const x = xi * baseSpacing;
      const ox = x + random(-baseSpacing * irregularity, baseSpacing * irregularity);
      const oy = y + random(-baseSpacing * irregularity, baseSpacing * irregularity);
      const jx = (noise(ox * 0.01, oy * 0.01, frameCount * 0.01) - 0.5) * jitterAmount;
      const jy = (noise(oy * 0.01, ox * 0.01, frameCount * 0.01) - 0.5) * jitterAmount;
      const ang = noise(ox * angleScale, oy * angleScale, frameCount * 0.005) * TWO_PI;
      const dx = Math.cos(ang) * lineLength;
      const dy = Math.sin(ang) * lineLength;
      const sx = ox + jx, sy = oy + jy;
      const ex = ox + dx + jx, ey = oy + dy + jy;
      const mx = ox + dx * 0.5 + Math.sin(frameCount * 0.02 + y * 0.01) * curlStrength;
      const my = oy + dy * 0.5 + Math.cos(frameCount * 0.02 + x * 0.01) * curlStrength;
      pg.beginShape();
      pg.vertex(sx, sy);
      pg.quadraticVertex(mx + jx, my + jy, ex, ey);
      pg.endShape();
    }
  }
}

function drawPersonBody(person, screenX, screenY) {
  const B = TUNE.body;
  person.mask.clear();
  person.emoG.clear();
  person.patG.clear();

  drawPersonBodyShape(person);

  const e = person.emotion;
  drawEmotionLayers(person.emoG, B.bufW, B.bufH, e.joy / 5, e.sadness / 5, e.anger / 5);
  drawAnxietyPattern(person.patG, B.bufW, B.bufH, e.anxiety, e.calm / 5);

  const maskImg = person.mask.get();
  const emoImg = person.emoG.get();
  const patImg = person.patG.get();
  emoImg.mask(maskImg);
  patImg.mask(maskImg);

  const desiredHeightPx = height * B.baseHeightFrac * person.depthScale;
  const finalScale = desiredHeightPx / B.bufH;

  push();
  translate(screenX, screenY);
  rotate(person.rot * 0.15); // subtle lean only — full rotation reads as falling over at crowd scale
  scale(finalScale);
  imageMode(CENTER);
  image(emoImg, 0, 0, B.bufW, B.bufH);
  image(patImg, 0, 0, B.bufW, B.bufH);
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
  const avg = (sel) => n ? arr.reduce((sum, p) => sum + sel(p), 0) / n : 0;

  const emotions = {};
  for (const k of emotionNames) emotions[k] = avg(p => p.emotion[k]);

  return {
    headcount: n,
    velocity: avg(p => p.movementVelocity),
    structure: avg(p => p.structure),
    balance: avg(p => p.balance),
    posture: avg(p => p.postureLean),
    emotions
  };
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

  const sample = buildCrowdSample();
  EnergyBodiesDisplay.crowd({ ...sample, t: now });

  const vw = video?.width || 960, vh = video?.height || 540;
  const list = Array.from(people.values()).map(p => {
    // Re-derive keypoints from the last matched pose isn't stored on Person to
    // save memory; send transform + emotion mix instead — enough for a
    // dashboard readout, without keeping every skeleton around.
    return {
      id: p.id,
      x: p.tx / vw,
      y: p.ty / vh,
      depthScale: p.depthScale,
      emotion: p.emotion
    };
  });
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

  let emotionRows = '';
  for (const name of emotionNames) {
    const val = avg.emotions?.[name] ?? 0;
    const barWidth = (val / 5) * 100;
    emotionRows += `
      <tr>
        <td class="label">${name.charAt(0).toUpperCase() + name.slice(1)}</td>
        <td class="value">${fmt(val)}</td>
        <td class="bar"><div class="bar-fill" style="width: ${barWidth}%"></div></td>
      </tr>`;
  }

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
          table { width: 100%; border-collapse: collapse; margin-top: 5px; }
          tr { border-bottom: 1px solid #333; }
          td { padding: 5px 2px; font-size: 10px; }
          td.label { width: 40%; text-transform: capitalize; }
          td.value { width: 20%; text-align: right; font-weight: bold; }
          td.bar { width: 40%; padding-left: 8px; }
          .bar-fill { height: 8px; background: #fff; }
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
            <div class="section-title">Core Metrics (crowd average)</div>
            <div class="core-metrics">
              <div class="metric"><div class="name">Structure</div><div class="val">${fmt(avg.structure)}</div></div>
              <div class="metric"><div class="name">Balance</div><div class="val">${fmt(avg.balance)}</div></div>
              <div class="metric"><div class="name">Posture</div><div class="val">${fmt(avg.posture)}</div></div>
              <div class="metric"><div class="name">Velocity</div><div class="val">${fmt(avg.velocity)}</div></div>
            </div>
          </div>
          <div class="section">
            <div class="section-title">Emotional State (crowd average)</div>
            <table>${emotionRows}</table>
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
