/* ============================================================================
   ENERGY BODIES — CROWD EDITION — DISPLAY SKETCH (v5: one shared kaleidoscope)
   One image for the whole room instead of one per person:
     - PoseNet runs in 'multiple' detection mode and a lightweight nearest-neighbor
       tracker gives each person a stable id across frames
     - The kaleidoscope is centered on the screen and spans its full width
     - Each person is one RING: the first person is the innermost ring and every
       additional person adds a ring outward. The rings re-space themselves so
       the outermost one always reaches the screen edges.
     - A ring's copies (its reflections) = that person's number of tracked body
       points, rounded up to an even number so the mirrored copies close up
     - The shape on a ring — circle, triangle or square — comes from that
       person's movement: still = square, a few body parts moving = triangle,
       whole-body movement = circle
     - Stillness vs motion sets the color: blue (still) → violet → red (moving)
     - Nothing rotates
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
    // --- layout: one kaleidoscope, centered on screen, outermost ring reaching the screen edges ---
    ringFill: 0.55,         // max shape half-size relative to the gap between rings (0.5 = neighboring rings just touch)
    arcFill: 1.0,           // max shape half-size relative to half the gap between neighbors on a ring (1.0 = they just touch)
    opacity: 0.8,
    // --- reflections (copies around each ring) ---
    reflectionsFrom: 'bodyPoints', // 'bodyPoints': each ring gets that person's number of tracked body points
                                   // 'people':     every ring gets one copy per person detected
    // --- movement → shape ---
    motionFullMean: 0.3,    // mean keypoint activation that reads as "fully in motion"
    stillThreshold: 0.08,   // motion below this = still → square
    wholeBodyFrac: 0.45,    // share of visible body points moving at once that counts as whole-body → circle (fewer = localized → triangle)
    // --- stillness vs motion → color (hue in degrees: 215 = blue, 360 = red, passing through violet) ---
    hueStill: 215, hueMoving: 360,
    saturation: 80, brightness: 95,
    // --- stability: a new layout (copy count / shape) must hold this long, then cross-fades in ---
    layoutDebounceMs: 600, layoutFadeFrames: 16,
    ease: { rank: 0.08, crowd: 0.08, motion: 0.08 } // per-frame easing of ring positions, ring spacing and color
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
    this.d = { rank: 1, motion: 0 };
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
  m.motion = visible ? clamp01((sum / visible) / K.motionFullMean) : 0;
  m.movingFrac = visible ? movingN / visible : 0;

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
  drawCrowdKaleidoscope(millis());
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

/* =============================
   7) DRAWING — one kaleidoscope for the whole room
   ============================= */
let crowdD = 1, crowdInit = false; // eased number of people, so rings glide apart/together when someone joins or leaves

// Fade a person in when first detected and out as they go missing, rather than popping.
function lifeAlpha(person, now) {
  const fadeIn = clamp01((now - person.born) / 300);
  const missing = now - person.lastSeen;
  const fadeStart = 250;
  const fadeOut = missing > fadeStart ? clamp01(1 - (missing - fadeStart) / (TUNE.tracking.personTimeoutMs - fadeStart)) : 1;
  return fadeIn * fadeOut;
}

// Largest a shape may be on a ring of radius r with `copies` copies and `spacing` between rings:
// small enough that neighboring rings and neighboring copies only just touch.
function shapeHalfSize(r, copies, spacing) {
  const K = TUNE.kaleido;
  return Math.min(K.ringFill * spacing, K.arcFill * Math.PI * r / copies);
}

function drawShape(kind, s) {
  if (kind === 'circle') circle(0, 0, s * 2);
  else if (kind === 'square') { rectMode(CENTER); square(0, 0, s * 1.7); }
  else triangle(s, 0, -s / 2, s * 0.866, -s / 2, -s * 0.866); // equilateral, pointing outward
}

// One ring: `copies` shapes around the center, every other copy mirrored (so with an even count the ring is
// mirror-symmetric), every other ring offset half a segment — the moonflower layout. Copy 0 sits at 12 o'clock.
function drawRing(r, ringIndex, spacing, layout, hueDeg, alpha) {
  if (alpha <= 0.002) return;
  const K = TUNE.kaleido;
  const copies = layout.refl, seg = TWO_PI / copies;
  const s = shapeHalfSize(r, copies, spacing);
  if (s < 0.5) return;
  const weave = ringIndex % 2 === 1 ? seg / 2 : 0;
  fill(hueDeg, K.saturation, K.brightness, alpha);
  for (let i = 0; i < copies; i++) {
    push();
    rotate(-HALF_PI + i * seg + weave);
    translate(r, 0);
    if (i % 2 === 1) scale(-1, 1);
    drawShape(layout.shape, s);
    pop();
  }
}

function drawCrowdKaleidoscope(now) {
  const K = TUNE.kaleido, E = K.ease;
  const list = Array.from(people.values()).sort((a, b) => a.id - b.id); // first person = innermost ring
  if (!list.length) return;

  crowdD = crowdInit ? lerp(crowdD, list.length, E.crowd) : list.length;
  crowdInit = true;
  const N = Math.max(1, crowdD);

  list.forEach((p, i) => {
    if (!p.dInit) { p.d.rank = i + 1; p.d.motion = p.m.motion; p.dInit = true; return; }
    p.d.rank = lerp(p.d.rank, i + 1, E.rank);
    p.d.motion = lerp(p.d.motion, p.m.motion, E.motion);
  });

  // Size the whole thing so the outermost shapes touch the left and right edges of the screen.
  const halfW = width / 2;
  const outerCopies = list[list.length - 1].layoutCur.refl;
  let L = halfW * 0.9;
  for (let it = 0; it < 3; it++) L = halfW - shapeHalfSize(L, outerCopies, L / N);
  const spacing = L / N;

  push();
  translate(width / 2, height / 2);
  colorMode(HSB, 360, 100, 100, 1);
  noStroke();
  for (let i = list.length - 1; i >= 0; i--) { // outermost first, so inner rings sit on top
    const p = list[i];
    const r = L * p.d.rank / N;
    const hueDeg = lerp(K.hueStill, K.hueMoving, p.d.motion);
    const alpha = K.opacity * lifeAlpha(p, now);
    if (p.layoutFade < 1) p.layoutFade = Math.min(1, p.layoutFade + 1 / K.layoutFadeFrames);
    if (p.layoutFade < 1) drawRing(r, i, spacing, p.layoutPrev, hueDeg, alpha * (1 - p.layoutFade));
    drawRing(r, i, spacing, p.layoutCur, hueDeg, alpha * p.layoutFade);
  }
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
