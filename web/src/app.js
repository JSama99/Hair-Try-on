// app.js — Braid Try-On Studio (browser). See web/README.md for the architecture.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import WORKER_SOURCE from 'virtual:worker-source';
import { FACE_VERTICES, FACE_TRIANGLES } from './canonical-face.js';
import { fitHead } from './headfit.js';
import { runJob } from './worker.js';
import * as T from './tryon.js';
import { buildFaceParts } from './mesh-tools.js';
import salonConfigRaw from '../salon/salon.config.json' with { type: 'json' };
import { validateSalonConfig, NO_SALON } from './salon-config.js';
import { createConsultation } from './consult-ui.js';
import { createExtras } from './extras-ui.js';
import { createLive } from './live.js';
import { HairSimulation, poseFromMatrix, SIM_DEFAULTS } from './hairsim.js';
import { lookFromHash } from './look-link.js';

const $ = (id) => document.getElementById(id);
const els = {
  wrap: $('wrap'), viewport: $('viewport'), gl: $('gl'), overlay: $('overlay'), photo: $('photo'),
  status: $('status'), banner: $('banner'), progress: $('progress'), views: $('views'),
  styles: $('styles'), sizes: $('sizes'), lengths: $('lengths'), colors: $('colors'), tones: $('tones'),
  styleBlurb: $('style-blurb'), sizeVal: $('size-val'), lengthVal: $('length-val'), colorVal: $('color-val'), skinVal: $('skin-val'),
  modeStudio: $('mode-studio'), modePhoto: $('mode-photo'), modeLive: $('mode-live'), livePick: $('live-pick'), liveStart: $('live-start'),
  liveHairline: $('live-hairline'), liveHint: $('live-hint'), cam: $('cam'), compare: $('compare'), offlineNote: $('offline-note'),
  photoPick: $('photo-pick'), photoInput: $('photo-input'), photoBtnLabel: $('photo-btn-label'),
  skinSec: $('skin-sec'), fitSec: $('fit-sec'), fitHint: $('fit-hint'), fitReset: $('fit-reset'),
  fit: { x: $('fit-x'), y: $('fit-y'), s: $('fit-s'), r: $('fit-r'), t: $('fit-t') },
  caption: $('caption'), capture: $('capture'), copyCaption: $('copy-caption'), copyStatus: $('copy-status'),
  dialog: $('capture-dialog'), captureImg: $('capture-img'), captureCopy: $('capture-copy'), captureClose: $('capture-close'), captureHint: $('capture-hint'),
};

// ------------------------------------------------------------------ state

const D = T.CATALOG.defaults;
const firstStyle = T.styleById(D.style);
const state = {
  look: { style: firstStyle.id, size: firstStyle.defaultSize, length: firstStyle.defaultLength, color: D.color },
  skinTone: D.skinTone,
  mode: 'studio',
  view: 'three',
  head: fitHead(FACE_VERTICES, { preset: 'mediapipe' }),
  photo: null,          // {canvas, w, h, url}
  vision: null,         // {face, hair} MediaPipe tasks, or {error}
  analysis: null,       // {matrix, landmarks, hair: {probs, w, h}, reprojPx}
  fit: { x: 0, y: 0, s: 1, r: 0, t: 0 },
  manual: false,
  conflict: false,
  lastMeasure: null,
  hairlineFront: null,  // calibrated from the photo, radians
  live: null,           // {w, h} of the camera picture while the live mirror is tracking
  liveAnalysis: { matrix: null, hair: null, hairMatrix: null },
  liveHairline: null,   // matched from the camera on request, radians
  liveStatus: 'off',    // off | starting | tracking | lost | error
};
/** What the style is drawn over: the photo, the camera picture, or nothing (the 3D bust). */
const backdrop = () => (state.mode === 'photo' ? state.photo : state.mode === 'live' ? state.live : null);
const analysis = () => (state.mode === 'live' ? state.liveAnalysis : state.analysis);
const BASE_HEAD = state.head;
const isCoarse = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
const TRIANGLE_BUDGET = isCoarse ? 700_000 : 1_600_000;

// ------------------------------------------------------------------ renderer

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: els.gl, antialias: true, alpha: true, preserveDrawingBuffer: true });
} catch (err) {
  els.status.textContent = 'This browser cannot start WebGL, so the 3D preview is unavailable.';
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

// Warm, low hemisphere: a cool sky term greys out steep facets on deep skin tones.
const hemi = new THREE.HemisphereLight(0xffeee2, 0x3a2a22, 0.55);
const key = new THREE.DirectionalLight(0xfff2e6, 2.3);
key.position.set(0.6, 0.9, 1.0);
const rim = new THREE.DirectionalLight(0xdfe8ff, 1.4);
rim.position.set(-0.8, 0.6, -1.0);
const fill = new THREE.DirectionalLight(0xffe2cc, 0.9);
fill.position.set(-0.9, 0.2, 0.8);
scene.add(hemi, key, rim, fill);

const studioCam = new THREE.PerspectiveCamera(28, 1, 0.01, 10);
const photoCam = new THREE.PerspectiveCamera(T.MP_VERTICAL_FOV, 1, 1, 2000); // MediaPipe camera, cm
const controls = new OrbitControls(studioCam, els.gl);
const TARGET = new THREE.Vector3(0, -0.035, -0.03);
controls.target.copy(TARGET);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 0.32;
controls.maxDistance = 1.4;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = 1.95;

// The rig is the head frame (canonical face frame, metres). In studio mode it
// sits at the origin; in photo mode its matrix is pose * scale(100).
const rig = new THREE.Group();
rig.matrixAutoUpdate = false;
scene.add(rig);

// ------------------------------------------------------------------ mannequin + occluders

const parts = buildFaceParts(FACE_VERTICES, FACE_TRIANGLES, BASE_HEAD, { feminine: true });
// Skin: low environment reflection (a mirror-like env sheen reads as grey patches on dark skin).
const skinMat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.25 });
const eyeMat = new THREE.MeshStandardMaterial({ color: 0x15100e, roughness: 0.18, metalness: 0 });
const lipMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0, side: THREE.DoubleSide });
const occluderMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

const mannequin = new THREE.Group();
const occluders = new THREE.Group();
for (const [geo, kind] of [[parts.face, 'skin'], [parts.skull, 'skin'], [parts.neck, 'skin'], [parts.torso, 'skin'],
  [parts.earL, 'skin'], [parts.earR, 'skin'], [parts.eyes, 'eye'], [parts.mouth, 'lip']]) {
  mannequin.add(new THREE.Mesh(geo, kind === 'eye' ? eyeMat : kind === 'lip' ? lipMat : skinMat));
  const occ = new THREE.Mesh(geo, occluderMat);
  occ.renderOrder = -1;
  occluders.add(occ);
}
occluders.visible = false;
rig.add(mannequin, occluders);

