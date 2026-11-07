// Unit tests for the try-on logic: catalog, colour, honesty check, captions,
// camera convention, hairline estimate, head fit, and mesh tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as T from '../src/tryon.js';
import { fitHead, faceCoverage } from '../src/headfit.js';
import { FACE_VERTICES, FACE_TRIANGLES } from '../src/canonical-face.js';
import { HeadProxy, generate, makeSpec } from '../src/protostyle.js';
import { boundaryLoops, orientOutward, rayMeshDistance } from '../src/mesh-tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = JSON.parse(readFileSync(path.join(here, 'fixtures', 'mp_face_probe.json'), 'utf8'));
const canonicalCm = FACE_VERTICES.map((p) => p.map((v) => v * 100));

// ---------------------------------------------------------------- catalog

test('T01 catalog: every style has sizes, defaults resolve, ids unique', () => {
  const ids = new Set();
  for (const s of T.STYLES) {
    assert.ok(!ids.has(s.id)); ids.add(s.id);
    assert.ok(s.sizes.length >= 3);
    assert.ok(T.sizeOf(s, s.defaultSize));
    assert.ok(T.lengthById(s.defaultLength));
    for (const z of s.sizes) assert.ok(z.width >= 0.004 && z.width <= 0.06, `${s.id}/${z.id}`);
    if (s.kind === 'cornrows') for (const z of s.sizes) assert.ok(z.rows >= 2 && z.rows <= 24);
  }
  assert.equal(new Set(T.COLORS.map((c) => c.id)).size, T.COLORS.length);
  assert.ok(T.colorById(T.CATALOG.defaults.color));
  assert.equal(T.SKIN_TONES.length, 10);
});

test('T02 every unlocked look builds a valid spec; body lengths are locked with the catalog message', () => {
  for (const s of T.STYLES) for (const z of s.sizes) for (const l of T.LENGTHS) {
    const r = T.specForLook({ style: s.id, size: z.id, length: l.id, color: '1B' });
    if (l.requiresBody) {
      assert.equal(r.ok, false);
      assert.ok(r.locked);
      assert.match(r.message, new RegExp(`^${l.label} length needs a body capture`));
      assert.match(r.message, /Armpit length is the longest available/);
    } else {
      assert.ok(r.ok, `${s.id}/${z.id}/${l.id}`);
      assert.equal(r.spec.width, z.width);
      assert.equal(r.spec.length, l.length);
    }
  }
  const unlocked = T.specForLook({ style: 'box_braids', size: 'medium', length: 'waist' }, { hasBodyProxy: true });
  assert.ok(unlocked.ok && unlocked.spec.has_body_proxy);
});

test('T03 unlocked lengths stay under the oracle no-torso limit', () => {
  for (const l of T.LENGTHS.filter((x) => !x.requiresBody)) assert.ok(l.length <= 0.40);
  for (const l of T.LENGTHS.filter((x) => x.requiresBody)) assert.ok(l.length > 0.40);
});

