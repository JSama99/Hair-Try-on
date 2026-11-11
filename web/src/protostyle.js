// protostyle.js — JavaScript port of reference/protostyle v0.2 (the Python oracle).
//
// Determinism contract (docs/ARCHITECTURE.md §9): every expression below keeps
// the Python evaluation order, component by component, so positions match the
// oracle to ~1e-13 m and the quantised SHA-256 digest matches exactly.
// Specifics that matter:
//   * Python's round() is round-half-even  -> pyRound()
//   * CPython >= 3.12 sum() over floats is Neumaier-compensated -> pySum()
//   * (x) ** 2 is evaluated as x * x (glibc pow(x, 2) is exactly x * x)
//   * all randomness is SplitMix64 on BigInt, seeds derived with FNV-1a 64
//
// The drape solver works on Float64Array for speed; it performs the same
// floating-point operations in the same order as reference/protostyle/drape.py.

// ---------------------------------------------------------------- numerics

export function pyRound(x) {
  const f = Math.floor(x);
  const diff = x - f;
  let r;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return r === 0 ? 0 : r; // never -0
}

/** CPython 3.12+ float sum(): Neumaier compensation, compensation added last. */
export function pySum(values) {
  let f = 0.0;
  let c = 0.0;
  for (const x of values) {
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  if (c !== 0 && Number.isFinite(c)) f += c;
  return f;
}

/** Python round(x, nd) for display-level stats (decimal, ties practically never exact). */
export function pyRoundDigits(x, nd) {
  return Number(x.toFixed(nd));
}

// ---------------------------------------------------------------- vectors

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.sqrt(dot(a, a));
export function normalize(a) {
  const n = length(a);
  if (n < 1e-15) throw new Error('cannot normalize a zero-length vector');
  return [a[0] / n, a[1] / n, a[2] / n];
}
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const isFiniteVec = (a) => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

// ---------------------------------------------------------------- RNG

const MASK64 = (1n << 64n) - 1n;

export class SplitMix64 {
  constructor(seed) {
    this.state = BigInt.asUintN(64, BigInt(seed));
  }
  nextU64() {
    this.state = (this.state + 0x9E3779B97F4A7C15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK64;
    return z ^ (z >> 31n);
  }
  nextUnit() {
    return Number(this.nextU64() >> 11n) * (1.0 / 9007199254740992.0);
  }
  nextSigned() {
    return this.nextUnit() * 2.0 - 1.0;
  }
}

export function deriveSeed(seed, salt) {
  let h = 0xCBF29CE484222325n;
  for (const b of new TextEncoder().encode(salt)) {
    h ^= BigInt(b);
    h = (h * 0x100000001B3n) & MASK64;
  }
  return new SplitMix64((BigInt.asUintN(64, BigInt(seed)) ^ h) & MASK64).nextU64();
}

// ---------------------------------------------------------------- head proxy

export const HEAD_DEFAULTS = Object.freeze({
  rx: 0.076, ry: 0.100, rz: 0.097,
  cx: 0.0, cy: 0.025, cz: -0.030,
  hairline_front: 0.98, hairline_back: 1.95, ear_notch: 0.30, ear_notch_width: 0.38,
  fx: 0.0, fy: -0.030, fz: 0.028, frx: 0.070, fry: 0.100, frz: 0.078,
});

function pushOut(p, cx, cy, cz, r0, r1, r2) {
  const d = [p[0] - cx, p[1] - cy, p[2] - cz];
  const a = d[0] / r0, b = d[1] / r1, c = d[2] / r2;
  const k = a * a + b * b + c * c;
  if (k >= 1.0) return [p, false];
  if (k < 1e-18) return [[cx + 0.0, cy + 0.0, cz + -r2], true];
  const s = 1.0 / Math.sqrt(k);
  return [[cx + d[0] * s, cy + d[1] * s, cz + d[2] * s], true];
}

// Face keep-out (oracle v0.2, scalp._push_out_face): the face ellipsoid above
// the brow; below it, behind the face plane, the ellipsoid's horizontal slice;
// in front, a slab whose depth term blends from none (below the centre) to the
// full ellipsoid (at the brow), pushed sideways only. Continuous everywhere.
export const FACE_SLAB_TOP = 0.6;

function pushOutFace(p, cx, cy, cz, r0, r1, r2) {
  const d = [p[0] - cx, p[1] - cy, p[2] - cz];
  const top = FACE_SLAB_TOP * r1;
  if (d[1] > top) return pushOut(p, cx, cy, cz, r0, r1, r2);
  const dy = d[1] > 0.0 ? d[1] : 0.0;
  const b = dy / r1;
  const q = 1.0 - b * b;
  const ax = d[0] / r0, az = d[2] / r2;
  if (d[2] > 0.0) {
    const lim = q - (dy / top) * (az * az);
    if (ax * ax >= lim) return [p, false];
    const w = r0 * Math.sqrt(lim);
    return [[cx + (d[0] >= 0.0 ? w : -w), p[1], p[2]], true];
  }
  const k = ax * ax + az * az;
  if (k >= q) return [p, false];
  if (k < 1e-18) return [[cx + r0 * Math.sqrt(q), p[1], p[2]], true];
  const s = Math.sqrt(q / k);
  return [[cx + d[0] * s, p[1], cz + d[2] * s], true];
}

export class HeadProxy {
  constructor(params = {}) {
    Object.assign(this, HEAD_DEFAULTS, params);
    Object.freeze(this);
  }
  with(params) {
    return new HeadProxy({ ...this.toJSON(), ...params });
  }
  toJSON() {
    const o = {};
    for (const k of Object.keys(HEAD_DEFAULTS)) o[k] = this[k];
    return o;
  }
  center() { return [this.cx, this.cy, this.cz]; }
  point(theta, phi) {
    const st = Math.sin(theta);
    return [
      this.cx + this.rx * st * Math.sin(phi),
      this.cy + this.ry * Math.cos(theta),
      this.cz + this.rz * st * Math.cos(phi),
    ];
  }
  normalAt(p) {
    const d = sub(p, this.center());
    return normalize([d[0] / (this.rx * this.rx), d[1] / (this.ry * this.ry), d[2] / (this.rz * this.rz)]);
  }
  implicit(p) {
    const d = sub(p, this.center());
    const a = d[0] / this.rx, b = d[1] / this.ry, c = d[2] / this.rz;
    return a * a + b * b + c * c;
  }
  projectOutside(p, clearance) {
    return pushOut(p, this.cx, this.cy, this.cz, this.rx + clearance, this.ry + clearance, this.rz + clearance);
  }
  projectOutsideFace(p, clearance) {
    return pushOutFace(p, this.fx, this.fy, this.fz, this.frx + clearance, this.fry + clearance, this.frz + clearance);
  }
  collide(p, clearance) {
    const [p1, h] = this.projectOutside(p, clearance);
    const [p2, f] = this.projectOutsideFace(p1, clearance);
    return [p2, h || f];
  }
  faceImplicit(p, clearance = 0.0) {
    const d = sub(p, [this.fx, this.fy, this.fz]);
    const r0 = this.frx + clearance, r1 = this.fry + clearance, r2 = this.frz + clearance;
    const top = FACE_SLAB_TOP * r1;
    const ax = d[0] / r0, az = d[2] / r2;
    if (d[1] > top) { const ay = d[1] / r1; return ax * ax + ay * ay + az * az; }
    const dy = d[1] > 0.0 ? d[1] : 0.0;
    const ay = dy / r1;
    if (d[2] > 0.0) return ax * ax + ay * ay + (dy / top) * (az * az);
    return ax * ax + ay * ay + az * az;
  }
  hairlineTheta(phi) {
    const base = this.hairline_front + (this.hairline_back - this.hairline_front) * (1.0 - Math.cos(phi)) * 0.5;
    const side = Math.abs(phi);
    const q = (side - Math.PI * 0.5) / this.ear_notch_width;
    const notch = this.ear_notch * Math.exp(-(q * q));
    return base - notch;
  }
  insideHairline(theta, phi, margin = 0.0) {
    return theta <= this.hairlineTheta(phi) - margin;
  }
  tangentFrame(theta, phi) {
    const p = this.point(theta, phi);
    const n = this.normalAt(p);
    const ref = [0.0, 0.0, -1.0];
    let tBack = sub(ref, mul(n, dot(ref, n)));
    if (length(tBack) < 1e-9) tBack = sub([1.0, 0.0, 0.0], mul(n, n[0]));
    tBack = normalize(tBack);
    const tSide = normalize(cross(n, tBack));
    return [n, tBack, tSide];
  }
  toSurface(p) {
    const d = sub(p, this.center());
    const a = d[0] / this.rx, b = d[1] / this.ry, c = d[2] / this.rz;
    const k = Math.sqrt(a * a + b * b + c * c);
    return add(this.center(), mul(d, 1.0 / k));
  }
  thetaPhiOf(p) {
    const d = sub(p, this.center());
    const nx = d[0] / this.rx, ny = d[1] / this.ry, nz = d[2] / this.rz;
    const theta = Math.acos(Math.max(-1.0, Math.min(1.0, ny / Math.sqrt(nx * nx + ny * ny + nz * nz))));
    return [theta, Math.atan2(nx, nz)];
  }
}

// ---------------------------------------------------------------- parting

const meanRadius = (h) => (h.rx + h.ry + h.rz) / 3.0;

export function gridSections(head, sectionSize, jitter, seed, hairlineMargin = 0.0) {
  if (!(sectionSize >= 0.004 && sectionSize <= 0.08)) throw new Error('section_size must be between 4 mm and 8 cm');
  if (!(jitter >= 0.0 && jitter <= 0.45)) throw new Error('jitter must be in [0, 0.45]');
  const rng = new SplitMix64(deriveSeed(seed, 'grid_sections'));
  const rMean = meanRadius(head);
  const dTheta = sectionSize / rMean;
  const thetaMax = head.hairline_back;
  const roots = [];
  let row = 0;
  let theta = dTheta * 0.5;
  while (theta < thetaMax) {
    const circ = 2.0 * Math.PI * rMean * Math.sin(theta);
    const cols = Math.max(1, pyRound(circ / sectionSize));
    const step = 2.0 * Math.PI / cols;
    const offset = row % 2 === 1 ? 0.5 * step : 0.0;
    for (let c = 0; c < cols; c++) {
      const phi = -Math.PI + (c + 0.5) * step + offset;
      const jt = rng.nextSigned() * jitter * dTheta;
      const jp = rng.nextSigned() * jitter * step;
      let th = theta + jt;
      let ph = phi + jp;
      if (ph > Math.PI) ph -= 2.0 * Math.PI;
      if (ph <= -Math.PI) ph += 2.0 * Math.PI;
      if (th <= 0.0) th = 1e-4;
      if (!head.insideHairline(th, ph, hairlineMargin)) continue;
      const p = head.point(th, ph);
      const [n, tb, ts] = head.tangentFrame(th, ph);
      roots.push({ index: roots.length, theta: th, phi: ph, point: p, normal: n, tBack: tb, tSide: ts });
    }
    theta += dTheta;
    row += 1;
  }
  return roots;
}

export function resamplePolyline(points, spacing) {
  if (points.length < 2) return points.slice();
  const seg = [];
  for (let i = 0; i < points.length - 1; i++) seg.push(length(sub(points[i + 1], points[i])));
  const total = pySum(seg);
  const n = Math.max(1, Math.ceil(total / spacing - 1e-9)); // oracle v0.2: ignore noise at exact integers
  const out = [points[0]];
  const targetStep = total / n;
  let i = 0;
  let acc = 0.0;
  for (let k = 1; k < n; k++) {
    const target = k * targetStep;
    while (acc + seg[i] < target) {
      acc += seg[i];
      i += 1;
    }
    const t = (target - acc) / seg[i];
    out.push(lerp(points[i], points[i + 1], t));
  }
  out.push(points[points.length - 1]);
  return out;
}

export function cornrowPaths(head, rows, widthFraction, spacing, hairlineMargin = 0.02) {
  if (!(rows >= 2 && rows <= 24)) throw new Error('rows must be between 2 and 24');
  if (!(widthFraction >= 0.2 && widthFraction <= 0.95)) throw new Error('width_fraction must be in [0.2, 0.95]');
  const paths = [];
  for (let k = 0; k < rows; k++) {
    const u = -1.0 + (2.0 * k + 1.0) / rows;
    const x = u * widthFraction * head.rx;
    const q = x / head.rx;
    const s = Math.sqrt(Math.max(0.0, 1.0 - q * q));
    let inside = [];
    let best = [];
    const samples = 480;
    for (let i = 0; i <= samples; i++) {
      const a = -0.2 + (Math.PI + 0.9) * i / samples;
      const p = [head.cx + x, head.cy + head.ry * s * Math.sin(a), head.cz + head.rz * s * Math.cos(a)];
      const [th, ph] = head.thetaPhiOf(p);
      if (head.insideHairline(th, ph, hairlineMargin)) inside.push(p);
      else {
        if (inside.length > best.length) best = inside;
        inside = [];
      }
    }
    if (inside.length > best.length) best = inside;
    if (best.length < 2) continue;
    paths.push(resamplePolyline(best, spacing).map((p) => head.toSurface(p)));
  }
  return paths;
}

// ---------------------------------------------------------------- drape

export const MAX_UNSUPPORTED_LENGTH = 0.40;

export const DRAPE_DEFAULTS = Object.freeze({
  steps: 220, passes: 10, gravity: 9.81, dt: 1.0 / 90.0, damping: 0.985, bendStiffness: 0.35, ftlDamping: 0.9,
});

function bendFlat(pos, count, nFixed, ds, stiffness, minRadius) {
  for (let i = Math.max(nFixed, 2); i < count; i++) {
    const ia = 3 * (i - 2), im = 3 * (i - 1), ib = 3 * i;
    const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
    const ux = pos[im] - ax, uy = pos[im + 1] - ay, uz = pos[im + 2] - az;
    const l1 = Math.sqrt(ux * ux + uy * uy + uz * uz);
    const l2 = ds;
    let phi = minRadius > 0.0 ? (l1 + l2) / (2.0 * minRadius) : 0.35;
    phi = Math.min(phi, 2.6);
    const rest = Math.sqrt(Math.max(0.0, l1 * l1 + l2 * l2 + 2.0 * l1 * l2 * Math.cos(phi)));
    const bx = pos[ib], by = pos[ib + 1], bz = pos[ib + 2];
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= rest || dist < 1e-12) continue;
    const corr = (dist - rest) / dist * stiffness;
    if (i - 2 < nFixed) {
      pos[ib] = bx - dx * corr; pos[ib + 1] = by - dy * corr; pos[ib + 2] = bz - dz * corr;
    } else {
      const h = 0.5 * corr;
      const hx = dx * h, hy = dy * h, hz = dz * h;
      pos[ia] = ax + hx; pos[ia + 1] = ay + hy; pos[ia + 2] = az + hz;
      pos[ib] = bx - hx; pos[ib + 1] = by - hy; pos[ib + 2] = bz - hz;
    }
  }
}

function followTheLeaderFlat(pos, count, nFixed, ds, corr) {
  for (let i = nFixed; i < count; i++) {
    const ip = 3 * (i - 1), ii = 3 * i;
    let dx = pos[ii] - pos[ip], dy = pos[ii + 1] - pos[ip + 1], dz = pos[ii + 2] - pos[ip + 2];
    let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-12) { dx = 0.0; dy = -1.0; dz = 0.0; dist = 1.0; }
    const s = ds / dist;
    const tx = pos[ip] + dx * s, ty = pos[ip + 1] + dy * s, tz = pos[ip + 2] + dz * s;
    if (corr) { corr[ii] = tx - pos[ii]; corr[ii + 1] = ty - pos[ii + 1]; corr[ii + 2] = tz - pos[ii + 2]; }
    pos[ii] = tx; pos[ii + 1] = ty; pos[ii + 2] = tz;
  }
}

