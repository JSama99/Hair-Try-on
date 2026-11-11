// Live simulation: the same properties HairKit's HairDynamics tests pin, on the JS twin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, makeSpec, HeadProxy, StyleKind } from '../src/protostyle.js';
import { packMesh } from '../src/worker.js';
import { HairSimulation, buildChains, eulerPose, poseFromMatrix, interpolatePose, OneEuroFilter, PoseFilter, minimalRotation, IDENTITY_POSE, SIM_DEFAULTS } from '../src/hairsim.js';

function make(kind = StyleKind.BOX_BRAIDS, overrides = {}) {
  const spec = makeSpec(kind, { width: 0.025, length: 0.22, ...overrides });
  const head = new HeadProxy();
  const res = generate(spec, head, { includeLOD0: false });
  const mesh = packMesh(res.lod1);
  return { res, mesh, sim: new HairSimulation(buildChains(res), head, mesh) };
}

function segmentError(sim) {
  let worst = 0;
  const { chains, offsets, positions } = sim;
  for (let k = 0; k < chains.counts.length; k++) {
    for (let i = chains.pinned[k]; i < chains.counts[k]; i++) {
      const j = 3 * (offsets[k] + i);
      const d = Math.hypot(positions[j] - positions[j - 3], positions[j + 1] - positions[j - 2], positions[j + 2] - positions[j - 1]);
      worst = Math.max(worst, Math.abs(d - chains.ds[k]));
    }
  }
  return worst;
}

test('chains cover every strand and pin at least the root lift', () => {
  const { res, sim } = make();
  assert.equal(sim.chains.counts.length, res.strands.length);
  for (let k = 0; k < sim.chains.counts.length; k++) {
    assert.ok(sim.chains.pinned[k] >= 2 && sim.chains.pinned[k] <= sim.chains.counts[k]);
    assert.ok(sim.chains.ds[k] > 0.004 && sim.chains.ds[k] < 0.02);
  }
});

test('skinning at rest reproduces the LOD1 shell', () => {
  const { mesh, sim } = make();
  const P = new Float32Array(mesh.positions.length), N = new Float32Array(mesh.normals.length);
  sim.skin(P, N);
  let worst = 0;
  for (let i = 0; i < P.length; i++) worst = Math.max(worst, Math.abs(P[i] - mesh.positions[i]), Math.abs(N[i] - mesh.normals[i]));
  assert.ok(worst < 1e-6, `rest skin error ${worst}`);
});

test('a rigid pose change with reset reproduces the shell in the head frame', () => {
  const { mesh, sim } = make();
  sim.reset(eulerPose(0.7, -0.2, 0.1, [0.03, -0.02, -0.4]));
  const P = new Float32Array(mesh.positions.length), N = new Float32Array(mesh.normals.length);
  sim.skin(P, N);
  let worst = 0;
  for (let i = 0; i < P.length; i++) worst = Math.max(worst, Math.abs(P[i] - mesh.positions[i]));
  assert.ok(worst < 1e-6, `rigid skin error ${worst}`);
});

test('every step ends inextensible, finite and outside the head', () => {
  const { sim } = make();
  const pose = eulerPose(0, 0, 0, [0, 0, -0.4]);
  sim.settle(pose, 1.0);
  for (let f = 0; f < 60; f++) {
    sim.advance(eulerPose(0.6 * Math.sin(f / 8), 0.2 * Math.sin(f / 5), 0, [0, 0, -0.4]), 1 / 30);
    assert.ok(segmentError(sim) < 1e-9, `segment error ${segmentError(sim)} at frame ${f}`);
  }
  const nodes = sim.nodesInHeadFrame();
  const h = sim.head;
  for (let k = 0; k < sim.chains.counts.length; k++) {
    for (let i = sim.chains.pinned[k]; i < sim.chains.counts[k]; i++) {
      const j = 3 * (sim.offsets[k] + i);
      assert.ok(Number.isFinite(nodes[j]) && Number.isFinite(nodes[j + 1]) && Number.isFinite(nodes[j + 2]));
      const a = (nodes[j] - h.cx) / h.rx, b = (nodes[j + 1] - h.cy) / h.ry, c = (nodes[j + 2] - h.cz) / h.rz;
      assert.ok(a * a + b * b + c * c > 0.98, 'node inside the scalp');
    }
  }
});

test('hair swings when the head turns and comes to rest when it stops', () => {
  const { sim } = make();
  sim.settle(Float64Array.from(IDENTITY_POSE));
  assert.ok(sim.maxSpeed < 0.05, `settled speed ${sim.maxSpeed}`);
  let peak = 0;
  for (let f = 0; f < 20; f++) { sim.advance(eulerPose(0.04 * (f + 1)), 1 / 30); peak = Math.max(peak, sim.maxSpeed); }
  assert.ok(peak > 0.2, `turning should move the hair (peak ${peak} m/s)`);
  const end = eulerPose(0.8);
  for (let f = 0; f < 150; f++) sim.advance(end, 1 / 30);
  assert.ok(sim.maxSpeed < 0.08, `speed after 5 s still ${sim.maxSpeed}`);
});