test('T04 the Swift package reads the same catalog file', () => {
  const swift = readFileSync(path.join(here, '..', '..', 'ios', 'Packages', 'HairKit', 'Sources', 'TryOnCore', 'Catalog.swift'), 'utf8');
  assert.match(swift, /catalog", withExtension: "json"/);
});

// ---------------------------------------------------------------- colour

test('T05 colour: sRGB round trip, ombré runs root to tip, jitter is bounded and stable', () => {
  for (const c of [0, 0.02, 0.2, 0.5, 0.9, 1]) assert.ok(Math.abs(T.linearToSrgb(T.srgbToLinear(c)) - c) < 1e-9);
  const om = T.colorById('1B/613');
  const root = T.lookColor(om, 0), tip = T.lookColor(om, 1);
  assert.deepEqual(root, T.hexToSrgb(om.hex).map(T.srgbToLinear));
  tip.forEach((v, i) => assert.ok(Math.abs(v - T.srgbToLinear(T.hexToSrgb(om.tipHex)[i])) < 1e-12));
  assert.equal(T.ombreWeight(T.CATALOG.ombre.start), 0);
  assert.equal(T.ombreWeight(T.CATALOG.ombre.end), 1);
  for (let i = 0; i < 500; i++) {
    const j = T.strandJitter(i);
    assert.ok(j >= -1 && j <= 1);
    assert.equal(j, T.strandJitter(i));
  }
  const solid = T.colorById('1');
  assert.deepEqual(T.lookColor(solid, 0.1), T.lookColor(solid, 0.9));
});

// ---------------------------------------------------------------- honesty

test('T06 measureConflict: uncovered share, wrapped detection, threshold', () => {
  const w = 10, h = 10;
  const hair = new Float32Array(100), style = new Uint8Array(100);
  for (let i = 0; i < 40; i++) hair[i] = 0.9;   // 40 hair pixels
  for (let i = 0; i < 30; i++) style[i] = 1;    // style covers 30 of them
  const m = T.measureConflict(hair, style, w, h, 100);
  assert.equal(m.hairPx, 40);
  assert.equal(m.uncovered, 10);
  assert.equal(m.ratio, 0.25);
  assert.equal(m.wrapped, false);
  const bare = T.measureConflict(new Float32Array(100).fill(0.2), style, w, h, 100);
  assert.equal(bare.hairPx, 0);
  assert.equal(bare.wrapped, true);
});

test('T07 updateConflict has hysteresis (enter > 0.12, leave < 0.08) and ignores wrapped photos', () => {
  const m = (ratio, wrapped = false) => ({ ratio, wrapped });
  assert.equal(T.updateConflict(false, m(0.10)), false);
  assert.equal(T.updateConflict(false, m(0.13)), true);
  assert.equal(T.updateConflict(true, m(0.10)), true);
  assert.equal(T.updateConflict(true, m(0.07)), false);
  assert.equal(T.updateConflict(true, m(0.9, true)), false);
  assert.match(T.conflictTip({ ratio: 0.345 }), /About 35% of the hair in your photo/);
});

// ---------------------------------------------------------------- caption

test('T08 caption names style, size in cm, length and colour code', () => {
  assert.equal(T.caption({ style: 'knotless_braids', size: 'small', length: 'armpit', color: '1B/27' }),
    'Knotless braids, small (1.2 cm parts), armpit length, colour 1B/27 (off black to honey blonde)');
  assert.equal(T.caption({ style: 'cornrows', size: 'medium', length: 'shoulder', color: '1' }),
    'Cornrows, 10 rows, 1.8 cm braids, shoulder-length tails, colour 1 (jet black)');
});

// ---------------------------------------------------------------- camera convention

test('T09 MediaPipe pose matrix is column-major with a 63° vertical FOV (verified by reprojection)', () => {
  const { matrix, landmarks, w, h } = probe;
  const lm = landmarks.map(([x, y]) => ({ x, y }));
  const err = T.reprojectionError(matrix, canonicalCm, lm, w, h);
  assert.ok(err < 12, `column-major reprojection ${err.toFixed(2)} px`);
  const rowMajor = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15].map((i) => matrix[i]);
  assert.ok(T.reprojectionError(rowMajor, canonicalCm, lm, w, h) > 10 * err, 'row-major must be far worse');
  assert.ok(T.reprojectionError(matrix, canonicalCm, lm, w, h, 45) > 3 * err, '45° FOV must be worse');
});