function pushOutFlat(pos, ii, cx, cy, cz, r0, r1, r2) {
  const dx = pos[ii] - cx, dy = pos[ii + 1] - cy, dz = pos[ii + 2] - cz;
  const a = dx / r0, b = dy / r1, c = dz / r2;
  const k = a * a + b * b + c * c;
  if (k >= 1.0) return;
  if (k < 1e-18) { pos[ii] = cx + 0.0; pos[ii + 1] = cy + 0.0; pos[ii + 2] = cz + -r2; return; }
  const s = 1.0 / Math.sqrt(k);
  pos[ii] = cx + dx * s; pos[ii + 1] = cy + dy * s; pos[ii + 2] = cz + dz * s;
}

function pushOutFaceFlat(pos, ii, cx, cy, cz, r0, r1, r2) {
  const dyRaw = pos[ii + 1] - cy;
  const top = FACE_SLAB_TOP * r1;
  if (dyRaw > top) { pushOutFlat(pos, ii, cx, cy, cz, r0, r1, r2); return; }
  const dx = pos[ii] - cx, dz = pos[ii + 2] - cz;
  const dy = dyRaw > 0.0 ? dyRaw : 0.0;
  const b = dy / r1;
  const q = 1.0 - b * b;
  const ax = dx / r0, az = dz / r2;
  if (dz > 0.0) {
    const lim = q - (dy / top) * (az * az);
    if (ax * ax >= lim) return;
    const w = r0 * Math.sqrt(lim);
    pos[ii] = cx + (dx >= 0.0 ? w : -w);
    return;
  }
  const k = ax * ax + az * az;
  if (k >= q) return;
  if (k < 1e-18) { pos[ii] = cx + r0 * Math.sqrt(q); return; }
  const s = Math.sqrt(q / k);
  pos[ii] = cx + dx * s;
  pos[ii + 2] = cz + dz * s;
}

