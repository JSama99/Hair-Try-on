// hairsim.js — live motion for a generated style in the browser (twin of HairKit/HairDynamics).
//
// Continues the reference solver at runtime on a coarse chain per strand (one node per drape
// segment, ~1 cm): Verlet in world space, then per pass bend -> collide -> follow-the-leader
// (last, so every step ends exactly inextensible) with the DFTL velocity correction. Collisions
// are resolved in the head frame through the current pose, using the generator's own kernels.
// Fixed 1/90 s steps, at most 6 per frame. LOD1 shells are skinned to the chains by the minimal
// rotation of each segment. Pure maths: no DOM, no three.js.

import { resamplePolyline, arcLengths, PROFILES, bendFlat, collideFlat, followTheLeaderFlat } from './protostyle.js';

export const SIM_DEFAULTS = Object.freeze({
  dt: 1 / 90, gravity: 9.81, damping: 0.97, passes: 4, bendStiffness: 0.35, ftlDamping: 0.9, maxStepsPerAdvance: 6,
});

// ---------------------------------------------------------------- pose (head frame -> world)
// A pose is a Float64Array(12): the three head axes in world (columns), then the translation.

export const IDENTITY_POSE = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

/** Yaw about +Y, pitch about +X, roll about +Z (R = Ry Rx Rz), then translation. */
export function eulerPose(yaw = 0, pitch = 0, roll = 0, t = [0, 0, 0]) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  return Float64Array.of(
    cy * cr + sy * sp * sr, cp * sr, -sy * cr + cy * sp * sr,
    -cy * sr + sy * sp * cr, cp * cr, sy * sr + cy * sp * cr,
    sy * cp, -sp, cy * cp,
    t[0], t[1], t[2]);
}

/**
 * MediaPipe's facial transformation matrix (column-major 4x4, canonical face in cm -> camera cm)
 * as a rigid pose in metres. The matrix may carry a uniform scale s; dividing the camera space by
 * 100 s keeps the head at its true size, which is what gravity and the colliders need.
 */
export function poseFromMatrix(m) {
  const s = Math.hypot(m[0], m[1], m[2]) || 1;
  const k = 1 / (100 * s);
  return Float64Array.of(m[0] / s, m[1] / s, m[2] / s, m[4] / s, m[5] / s, m[6] / s, m[8] / s, m[9] / s, m[10] / s, m[12] * k, m[13] * k, m[14] * k);
}

export function interpolatePose(a, b, f, out = new Float64Array(12)) {
  // Linear blend of axes, re-orthonormalised (poses between frames differ by a few degrees).
  let x0 = a[0] + (b[0] - a[0]) * f, x1 = a[1] + (b[1] - a[1]) * f, x2 = a[2] + (b[2] - a[2]) * f;
  let n = Math.hypot(x0, x1, x2) || 1; x0 /= n; x1 /= n; x2 /= n;
  let y0 = a[3] + (b[3] - a[3]) * f, y1 = a[4] + (b[4] - a[4]) * f, y2 = a[5] + (b[5] - a[5]) * f;
  const d = x0 * y0 + x1 * y1 + x2 * y2;
  y0 -= x0 * d; y1 -= x1 * d; y2 -= x2 * d;
  n = Math.hypot(y0, y1, y2) || 1; y0 /= n; y1 /= n; y2 /= n;
  out[0] = x0; out[1] = x1; out[2] = x2; out[3] = y0; out[4] = y1; out[5] = y2;
  out[6] = x1 * y2 - x2 * y1; out[7] = x2 * y0 - x0 * y2; out[8] = x0 * y1 - x1 * y0;
  for (let i = 9; i < 12; i++) out[i] = a[i] + (b[i] - a[i]) * f;
  return out;
}

// ---------------------------------------------------------------- 1€ filter (Casiez et al., CHI 2012)

export class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.reset();
  }
  static alpha(cutoff, dt) { return 1 / (1 + (1 / (2 * Math.PI * cutoff)) / dt); }
  reset() { this.x = null; this.dx = 0; this.lastTime = null; }
  filter(value, time) {
    if (this.x === null || !(time > this.lastTime)) { this.x = value; this.lastTime = time; this.dx = 0; return value; }
    const dt = time - this.lastTime;
    this.dx += OneEuroFilter.alpha(this.dCutoff, dt) * ((value - this.x) / dt - this.dx);
    const out = this.x + OneEuroFilter.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (value - this.x);
    this.x = out; this.lastTime = time;
    return out;
  }
}

/**
 * Smooths a MediaPipe pose matrix: translation (cm), uniform scale and rotation (as a quaternion
 * kept in one hemisphere) each through a 1€ filter. Low jitter when still, low lag when moving.
 */