test('T10 manualPose places the face where asked, at the asked size', () => {
  const w = 800, h = 1000;
  const m = T.manualPose({ cx: 300, cy: 420, headWidthPx: 280 }, w, h);
  const [px, py] = T.projectToPixels(T.applyMat(m, [0, 0, 0]), w, h);
  assert.ok(Math.abs(px - 300) < 1e-6 && Math.abs(py - 420) < 1e-6);
  const l = T.projectToPixels(T.applyMat(m, [-7.65, 0, 0]), w, h), r = T.projectToPixels(T.applyMat(m, [7.65, 0, 0]), w, h);
  assert.ok(Math.abs(r[0] - l[0] - 280) < 1e-6);
  const rolled = T.manualPose({ cx: 300, cy: 420, headWidthPx: 280, rollDeg: 20, yawDeg: -15 }, w, h);
  const R = [[rolled[0], rolled[4], rolled[8]], [rolled[1], rolled[5], rolled[9]], [rolled[2], rolled[6], rolled[10]]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const d = R[0][i] * R[0][j] + R[1][i] * R[1][j] + R[2][i] * R[2][j];
    assert.ok(Math.abs(d - (i === j ? 1 : 0)) < 1e-12, 'rotation is orthonormal');
  }
});

test('T18 hairline: a part line running down the meridian does not stop the estimate early', () => {
  const head = fitHead(FACE_VERTICES);
  const { project, sample } = syntheticPhoto(head, 1.0);
  // Cornrow-style parts: thin vertical skin stripes through the hair, on every meridian's x.
  const parted = (u, v) => (Math.abs(((u - 0.5) * 100) % 3) < 0.6 ? 0.02 : sample(u, v));
  const est = T.estimateHairlineFront(head, project, parted);
  assert.ok(est !== null && Math.abs(est - 1.0) < 0.03, `estimate ${est}`);
});

test('T19 dilate closes gaps between strands and leaves far pixels alone', () => {
  const w = 9, h = 1;
  const m = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(T.dilate(m, w, h, 2)), [1, 1, 1, 1, 1, 1, 1, 0, 0]);
  assert.equal(T.closingRadius(256, 192), 3);
  const sq = new Uint8Array(25); sq[12] = 1;
  assert.equal(T.dilate(sq, 5, 5, 1).reduce((a, b) => a + b, 0), 9);
});

test('T11 mask helpers', () => {
  assert.deepEqual(T.maskSize(1600, 1200, 256), [256, 192]);
  assert.deepEqual(Array.from(T.threshold([0.2, 0.5, 0.9])), [0, 1, 1]);
  const src = Uint8Array.from([1, 0, 0, 1]);
  assert.deepEqual(Array.from(T.resampleMask(src, 2, 2, 4, 4)), [1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);
});

// ---------------------------------------------------------------- hairline from a photo

function syntheticPhoto(head, trueFront) {
  // Orthographic front view: u = x, v = -y (both scaled to 0..1); hair where the
  // point is above the true hairline curve on the scalp.
  const truth = head.with({ hairline_front: trueFront });
  const project = (p) => [0.5 + p[0] * 3, 0.5 - p[1] * 3];
  const sample = (u, v) => {
    const x = (u - 0.5) / 3, y = (0.5 - v) / 3;
    // find the scalp point with this x, y on the front of the head
    const dx = (x - head.cx) / head.rx, dy = (y - head.cy) / head.ry;
    const r2 = dx * dx + dy * dy;
    if (r2 >= 1) return 0;
    const p = [x, y, head.cz + head.rz * Math.sqrt(1 - r2)];
    const [th, ph] = truth.thetaPhiOf(p);
    return truth.insideHairline(th, ph) ? 0.95 : 0.05;
  };
  return { project, sample };
}

test('T12 estimateHairlineFront recovers a known hairline and inverts the hairline curve', () => {
  const head = fitHead(FACE_VERTICES);
  for (const truth of [0.9, 0.98, 1.08]) {
    const { project, sample } = syntheticPhoto(head, truth);
    const est = T.estimateHairlineFront(head, project, sample);
    assert.ok(est !== null && Math.abs(est - truth) < 0.02, `truth ${truth} est ${est}`);
  }
  for (const phi of [-0.4, 0, 0.3]) {
    const th = head.with({ hairline_front: 1.02 }).hairlineTheta(phi);
    assert.ok(Math.abs(T.frontEquivalent(head, th, phi) - 1.02) < 1e-12);
  }
});

test('T13 estimateHairlineFront refuses when there is no hair (wrap) or only noise', () => {
  const head = fitHead(FACE_VERTICES);
  const { project } = syntheticPhoto(head, 1.0);
  assert.equal(T.estimateHairlineFront(head, project, () => 0.0), null);
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 > 0.5 ? 0.9 : 0.1);
  const est = T.estimateHairlineFront(head, project, noise);
  assert.ok(est === null || (est >= 0.84 && est <= 1.16), 'noise never escapes the clamp');
});

