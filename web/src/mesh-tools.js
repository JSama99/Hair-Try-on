// mesh-tools.js — builds the studio bust and the photo-mode occluders from the
// canonical face mesh and the fitted head proxy (all in metres, face frame).
//
// The face mesh is a shell with open eyes and mouth; those holes are closed
// (so nothing shows through them) and the skull ellipsoid is pressed back
// behind the face along rays from the head centre, so the bust reads as one
// head and the occluder hides hair behind the face.
import * as THREE from 'three';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Orient triangles so their normals point away from `center`. */
export function orientOutward(V, F, center) {
  let s = 0;
  for (const [a, b, c] of F) {
    const n = cross(sub(V[b], V[a]), sub(V[c], V[a]));
    const m = [(V[a][0] + V[b][0] + V[c][0]) / 3, (V[a][1] + V[b][1] + V[c][1]) / 3, (V[a][2] + V[b][2] + V[c][2]) / 3];
    s += dot(n, sub(m, center));
  }
  return s >= 0 ? F.map((t) => t.slice()) : F.map(([a, b, c]) => [a, c, b]);
}

/** Boundary loops of a triangle mesh, each a list of vertex indices in edge order. */
export function boundaryLoops(F) {
  const count = new Map();
  for (const [a, b, c] of F) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    const k = u < v ? `${u},${v}` : `${v},${u}`;
    count.set(k, (count.get(k) || 0) + 1);
  }
  const next = new Map();
  for (const [a, b, c] of F) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    const k = u < v ? `${u},${v}` : `${v},${u}`;
    if (count.get(k) === 1) next.set(u, v);
  }
  const loops = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let v = start;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops.sort((a, b) => b.length - a.length);
}

/** Close a hole loop with a fan around its centroid, pushed `inset` metres into the head. */
function fillLoop(V, loop, inset) {
  const c = [0, 0, 0];
  for (const i of loop) { c[0] += V[i][0]; c[1] += V[i][1]; c[2] += V[i][2]; }
  c[0] /= loop.length; c[1] /= loop.length; c[2] = c[2] / loop.length - inset;
  const positions = [];
  for (let k = 0; k < loop.length; k++) {
    const a = V[loop[k]], b = V[loop[(k + 1) % loop.length]];
    // Boundary edges run a->b in the face's winding; the fill must run b->a to face the same way.
    positions.push(...b, ...a, ...c);
  }
  return { positions, centroid: c };
}

/** Möller–Trumbore: distance along unit ray (o, d) to the nearest triangle, or Infinity. */
export function rayMeshDistance(o, d, tris) {
  let best = Infinity;
  for (let t = 0; t < tris.length; t += 9) {
    const e1x = tris[t + 3] - tris[t], e1y = tris[t + 4] - tris[t + 1], e1z = tris[t + 5] - tris[t + 2];
    const e2x = tris[t + 6] - tris[t], e2y = tris[t + 7] - tris[t + 1], e2z = tris[t + 8] - tris[t + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det;
    const sx = o[0] - tris[t], sy = o[1] - tris[t + 1], sz = o[2] - tris[t + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist > 1e-6 && dist < best) best = dist;
  }
  return best;
}

// MediaPipe face-mesh landmark groups (canonical topology, 468 vertices).
export const LANDMARKS = Object.freeze({
  eyeR: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
  eyeL: [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249],
  browR: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  browL: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
  lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
    78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191],
});

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/**
 * Sculpt the canonical (androgynous) face toward softer, feminine proportions for
 * the studio bust: narrower jaw and chin, slimmer nose, softer brow ridge, fuller
 * lips, lifted cheekbones. Display only: head fitting always uses the canonical face.
 */