export class PoseFilter {
  constructor({ minCutoff = 1.2, betaT = 0.06, betaR = 1.2 } = {}) {
    this.t = [0, 1, 2].map(() => new OneEuroFilter(minCutoff, betaT));
    this.q = [0, 1, 2, 3].map(() => new OneEuroFilter(minCutoff, betaR));
    this.s = new OneEuroFilter(0.5, 0.02);
    this.lastQ = null;
  }
  reset() { for (const f of [...this.t, ...this.q, this.s]) f.reset(); this.lastQ = null; }
  update(m, time) {
    const s = Math.hypot(m[0], m[1], m[2]) || 1;
    let q = quatFromAxes(m[0] / s, m[1] / s, m[2] / s, m[4] / s, m[5] / s, m[6] / s, m[8] / s, m[9] / s, m[10] / s);
    if (this.lastQ && q[0] * this.lastQ[0] + q[1] * this.lastQ[1] + q[2] * this.lastQ[2] + q[3] * this.lastQ[3] < 0) q = q.map((v) => -v);
    q = q.map((v, i) => this.q[i].filter(v, time));
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    q = q.map((v) => v / n);
    this.lastQ = q;
    const sf = this.s.filter(s, time);
    const [x, y, z, w] = q;
    const out = new Array(16).fill(0);
    out[0] = (1 - 2 * (y * y + z * z)) * sf; out[1] = 2 * (x * y + z * w) * sf; out[2] = 2 * (x * z - y * w) * sf;
    out[4] = 2 * (x * y - z * w) * sf; out[5] = (1 - 2 * (x * x + z * z)) * sf; out[6] = 2 * (y * z + x * w) * sf;
    out[8] = 2 * (x * z + y * w) * sf; out[9] = 2 * (y * z - x * w) * sf; out[10] = (1 - 2 * (x * x + y * y)) * sf;
    out[12] = this.t[0].filter(m[12], time); out[13] = this.t[1].filter(m[13], time); out[14] = this.t[2].filter(m[14], time);
    out[15] = 1;
    return out;
  }
}

/** Unit quaternion [x, y, z, w] of the rotation whose columns are (a, b, c). */
export function quatFromAxes(a0, a1, a2, b0, b1, b2, c0, c1, c2) {
  const tr = a0 + b1 + c2;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); return [(b2 - c1) * s, (c0 - a2) * s, (a1 - b0) * s, 0.25 / s]; }
  if (a0 > b1 && a0 > c2) { const s = 2 * Math.sqrt(1 + a0 - b1 - c2); return [0.25 * s, (b0 + a1) / s, (c0 + a2) / s, (b2 - c1) / s]; }
  if (b1 > c2) { const s = 2 * Math.sqrt(1 + b1 - a0 - c2); return [(b0 + a1) / s, 0.25 * s, (c1 + b2) / s, (c0 - a2) / s]; }
  const s = 2 * Math.sqrt(1 + c2 - a0 - b1);
  return [(c0 + a2) / s, (c1 + b2) / s, 0.25 * s, (a1 - b0) / s];
}

// ---------------------------------------------------------------- chains

/**
 * Coarse simulation chains for a generated style (runs in the worker; the arrays transfer).
 * One chain per strand, resampled at the drape segment length; nodes up to `freeFromS` are pinned.
 */
export function buildChains(result) {
  const { spec, strands } = result;
  const segment = Math.max(0.5 * spec.width, 0.008);
  const counts = new Uint32Array(strands.length), pinned = new Uint32Array(strands.length);
  const ds = new Float64Array(strands.length), totals = new Float64Array(strands.length), rootIds = new Float64Array(strands.length);
  const all = [];
  strands.forEach((strand, k) => {
    const lens = arcLengths(strand.centerline);
    const total = lens[lens.length - 1];
    const nodes = resamplePolyline(strand.centerline, segment);
    const d = total / Math.max(1, nodes.length - 1);
    let pin = 0;
    for (let i = 0; i < nodes.length; i++) if (i * d <= strand.freeFromS + 1e-9) pin = i + 1;
    counts[k] = nodes.length;
    pinned[k] = Math.min(Math.max(2, pin), nodes.length);
    ds[k] = d; totals[k] = total; rootIds[k] = strand.rootIndex;
    for (const p of nodes) all.push(p[0], p[1], p[2]);
  });
  const clearance = PROFILES[spec.kind].shellRadius * spec.width;
  return { nodes: Float64Array.from(all), counts, pinned, ds, totals, rootIds, clearance, minBendRadius: 1.25 * clearance };
}