function collideFlat(pos, count, nFixed, head, clearance) {
  const hr0 = head.rx + clearance, hr1 = head.ry + clearance, hr2 = head.rz + clearance;
  const fr0 = head.frx + clearance, fr1 = head.fry + clearance, fr2 = head.frz + clearance;
  for (let i = nFixed; i < count; i++) {
    pushOutFlat(pos, 3 * i, head.cx, head.cy, head.cz, hr0, hr1, hr2);
    pushOutFaceFlat(pos, 3 * i, head.fx, head.fy, head.fz, fr0, fr1, fr2);
  }
}

export function drape(head, fixed, freeLength, segment, clearance, params = DRAPE_DEFAULTS, minBendRadius = 0.0) {
  if (fixed.length < 2) throw new Error('drape needs at least two fixed points');
  if (segment <= 0.0) throw new Error('segment must be positive');
  if (freeLength < 0.0) throw new Error('free_length must be >= 0');
  const nFree = pyRound(freeLength / segment);
  if (nFree === 0) return fixed.map((p) => p.slice());
  const ds = freeLength / nFree;
  const nFixed = fixed.length;
  const count = nFixed + nFree;
  const last = fixed[nFixed - 1];
  const dir = normalize(sub(last, fixed[nFixed - 2]));
  const pos = new Float64Array(3 * count);
  for (let i = 0; i < nFixed; i++) pos.set(fixed[i], 3 * i);
  for (let i = 1; i <= nFree; i++) {
    const t = ds * i;
    const ii = 3 * (nFixed + i - 1);
    pos[ii] = last[0] + dir[0] * t; pos[ii + 1] = last[1] + dir[1] * t; pos[ii + 2] = last[2] + dir[2] * t;
  }
  const prev = Float64Array.from(pos);
  const gy = -params.gravity * params.dt * params.dt;
  const acc = new Float64Array(3 * count);
  const corr = new Float64Array(3 * count);
  for (let step = 0; step < params.steps; step++) {
    for (let i = nFixed; i < count; i++) {
      const ii = 3 * i;
      const px = pos[ii], py = pos[ii + 1], pz = pos[ii + 2];
      const vx = (px - prev[ii]) * params.damping;
      const vy = (py - prev[ii + 1]) * params.damping;
      const vz = (pz - prev[ii + 2]) * params.damping;
      prev[ii] = px; prev[ii + 1] = py; prev[ii + 2] = pz;
      pos[ii] = px + vx + 0.0; pos[ii + 1] = py + vy + gy; pos[ii + 2] = pz + vz + 0.0;
    }
    acc.fill(0);
    for (let pass = 0; pass < params.passes; pass++) {
      followTheLeaderFlat(pos, count, nFixed, ds, corr);
      for (let j = 3 * nFixed; j < 3 * count; j++) acc[j] = acc[j] + corr[j];
      bendFlat(pos, count, nFixed, ds, params.bendStiffness, minBendRadius);
      collideFlat(pos, count, nFixed, head, clearance);
    }
    for (let i = nFixed; i < count - 1; i++) {
      const ii = 3 * i, ic = 3 * (i + 1);
      prev[ii] = prev[ii] + acc[ic] * params.ftlDamping;
      prev[ii + 1] = prev[ii + 1] + acc[ic + 1] * params.ftlDamping;
      prev[ii + 2] = prev[ii + 2] + acc[ic + 2] * params.ftlDamping;
    }
  }
  for (let k = 0; k < 6; k++) {
    bendFlat(pos, count, nFixed, ds, 1.0, minBendRadius);
    collideFlat(pos, count, nFixed, head, clearance);
    followTheLeaderFlat(pos, count, nFixed, ds, null);
  }
  const out = [];
  for (let i = 0; i < count; i++) out.push([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
  return out;
}

// ---------------------------------------------------------------- sweep

export class Mesh {
  constructor() {
    this.positions = []; // flat xyz
    this.normals = [];   // flat xyz
    this.uvs = [];       // flat uv
    this.triangles = []; // flat indices
    this.fracs = [];     // root -> tip fraction per vertex (render-only, not in the digest)
    this.strandIds = []; // root index per vertex (render-only)
  }
  get vertexCount() { return this.positions.length / 3; }
  get triangleCount() { return this.triangles.length / 3; }
  extend(other) {
    const base = this.vertexCount;
    for (const v of other.positions) this.positions.push(v);
    for (const v of other.normals) this.normals.push(v);
    for (const v of other.uvs) this.uvs.push(v);
    for (const v of other.fracs) this.fracs.push(v);
    for (const v of other.strandIds) this.strandIds.push(v);
    for (const t of other.triangles) this.triangles.push(t + base);
  }
}

export function tangents(points) {
  const n = points.length;
  if (n < 2) throw new Error('need at least two points');
  const out = [];
  for (let i = 0; i < n; i++) out.push(normalize(sub(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)])));
  return out;
}