// Feminine features on the bust: almond eyes with lashes, brows, lip colour, gold hoops.
function eyeTexture() {
  // The eye's UV box is ~3:1 wide while the canvas is 2:1, so circles are drawn as
  // ellipses 1.5x narrower to land round on the face.
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#d8cabd';
  g.fillRect(0, 0, 256, 128);
  const shade = g.createLinearGradient(0, 0, 0, 128);
  shade.addColorStop(0, 'rgba(60,35,25,0.35)'); shade.addColorStop(0.45, 'rgba(60,35,25,0)');
  g.fillStyle = shade; g.fillRect(0, 0, 256, 128);
  // Iris slightly taller than the opening, so both lids cross it as in a relaxed gaze.
  const ell = (r, fill) => { g.fillStyle = fill; g.beginPath(); g.ellipse(128, 60, r / 1.5, r, 0, 0, Math.PI * 2); g.fill(); };
  const iris = g.createRadialGradient(128, 60, 6, 128, 60, 74);
  iris.addColorStop(0, '#0d0805'); iris.addColorStop(0.3, '#2b170b'); iris.addColorStop(0.78, '#4a2914'); iris.addColorStop(1, '#170d07');
  ell(74, iris);
  ell(25, '#040302');
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath(); g.ellipse(114, 42, 7, 10, 0, 0, Math.PI * 2); g.fill();
  // Lash line with a small outer flick; the outer corner is at u = 0 for one eye
  // and u = 1 for the other, so the flick is drawn at both ends, faintly.
  const lash = g.createLinearGradient(0, 0, 0, 30);
  lash.addColorStop(0, 'rgba(6,4,3,1)'); lash.addColorStop(1, 'rgba(6,4,3,0)');
  g.fillStyle = lash; g.fillRect(0, 0, 256, 30);
  const low = g.createLinearGradient(0, 128, 0, 112);
  low.addColorStop(0, 'rgba(45,26,18,0.7)'); low.addColorStop(1, 'rgba(45,26,18,0)');
  g.fillStyle = low; g.fillRect(0, 112, 256, 16);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  return t;
}

function browTexture(mirror) {
  // A tapered arch on a transparent canvas: full at the inner end, a fine tail outside.
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  if (mirror) { g.translate(256, 0); g.scale(-1, 1); }
  g.fillStyle = 'rgba(34,22,15,0.95)';
  g.beginPath();
  g.moveTo(8, 34);
  g.quadraticCurveTo(120, 4, 250, 30);
  g.quadraticCurveTo(140, 22, 14, 52);
  g.closePath();
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  return t;
}

const featureMats = {
  eye: new THREE.MeshPhysicalMaterial({ map: eyeTexture(), roughness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.15, polygonOffset: true, polygonOffsetFactor: -2 }),
  browL: new THREE.MeshStandardMaterial({ map: browTexture(false), transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false }),
  browR: new THREE.MeshStandardMaterial({ map: browTexture(true), transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false }),
  lips: new THREE.MeshStandardMaterial({ roughness: 0.58, polygonOffset: true, polygonOffsetFactor: -1 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd8a94e, metalness: 1, roughness: 0.28 }),
};
if (parts.feature) {
  const f = parts.feature;
  mannequin.add(new THREE.Mesh(f.eyeL, featureMats.eye), new THREE.Mesh(f.eyeR, featureMats.eye),
    new THREE.Mesh(f.browL, featureMats.browL), new THREE.Mesh(f.browR, featureMats.browR),
    new THREE.Mesh(f.lips, featureMats.lips), new THREE.Mesh(f.hoopL, featureMats.gold), new THREE.Mesh(f.hoopR, featureMats.gold));
}

// A close-cropped look painted on the scalp exactly above the hairline (no thickness). Used
// only by the test snapshot: it gives the hairline estimator a photo with a known, flat hairline.
const closeCrop = (() => {
  const geo = parts.skull.clone();
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < pos.count; i++) {
    const [th, ph] = BASE_HEAD.thetaPhiOf([pos.getX(i), pos.getY(i), pos.getZ(i)]);
    const hair = BASE_HEAD.insideHairline(th, ph);
    const v = hair ? 0.012 + 0.01 * rnd() : 1;
    col.set(hair ? [v, v * 0.8, v * 0.65] : [1, 1, 1], 3 * i);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.scale(1.002, 1.002, 1.002);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
  m.visible = false;
  mannequin.add(m);
  return m;
})();

function applySkin() {
  const tone = T.SKIN_TONES.find((t) => t.id === state.skinTone);
  skinMat.color.set(tone.hex);
  lipMat.color.set(tone.hex).multiplyScalar(0.72);
  // Lips: a berry-brown a little deeper than the skin, so the colour reads on every Monk tone.
  featureMats.lips.color.set(tone.hex).lerp(new THREE.Color(0x5a2230), 0.6).multiplyScalar(0.8);
  els.skinVal.textContent = `MST ${tone.label}`;
  requestRender();
}

// ------------------------------------------------------------------ hair