export class HairSimulation {
  /**
   * @param chains  buildChains() output
   * @param head    HeadProxy (collision shape, head frame)
   * @param mesh    LOD1 {positions, normals, fracs, strandIds}: fracs are arc-length fractions along
   *                the strand and strandIds the root index, both written by the generator
   */
  constructor(chains, head, mesh, params = SIM_DEFAULTS) {
    this.head = head;
    this.params = params;
    this.chains = chains;
    this.rest = chains.nodes;
    const n = this.rest.length / 3;
    this.nodeCount = n;
    this.offsets = new Uint32Array(chains.counts.length);
    let o = 0, maxCount = 0;
    for (let k = 0; k < chains.counts.length; k++) { this.offsets[k] = o; o += chains.counts[k]; maxCount = Math.max(maxCount, chains.counts[k]); }
    this.positions = new Float64Array(3 * n);
    this.previous = new Float64Array(3 * n);
    this.accum = new Float64Array(3 * n);
    this.stepStart = new Float64Array(3 * n);
    this.local = new Float64Array(3 * maxCount);
    this.corr = new Float64Array(3 * maxCount);
    this.headNodes = new Float64Array(3 * n);
    this.segRot = new Float64Array(9 * n);
    this.pose = Float64Array.from(IDENTITY_POSE);
    this.scratchPose = new Float64Array(12);
    this.timeBank = 0;
    this.stepCount = 0;
    this.bind(mesh);
    this.reset(this.pose);
  }

  bind(mesh) {
    const { chains, rest } = this;
    const byRoot = new Map();
    chains.rootIds.forEach((id, k) => byRoot.set(id, k));
    const nv = mesh.positions.length / 3;
    this.bindA = new Uint32Array(nv);
    this.bindT = new Float32Array(nv);
    this.bindOffset = new Float32Array(3 * nv);
    this.bindNormal = Float32Array.from(mesh.normals);
    // Rest direction of every segment (node i -> i + 1 within a chain).
    this.restDir = new Float64Array(3 * this.nodeCount);
    for (let k = 0; k < chains.counts.length; k++) {
      for (let i = 0; i + 1 < chains.counts[k]; i++) {
        const a = 3 * (this.offsets[k] + i);
        const dx = rest[a + 3] - rest[a], dy = rest[a + 4] - rest[a + 1], dz = rest[a + 5] - rest[a + 2];
        const l = Math.hypot(dx, dy, dz) || 1;
        this.restDir[a] = dx / l; this.restDir[a + 1] = dy / l; this.restDir[a + 2] = dz / l;
      }
    }
    for (let v = 0; v < nv; v++) {
      const k = byRoot.get(mesh.strandIds[v]);
      if (k === undefined) throw new Error(`vertex ${v} belongs to unknown strand ${mesh.strandIds[v]}`);
      const s = mesh.fracs[v] * chains.totals[k];
      const d = chains.ds[k];
      const i = Math.min(chains.counts[k] - 2, Math.max(0, Math.floor(s / d)));
      const t = Math.min(1, Math.max(0, (s - i * d) / d));
      const a = this.offsets[k] + i;
      this.bindA[v] = a;
      this.bindT[v] = t;
      for (let c = 0; c < 3; c++) {
        const base = rest[3 * a + c] + (rest[3 * a + 3 + c] - rest[3 * a + c]) * t;
        this.bindOffset[3 * v + c] = mesh.positions[3 * v + c] - base;
      }
    }
  }

