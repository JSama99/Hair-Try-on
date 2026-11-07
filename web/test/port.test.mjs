// Parity of web/src/protostyle.js against the Python oracle's golden fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SplitMix64, deriveSeed, pyRound, pySum, HeadProxy, makeSpec, generate, generateAsync, digest, validateSpec,
  StyleKind, resamplePolyline,
} from '../src/protostyle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = (name) => JSON.parse(readFileSync(path.join(here, '..', '..', 'reference', 'golden', name), 'utf8'));

function close(a, b, tol, label) {
  assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (tol ${tol})`);
}

test('P01 SplitMix64 sequence and derive_seed are bit-exact', () => {
  const g = golden('rng_splitmix64.json');
  const rng = new SplitMix64(g.seed);
  for (const want of g.u64) assert.equal(rng.nextU64().toString(), want);
  for (const [salt, want] of Object.entries(g.derive_seed)) assert.equal(deriveSeed(g.seed, salt).toString(), want);
});

test('P02 pyRound is round-half-even and never -0', () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4999, -0.2].map(pyRound), [0, 2, 2, 0, -2, -2, 2, 0]);
  assert.ok(!Object.is(pyRound(-0.4), -0));
});

test('P03 pySum matches CPython compensated sum', () => {
  assert.equal(pySum([1e16, 1.0, -1e16]), 1.0);
  assert.equal(pySum([0.1, 0.2, 0.3]), 0.6);
  assert.equal(pySum([]), 0);
});

test('P04 scalp: hairline and surface points match', () => {
  const g = golden('scalp.json');
  const head = new HeadProxy(g.head);
  for (const [phi, th] of g.hairline_theta) close(head.hairlineTheta(phi), th, 1e-9, `hairline(${phi})`);
  for (const s of g.points) {
    const p = head.point(s.theta, s.phi);
    const n = head.normalAt(p);
    for (let i = 0; i < 3; i++) {
      close(p[i], s.point[i], 1e-9, 'point');
      close(n[i], s.normal[i], 1e-9, 'normal');
    }
  }
});

const FIXTURES = ['box_braids', 'knotless_braids', 'two_strand_twists', 'locs', 'cornrows', 'box_braids_long'];

for (const kind of FIXTURES) {
  test(`P05 ${kind}: stats, roots, centreline, LOD1 and digest match the oracle`, async () => {
    const g = golden(`style_${kind}.json`);
    const { kind: k, ...rest } = g.spec;
    const spec = makeSpec(k, rest);
    const res = generate(spec, new HeadProxy());
    assert.deepEqual(res.stats, g.stats);
    assert.equal(res.roots.length, g.roots.length);
    res.roots.forEach((r, i) => {
      if (g.roots[i].point) for (let c = 0; c < 3; c++) close(r[c], g.roots[i].point[c], 1e-9, 'root point');
      else { close(r.theta, g.roots[i].theta, 1e-9, 'theta'); close(r.phi, g.roots[i].phi, 1e-9, 'phi'); }
    });
    const cl = res.strands[0].centerline.filter((_, i) => i % 5 === 0);
    assert.equal(cl.length, g.strand0_centerline_every5.length);
    cl.forEach((p, i) => p.forEach((v, c) => close(v, g.strand0_centerline_every5[i][c], g.tolerance_abs_m, 'centreline')));
    g.lod1_positions_head.forEach((p, i) => p.forEach((v, c) => close(res.lod1.positions[3 * i + c], v, g.tolerance_abs_m, 'lod1')));
    assert.deepEqual(Array.from(res.lod1.triangles.slice(0, 144)), g.lod1_triangles_head.flat());
    assert.equal(await digest(res), g.digest_sha256_q10um);
  });
}

test('P06 spec validation mirrors the oracle (length policy)', () => {
  assert.equal(validateSpec(makeSpec(StyleKind.BOX_BRAIDS, { length: 0.40 })).length, 0);
  const p = validateSpec(makeSpec(StyleKind.BOX_BRAIDS, { length: 0.55 }));
  assert.equal(p.length, 1);
  assert.match(p[0], /without a torso collider/);
  assert.equal(validateSpec(makeSpec(StyleKind.BOX_BRAIDS, { length: 0.55, has_body_proxy: true })).length, 0);
  assert.throws(() => generate(makeSpec(StyleKind.LOCS, { width: 0.002 })), /width/);
});

test('P07 generateAsync equals generate, reports progress and aborts', async () => {
  const spec = makeSpec(StyleKind.LOCS, { width: 0.035, length: 0.12, seed: 0x10C5 });
  const seen = [];
  const a = await generateAsync(spec, new HeadProxy(), { onProgress: (f) => seen.push(f), sliceMs: 1 });
  assert.equal(await digest(a), await digest(generate(spec)));
  assert.ok(seen.length > 0 && seen[seen.length - 1] === 1);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(generateAsync(spec, new HeadProxy(), { signal: ctl.signal }), /aborted/);
});

test('P08 LOD0 can be skipped without changing LOD1', async () => {
  const spec = makeSpec(StyleKind.TWO_STRAND_TWISTS, { width: 0.035, length: 0.12, seed: 0xB0A7 });
  const full = generate(spec);
  const lite = generate(spec, new HeadProxy(), { includeLOD0: false });
  assert.equal(lite.lod0.vertexCount, 0);
  assert.deepEqual(lite.lod1.positions, full.lod1.positions);
});

test('P09 render attributes: one frac and strand id per vertex, fracs in [0,1]', () => {
  const res = generate(makeSpec(StyleKind.KNOTLESS_BRAIDS, { width: 0.035, length: 0.12 }));
  for (const m of [res.lod0, res.lod1]) {
    assert.equal(m.fracs.length, m.vertexCount);
    assert.equal(m.strandIds.length, m.vertexCount);
    assert.equal(m.uvs.length, 2 * m.vertexCount);
    assert.ok(m.fracs.every((f) => f >= 0 && f <= 1));
  }
});

test('P11 face slab: hair is pushed sideways out of the space in front of the face', () => {
  const head = new HeadProxy();
  const p = [0.01, head.fy - 0.1, head.fz + 0.02];
  const [q, hit] = head.projectOutsideFace(p, 0);
  assert.ok(hit);
  assert.deepEqual([q[1], q[2]], [p[1], p[2]]);
  assert.equal(q[0], head.fx + head.frx);
  const res = generate(makeSpec(StyleKind.BOX_BRAIDS, { length: 0.30 }), head, { includeLOD0: false });
  let bad = 0;
  for (const s of res.strands) for (const c of s.centerline) {
    if (c[1] - head.fy < 0.6 * head.fry && c[2] - head.fz > 0 && Math.abs(c[0] - head.fx) < 0.8 * head.frx) bad++;
  }
  assert.equal(bad, 0);
});

test('P10 resamplePolyline keeps endpoints and spacing', () => {
  const pts = [[0, 0, 0], [0.1, 0, 0], [0.1, 0.05, 0]];
  const out = resamplePolyline(pts, 0.01);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[2]);
  assert.equal(out.length, 16); // oracle v0.2: 0.15/0.01 = 15.000000000000002 is 15 segments, not 16
  for (let i = 1; i < out.length; i++) {
    const d = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1], out[i][2] - out[i - 1][2]);
    assert.ok(d <= 0.01 + 1e-12, `segment ${i} is ${d}`);
  }
});