function bumpTexture(kind, lod) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#808080';
  g.fillRect(0, 0, size, size);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (lod === 0 || kind === 'locs') {
    // Fibres run along v (down the strand) with a slight twist.
    for (let i = 0; i < 70; i++) {
      const x = rnd() * size, w = 0.6 + rnd() * 1.6, shade = 90 + rnd() * 90;
      g.strokeStyle = `rgb(${shade},${shade},${shade})`;
      g.lineWidth = w;
      for (const dx of [-size, 0, size]) {
        g.beginPath();
        g.moveTo(x + dx, 0);
        g.lineTo(x + dx + size * 0.18, size);
        g.stroke();
      }
    }
    if (kind === 'locs') {
      for (let i = 0; i < 40; i++) {
        const x = rnd() * size, y = rnd() * size, r = 4 + rnd() * 10;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(200,200,200,0.5)');
        grd.addColorStop(1, 'rgba(128,128,128,0)');
        g.fillStyle = grd;
        g.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    }
  } else {
    // LOD1 shell: draw the plait (or twist) lobes the shell stands in for.
    const lobes = kind === 'two_strand_twists' ? 4 : 6;
    for (let k = 0; k < lobes; k++) {
      const y = ((k + 0.5) / lobes) * size;
      const ang = kind === 'two_strand_twists' ? 0.6 : (k % 2 ? -0.7 : 0.7);
      for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
        g.save();
        g.translate(size / 2 + dx, y + dy);
        g.rotate(ang);
        g.scale(1, 0.32);
        const grd = g.createRadialGradient(0, 0, 0, 0, 0, size * 0.5);
        grd.addColorStop(0, '#f0f0f0');
        grd.addColorStop(0.75, '#7a7a7a');
        grd.addColorStop(1, '#202020');
        g.fillStyle = grd;
        g.beginPath();
        g.arc(0, 0, size * 0.5, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(lod === 1 ? 2 : 1, 1);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const bumpCache = new Map();
function bumpFor(kind, lod) {
  const k = `${kind}:${lod}`;
  if (!bumpCache.has(k)) bumpCache.set(k, bumpTexture(kind, lod));
  return bumpCache.get(k);
}

const hairMat = new THREE.MeshPhysicalMaterial({
  vertexColors: true, roughness: 0.46, metalness: 0, sheen: 0.4, sheenRoughness: 0.42,
  sheenColor: new THREE.Color(0.16, 0.135, 0.12), bumpScale: 1.6, envMapIntensity: 0.6,
});
let hairMesh = null;
let hairData = null; // last worker reply
let sim = null;      // live mirror: HairSimulation over the LOD1 shells
let simPlaced = false;
let comparing = false;

function syncHairVisible() {
  if (hairMesh) hairMesh.visible = !comparing && !(state.mode === 'live' && state.live && state.liveStatus !== 'tracking');
}

function recolor() {
  if (!hairMesh) return;
  const color = T.colorById(state.look.color);
  const attr = hairMesh.geometry.getAttribute('color');
  const { fracs, strandIds } = hairData;
  const jitterCache = new Map();
  for (let i = 0; i < fracs.length; i++) {
    const id = strandIds[i];
    let j = jitterCache.get(id);
    if (j === undefined) { j = T.strandJitter(id); jitterCache.set(id, j); }
    const c = T.lookColor(color, fracs[i], j);
    attr.setXYZ(i, c[0], c[1], c[2]);
  }
  attr.needsUpdate = true;
  requestRender();
}

/** Fewer, larger steps for very dense styles so phones keep up (same solver, coarser time step). */
function simParamsFor(nodes) {
  const heavy = nodes > (isCoarse ? 5000 : 9000);
  return heavy ? { ...SIM_DEFAULTS, dt: 1 / 60, passes: 3, maxStepsPerAdvance: 3 } : { ...SIM_DEFAULTS };
}

function installHair(data, spec, head) {
  if (hairMesh) {
    rig.remove(hairMesh);
    hairMesh.geometry.dispose();
  }
  hairData = data;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(data.positions.length), 3));
  geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geo.computeBoundingSphere();
  hairMat.bumpMap = bumpFor(spec.kind, data.lod);
  hairMat.bumpScale = data.lod === 0 ? 1.2 : 2.4;
  hairMat.needsUpdate = true;
  hairMesh = new THREE.Mesh(geo, hairMat);
  sim = null;
  if (data.chains) {
    // Live mirror: the shells are re-skinned to the simulated chains every frame.
    sim = new HairSimulation(data.chains, head, data, simParamsFor(data.chains.nodes.length / 3));
    simPlaced = false;
    geo.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
    geo.getAttribute('normal').setUsage(THREE.DynamicDrawUsage);
    hairMesh.frustumCulled = false;
  }
  rig.add(hairMesh);
  syncHairVisible();
  recolor();
}

// ------------------------------------------------------------------ generation (worker)

let worker = null;
let jobId = 0;
let pending = null;

function makeWorker() {
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = onWorkerMessage;
    w.onerror = () => { worker = null; };
    return w;
  } catch {
    return null;
  }
}

function setProgress(p) {
  els.progress.style.width = p === null ? '0' : `${Math.round(p * 100)}%`;
}

function onWorkerMessage(e) {
  const msg = e.data;
  if (!pending || msg.id !== pending.id) return;
  if (msg.progress !== undefined) {
    setStatus(`Building ${pending.label}… ${Math.round(msg.progress * 100)}%`);
    setProgress(msg.progress);
    return;
  }
  const job = pending;
  pending = null;
  setProgress(null);
  if (msg.error) { setStatus(`Could not build this style: ${msg.error}`); return; }
  finishBuild(msg, job);
}

function finishBuild(data, job) {
  installHair(data, job.spec, job.head);
  builtSim = !!data.chains;
  const unit = job.spec.kind === 'cornrows' ? 'rows' : job.spec.kind === 'locs' ? 'locs' : job.spec.kind === 'two_strand_twists' ? 'twists' : 'braids';
  const tris = data.indices.length / 3;
  const detail = data.lod === 0 ? 'full strand detail' : 'light detail for this device';
  setStatus(`${data.stats.roots} ${unit} · ${(tris / 1000).toFixed(0)}k triangles · ${detail}`, { ready: true });
  document.body.dataset.ready = 'true';
  document.body.dataset.lod = String(data.lod);
  document.body.dataset.sim = sim ? 'on' : 'off';
  if (backdrop()) scheduleConflict();
  requestRender();
}

let builtSim = false;
let buildTimer = 0;
function scheduleBuild() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(build, 90);
}

function build() {
  const res = T.specForLook(state.look);
  if (!res.ok) { showNotice(res.message); return; }
  const spec = res.spec;
  const head = state.hairlineFront !== null ? BASE_HEAD.with({ hairline_front: state.hairlineFront }) : BASE_HEAD;
  state.head = head;
  const label = res.style.name.toLowerCase();
  document.body.dataset.ready = 'false';
  if (pending && worker) { worker.terminate(); worker = null; }
  const id = ++jobId;
  const wantSim = state.mode === 'live';
  pending = { id, spec, label, head };
  setStatus(`Building ${label}…`);
  setProgress(0.02);
  if (!worker) worker = makeWorker();
  const job = { id, spec, head: head.toJSON(), triangleBudget: TRIANGLE_BUDGET, sim: wantSim };
  if (worker) {
    worker.postMessage(job);
  } else {
    // No worker available: build on the main thread after the status paints.
    setTimeout(() => {
      if (!pending || pending.id !== id) return;
      const out = runJob(job, () => {});
      pending = null;
      setProgress(null);
      finishBuild(out, { spec, label, head });
    }, 30);
  }
}

// ------------------------------------------------------------------ layout + render loop

let dirty = true;
function requestRender() { dirty = true; }

