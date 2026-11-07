// tryon.js — pure try-on logic shared by the studio UI and its tests.
// Catalog, look colours, the honest-preview check, captions, and the camera
// maths that places the head proxy on a photo. No DOM, no three.js.

import catalog from '../../ios/Packages/HairKit/Sources/TryOnCore/Resources/catalog.json' with { type: 'json' };
import { makeSpec, StyleKind } from './protostyle.js';

export const CATALOG = catalog;
export const STYLES = catalog.styles;
export const LENGTHS = catalog.lengths;
export const COLORS = catalog.colors;
export const SKIN_TONES = catalog.skinTones;
export const HONESTY = catalog.honesty;

export const styleById = (id) => STYLES.find((s) => s.id === id);
export const lengthById = (id) => LENGTHS.find((l) => l.id === id);
export const colorById = (id) => COLORS.find((c) => c.id === id);
export const sizeOf = (style, sizeId) => style.sizes.find((s) => s.id === sizeId);

/** A look: {style, size, length, color}. Returns {ok, spec} or {ok:false, message}. */
export function specForLook(look, { hasBodyProxy = false, seed } = {}) {
  const style = styleById(look.style);
  if (!style) return { ok: false, message: `Unknown style ${look.style}` };
  const size = sizeOf(style, look.size) || sizeOf(style, style.defaultSize);
  const len = lengthById(look.length) || lengthById(style.defaultLength);
  if (len.requiresBody && !hasBodyProxy) {
    return { ok: false, locked: true, message: catalog.lockedLengthMessage.replace('{label}', len.label) };
  }
  const overrides = { width: size.width, length: len.length, has_body_proxy: hasBodyProxy };
  if (style.kind === StyleKind.CORNROWS) overrides.cornrow_rows = size.rows;
  if (seed !== undefined) overrides.seed = seed;
  return { ok: true, spec: makeSpec(style.kind, overrides), style, size, length: len };
}

// ---------------------------------------------------------------- colour