test('a stalled frame cannot spiral: steps are capped and the time bank is dropped', () => {
  const { sim } = make();
  const steps = sim.advance(Float64Array.from(IDENTITY_POSE), 2.0);
  assert.equal(steps, SIM_DEFAULTS.maxStepsPerAdvance);
  assert.equal(sim.timeBank, 0);
  assert.equal(sim.advance(Float64Array.from(IDENTITY_POSE), 0.001), 0);
});

test('deterministic for the same pose sequence', () => {
  const run = () => {
    const { sim } = make(StyleKind.LOCS);
    sim.settle(Float64Array.from(IDENTITY_POSE), 0.5);
    for (let f = 0; f < 30; f++) sim.advance(eulerPose(0.02 * f, 0.01 * f), 1 / 60);
    return Array.from(sim.positions);
  };
  assert.deepEqual(run(), run());
});

test('every style kind simulates (cornrows pin their on-scalp run)', () => {
  for (const kind of Object.values(StyleKind)) {
    const { res, sim } = make(kind, kind === StyleKind.CORNROWS ? { cornrow_rows: 8, length: 0.12 } : {});
    sim.settle(Float64Array.from(IDENTITY_POSE), 0.3);
    assert.ok(segmentError(sim) < 1e-9, kind);
    if (kind === StyleKind.CORNROWS) {
      const k = 0;
      assert.ok(sim.chains.pinned[k] * sim.chains.ds[k] >= res.strands[k].freeFromS - sim.chains.ds[k], 'scalp run pinned');
    }
  }
});

test('poseFromMatrix removes MediaPipe scale and converts cm to metres', () => {
  const s = 1.07;
  const e = eulerPose(0.3, -0.1, 0.05);
  const m = [e[0] * s, e[1] * s, e[2] * s, 0, e[3] * s, e[4] * s, e[5] * s, 0, e[6] * s, e[7] * s, e[8] * s, 0, 2, -3, -40, 1];
  const p = poseFromMatrix(m);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(p[i] - e[i]) < 1e-12);
  assert.ok(Math.abs(p[11] - (-40 / (100 * s))) < 1e-12);
});

test('interpolatePose stays orthonormal', () => {
  const p = interpolatePose(eulerPose(0), eulerPose(0.5, 0.3, 0.2), 0.37);
  const dot = (a, b) => p[a] * p[b] + p[a + 1] * p[b + 1] + p[a + 2] * p[b + 2];
  assert.ok(Math.abs(dot(0, 0) - 1) < 1e-12 && Math.abs(dot(3, 3) - 1) < 1e-12 && Math.abs(dot(6, 6) - 1) < 1e-12);
  assert.ok(Math.abs(dot(0, 3)) < 1e-12 && Math.abs(dot(0, 6)) < 1e-12 && Math.abs(dot(3, 6)) < 1e-12);
});

test('minimalRotation maps a to b, including the opposite case', () => {
  const out = new Float64Array(9);
  const apply = (v) => [out[0] * v[0] + out[3] * v[1] + out[6] * v[2], out[1] * v[0] + out[4] * v[1] + out[7] * v[2], out[2] * v[0] + out[5] * v[1] + out[8] * v[2]];
  const a = [0, -1, 0], b = [0.6, -0.8, 0];
  minimalRotation(...a, ...b, out, 0);
  apply(a).forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-12));
  minimalRotation(0, 1, 0, 0, -1, 0, out, 0);
  apply([0, 1, 0]).forEach((v, i) => assert.ok(Math.abs(v - [0, -1, 0][i]) < 1e-12));
});

test('1€ filter: removes jitter at rest, follows a fast move', () => {
  const f = new OneEuroFilter(1.0, 0.5);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  let worst = 0;
  for (let i = 0; i < 120; i++) { const y = f.filter(10 + 0.2 * rnd(), i / 30); if (i > 30) worst = Math.max(worst, Math.abs(y - 10)); }
  assert.ok(worst < 0.07, `rest jitter ${worst}`);
  let y = 0;
  for (let i = 120; i < 135; i++) y = f.filter(10 + (i - 119) * 2, i / 30);
  assert.ok(Math.abs(y - 40) < 3, `lag ${40 - y}`);
});

test('PoseFilter returns the pose it is given when still, and keeps quaternion sign continuous', () => {
  const pf = new PoseFilter();
  const e = eulerPose(3.0, 0.1, 0);
  const m = [e[0], e[1], e[2], 0, e[3], e[4], e[5], 0, e[6], e[7], e[8], 0, 1, 2, -45, 1];
  let out;
  for (let i = 0; i < 40; i++) out = pf.update(m, i / 30);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(out[i] - m[i]) < 1e-9, `element ${i}`);
  // Crossing yaw = pi flips the raw quaternion's sign; the output must not jump.
  const e2 = eulerPose(3.3, 0.1, 0);
  const m2 = [e2[0], e2[1], e2[2], 0, e2[3], e2[4], e2[5], 0, e2[6], e2[7], e2[8], 0, 1, 2, -45, 1];
  const next = pf.update(m2, 41 / 30);
  assert.ok(Math.abs(next[0] - out[0]) < 0.3 && Math.abs(next[10] - out[10]) < 0.3);
});