export function rotationMinimizingFrames(points, lateral0, outward) {
  const T = tangents(points);
  let n0 = sub(lateral0, mul(T[0], dot(lateral0, T[0])));
  if (length(n0) < 1e-9) {
    const alt = Math.abs(T[0][0]) < 0.9 ? [1.0, 0.0, 0.0] : [0.0, 1.0, 0.0];
    n0 = sub(alt, mul(T[0], dot(alt, T[0])));
  }
  n0 = normalize(n0);
  if (dot(cross(T[0], n0), outward) < 0.0) n0 = mul(n0, -1.0);
  const N = [n0];
  for (let i = 0; i < points.length - 1; i++) {
    const v1 = sub(points[i + 1], points[i]);
    const c1 = dot(v1, v1);
    if (c1 < 1e-24) { N.push(N[N.length - 1]); continue; }
    const rL = sub(N[i], mul(v1, 2.0 / c1 * dot(v1, N[i])));
    const tL = sub(T[i], mul(v1, 2.0 / c1 * dot(v1, T[i])));
    const v2 = sub(T[i + 1], tL);
    const c2 = dot(v2, v2);
    let r = c2 < 1e-24 ? rL : sub(rL, mul(v2, 2.0 / c2 * dot(v2, rL)));
    r = normalize(sub(r, mul(T[i + 1], dot(r, T[i + 1]))));
    N.push(r);
  }
  const B = points.map((_, i) => cross(T[i], N[i]));
  return [T, N, B];
}