function layout() {
  const W = els.wrap.clientWidth, H = els.wrap.clientHeight;
  let w = W, h = H;
  const bd = backdrop();
  if (bd) {
    const a = bd.w / bd.h;
    w = Math.min(W, H * a);
    h = w / a;
    els.viewport.classList.add('photo');
  } else {
    els.viewport.classList.remove('photo');
  }
  els.viewport.style.width = `${w}px`;
  els.viewport.style.height = `${h}px`;
  renderer.setSize(w, h, false);
  studioCam.aspect = w / h;
  studioCam.updateProjectionMatrix();
  photoCam.aspect = w / h;
  photoCam.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(layout).observe(els.wrap);

controls.addEventListener('change', requestRender);
function frame() {
  if (state.mode === 'studio' && controls.update()) dirty = true;
  if (dirty) {
    dirty = false;
    renderer.render(scene, backdrop() ? photoCam : studioCam);
  }
  requestAnimationFrame(frame);
}

const VIEWS = {
  front: [0, 0.02, 0.78],
  three: [0.44, 0.07, 0.62],
  side: [0.78, 0.04, -0.03],
  back: [-0.12, 0.08, -0.78],
};
function setView(v) {
  state.view = v;
  const p = VIEWS[v];
  studioCam.position.set(TARGET.x + p[0], TARGET.y + p[1], TARGET.z + p[2]);
  controls.update();
  for (const b of els.views.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  requestRender();
}

// ------------------------------------------------------------------ UI

let readyStatus = '';
function setStatus(text, { ready = false } = {}) {
  els.status.textContent = text;
  if (ready) readyStatus = text;
}

let noticeTimer = 0;
function showNotice(text, { kind = 'info', title = '', sticky = false } = {}) {
  clearTimeout(noticeTimer);
  els.banner.hidden = false;
  els.banner.className = `banner${kind === 'info' ? ' info' : ''}`;
  els.banner.innerHTML = '';
  const body = document.createElement('div');
  if (title) {
    const s = document.createElement('strong');
    s.textContent = title + ' ';
    body.append(s);
  }
  body.append(document.createTextNode(text));
  els.banner.append(body);
  els.banner.dataset.kind = kind;
  if (!sticky) noticeTimer = setTimeout(() => { if (els.banner.dataset.kind === kind) els.banner.hidden = true; }, 6000);
}
function hideNotice(kind) {
  if (!kind || els.banner.dataset.kind === kind) els.banner.hidden = true;
}

function chip(label, sub, pressed, onClick, { locked = false, offered = false } = {}) {
  const b = document.createElement('button');
  b.className = `chip${locked ? ' locked' : ''}`;
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  // The accessible name is the visible text plus a hidden note, so voice control ("click Waist") matches what is shown.
  const note = (text) => { const s = document.createElement('span'); s.className = 'sr-only'; s.textContent = text; return s; };
  if (locked) {
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
    b.dataset.locked = 'true';
  }
  if (offered) {
    const dot = document.createElement('span');
    dot.className = 'offered';
    dot.setAttribute('aria-hidden', 'true');
    b.append(dot);
  }
  b.append(document.createTextNode(label));
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    b.append(document.createTextNode(' '), s);
  }
  if (locked) b.append(note(', needs a body capture'));
  if (offered) b.append(note(', offered by this salon'));
  b.addEventListener('click', onClick);
  return b;
}

function renderControls() {
  const style = T.styleById(state.look.style);
  els.styles.replaceChildren(...T.STYLES.map((s) => chip(s.name, '', s.id === style.id, () => {
    state.look = { ...state.look, style: s.id, size: s.defaultSize, length: s.defaultLength };
    renderControls();
    scheduleBuild();
  }, { offered: consult ? consult.isOffered(s.id) : false })));
  els.styleBlurb.textContent = style.blurb;

  const size = T.sizeOf(style, state.look.size);
  els.sizes.replaceChildren(...style.sizes.map((z) => chip(z.label, z.rows ? `${(z.width * 100).toFixed(1)} cm` : `${(z.width * 100).toFixed(1)} cm`, z.id === size.id, () => {
    state.look = { ...state.look, size: z.id };
    renderControls();
    scheduleBuild();
  })));
  els.sizeVal.textContent = style.kind === 'cornrows' ? `${size.rows} rows` : `${(size.width * 100).toFixed(1)} cm parts`;

  const len = T.lengthById(state.look.length);
  els.lengths.replaceChildren(...T.LENGTHS.map((l) => chip(l.label, `${Math.round(l.length * 100)} cm`, l.id === len.id, () => {
    if (l.requiresBody) {
      showNotice(T.CATALOG.lockedLengthMessage.replace('{label}', l.label), { kind: 'locked' });
      return;
    }
    state.look = { ...state.look, length: l.id };
    renderControls();
    scheduleBuild();
  }, { locked: !!l.requiresBody })));
  els.lengthVal.textContent = `${Math.round(len.length * 100)} cm ${style.kind === 'cornrows' ? 'tails' : 'below the part'}`;

  const color = T.colorById(state.look.color);
  els.colors.replaceChildren(...T.COLORS.map((c) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.type = 'button';
    b.title = `${c.label} ${c.name}`;
    b.setAttribute('aria-label', `Colour ${c.label}, ${c.name}`);
    b.setAttribute('aria-pressed', String(c.id === color.id));
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = c.tipHex ? `linear-gradient(180deg, ${c.hex} 0 38%, ${c.tipHex})` : c.hex;
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = c.label;
    b.append(dot, code);
    b.addEventListener('click', () => {
      state.look = { ...state.look, color: c.id };
      renderControls();
      recolor();
    });
    return b;
  }));
  els.colorVal.textContent = color.name;

  els.tones.replaceChildren(...T.SKIN_TONES.map((t) => {
    const b = document.createElement('button');
    b.className = 'tone';
    b.type = 'button';
    b.style.background = t.hex;
    b.setAttribute('aria-label', `Monk skin tone ${t.label}`);
    b.setAttribute('aria-pressed', String(t.id === state.skinTone));
    b.addEventListener('click', () => { state.skinTone = t.id; renderControls(); applySkin(); });
    return b;
  }));

  els.caption.textContent = T.caption(state.look);
  if (consult) consult.lookChanged();
  if (extras) extras.lookChanged();
}

// ------------------------------------------------------------------ modes

/** Show the bust, the photo or the camera picture behind the style, to match the mode. */
function syncBackdrop() {
  const shown = !!backdrop();
  els.photo.hidden = !(state.mode === 'photo' && state.photo);
  els.cam.hidden = !(state.mode === 'live' && state.live);
  els.overlay.hidden = !shown;
  els.compare.hidden = !shown;
  els.viewport.classList.toggle('mirror', state.mode === 'live' && !!state.live);
  mannequin.visible = !shown;
  occluders.visible = shown;
  syncHairVisible();
  if (!shown) { rig.matrix.identity(); rig.matrixWorldNeedsUpdate = true; }
  layout();
}

function setMode(mode) {
  if (state.mode === 'live' && mode !== 'live') stopLive();
  state.mode = mode;
  els.modeStudio.setAttribute('aria-pressed', String(mode === 'studio'));
  els.modePhoto.setAttribute('aria-pressed', String(mode === 'photo'));
  els.modeLive.setAttribute('aria-pressed', String(mode === 'live'));
  els.photoPick.hidden = mode !== 'photo';
  els.livePick.hidden = mode !== 'live';
  els.skinSec.hidden = mode !== 'studio';
  els.fitSec.hidden = !(mode === 'photo' && state.photo);
  els.views.hidden = mode !== 'studio';
  controls.enabled = mode === 'studio';
  hideNotice('conflict');
  syncBackdrop();
  if (mode === 'photo' && state.photo) applyPose();
  // The bust uses the standard hairline; a photo or the camera uses the one matched from it.
  const hairline = mode === 'photo' && state.photo && state.analysis ? (state.analysis.hairline ?? null) : mode === 'live' ? state.liveHairline : null;
  if (hairline !== state.hairlineFront || (mode === 'live') !== builtSim) {
    state.hairlineFront = hairline;
    scheduleBuild();
  }
  if (mode === 'photo' && !state.photo) showNotice('Choose a photo to see the style on you. It never leaves this tab.', { kind: 'info' });
  if (mode === 'live' && !live.running) showNotice('Turn on the camera to see the style move with you. Nothing is recorded or sent.', { kind: 'info' });
}