export function feminineFace(V) {
  const lips = new Set(LANDMARKS.lips);
  const eyeSets = [LANDMARKS.eyeR, LANDMARKS.eyeL].map((ids) => {
    const cx = ids.reduce((t, i) => t + V[i][0], 0) / ids.length, cy = ids.reduce((t, i) => t + V[i][1], 0) / ids.length;
    return { ids: new Set(ids), cx, cy };
  });
  // Every region falls off smoothly: a hard region edge stretches the triangles that cross it.
  const band = (v, a0, a1, b0, b1) => smooth(a0, a1, v) * (1 - smooth(b0, b1, v));
  return V.map(([x, y, z], i) => {
    let nx = x, ny = y, nz = z;
    const ax = Math.abs(x);
    const front = smooth(0.0, 0.03, z);
    nx *= 1 - 0.17 * smooth(-0.02, -0.094, y);                         // tapered, V-shaped jaw
    ny += 0.007 * smooth(-0.06, -0.094, y) * (1 - smooth(0.02, 0.045, ax)); // shorter, rounder chin
    nz -= 0.004 * band(y, 0.028, 0.045, 0.058, 0.072) * front;           // soft brow ridge
    const nose = (1 - smooth(0.008, 0.03, ax)) * band(y, -0.035, -0.02, 0.035, 0.05) * smooth(0.03, 0.05, z);
    nx *= 1 - 0.18 * nose;                                              // slimmer nose
    nz -= 0.002 * nose * smooth(0.0, 0.03, y);                          // lower, softer bridge
    nz += 0.003 * band(ax, 0.03, 0.045, 0.06, 0.072) * band(y, -0.025, -0.01, 0.015, 0.03); // cheekbones
    if (lips.has(i)) { nz += 0.003; ny += y < -0.044 ? -0.0016 : 0.0008; }  // fuller lips
    for (const e of eyeSets) if (e.ids.has(i)) ny = e.cy + (y - e.cy) * 1.45 + (y > e.cy ? 0.0005 : 0); // relaxed almond eyes
    return [nx, ny, nz];
  });
}

/** Triangles of `tris` whose three vertices are all in `ids` (a closed feature region). */
function regionTriangles(tris, ids) {
  const set = new Set(ids);
  return tris.filter(([a, b, c]) => set.has(a) && set.has(b) && set.has(c));
}

/** A feature overlay: the region's triangles lifted `lift` m along their normals, with planar UVs. */
function featureGeometry(V, tris, ids, lift, withUV) {
  const region = regionTriangles(tris, ids);
  const used = [...new Set(region.flat())];
  const remap = new Map(used.map((v, i) => [v, i]));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(used.flatMap((v) => V[v]), 3));
  g.setIndex(region.flat().map((v) => remap.get(v)));
  g.computeVertexNormals();
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal');
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) + nrm.getX(i) * lift, pos.getY(i) + nrm.getY(i) * lift, pos.getZ(i) + nrm.getZ(i) * lift);
  }
  if (withUV) {
    const xs = used.map((v) => V[v][0]), ys = used.map((v) => V[v][1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(used.flatMap((v) => [(V[v][0] - x0) / (x1 - x0), (V[v][1] - y0) / (y1 - y0)]), 2));
  }
  return g;
}