// ---------------------------------------------------------------- head fit

test('T14 fitHead on the canonical face: plausible head, face fully protected, front hairline on the forehead top', () => {
  const head = fitHead(FACE_VERTICES);
  assert.ok(head.rx > 0.07 && head.rx < 0.09);
  assert.ok(head.ry > 0.09 && head.ry < 0.11);
  assert.equal(faceCoverage(head, FACE_VERTICES), 1);
  assert.ok(faceCoverage(new HeadProxy(), FACE_VERTICES) < 1, 'defaults leave part of this face exposed');
  const top = FACE_VERTICES.reduce((a, b) => (b[1] > a[1] ? b : a));
  const hp = head.point(head.hairline_front, 0);
  assert.ok(Math.abs(hp[1] - top[1]) < 1e-9 && Math.abs(hp[2] - top[2]) < 1e-9);
});

test('T15 fitHead scales with the face and honours presets and calibration', () => {
  const big = FACE_VERTICES.map((p) => p.map((v) => v * 1.1));
  const a = fitHead(FACE_VERTICES), b = fitHead(big);
  assert.ok(Math.abs(b.rx / a.rx - 1.1) < 0.01);
  assert.ok(Math.abs(b.ry / a.ry - 1.1) < 1e-9);
  const ar = fitHead(FACE_VERTICES, { preset: 'arkit' });
  assert.ok(ar.ry > a.ry, 'ARKit preset raises the forehead top');
  assert.equal(fitHead(FACE_VERTICES, { hairline: { hairline_front: 1.05 } }).hairline_front, 1.05);
  assert.throws(() => fitHead([[0, 0, 0]]), /face mesh/);
  assert.throws(() => fitHead(FACE_VERTICES, { preset: 'nope' }), /preset/);
});

test('T16 every style on the fitted canonical head keeps hair off the eyes, nose and mouth', () => {
  const head = fitHead(FACE_VERTICES);
  const features = [33, 133, 159, 263, 362, 386, 1, 4, 13, 14, 61, 291].map((i) => FACE_VERTICES[i]);
  for (const kind of ['box_braids', 'knotless_braids', 'two_strand_twists', 'locs', 'cornrows']) {
    const r = generate(makeSpec(kind), head, { includeLOD0: false });
    let min = Infinity;
    for (const s of r.strands) for (const p of s.centerline) for (const f of features) {
      min = Math.min(min, Math.hypot(p[0] - f[0], p[1] - f[1], p[2] - f[2]));
    }
    assert.ok(min > 0.03, `${kind}: hair centreline ${(min * 100).toFixed(1)} cm from a facial feature`);
  }
});

// ---------------------------------------------------------------- mesh tools

test('T17 mesh tools: outward orientation, boundary loops, ray casting', () => {
  const center = [0, 0.0275, -0.035];
  const tris = orientOutward(FACE_VERTICES, FACE_TRIANGLES, center);
  const loops = boundaryLoops(tris);
  assert.ok(loops.length >= 1);
  assert.ok(loops[0].length > 30, 'outer face contour');
  const flat = new Float64Array(tris.length * 9);
  let o = 0;
  for (const t of tris) for (const i of t) for (const v of FACE_VERTICES[i]) flat[o++] = v;
  const d = rayMeshDistance(center, [0, 0, 1], flat);
  assert.ok(d > 0.08 && d < 0.13, `ray from head centre hits the face ahead (${d})`);
  assert.equal(rayMeshDistance(center, [0, 0, -1], flat), Infinity);
});