// ------------------------------------------------------------------ photo pipeline

const ASSET = (p) => new URL(p, document.baseURI).href;
const MP = (f) => ASSET(`mediapipe/${f}`); // MediaPipe Tasks Vision, served from this page's own files

/** Fetch a model shipped as {sha256, base64}, decode it, and refuse it unless the hash matches. */
async function loadModel(rel) {
  const res = await fetch(ASSET(rel));
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  const { sha256, base64 } = await res.json();
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const got = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  if (got !== sha256) throw new Error(`${rel}: SHA-256 mismatch`);
  return bytes;
}

async function loadVision() {
  if (state.vision) return state.vision;
  setStatus('Loading face and hair models…');
  try {
    // The library, its wasm binary and the models are all this page's own files: no other host is contacted.
    const vision = await import(MP('vision_bundle.js'));
    const fileset = { wasmLoaderPath: MP('vision_wasm_internal.js'), wasmBinaryPath: MP('vision_wasm_internal.wasm') };
    const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('model load timed out')), ms));
    const [faceModel, hairModel] = await Promise.all([loadModel('models/face_landmarker.json'), loadModel('models/hair_segmenter.json')]);
    const face = await Promise.race([vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: faceModel, delegate: 'CPU' },
      runningMode: 'IMAGE', numFaces: 1, outputFacialTransformationMatrixes: true,
    }), timeout(30000)]);
    const hair = await Promise.race([vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: hairModel, delegate: 'CPU' },
      runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
    }), timeout(30000)]);
    state.vision = { face, hair, lib: vision, fileset, timeout };
  } catch (err) {
    console.warn('MediaPipe unavailable:', err);
    state.vision = { error: String(err && err.message ? err.message : err) };
  }
  return state.vision;
}

async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    showNotice('That file could not be opened as an image. Try a JPEG or PNG.', { kind: 'error' });
    return;
  }
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  if (state.photo) URL.revokeObjectURL(state.photo.url);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  state.photo = { canvas, w, h, url: URL.createObjectURL(blob) };
  els.photo.src = state.photo.url;
  els.photoBtnLabel.textContent = 'Choose a different photo';
  state.fit = { x: 0, y: 0, s: 1, r: 0, t: 0 };
  syncFitInputs();
  state.analysis = null;
  state.manual = false;
  setMode('photo');
  await analyzePhoto();
}

/** Front hairline (radians on the scalp proxy) from a pose matrix and a hair mask, or null. */
function estimateHairline(matrix, hair, w, h) {
  return T.estimateHairlineFront(BASE_HEAD, (p) => {
    const cam = T.applyMat(matrix, [p[0] * 100, p[1] * 100, p[2] * 100]);
    const [px, py] = T.projectToPixels(cam, w, h);
    return [px / w, py / h];
  }, (u, vv) => {
    const x = Math.min(hair.w - 1, Math.max(0, Math.floor(u * hair.w)));
    const y = Math.min(hair.h - 1, Math.max(0, Math.floor(vv * hair.h)));
    return hair.probs[y * hair.w + x];
  });
}

async function analyzePhoto() {
  const { canvas, w, h } = state.photo;
  const v = await loadVision();
  let matrix = null, landmarks = null, hair = null;
  if (!v.error) {
    try {
      setStatus('Finding your face…');
      const r = v.face.detect(canvas);
      if (r.faceLandmarks && r.faceLandmarks.length && r.facialTransformationMatrixes && r.facialTransformationMatrixes.length) {
        matrix = Array.from(r.facialTransformationMatrixes[0].data);
        landmarks = r.faceLandmarks[0];
      }
      setStatus('Finding your hair…');
      const seg = v.hair.segment(canvas);
      const masks = seg.confidenceMasks || [];
      const m = masks[masks.length > 1 ? 1 : 0];
      if (m) hair = { probs: m.getAsFloat32Array().slice(), w: m.width, h: m.height };
      for (const mm of masks) mm.close();
      if (seg.close) seg.close();
    } catch (err) {
      console.warn('analysis failed', err);
    }
  }
  if (!matrix) {
    state.manual = true;
    matrix = T.manualPose({ cx: w / 2, cy: h * 0.42, headWidthPx: w * 0.36 }, w, h);
    els.fitHint.textContent = 'Drag on the photo to move the hair onto your head. Use Size, Tilt and Turn to match.';
    showNotice(v.error
      ? 'Automatic face fitting is not available in this browser, so place the style by hand: drag it onto your head and adjust the size.'
      : 'No face was found in this photo. Drag the style onto your head and adjust the size, or try a brighter, front-facing photo.',
    { kind: 'info', title: 'Place it by hand.', sticky: true });
  } else {
    els.fitHint.textContent = 'Fitted to your face automatically. Drag on the photo or use these to fine-tune.';
    hideNotice();
  }
  const reprojPx = landmarks ? T.reprojectionError(matrix, FACE_VERTICES.map((p) => [p[0] * 100, p[1] * 100, p[2] * 100]), landmarks, w, h) : null;
  state.analysis = { matrix, landmarks, hair, reprojPx };
  const hairline = hair && !state.manual ? estimateHairline(matrix, hair, w, h) : null;
  state.analysis.hairline = hairline;
  if (readyStatus) setStatus(readyStatus);
  document.body.dataset.fit = state.manual ? 'manual' : 'auto';
  document.body.dataset.hairline = hairline === null ? 'default' : hairline.toFixed(3);
  els.fitSec.hidden = false;
  applyPose();
  if (hairline !== state.hairlineFront) {
    state.hairlineFront = hairline;
    scheduleBuild();
  } else {
    scheduleConflict();
  }
}

function poseMatrix() {
  const base = new THREE.Matrix4().fromArray(state.analysis.matrix);
  const depth = -state.analysis.matrix[14];
  const f = state.fit;
  const shift = new THREE.Matrix4().makeTranslation(f.x * depth / 60, f.y * depth / 60, 0);
  const rot = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(f.r))
    .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(f.t)));
  const scale = new THREE.Matrix4().makeScale(f.s * 100, f.s * 100, f.s * 100);
  return shift.multiply(base).multiply(rot).multiply(scale);
}