export function arcLengths(points) {
  const s = [0.0];
  for (let i = 1; i < points.length; i++) s.push(s[i - 1] + length(sub(points[i], points[i - 1])));
  return s;
}

export function clampToCurvature(centers, radii, factor = 0.9) {
  const out = radii.slice();
  for (let k = 1; k < centers.length - 1; k++) {
    const u = sub(centers[k], centers[k - 1]);
    const v = sub(centers[k + 1], centers[k]);
    const lu = length(u), lv = length(v);
    if (lu < 1e-12 || lv < 1e-12) continue;
    const ang = Math.acos(Math.max(-1.0, Math.min(1.0, dot(u, v) / (lu * lv))));
    if (ang < 1e-9) continue;
    const rCurv = 0.5 * (lu + lv) / ang;
    if (out[k] > factor * rCurv) out[k] = factor * rCurv;
  }
  return out;
}

export function tube(centers, N, B, radiiIn, sides, capTip, vScale = 1.0, sValues = null, fracs = null, strandId = 0) {
  if (sides < 3) throw new Error('sides must be >= 3');
  const m = new Mesh();
  const rings = centers.length;
  const radii = clampToCurvature(centers, radiiIn);
  for (let k = 0; k < rings; k++) {
    const c = centers[k], n = N[k], b = B[k], r = radii[k];
    const v = (sValues !== null ? sValues[k] : k) * vScale;
    const fr = fracs ? fracs[k] : 0;
    for (let j = 0; j < sides; j++) {
      const a = 2.0 * Math.PI * j / sides;
      const ca = Math.cos(a), sa = Math.sin(a);
      const radial = add(mul(n, ca), mul(b, sa));
      const p = add(c, mul(radial, r));
      m.positions.push(p[0], p[1], p[2]);
      m.normals.push(radial[0], radial[1], radial[2]);
      m.uvs.push(j / sides, v);
      m.fracs.push(fr);
      m.strandIds.push(strandId);
    }
  }
  for (let k = 0; k < rings - 1; k++) {
    const r0 = k * sides, r1 = (k + 1) * sides;
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      m.triangles.push(r0 + j, r1 + j1, r1 + j);
      m.triangles.push(r0 + j, r0 + j1, r1 + j1);
    }
  }
  if (capTip) {
    const tipIndex = m.vertexCount;
    const t = normalize(sub(centers[rings - 1], centers[rings - 2]));
    const p = add(centers[rings - 1], mul(t, radii[rings - 1] * 0.6));
    m.positions.push(p[0], p[1], p[2]);
    m.normals.push(t[0], t[1], t[2]);
    m.uvs.push(0.5, (sValues !== null ? sValues[rings - 1] : rings - 1) * vScale);
    m.fracs.push(fracs ? fracs[rings - 1] : 1);
    m.strandIds.push(strandId);
    const base = (rings - 1) * sides;
    for (let j = 0; j < sides; j++) m.triangles.push(base + j, base + (j + 1) % sides, tipIndex);
  }
  return m;
}

// ---------------------------------------------------------------- styles