export function hexToSrgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Ombré weight at root->tip fraction f (0 at the root). */
export function ombreWeight(f) {
  const { start, end } = catalog.ombre;
  const t = Math.min(1, Math.max(0, (f - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

/** Linear-RGB colour of a look at fraction f; `jitter` in [-1,1] varies lightness per strand. */
export function lookColor(color, f, jitter = 0) {
  const root = hexToSrgb(color.hex).map(srgbToLinear);
  let c = root;
  if (color.tipHex) {
    const tip = hexToSrgb(color.tipHex).map(srgbToLinear);
    const w = ombreWeight(f);
    c = root.map((r, i) => r + (tip[i] - r) * w);
  }
  const k = 1 + 0.07 * jitter;
  return c.map((v) => Math.min(1, v * k));
}

/** Stable per-strand jitter in [-1, 1] (integer hash, no RNG state). */
export function strandJitter(id) {
  let x = (id + 1) * 0x9E3779B1;
  x = Math.imul(x ^ (x >>> 16), 0x85EBCA6B);
  x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

// ---------------------------------------------------------------- honest preview

/**
 * Compare the person's own hair (segmentation probabilities, 0..1) with the
 * silhouette the virtual style covers (0/1), both w*h in the same pixel grid.
 * ratio = share of the person's hair that the style leaves visible. A wrap or
 * slicked-back hair (very little hair at all) is reported as `wrapped`.
 */
/**
 * Close the gaps between strands: dilate a 0/1 mask by `r` pixels (square). Segmenters label
 * the whole hair region, gaps between braids included, so the style's raw strand silhouette
 * would count those gaps as "her hair showing".
 */
export function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = -1e9;
    for (let x = 0; x < w; x++) { if (mask[y * w + x]) run = x; tmp[y * w + x] = x - run <= r ? 1 : 0; }
    run = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (mask[y * w + x]) run = x; if (run - x <= r) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let run = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; out[y * w + x] = y - run <= r ? 1 : 0; }
    run = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

/** Dilation radius for a mask: 1.2% of its long side (3 px at 256). */
export const closingRadius = (w, h) => Math.max(1, Math.round(0.012 * Math.max(w, h)));

export function measureConflict(hair, style, w, h, headArea, threshold = HONESTY.maskThreshold) {
  let hairPx = 0, uncovered = 0;
  for (let i = 0; i < w * h; i++) {
    if (hair[i] >= threshold) {
      hairPx++;
      if (!style[i]) uncovered++;
    }
  }
  const ratio = hairPx ? uncovered / hairPx : 0;
  const hairShare = headArea > 0 ? hairPx / headArea : 0;
  return { hairPx, uncovered, ratio, hairShare, wrapped: hairShare < HONESTY.wrapped };
}

/** Hysteresis so the warning does not flicker: enter above 0.12, leave below 0.08. */
export function updateConflict(active, m) {
  if (m.wrapped) return false;
  if (!active && m.ratio > HONESTY.enter) return true;
  if (active && m.ratio < HONESTY.exit) return false;
  return active;
}

export function conflictTip(m) {
  const pct = Math.round(m.ratio * 100);
  return `About ${pct}% of the hair in your photo falls outside this style (shown in amber). In real life that hair has to be braided in or tucked away, so the result can look different from this preview. For the truest preview, use a photo with your hair pulled back or under a wrap.`;
}

// ---------------------------------------------------------------- caption

export function caption(look) {
  const style = styleById(look.style);
  const size = sizeOf(style, look.size) || sizeOf(style, style.defaultSize);
  const len = lengthById(look.length) || lengthById(style.defaultLength);
  const color = colorById(look.color) || colorById(catalog.defaults.color);
  const sizeText = style.kind === StyleKind.CORNROWS
    ? `${size.rows} rows, ${(size.width * 100).toFixed(1)} cm braids`
    : `${size.label.toLowerCase()} (${(size.width * 100).toFixed(1)} cm parts)`;
  const lenText = style.kind === StyleKind.CORNROWS ? `${len.label.toLowerCase()}-length tails` : `${len.label.toLowerCase()} length`;
  return `${style.name}, ${sizeText}, ${lenText}, colour ${color.label} (${color.name.toLowerCase()})`;
}

// ---------------------------------------------------------------- camera maths
//
// MediaPipe FaceLandmarker's facialTransformationMatrixes[i].data is a 4x4
// column-major matrix taking canonical-face-model coordinates (cm) to a
// right-handed camera frame (cm): camera at the origin looking down -Z, +Y up,
// rendered with a 63-degree vertical field of view (MediaPipe face_geometry
// default). tests/tryon.test.mjs checks this against recorded landmarks.

export const MP_VERTICAL_FOV = 63;

export function applyMat(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Camera-space point -> pixel (x right, y down) for a w*h image. */
export function projectToPixels(p, w, h, fovDeg = MP_VERTICAL_FOV) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const aspect = w / h;
  const xn = (f / aspect) * p[0] / -p[2];
  const yn = f * p[1] / -p[2];
  return [(xn + 1) * 0.5 * w, (1 - yn) * 0.5 * h];
}

/** Mean pixel error between projected canonical vertices (cm) and detected landmarks (normalised). */
export function reprojectionError(matrix, canonicalCm, landmarks, w, h, fovDeg = MP_VERTICAL_FOV) {
  let sum = 0;
  const n = Math.min(canonicalCm.length, landmarks.length);
  for (let i = 0; i < n; i++) {
    const [px, py] = projectToPixels(applyMat(matrix, canonicalCm[i]), w, h, fovDeg);
    sum += Math.hypot(px - landmarks[i].x * w, py - landmarks[i].y * h);
  }
  return sum / n;
}

/**
 * Manual placement when face landmarks are unavailable: the person drags a
 * head guide. cx, cy: guide centre in pixels; headWidthPx: on-image width of
 * the face at the cheekbones; rollDeg, yawDeg. Returns a column-major matrix in
 * the same convention as MediaPipe (canonical cm -> camera cm).
 */
export function manualPose({ cx, cy, headWidthPx, rollDeg = 0, yawDeg = 0 }, w, h, fovDeg = MP_VERTICAL_FOV, faceWidthCm = 15.3) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const pxPerUnitAtDepth1 = f * h * 0.5; // pixels per cm at z = -1 cm, vertically and horizontally
  const z = -(faceWidthCm * pxPerUnitAtDepth1) / headWidthPx;
  const x = ((cx - w / 2) / pxPerUnitAtDepth1) * -z;
  const y = ((h / 2 - cy) / pxPerUnitAtDepth1) * -z;
  const r = (rollDeg * Math.PI) / 180, yw = (yawDeg * Math.PI) / 180;
  const cr = Math.cos(r), sr = Math.sin(r), cyw = Math.cos(yw), syw = Math.sin(yw);
  // R = Rz(roll) * Ry(yaw), column-major.
  return [
    cr * cyw, sr * cyw, -syw, 0,
    -sr, cr, 0, 0,
    cr * syw, sr * syw, cyw, 0,
    x, y, z, 1,
  ];
}

// ---------------------------------------------------------------- hairline from a photo
//
// The web twin of HairKit's HairlineObserver + CalibrationSession, for a single
// photo: walk down each front meridian of the head proxy, label every sample as
// hair or not from the segmentation, and confirm the hair -> skin transition
// only after `confirm` consecutive samples on each side (labels are noisy at
// the hairline). The per-meridian median is the calibrated front hairline.

export const HAIRLINE = Object.freeze({
  phis: [-0.5, -0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5],
  thetaStart: 0.55, thetaEnd: 1.4, step: 0.01, confirm: 3, minMeridians: 5, clamp: [0.84, 1.16],
});

/** Invert scalp.hairline_theta for hairline_front: a hairline seen at (theta, phi) implies this front value. */
export function frontEquivalent(head, theta, phi) {
  const k = (1 - Math.cos(phi)) * 0.5;
  const q = (Math.abs(phi) - Math.PI * 0.5) / head.ear_notch_width;
  const notch = head.ear_notch * Math.exp(-(q * q));
  return (theta + notch - head.hairline_back * k) / (1 - k);
}

/**
 * project(pointMetres) -> [u, v] in 0..1 image coordinates (or null if off-image);
 * sampleHair(u, v) -> hair probability. Returns hairline_front (radians) or null.
 */
export function estimateHairlineFront(head, project, sampleHair, threshold = HONESTY.maskThreshold) {
  // Per meridian: the hairline is where hair stops for good, i.e. the end of the LAST confirmed
  // hair run that is followed by confirmed skin. (The first transition would stop at a part:
  // cornrow parts run exactly front to back, along the meridians.)
  const found = [];
  for (const phi of HAIRLINE.phis) {
    let hairRun = 0, skinRun = 0, skinStart = null, candidate = null, inHair = false;
    for (let th = HAIRLINE.thetaStart; th <= HAIRLINE.thetaEnd + 1e-9; th += HAIRLINE.step) {
      const uv = project(head.point(th, phi));
      if (!uv || uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) { hairRun = 0; skinRun = 0; continue; }
      if (sampleHair(uv[0], uv[1]) >= threshold) {
        hairRun++;
        skinRun = 0;
        if (hairRun >= HAIRLINE.confirm) { inHair = true; candidate = null; }
      } else {
        if (skinRun === 0) skinStart = th;
        skinRun++;
        hairRun = 0;
        if (inHair && skinRun >= HAIRLINE.confirm) { candidate = skinStart; inHair = false; }
      }
    }
    if (candidate !== null) found.push(frontEquivalent(head, candidate, phi));
  }
  if (found.length < HAIRLINE.minMeridians) return null;
  found.sort((a, b) => a - b);
  const mid = found.length >> 1;
  const median = found.length % 2 ? found[mid] : (found[mid - 1] + found[mid]) / 2;
  return Math.min(HAIRLINE.clamp[1], Math.max(HAIRLINE.clamp[0], median));
}

// ---------------------------------------------------------------- masks

export const threshold = (probs, t = HONESTY.maskThreshold) => Uint8Array.from(probs, (v) => (v >= t ? 1 : 0));

/** Nearest-neighbour resample of a w*h Float32/Uint8 mask to tw*th. */
export function resampleMask(src, w, h, tw, th) {
  const out = new src.constructor(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / tw));
      out[y * tw + x] = src[sy * w + sx];
    }
  }
  return out;
}

/** Fit a long side to `longSide` keeping aspect (mask working resolution). */
export function maskSize(w, h, longSide = 256) {
  const s = longSide / Math.max(w, h);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}