function applyPose() {
  if (!state.analysis) return;
  rig.matrix.copy(poseMatrix());
  rig.matrixWorldNeedsUpdate = true;
  requestRender();
  scheduleConflict();
}

function syncFitInputs() {
  for (const k of Object.keys(els.fit)) els.fit[k].value = String(state.fit[k]);
}
for (const k of Object.keys(els.fit)) {
  els.fit[k].addEventListener('input', () => { state.fit[k] = Number(els.fit[k].value); applyPose(); });
}
els.fitReset.addEventListener('click', () => { state.fit = { x: 0, y: 0, s: 1, r: 0, t: 0 }; syncFitInputs(); applyPose(); });

// Drag to move in photo mode. f.x/f.y are in "depth/60" units so a slider step
// is ~1 mm at a normal selfie distance; convert pixels at the head's depth.
let drag = null;
els.viewport.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'photo' || !state.analysis) return;
  drag = { x: e.clientX, y: e.clientY, fx: state.fit.x, fy: state.fit.y };
  els.viewport.setPointerCapture(e.pointerId);
});
els.viewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const hPx = els.viewport.clientHeight;
  const f = 1 / Math.tan(THREE.MathUtils.degToRad(T.MP_VERTICAL_FOV / 2));
  const perPx = 60 / (f * hPx / 2); // fit units per pixel at the head's depth
  state.fit.x = THREE.MathUtils.clamp(drag.fx + (e.clientX - drag.x) * perPx, -12, 12);
  state.fit.y = THREE.MathUtils.clamp(drag.fy - (e.clientY - drag.y) * perPx, -12, 12);
  syncFitInputs();
  applyPose();
});
const endDrag = () => { drag = null; };
els.viewport.addEventListener('pointerup', endDrag);
els.viewport.addEventListener('pointercancel', endDrag);

// ------------------------------------------------------------------ live mirror

const SCALE100 = new THREE.Matrix4().makeScale(100, 100, 100);
let wantHairline = false;
let simCostMs = 0;

/** A second FaceLandmarker in VIDEO mode (the photo one stays in IMAGE mode), from the same model. */
async function loadLiveTasks() {
  const v = await loadVision();
  if (v.error) throw new Error(v.error);
  if (!v.faceVideo) {
    v.faceVideo = await Promise.race([v.lib.FaceLandmarker.createFromOptions(v.fileset, {
      baseOptions: { modelAssetBuffer: await loadModel('models/face_landmarker.json'), delegate: 'CPU' },
      runningMode: 'VIDEO', numFaces: 1, outputFacialTransformationMatrixes: true,
    }), v.timeout(30000)]);
  }
  if (readyStatus) setStatus(readyStatus);
  return { face: v.faceVideo, hair: v.hair };
}

function setLiveStatus(status) {
  state.liveStatus = status;
  document.body.dataset.live = status;
  els.liveStart.textContent = live.streaming ? 'Turn off the camera' : 'Turn on the camera';
  els.liveHairline.hidden = !live.streaming;
  if (status === 'lost' && state.live) showNotice('Face the camera so the style can find your head.', { kind: 'live', sticky: true });
  if (status === 'tracking') hideNotice('live');
  syncHairVisible();
  requestRender();
}

function onLivePose({ matrix, raw, dt, w, h }) {
  if (state.mode !== 'live') return;
  if (!state.live || state.live.w !== w || state.live.h !== h) {
    state.live = { w, h };
    syncBackdrop();
  }
  state.liveAnalysis.matrix = matrix;
  state.liveAnalysis.raw = raw;
  rig.matrix.fromArray(matrix).multiply(SCALE100);
  rig.matrixWorldNeedsUpdate = true;
  if (sim && hairMesh) {
    const t0 = performance.now();
    const pose = poseFromMatrix(matrix);
    if (!simPlaced) { sim.settle(pose, 1.0); simPlaced = true; } else sim.advance(pose, dt);
    const pos = hairMesh.geometry.getAttribute('position'), nrm = hairMesh.geometry.getAttribute('normal');
    sim.skin(pos.array, nrm.array);
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    // Governor: if the solver alone eats the frame, take fewer steps (hair moves a little heavier).
    simCostMs += 0.1 * ((performance.now() - t0) - simCostMs);
    if (simCostMs > 12 && sim.params.maxStepsPerAdvance > 1) { sim.params.maxStepsPerAdvance--; simCostMs = 6; }
  }
  requestRender();
}

function onLiveHair(hair, rawMatrix) {
  if (state.mode !== 'live' || !state.live) return;
  state.liveAnalysis.hair = hair;
  state.liveAnalysis.hairMatrix = rawMatrix;
  if (wantHairline) {
    wantHairline = false;
    const hl = estimateHairline(rawMatrix, hair, state.live.w, state.live.h);
    document.body.dataset.hairline = hl === null ? 'default' : hl.toFixed(3);
    if (hl === null) {
      showNotice('Your hairline was not clear enough to match. Pull your hair back or wear a wrap, face the camera in even light, and try again.', { kind: 'info' });
    } else {
      state.liveHairline = hl;
      state.hairlineFront = hl;
      showNotice('The style now starts at your hairline (good to about a centimetre).', { kind: 'info', title: 'Hairline matched.' });
      scheduleBuild();
    }
  }
  scheduleConflict();
}

const live = createLive({
  video: els.cam,
  loadTasks: loadLiveTasks,
  onPose: onLivePose,
  onLost: () => { simPlaced = false; },
  onHair: onLiveHair,
  onState: (st) => setLiveStatus(st),
});

async function startLive() {
  els.liveStart.disabled = true;
  setStatus('Starting the camera…');
  const r = await live.start();
  els.liveStart.disabled = false;
  if (readyStatus) setStatus(readyStatus);
  if (!r.ok) {
    if (r.message) showNotice(r.message, { kind: 'error', title: 'Camera unavailable.', sticky: true });
    setLiveStatus('error');
    return;
  }
  hideNotice();
  setLiveStatus(state.liveStatus);
}

function stopLive() {
  live.stop();
  state.live = null;
  state.liveAnalysis = { matrix: null, hair: null, hairMatrix: null };
  simPlaced = false;
  wantHairline = false;
  hideNotice('live');
  hideNotice('conflict');
  state.conflict = false;
  document.body.dataset.conflict = 'no';
}

els.liveStart.addEventListener('click', () => {
  if (live.streaming) { stopLive(); syncBackdrop(); } else startLive();
});
els.liveHairline.addEventListener('click', () => {
  if (state.liveStatus !== 'tracking') { showNotice('Face the camera first, then match your hairline.', { kind: 'info' }); return; }
  wantHairline = true;
  live.requestHair();
  showNotice('Hold still for a moment…', { kind: 'info' });
});
// The camera never stays on behind the user's back: leaving the tab turns it off.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && live.streaming) { stopLive(); syncBackdrop(); showNotice('The camera was turned off because you left this tab.', { kind: 'info' }); }
});
window.addEventListener('pagehide', () => { if (live.streaming) live.stop(); });