export const StyleKind = Object.freeze({
  BOX_BRAIDS: 'box_braids',
  KNOTLESS_BRAIDS: 'knotless_braids',
  TWO_STRAND_TWISTS: 'two_strand_twists',
  LOCS: 'locs',
  CORNROWS: 'cornrows',
});

export const CORNROW_WIDTH_FRACTION = 0.93;
export const RELAX_MIN_MOVE = 1e-9;

export const PROFILES = Object.freeze({
  box_braids: { strands: 3, lateralAmp: 0.30, depthAmp: 0.09, strandRadius: 0.26, period: 1.50, shellRadius: 0.56 },
  knotless_braids: { strands: 3, lateralAmp: 0.30, depthAmp: 0.09, strandRadius: 0.26, period: 1.50, shellRadius: 0.56 },
  two_strand_twists: { strands: 2, lateralAmp: 0.22, depthAmp: 0.22, strandRadius: 0.24, period: 1.60, shellRadius: 0.46 },
  locs: { strands: 1, lateralAmp: 0.0, depthAmp: 0.0, strandRadius: 0.40, period: 1.00, shellRadius: 0.46 },
  cornrows: { strands: 3, lateralAmp: 0.30, depthAmp: 0.10, strandRadius: 0.24, period: 1.30, shellRadius: 0.54 },
});

export const SPEC_DEFAULTS = Object.freeze({
  seed: 0x5EED, width: 0.020, length: 0.30, jitter: 0.18, hairline_margin: 0.03, cornrow_rows: 10,
  lod0_sides: 6, lod1_sides: 6, samples_per_period: 10, has_body_proxy: false,
});

export function makeSpec(kind, overrides = {}) {
  if (!Object.values(StyleKind).includes(kind)) throw new Error(`unknown style kind ${kind}`);
  return Object.freeze({ kind, ...SPEC_DEFAULTS, ...overrides });
}

export function validateSpec(spec) {
  const problems = [];
  if (!(spec.width >= 0.004 && spec.width <= 0.06)) problems.push('width must be between 4 mm and 6 cm');
  if (!(spec.length >= 0.0 && spec.length <= 1.2)) problems.push('length must be between 0 and 1.2 m');
  if (spec.length > MAX_UNSUPPORTED_LENGTH && !spec.has_body_proxy) {
    problems.push(`length ${spec.length.toFixed(2)} m exceeds ${MAX_UNSUPPORTED_LENGTH.toFixed(2)} m without a torso collider; strands would hang through the shoulders`);
  }
  if (!(spec.lod0_sides >= 3 && spec.lod0_sides <= 16 && spec.lod1_sides >= 3 && spec.lod1_sides <= 16)) problems.push('sides must be between 3 and 16');
  if (!(spec.samples_per_period >= 6 && spec.samples_per_period <= 32)) problems.push('samples_per_period must be between 6 and 32');
  if (spec.kind === StyleKind.CORNROWS && !(spec.cornrow_rows >= 2 && spec.cornrow_rows <= 24)) problems.push('cornrow_rows must be between 2 and 24');
  const seed = BigInt(spec.seed);
  if (!(seed >= 0n && seed < 1n << 64n)) problems.push('seed must fit in UInt64');
  return problems;
}

export function smoothstep(e0, e1, x) {
  const t = Math.min(1.0, Math.max(0.0, (x - e0) / (e1 - e0)));
  return t * t * (3.0 - 2.0 * t);
}

/** ceil() that ignores rounding noise at exact integers (oracle v0.2, styles._ceil_count). */
export const ceilCount = (ratio) => Math.max(1, Math.ceil(ratio - 1e-9));

export function catmullRomIndexed(points, spacing) {
  if (points.length < 2) return [points.slice(), points.map((_, i) => i)];
  const out = [points[0]];
  const idx = [0];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(n - 1, i + 2)];
    const seg = length(sub(p2, p1));
    const steps = ceilCount(seg / spacing);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t, t3 = t * t * t;
      const c = [0, 0, 0];
      for (let d = 0; d < 3; d++) {
        c[d] = 0.5 * ((2.0 * p1[d]) + (-p0[d] + p2[d]) * t + (2.0 * p0[d] - 5.0 * p1[d] + 4.0 * p2[d] - p3[d]) * t2 + (-p0[d] + 3.0 * p1[d] - 3.0 * p2[d] + p3[d]) * t3);
      }
      out.push(c);
    }
    out.push(p2);
    idx.push(out.length - 1);
  }
  return [out, idx];
}

export const catmullRom = (points, spacing) => catmullRomIndexed(points, spacing)[0];

export function relaxCurvature(head, points, minRadius, clearance, spacing, keep = 1, iterations = 60) {
  const pts = points.slice();
  const n = pts.length;
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = keep; i < n - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const u = sub(b, a), v = sub(c, b);
      const lu = length(u), lv = length(v);
      if (lu < 1e-12 || lv < 1e-12) continue;
      const ang = Math.acos(Math.max(-1.0, Math.min(1.0, dot(u, v) / (lu * lv))));
      if (ang < 1e-9 || 0.5 * (lu + lv) / ang >= minRadius) continue;
      const mid = mul(add(a, c), 0.5);
      const q = head.collide(add(b, mul(sub(mid, b), 0.6)), clearance)[0];
      if (length(sub(q, b)) < RELAX_MIN_MOVE) continue; // held by a collider: not a move (oracle v0.2)
      pts[i] = q;
      moved = true;
    }
    if (!moved) break;
  }
  const headPart = pts.slice(0, keep);
  const tail = resamplePolyline(pts.slice(keep - 1), spacing);
  return headPart.concat(tail.slice(1));
}