  applyPose(p, src, i, dst, j) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    dst[j] = p[0] * x + p[3] * y + p[6] * z + p[9];
    dst[j + 1] = p[1] * x + p[4] * y + p[7] * z + p[10];
    dst[j + 2] = p[2] * x + p[5] * y + p[8] * z + p[11];
  }

  inversePose(p, src, i, dst, j) {
    const x = src[i] - p[9], y = src[i + 1] - p[10], z = src[i + 2] - p[11];
    dst[j] = p[0] * x + p[1] * y + p[2] * z;
    dst[j + 1] = p[3] * x + p[4] * y + p[5] * z;
    dst[j + 2] = p[6] * x + p[7] * y + p[8] * z;
  }

  /** Place every chain at its rest shape under `pose`, at rest. */
  reset(pose) {
    this.pose.set(pose);
    for (let i = 0; i < this.nodeCount; i++) this.applyPose(pose, this.rest, 3 * i, this.positions, 3 * i);
    this.previous.set(this.positions);
    this.stepStart.set(this.positions);
    this.accum.fill(0);
    this.timeBank = 0;
  }

  /**
   * Run `seconds` at a fixed pose, then zero the velocity. The generator's 220-step drape can leave
   * a strand still sliding slowly; that should not play out on screen when a style is installed.
   */
  settle(pose, seconds = 2.5) {
    this.reset(pose);
    const steps = Math.floor(seconds / this.params.dt);
    for (let i = 0; i < steps; i++) this.step(pose);
    this.previous.set(this.positions);
    this.stepStart.set(this.positions);
    this.timeBank = 0;
  }

  /** Advance to `newPose` over `elapsed` seconds in fixed steps; pinned nodes interpolate between poses. */
  advance(newPose, elapsed) {
    const { params } = this;
    this.timeBank += Math.max(0, elapsed);
    let steps = Math.floor(this.timeBank / params.dt);
    if (steps > params.maxStepsPerAdvance) { steps = params.maxStepsPerAdvance; this.timeBank = 0; } else this.timeBank -= steps * params.dt;
    if (steps === 0) { this.pose.set(newPose); this.pin(newPose); return 0; }
    const from = Float64Array.from(this.pose);
    for (let k = 1; k <= steps; k++) this.step(interpolatePose(from, newPose, k / steps, this.scratchPose));
    this.pose.set(newPose);
    return steps;
  }

  pin(p) {
    const { chains, offsets } = this;
    for (let k = 0; k < chains.counts.length; k++) {
      for (let i = 0; i < chains.pinned[k]; i++) this.applyPose(p, this.rest, 3 * (offsets[k] + i), this.positions, 3 * (offsets[k] + i));
    }
  }

  step(p) {
    const { params, chains, offsets, positions, previous, accum, local, corr } = this;
    const gy = -params.gravity * params.dt * params.dt;
    this.stepStart.set(positions);
    this.pin(p);
    for (let k = 0; k < chains.counts.length; k++) {
      for (let i = chains.pinned[k]; i < chains.counts[k]; i++) {
        const j = 3 * (offsets[k] + i);
        for (let c = 0; c < 3; c++) {
          const x = positions[j + c];
          const v = (x - previous[j + c]) * params.damping;
          previous[j + c] = x;
          positions[j + c] = x + v + (c === 1 ? gy : 0);
          accum[j + c] = 0;
        }
      }
    }
    for (let pass = 0; pass < params.passes; pass++) {
      for (let k = 0; k < chains.counts.length; k++) {
        const count = chains.counts[k], nFixed = chains.pinned[k], base = offsets[k];
        if (nFixed >= count) continue;
        for (let i = 0; i < count; i++) this.inversePose(p, positions, 3 * (base + i), local, 3 * i);
        bendFlat(local, count, nFixed, chains.ds[k], params.bendStiffness, chains.minBendRadius);
        collideFlat(local, count, nFixed, this.head, chains.clearance);
        followTheLeaderFlat(local, count, nFixed, chains.ds[k], corr);
        for (let i = nFixed; i < count; i++) {
          const j = 3 * (base + i), l = 3 * i;
          const cx = corr[l], cy = corr[l + 1], cz = corr[l + 2];
          accum[j] += p[0] * cx + p[3] * cy + p[6] * cz;
          accum[j + 1] += p[1] * cx + p[4] * cy + p[7] * cz;
          accum[j + 2] += p[2] * cx + p[5] * cy + p[8] * cz;
          this.applyPose(p, local, l, positions, j);
        }
      }
    }
    for (let k = 0; k < chains.counts.length; k++) {
      for (let i = chains.pinned[k]; i < chains.counts[k] - 1; i++) {
        const j = 3 * (offsets[k] + i);
        previous[j] += accum[j + 3] * params.ftlDamping;
        previous[j + 1] += accum[j + 4] * params.ftlDamping;
        previous[j + 2] += accum[j + 5] * params.ftlDamping;
      }
    }
    this.stepCount++;
  }

  /** Chain nodes in the head frame (what a renderer parented to the head needs). */
  nodesInHeadFrame() {
    for (let i = 0; i < this.nodeCount; i++) this.inversePose(this.pose, this.positions, 3 * i, this.headNodes, 3 * i);
    return this.headNodes;
  }

  /** Skinned LOD1 positions and normals in the head frame, written into Float32Arrays. */
  skin(outP, outN) {
    const nodes = this.nodesInHeadFrame();
    const { chains, offsets, restDir, segRot } = this;
    // One minimal rotation (rest direction -> current direction) per segment, as a 3x3 matrix.
    for (let k = 0; k < chains.counts.length; k++) {
      for (let i = 0; i + 1 < chains.counts[k]; i++) {
        const a = offsets[k] + i, j = 3 * a, m = 9 * a;
        let dx = nodes[j + 3] - nodes[j], dy = nodes[j + 4] - nodes[j + 1], dz = nodes[j + 5] - nodes[j + 2];
        const len = Math.hypot(dx, dy, dz);
        const ax = restDir[j], ay = restDir[j + 1], az = restDir[j + 2];
        if (len > 1e-12) { dx /= len; dy /= len; dz /= len; } else { dx = ax; dy = ay; dz = az; }
        minimalRotation(ax, ay, az, dx, dy, dz, segRot, m);
      }
    }
    const nv = this.bindA.length;
    const { bindA, bindT, bindOffset, bindNormal } = this;
    for (let v = 0; v < nv; v++) {
      const a = bindA[v], j = 3 * a, m = 9 * a, t = bindT[v], o = 3 * v;
      const ox = bindOffset[o], oy = bindOffset[o + 1], oz = bindOffset[o + 2];
      outP[o] = nodes[j] + (nodes[j + 3] - nodes[j]) * t + segRot[m] * ox + segRot[m + 3] * oy + segRot[m + 6] * oz;
      outP[o + 1] = nodes[j + 1] + (nodes[j + 4] - nodes[j + 1]) * t + segRot[m + 1] * ox + segRot[m + 4] * oy + segRot[m + 7] * oz;
      outP[o + 2] = nodes[j + 2] + (nodes[j + 5] - nodes[j + 2]) * t + segRot[m + 2] * ox + segRot[m + 5] * oy + segRot[m + 8] * oz;
      const nx = bindNormal[o], ny = bindNormal[o + 1], nz = bindNormal[o + 2];
      outN[o] = segRot[m] * nx + segRot[m + 3] * ny + segRot[m + 6] * nz;
      outN[o + 1] = segRot[m + 1] * nx + segRot[m + 4] * ny + segRot[m + 7] * nz;
      outN[o + 2] = segRot[m + 2] * nx + segRot[m + 5] * ny + segRot[m + 8] * nz;
    }
  }

  /** Largest free-node speed (m/s) over the last step, from actual displacement. */
  get maxSpeed() {
    const { chains, offsets, positions, stepStart } = this;
    let m = 0;
    for (let k = 0; k < chains.counts.length; k++) {
      for (let i = chains.pinned[k]; i < chains.counts[k]; i++) {
        const j = 3 * (offsets[k] + i);
        m = Math.max(m, Math.hypot(positions[j] - stepStart[j], positions[j + 1] - stepStart[j + 1], positions[j + 2] - stepStart[j + 2]));
      }
    }
    return m / this.params.dt;
  }
}