function geometryFrom(positions, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (index) g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

export function buildFaceParts(V0, F, head, { feminine = false } = {}) {
  const V = feminine ? feminineFace(V0) : V0;
  const center = [head.cx, head.cy, head.cz];
  const tris = orientOutward(V, F, center);
  const face = geometryFrom(V.flat(), tris.flat());

  const loops = boundaryLoops(tris);
  const eyes = [], mouth = [];
  for (const loop of loops.slice(1)) {
    const probe = fillLoop(V, loop, 0);
    const isMouth = probe.centroid[1] < -0.01;
    const filled = fillLoop(V, loop, isMouth ? 0.002 : 0.006);
    (isMouth ? mouth : eyes).push(...filled.positions);
  }

  // Ray targets: face plus the hole fills, flattened.
  const rayTris = new Float64Array(tris.length * 9 + eyes.length + mouth.length);
  let o = 0;
  for (const [a, b, c] of tris) for (const i of [a, b, c]) { rayTris[o++] = V[i][0]; rayTris[o++] = V[i][1]; rayTris[o++] = V[i][2]; }
  rayTris.set(eyes, o); o += eyes.length;
  rayTris.set(mouth, o);

  const sphere = new THREE.SphereGeometry(1, 112, 80);
  const pos = sphere.getAttribute('position');
  const rad = [head.rx, head.ry, head.rz];
  for (let i = 0; i < pos.count; i++) {
    const u = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const p = [u[0] * rad[0], u[1] * rad[1], u[2] * rad[2]];
    const len = Math.hypot(p[0], p[1], p[2]);
    const d = [p[0] / len, p[1] / len, p[2] / len];
    let r = len;
    if (d[2] > -0.35) {
      const hit = rayMeshDistance(center, d, rayTris);
      // Deeper behind the middle of the face (concave nose sides, eye sockets),
      // shallow near the face's edge so no ledge shows from the side.
      // Deep only across the eyes, nose and mouth; shallow at the forehead and edges so no ledge shows.
      const inset = 0.002 + 0.010 * smooth(0.2, 0.6, d[2]) * (1 - smooth(0.2, 0.42, d[1]));
      if (hit < len + 0.06) r = Math.min(r, hit - inset);
    }
    pos.setXYZ(i, center[0] + d[0] * r, center[1] + d[1] * r, center[2] + d[2] * r);
  }
  sphere.computeVertexNormals();

  const neckTop = feminine ? 0.038 : 0.05, neckBottom = feminine ? 0.045 : 0.058;
  const neck = new THREE.CylinderGeometry(neckTop, neckBottom, feminine ? 0.15 : 0.2, 48, 1, true);
  neck.translate(head.cx, feminine ? -0.07 : -0.105, head.cz + 0.008);

  let torso;
  if (feminine) {
    // Dress-form shoulders: lathe profile from the neck base, along a sloping
    // trapezius to rounded shoulders, then down to the chest; flattened front to back.
    const prof = [[0.0, -0.128], [0.043, -0.128], [0.058, -0.14], [0.09, -0.158], [0.128, -0.172], [0.158, -0.186],
      [0.176, -0.204], [0.182, -0.228], [0.178, -0.27], [0.168, -0.33], [0.162, -0.38]].map(([r, y]) => new THREE.Vector2(r, y));
    torso = new THREE.LatheGeometry(prof, 96);
    torso.scale(1, 1, 0.62);
    torso.translate(head.cx, 0, head.cz + 0.004);
  } else {
    torso = new THREE.SphereGeometry(1, 72, 36, 0, Math.PI * 2, 0, Math.PI * 0.62);
    torso.scale(0.205, 0.085, 0.118);
    torso.translate(head.cx, -0.205, head.cz - 0.006);
  }

  const ear = (side) => {
    const g = new THREE.SphereGeometry(1, 28, 18);
    g.scale(0.010, 0.029, 0.017);
    g.rotateY(side * 0.35);
    g.translate(head.cx + side * (head.rx - 0.002), head.cy - 0.028, head.cz + 0.006);
    return g;
  };

  // Small gold hoops hanging from the earlobes.
  const hoop = (side) => {
    const g = new THREE.TorusGeometry(0.0105, 0.0011, 12, 48);
    g.rotateY(Math.PI / 2);
    g.translate(head.cx + side * (head.rx + 0.003), head.cy - 0.028 - 0.026 - 0.0095, head.cz + 0.01);
    return g;
  };

  return {
    face, skull: sphere, neck, torso, earL: ear(1), earR: ear(-1),
    eyes: geometryFrom(eyes), mouth: geometryFrom(mouth),
    holeCount: loops.length - 1,
    feature: feminine ? {
      eyeL: featureGeometry(V, tris, LANDMARKS.eyeL, 0.0009, true),
      eyeR: featureGeometry(V, tris, LANDMARKS.eyeR, 0.0009, true),
      browL: featureGeometry(V, tris, LANDMARKS.browL, 0.0006, true),
      browR: featureGeometry(V, tris, LANDMARKS.browR, 0.0006, true),
      lips: featureGeometry(V, tris, LANDMARKS.lips, 0.0004, false),
      hoopL: hoop(1), hoopR: hoop(-1),
    } : null,
  };
}