export class ValueNoise {
  constructor(seed, cell, count) {
    const rng = new SplitMix64(seed);
    this.cell = cell;
    this.values = [];
    for (let i = 0; i < count + 2; i++) this.values.push(rng.nextSigned());
  }
  at(s) {
    const x = Math.max(0.0, s / this.cell);
    let i = Math.floor(x);
    i = Math.min(i, this.values.length - 2);
    const f = x - i;
    const w = (1.0 - Math.cos(f * Math.PI)) * 0.5;
    return this.values[i] * (1.0 - w) + this.values[i + 1] * w;
  }
}

function radiusProfile(kind, s, total, width, strandRadius, noise) {
  let r = strandRadius * width;
  if (kind === StyleKind.BOX_BRAIDS) {
    const q = s / 0.010;
    r *= 1.0 + 0.28 * Math.exp(-(q * q));
  } else if (kind === StyleKind.KNOTLESS_BRAIDS) {
    r *= 0.45 + 0.55 * smoothstep(0.0, 0.035, s);
  } else if (kind === StyleKind.LOCS) {
    r *= 1.0 + 0.12 * noise.at(s);
  }
  const taperStart = total * 0.94;
  if (s > taperStart && total > 0.0) r *= 1.0 - 0.45 * smoothstep(taperStart, total, s);
  return r;
}

const feedScale = (kind, s) => (kind === StyleKind.KNOTLESS_BRAIDS ? 0.45 + 0.55 * smoothstep(0.0, 0.035, s) : 1.0);

function strandOffset(profile, strand, s, width) {
  if (profile.strands === 1) {
    return [0.04 * width * Math.sin(2.0 * Math.PI * s / (profile.period * width)), 0.0];
  }
  const omega = 2.0 * Math.PI / (profile.period * width);
  if (profile.strands === 3) {
    const phase = omega * s + 2.0 * Math.PI * strand / 3.0;
    return [profile.lateralAmp * width * Math.sin(phase), profile.depthAmp * width * Math.sin(2.0 * phase)];
  }
  const phase = omega * s + Math.PI * strand;
  return [profile.lateralAmp * width * Math.cos(phase), profile.depthAmp * width * Math.sin(phase)];
}

function sweepStrands(spec, profile, centerline, lateral0, outward, noise, lod0, lod1, strandId, includeLOD0) {
  const [, N, B] = rotationMinimizingFrames(centerline, lateral0, outward);
  const sVals = arcLengths(centerline);
  const total = sVals[sVals.length - 1];
  const w = spec.width;
  const fracs = sVals.map((s) => (total > 0 ? s / total : 0));
  let rMax = 0.0;
  for (let strand = 0; strand < profile.strands; strand++) {
    const centers = [], radii = [];
    for (let k = 0; k < sVals.length; k++) {
      const s = sVals[k];
      const [lat, dep] = strandOffset(profile, strand, s, w);
      const scale = feedScale(spec.kind, s);
      centers.push(add(centerline[k], add(mul(N[k], lat * scale), mul(B[k], dep * scale))));
      const r = radiusProfile(spec.kind, s, total, w, profile.strandRadius, noise);
      radii.push(r);
      rMax = Math.max(rMax, r);
    }
    if (includeLOD0) {
      let Ns = N, Bs = B;
      if (profile.strands > 1) [, Ns, Bs] = rotationMinimizingFrames(centers, N[0], outward);
      lod0.extend(tube(centers, Ns, Bs, radii, spec.lod0_sides, true, 1.0 / (profile.period * w), sVals, fracs, strandId));
    }
  }
  const idx = [];
  for (let i = 0; i < centerline.length; i += 4) idx.push(i);
  if (idx[idx.length - 1] !== centerline.length - 1) idx.push(centerline.length - 1);
  const shellC = idx.map((i) => centerline[i]);
  const shellR = idx.map((i) => {
    const s = sVals[i];
    let base = profile.shellRadius * w * feedScale(spec.kind, s);
    if (spec.kind === StyleKind.LOCS) base *= 1.0 + 0.12 * noise.at(s);
    if (s > total * 0.94) base *= 1.0 - 0.45 * smoothstep(total * 0.94, total, s);
    return base;
  });
  lod1.extend(tube(shellC, idx.map((i) => N[i]), idx.map((i) => B[i]), shellR, spec.lod1_sides, true,
    1.0 / (profile.period * w), idx.map((i) => sVals[i]), idx.map((i) => fracs[i]), strandId));
  return rMax;
}

function partDirection(root) {
  const sweep = 1.1 * Math.max(0.0, Math.cos(root.phi));
  return normalize(add(root.normal, mul(root.tBack, sweep)));
}

function polylineLength(points) {
  const segs = [];
  for (let i = 1; i < points.length; i++) segs.push(length(sub(points[i], points[i - 1])));
  return pySum(segs);
}

/**
 * Generator form of generate(): yields {done, total} after each strand so a
 * caller can time-slice on the main thread or report progress from a worker.
 * Returns the StyleResult.
 */