/** Column-major 3x3 of the minimal rotation taking unit a to unit b (Rodrigues), written at out[o..o+8]. */
export function minimalRotation(ax, ay, az, bx, by, bz, out, o) {
  let kx = ay * bz - az * by, ky = az * bx - ax * bz, kz = ax * by - ay * bx;
  const s = Math.hypot(kx, ky, kz);
  const c = ax * bx + ay * by + az * bz;
  if (s < 1e-12) {
    if (c > 0) { out[o] = 1; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; out[o + 4] = 1; out[o + 5] = 0; out[o + 6] = 0; out[o + 7] = 0; out[o + 8] = 1; return; }
    // Opposite: half-turn about any axis perpendicular to a (R = 2kk^T - I).
    let px = Math.abs(ax) < 0.9 ? 1 : 0, py = px ? 0 : 1, pz = 0;
    const d = px * ax + py * ay + pz * az;
    px -= ax * d; py -= ay * d; pz -= az * d;
    const n = Math.hypot(px, py, pz);
    px /= n; py /= n; pz /= n;
    out[o] = 2 * px * px - 1; out[o + 1] = 2 * px * py; out[o + 2] = 2 * px * pz;
    out[o + 3] = 2 * py * px; out[o + 4] = 2 * py * py - 1; out[o + 5] = 2 * py * pz;
    out[o + 6] = 2 * pz * px; out[o + 7] = 2 * pz * py; out[o + 8] = 2 * pz * pz - 1;
    return;
  }
  kx /= s; ky /= s; kz /= s;
  const t = 1 - c;
  out[o] = c + kx * kx * t; out[o + 1] = kz * s + kx * ky * t; out[o + 2] = -ky * s + kx * kz * t;
  out[o + 3] = -kz * s + kx * ky * t; out[o + 4] = c + ky * ky * t; out[o + 5] = kx * s + ky * kz * t;
  out[o + 6] = ky * s + kx * kz * t; out[o + 7] = -kx * s + ky * kz * t; out[o + 8] = c + kz * kz * t;
}