// Hold to compare: hide the style while the button is held (photo and live mirror).
function setComparing(on) {
  comparing = on;
  els.compare.setAttribute('aria-pressed', String(on));
  syncHairVisible();
  requestRender();
}
els.compare.addEventListener('pointerdown', (e) => { els.compare.setPointerCapture(e.pointerId); setComparing(true); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) els.compare.addEventListener(ev, () => setComparing(false));
els.compare.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); setComparing(true); } });
els.compare.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') setComparing(false); });

// ------------------------------------------------------------------ honest preview

let conflictTimer = 0;
function scheduleConflict() {
  clearTimeout(conflictTimer);
  conflictTimer = setTimeout(checkConflict, 60);
}

const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
function silhouette(objects, mw, mh) {
  const rt = new THREE.WebGLRenderTarget(mw, mh);
  const saved = new Map();
  rig.traverse((o) => { if (o.isMesh) saved.set(o, [o.visible, o.material]); });
  for (const o of saved.keys()) o.visible = false;
  for (const [o, mat] of objects) { o.visible = true; o.material = mat; }
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearAlpha();
  const prevMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, photoCam);
  const px = new Uint8Array(mw * mh * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, mw, mh, px);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(0x000000, prevClear);
  renderer.toneMapping = prevMapping;
  for (const [o, [vis, mat]] of saved) { o.visible = vis; o.material = mat; }
  rt.dispose();
  const out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) out[(mh - 1 - y) * mw + x] = px[4 * (y * mw + x)] > 127 ? 1 : 0;
  return out;
}

function checkConflict() {
  const bd = backdrop(), an = analysis();
  if (!bd || !an || !an.matrix || !hairMesh) return;
  if (state.mode === 'live' && state.liveStatus !== 'tracking') return;
  const hair = an.hair;
  if (!hair) { document.body.dataset.conflict = 'unknown'; return; }
  const [mw, mh] = T.maskSize(bd.w, bd.h, 256);
  const aspect = photoCam.aspect;
  const wasVisible = hairMesh.visible;
  photoCam.aspect = bd.w / bd.h;
  photoCam.updateProjectionMatrix();
  const occ = occluders.children.map((o) => [o, occluderMat]);
  const styleMask = T.dilate(silhouette([[hairMesh, whiteMat], ...occ], mw, mh), mw, mh, T.closingRadius(mw, mh));
  const headMask = silhouette(occluders.children.map((o) => [o, whiteMat]), mw, mh);
  photoCam.aspect = aspect;
  photoCam.updateProjectionMatrix();
  hairMesh.visible = wasVisible;
  const probs = T.resampleMask(hair.probs, hair.w, hair.h, mw, mh);
  let headArea = 0;
  for (let i = 0; i < headMask.length; i++) headArea += headMask[i];
  const m = T.measureConflict(probs, styleMask, mw, mh, headArea);
  state.lastMeasure = m;
  state.conflict = T.updateConflict(state.conflict, m);
  document.body.dataset.conflict = state.conflict ? 'yes' : 'no';
  document.body.dataset.conflictRatio = m.ratio.toFixed(3);
  drawOverlay(probs, styleMask, mw, mh);
  if (state.conflict) showNotice(T.conflictTip(m), { kind: 'conflict', title: 'Your own hair would still show.', sticky: true });
  else hideNotice('conflict');
  requestRender();
}

function drawOverlay(probs, styleMask, mw, mh) {
  const c = els.overlay;
  c.width = mw;
  c.height = mh;
  const g = c.getContext('2d');
  const img = g.createImageData(mw, mh);
  if (state.conflict) {
    for (let i = 0; i < mw * mh; i++) {
      if (probs[i] >= T.HONESTY.maskThreshold && !styleMask[i]) {
        img.data[4 * i] = 245; img.data[4 * i + 1] = 158; img.data[4 * i + 2] = 11; img.data[4 * i + 3] = 150;
      }
    }
  }
  g.putImageData(img, 0, 0);
}

// ------------------------------------------------------------------ capture

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function wrapText(g, text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

let captureBlob = null;
let captureSource = null; // 'photo' (may show the customer) or 'studio' (the 3D bust)
async function capture() {
  const bd = backdrop();
  renderer.render(scene, bd ? photoCam : studioCam);
  const src = renderer.domElement;
  const w = src.width, h = src.height;
  const pad = Math.round(w * 0.04);
  const fontPx = Math.max(15, Math.round(w * 0.028));
  const out = document.createElement('canvas');
  const g = out.getContext('2d');
  g.font = `500 ${fontPx}px Figtree, system-ui, sans-serif`;
  const lines = wrapText(g, T.caption(state.look), w - 2 * pad);
  const band = pad * 2 + lines.length * fontPx * 1.35 + fontPx * 1.2;
  out.width = w;
  out.height = Math.round(h + band);
  if (state.mode === 'live' && bd) {
    // The mirror is shown flipped; the capture is flipped the same way so it matches what she saw.
    g.save();
    g.translate(w, 0);
    g.scale(-1, 1);
    g.drawImage(els.cam, 0, 0, w, h);
    g.drawImage(src, 0, 0, w, h);
    g.restore();
  } else if (bd) {
    g.drawImage(state.photo.canvas, 0, 0, w, h);
  } else {
    const grd = g.createRadialGradient(w / 2, h * 0.35, 0, w / 2, h * 0.35, Math.max(w, h) * 0.75);
    grd.addColorStop(0, cssVar('--stage-a'));
    grd.addColorStop(1, cssVar('--stage-b'));
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }
  if (state.mode !== 'live' || !bd) g.drawImage(src, 0, 0, w, h);
  g.fillStyle = cssVar('--surface');
  g.fillRect(0, h, w, band);
  g.fillStyle = cssVar('--ink');
  g.font = `500 ${fontPx}px Figtree, system-ui, sans-serif`;
  g.textBaseline = 'top';
  lines.forEach((l, i) => g.fillText(l, pad, h + pad + i * fontPx * 1.35));
  g.fillStyle = cssVar('--muted');
  g.font = `400 ${Math.round(fontPx * 0.72)}px "IBM Plex Mono", ui-monospace, monospace`;
  g.fillText('Preview from Braid Try-On Studio. Ask your stylist about hair amount and install time.', pad, h + pad + lines.length * fontPx * 1.35 + fontPx * 0.35);
  captureBlob = await new Promise((res) => out.toBlob(res, 'image/png'));
  captureSource = bd ? 'photo' : 'studio'; // a photo or camera capture may show the customer
  if (consult) consult.refresh();
  if (els.captureImg.src) URL.revokeObjectURL(els.captureImg.src);
  els.captureImg.src = URL.createObjectURL(captureBlob);
  els.captureHint.textContent = 'On a phone, press and hold the image to save it. On a computer, use Copy image.';
  if (typeof els.dialog.showModal === 'function') els.dialog.showModal(); else els.dialog.setAttribute('open', '');
}

els.capture.addEventListener('click', () => { capture().catch((e) => showNotice(`Capture failed: ${e.message}`, { kind: 'error' })); });
els.captureClose.addEventListener('click', () => els.dialog.close());
els.captureCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': captureBlob })]);
    els.captureHint.textContent = 'Image copied. Paste it into a message to your stylist.';
  } catch {
    els.captureHint.textContent = 'This browser blocked copying the image. Press and hold (or right-click) the image to save it instead.';
  }
});
els.copyCaption.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(T.caption(state.look));
    els.copyStatus.textContent = 'Description copied.';
  } catch {
    els.copyStatus.textContent = 'Copy was blocked here. Select the description above and copy it by hand.';
  }
});