export function* generateSteps(spec, head = new HeadProxy(), options = {}) {
  const drapeParams = options.drapeParams || DRAPE_DEFAULTS;
  const includeLOD0 = options.includeLOD0 !== false;
  const problems = validateSpec(spec);
  if (problems.length) throw new Error(problems.join('; '));
  const profile = PROFILES[spec.kind];
  const w = spec.width;
  const period = profile.period * w;
  const denseSpacing = period / spec.samples_per_period;
  const drapeSegment = Math.max(0.5 * w, 0.008);
  const clearance = profile.shellRadius * w;
  const lod0 = new Mesh(), lod1 = new Mesh();
  const strands = [];
  let rootRecords;

  if (spec.kind === StyleKind.CORNROWS) {
    const paths = cornrowPaths(head, spec.cornrow_rows, CORNROW_WIDTH_FRACTION, drapeSegment, spec.hairline_margin);
    rootRecords = [];
    for (let ri = 0; ri < paths.length; ri++) {
      const path = paths[ri];
      const lifted = path.map((p) => add(p, mul(head.normalAt(head.toSurface(p)), 0.35 * w)));
      const coarse = drape(head, lifted, spec.length, drapeSegment, clearance, drapeParams, 1.25 * clearance);
      let [dense, ctrl] = catmullRomIndexed(coarse, denseSpacing);
      const keep = ctrl[lifted.length - 1] + 1;
      dense = relaxCurvature(head, dense, 1.1 * clearance, 0.9 * clearance, denseSpacing, keep);
      const outward = head.normalAt(head.toSurface(path[0]));
      const t0 = normalize(sub(path[1], path[0]));
      const lateral0 = normalize(cross(outward, t0));
      const noise = new ValueNoise(deriveSeed(spec.seed, `noise:${ri}`), 0.02, Math.trunc(dense.length * denseSpacing / 0.02) + 4);
      const rMax = sweepStrands(spec, profile, dense, lateral0, outward, noise, lod0, lod1, ri, includeLOD0);
      strands.push({ rootIndex: ri, centerline: dense, radiusMax: rMax, freeFromS: polylineLength(lifted) });
      rootRecords.push(path[0]);
      yield { done: ri + 1, total: paths.length };
    }
  } else {
    rootRecords = gridSections(head, w, spec.jitter, spec.seed, spec.hairline_margin);
    const lift = 0.6 * w;
    for (const root of rootRecords) {
      const fixed = [root.point, add(root.point, mul(partDirection(root), lift))];
      const coarse = drape(head, fixed, spec.length, drapeSegment, clearance, drapeParams, 1.25 * clearance);
      const dense = relaxCurvature(head, catmullRom(coarse, denseSpacing), 1.1 * clearance, 0.9 * clearance, denseSpacing, 1);
      const noise = new ValueNoise(deriveSeed(spec.seed, `noise:${root.index}`), 0.02, Math.trunc((spec.length + lift) / 0.02) + 6);
      const rMax = sweepStrands(spec, profile, dense, root.tSide, root.normal, noise, lod0, lod1, root.index, includeLOD0);
      strands.push({ rootIndex: root.index, centerline: dense, radiusMax: rMax, freeFromS: lift });
      yield { done: root.index + 1, total: rootRecords.length };
    }
  }

  const lengths = strands.map((s) => { const a = arcLengths(s.centerline); return a[a.length - 1]; });
  const stats = {
    kind: spec.kind,
    roots: strands.length,
    strands_per_root: profile.strands,
    lod0_vertices: lod0.vertexCount,
    lod0_triangles: lod0.triangleCount,
    lod1_vertices: lod1.vertexCount,
    lod1_triangles: lod1.triangleCount,
    mean_length_m: lengths.length ? pyRoundDigits(pySum(lengths) / lengths.length, 6) : 0.0,
  };
  return { spec, head, roots: rootRecords, strands, lod0, lod1, stats };
}

export function generate(spec, head = new HeadProxy(), options = {}) {
  const it = generateSteps(spec, head, options);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** Time-sliced generate for the main thread; aborts via AbortSignal. */
export async function generateAsync(spec, head = new HeadProxy(), { signal, onProgress, sliceMs = 12, ...options } = {}) {
  const it = generateSteps(spec, head, options);
  let deadline = performance.now() + sliceMs;
  for (;;) {
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    const r = it.next();
    if (r.done) return r.value;
    if (onProgress) onProgress(r.value.done / Math.max(1, r.value.total));
    if (performance.now() > deadline) {
      await new Promise((res) => setTimeout(res, 0));
      deadline = performance.now() + sliceMs;
    }
  }
}

// ---------------------------------------------------------------- digest

export const QUANTUM = 1e-5;

/** SHA-256 over quantised LOD0 + LOD1 positions and triangles (validate.digest). */
export async function digest(result) {
  const parts = [];
  for (const mesh of [result.lod0, result.lod1]) {
    const nv = mesh.vertexCount, nt = mesh.triangleCount;
    const buf = new ArrayBuffer(8 + nv * 24 + 8 + nt * 12);
    const dv = new DataView(buf);
    let o = 0;
    dv.setBigUint64(o, BigInt(nv), true); o += 8;
    for (let i = 0; i < nv * 3; i++) { dv.setBigInt64(o, BigInt(pyRound(mesh.positions[i] / QUANTUM)), true); o += 8; }
    dv.setBigUint64(o, BigInt(nt), true); o += 8;
    for (let i = 0; i < nt * 3; i++) { dv.setUint32(o, mesh.triangles[i], true); o += 4; }
    parts.push(new Uint8Array(buf));
  }
  const all = new Uint8Array(parts[0].length + parts[1].length);
  all.set(parts[0], 0);
  all.set(parts[1], parts[0].length);
  const h = await crypto.subtle.digest('SHA-256', all);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Constraint kernels shared with the live simulation (src/hairsim.js). Exported, not changed.
export { bendFlat, followTheLeaderFlat, collideFlat };
