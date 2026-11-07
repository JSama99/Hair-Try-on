// headfit.js — fit the scalp proxy to a tracked face mesh (JS twin of HairKit/HeadFit).
//
// Neither ARKit's face geometry nor MediaPipe's face mesh has a scalp, so the
// ellipsoidal head proxy (reference/protostyle/scalp.py) is fitted in closed
// form from the face mesh, in the mesh's own frame (metres, +Y up, +Z out of
// the face):
//
//   head ellipsoid  breadth from the widest face vertices, height from the
//                   face height (anthropometric ratio 0.56), placed so the
//                   front hairline point (theta = hairline_front, phi = 0)
//                   lands on the top-of-forehead vertex.
//   face keep-out   brow to below the chin, nose tip + 2 cm to the head
//                   centre, then grown just enough that every face vertex
//                   not already inside the head is inside the keep-out —
//                   so hanging hair can never cross the face.
//
// Presets differ only in where the mesh stops on the forehead: MediaPipe's
// canonical mesh reaches the hairline; ARKit's stops ~1.5 cm lower.

import { HeadProxy, HEAD_DEFAULTS } from './protostyle.js';

export const PRESETS = Object.freeze({
  mediapipe: { topRaise: 0.0 },
  arkit: { topRaise: 0.015 },
});

export const FIT = Object.freeze({
  heightRatio: 0.56,      // head semi-height / face height (chin -> forehead top)
  depthRatio: 0.97,       // head semi-depth / head semi-height
  breadthPad: 0.002,      // m added to the widest face half-breadth
  keepTopDrop: 0.06,      // keep-out top sits this fraction of face height below the hairline
  keepChinDrop: 0.12,     // and extends this fraction below the chin
  keepNoseGap: 0.02,      // m in front of the nose tip
  keepBreadth: 0.92,      // keep-out half-breadth / face half-breadth
  containMargin: 0.98,    // vertices must reach implicit <= this inside the keep-out
  minClearance: 0.004,    // m: thinnest strand envelope (4 mm parts); hair never gets closer to the head
  keepBackFrac: 0.25,     // keep-out reaches this fraction of the head semi-depth behind the head centre
});

/** A face vertex is protected when hair cannot reach it: inside the head inflated by the
 * thinnest strand clearance, above the keep-out top (root zone, hair is swept back there),
 * or inside the face keep-out. */
function needsKeepOut(head, v, kTop) {
  if (v[1] > kTop) return false;
  const d = [v[0] - head.cx, v[1] - head.cy, v[2] - head.cz];
  const a = d[0] / (head.rx + FIT.minClearance), b = d[1] / (head.ry + FIT.minClearance), c = d[2] / (head.rz + FIT.minClearance);
  return a * a + b * b + c * c >= 1.0;
}

function bounds(vertices) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let topIndex = 0;
  vertices.forEach((v, i) => {
    for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], v[c]); mx[c] = Math.max(mx[c], v[c]); }
    if (v[1] > vertices[topIndex][1]) topIndex = i;
  });
  return { mn, mx, topIndex };
}

/**
 * vertices: array of [x, y, z] in metres (face frame).
 * options.preset: 'mediapipe' | 'arkit'; options.hairline: {hairline_front, ear_notch} overrides
 * (from hairline calibration). Returns a HeadProxy.
 */
export function fitHead(vertices, { preset = 'mediapipe', hairline = {} } = {}) {
  if (!vertices || vertices.length < 16) throw new Error('fitHead needs a face mesh (>= 16 vertices)');
  const p = PRESETS[preset];
  if (!p) throw new Error(`unknown preset ${preset}`);
  const { mn, mx, topIndex } = bounds(vertices);
  const midX = (mn[0] + mx[0]) / 2;
  const halfBreadth = (mx[0] - mn[0]) / 2;
  const top = mx[1] + p.topRaise;
  const chin = mn[1];
  const faceH = top - chin;
  const noseZ = mx[2];
  const topZ = vertices[topIndex][2];
  const hf = hairline.hairline_front ?? HEAD_DEFAULTS.hairline_front;

  const rx = halfBreadth + FIT.breadthPad;
  const ry = FIT.heightRatio * faceH;
  const rz = FIT.depthRatio * ry;
  const cx = midX;
  const cy = top - ry * Math.cos(hf);
  const cz = topZ - rz * Math.sin(hf);

  const kTop = top - FIT.keepTopDrop * faceH;
  const kBottom = chin - FIT.keepChinDrop * faceH;
  const kFront = noseZ + FIT.keepNoseGap;
  const kBack = cz - FIT.keepBackFrac * rz;
  let frx = FIT.keepBreadth * halfBreadth;
  let fry = (kTop - kBottom) / 2;
  let frz = (kFront - kBack) / 2;
  const fx = midX, fy = (kTop + kBottom) / 2, fz = (kFront + kBack) / 2;

  const head0 = new HeadProxy({ ...HEAD_DEFAULTS, ...hairline, rx, ry, rz, cx, cy, cz, fx, fy, fz, frx, fry, frz });
  let worst = 0;
  for (const v of vertices) {
    if (!needsKeepOut(head0, v, kTop)) continue;
    worst = Math.max(worst, head0.faceImplicit(v));
  }
  if (worst > FIT.containMargin) {
    const s = Math.sqrt(worst / FIT.containMargin);
    frx *= s; fry *= s; frz *= s;
  }
  const fitted = head0.with({ frx, fry, frz });
  return fitted;
}

/** Fraction of face vertices hair cannot cross (see needsKeepOut). 1.0 for a valid fit. */
export function faceCoverage(head, vertices) {
  const kTop = head.fy + head.fry;
  let ok = 0;
  for (const v of vertices) if (!needsKeepOut(head, v, kTop) || head.faceImplicit(v) <= 1.0) ok++;
  return ok / vertices.length;
}