// ------------------------------------------------------------------ boot

els.modeStudio.addEventListener('click', () => setMode('studio'));
els.modePhoto.addEventListener('click', () => setMode('photo'));
els.modeLive.addEventListener('click', () => setMode('live'));
els.photoInput.addEventListener('change', () => {
  const f = els.photoInput.files && els.photoInput.files[0];
  if (f) loadPhoto(f);
  els.photoInput.value = '';
});
for (const b of els.views.querySelectorAll('button')) b.addEventListener('click', () => setView(b.dataset.view));

// Pilot salon: validated at startup; a broken config falls back to "no salon" so the studio still works.
function loadSalon(raw) {
  const { config, errors, warnings } = validateSalonConfig(raw, T.CATALOG);
  for (const m of [...errors, ...warnings]) console.warn(`salon config: ${m}`);
  return errors.length ? NO_SALON : config;
}
let consult = null;
let extras = null;
const setLook = (look) => { state.look = { ...state.look, ...look }; renderControls(); scheduleBuild(); };
consult = createConsultation({
  getLook: () => ({ ...state.look }),
  setLook,
  getCapture: () => (captureBlob ? { blob: captureBlob, source: captureSource } : null),
  onNotice: (text) => showNotice(text, { kind: 'info' }),
});
consult.setSalon(loadSalon(salonConfigRaw));
consult.restoreSession();
document.body.dataset.salon = 'built-in';
extras = createExtras({ getLook: () => ({ ...state.look }), setLook });

// A link to a look (#look=...) opens on that look; it holds four catalog ids and nothing else.
function applyHashLook() {
  const linked = lookFromHash(window.location.hash);
  if (linked) { state.look = linked; document.body.dataset.linked = 'true'; }
  return !!linked;
}
applyHashLook();
window.addEventListener('hashchange', () => { if (applyHashLook()) { renderControls(); scheduleBuild(); } });

// The salon's settings can be changed without rebuilding: salon.config.json beside this page
// replaces the built-in copy (validated the same way). The setup page can also hand over an
// unsaved draft through this tab's session storage for a preview.
let salonLocked = false;
function applySalon(raw, source) {
  consult.setSalon(loadSalon(raw));
  document.body.dataset.salon = source;
  renderControls();
}
(async () => {
  try {
    const draft = window.sessionStorage.getItem('hairtryon.salonPreview.v1');
    if (draft) {
      applySalon(JSON.parse(draft), 'preview');
      showNotice('These are unsaved settings from the setup page. Customers see them only after you replace salon.config.json.', { kind: 'info', title: 'Salon preview.', sticky: true });
      return;
    }
  } catch { /* no draft */ }
  try {
    const res = await fetch(ASSET('salon.config.json'), { cache: 'no-cache' });
    if (res.ok && !salonLocked) applySalon(await res.json(), 'file');
  } catch { /* keep the built-in salon */ }
})().finally(() => { document.body.dataset.salonChecked = 'true'; });

// Installed copy: cache this page's own files so it opens and works with no connection.
if ('serviceWorker' in navigator && window.isSecureContext && /^https?:$/.test(window.location.protocol)) {
  navigator.serviceWorker.register(ASSET('sw.js')).then(() => navigator.serviceWorker.ready).then(() => {
    els.offlineNote.hidden = false;
    document.body.dataset.offline = 'ready';
  }).catch(() => { /* hosts that forbid service workers: the page still works online */ });
}

renderControls();
applySkin();
setView('three');
layout();
frame();
build();

// Test and debugging hooks (read-only views of state; no behaviour depends on them).
window.__tryon = {
  state, T, BASE_HEAD,
  setLook,
  loadPhotoBlob: (blob) => loadPhoto(blob),
  // Pilot tests: swap the salon config (validated exactly as at startup) and read the current card.
  setSalonConfig: (raw) => { salonLocked = true; applySalon(raw, 'test'); },
  get live() { return { status: state.liveStatus, size: state.live, stats: live.stats, streaming: live.streaming, simSteps: sim ? sim.stepCount : 0, maxSpeed: sim ? sim.maxSpeed : 0, hairline: state.liveHairline }; },
  get sim() { return sim; },
  get hairVisible() { return !!(hairMesh && hairMesh.visible); },
  get rigMatrix() { return Array.from(rig.matrix.elements); },
  openCardText: (text) => extras.openCardText(text),
  get card() { return consult.card; },
  holeCount: parts.holeCount,
  // Render the studio view to a PNG (used by the end-to-end tests as a stand-in photo).
  // `selfie` renders like a phone front camera (63° vertical FOV, ~35 cm away), which is what
  // MediaPipe's pose assumes; the studio's 28° camera would not be a realistic photo.
  snapshot: (withHair = true, { selfie = true, closeCropped = false, yaw = 0, type = 'image/png' } = {}) => new Promise((res) => {
    const vis = hairMesh ? hairMesh.visible : false;
    if (hairMesh) hairMesh.visible = withHair;
    closeCrop.material.color.copy(skinMat.color);
    closeCrop.visible = closeCropped;
    let cam = studioCam;
    if (selfie) {
      cam = new THREE.PerspectiveCamera(T.MP_VERTICAL_FOV, studioCam.aspect, 0.01, 10);
      cam.position.set(0, 0.0, 0.42);
      cam.lookAt(0, -0.03, 0);
    }
    rig.matrix.makeRotationY(yaw);
    rig.matrixWorldNeedsUpdate = true;
    renderer.render(scene, cam);
    rig.matrix.identity();
    rig.matrixWorldNeedsUpdate = true;
    const c = document.createElement('canvas');
    c.width = els.gl.width;
    c.height = els.gl.height;
    const g = c.getContext('2d');
    g.fillStyle = '#d9d3d6';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(els.gl, 0, 0);
    if (hairMesh) hairMesh.visible = vis;
    closeCrop.visible = false;
    requestRender();
    c.toBlob(res, type, 0.9);
  }),
};
