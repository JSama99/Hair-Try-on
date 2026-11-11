// live.js — the live mirror: the front camera, MediaPipe face tracking in VIDEO mode, and a
// periodic hair mask for the honest-preview check. Camera frames are read by the models on this
// device and dropped; nothing is recorded, stored or sent. Rendering and physics stay in app.js.

import { PoseFilter } from './hairsim.js';

export const HAIR_INTERVAL_MS = 1500;
export const LOST_AFTER_MS = 600;

/** A plain-language reason for a getUserMedia failure. */
export function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The camera is blocked for this page. Allow camera access in your browser\'s site settings, or use Your photo instead.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. Use Your photo instead.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Another app is using the camera. Close it and try again.';
  return 'The camera could not be started here. Use Your photo instead.';
}

export function createLive({ video, loadTasks, onPose, onLost, onHair, onState, now = () => performance.now() }) {
  let stream = null;
  let tasks = null;
  let running = false;
  let handle = 0;
  let lastVideoTime = -1;
  let lastSeen = 0;
  let lastHair = 0;
  let lastFrame = 0;
  let lost = true;
  const filter = new PoseFilter();
  const hairCanvas = document.createElement('canvas');
  const stats = { frames: 0, tracked: 0, hairMasks: 0, detectMs: 0 };

  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  function schedule() {
    if (!running) return;
    handle = typeof video.requestVideoFrameCallback === 'function' ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  }

  function segmentHair(rawMatrix) {
    const w = video.videoWidth, h = video.videoHeight;
    const k = Math.min(1, 384 / Math.max(w, h));
    hairCanvas.width = Math.round(w * k);
    hairCanvas.height = Math.round(h * k);
    hairCanvas.getContext('2d', { willReadFrequently: false }).drawImage(video, 0, 0, hairCanvas.width, hairCanvas.height);
    const seg = tasks.hair.segment(hairCanvas);
    const masks = seg.confidenceMasks || [];
    const m = masks[masks.length > 1 ? 1 : 0];
    if (m) { onHair({ probs: m.getAsFloat32Array().slice(), w: m.width, h: m.height }, rawMatrix); stats.hairMasks++; }
    for (const mm of masks) mm.close();
    if (seg.close) seg.close();
  }

  function tick() {
    if (!running) return;
    const t = now();
    if (video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      stats.frames++;
      let matrix = null, landmarks = null;
      try {
        const t0 = now();
        const r = tasks.face.detectForVideo(video, t);
        stats.detectMs += 0.1 * ((now() - t0) - stats.detectMs);
        if (r.faceLandmarks && r.faceLandmarks.length && r.facialTransformationMatrixes && r.facialTransformationMatrixes.length) {
          matrix = Array.from(r.facialTransformationMatrixes[0].data);
          landmarks = r.faceLandmarks[0];
        }
      } catch (err) {
        console.warn('face tracking failed', err);
      }
      if (matrix) {
        if (lost) { filter.reset(); lost = false; onState('tracking'); }
        lastSeen = t;
        stats.tracked++;
        const dt = lastFrame ? Math.min(0.25, (t - lastFrame) / 1000) : 0;
        lastFrame = t;
        onPose({ matrix: filter.update(matrix, t / 1000), raw: matrix, landmarks, dt, w: video.videoWidth, h: video.videoHeight });
        if (t - lastHair > HAIR_INTERVAL_MS) {
          lastHair = t;
          try { segmentHair(matrix); } catch (err) { console.warn('hair mask failed', err); }
        }
      } else if (!lost && t - lastSeen > LOST_AFTER_MS) {
        lost = true;
        lastFrame = 0;
        onState('lost');
        onLost();
      }
    }
    schedule();
  }

  async function start() {
    if (running) return { ok: true };
    if (!supported()) {
      onState('error');
      return { ok: false, message: window.isSecureContext === false ? 'The camera needs a secure (https) page. Use Your photo instead.' : 'This browser cannot use the camera here. Use Your photo instead.' };
    }
    onState('starting');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (err) {
      onState('error');
      return { ok: false, message: cameraErrorMessage(err) };
    }
    video.srcObject = stream;
    try {
      await video.play();
      tasks = await loadTasks();
    } catch (err) {
      stop();
      onState('error');
      return { ok: false, message: 'Face tracking could not start in this browser. Use Your photo instead.' };
    }
    if (!stream) return { ok: false, message: '' }; // stopped while loading
    running = true;
    lost = true;
    lastVideoTime = -1; lastFrame = 0; lastHair = 0;
    onState('lost');
    schedule();
    return { ok: true };
  }

  function stop() {
    running = false;
    if (handle) {
      if (typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(handle);
      cancelAnimationFrame(handle);
      handle = 0;
    }
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    video.srcObject = null;
    filter.reset();
    onState('off');
  }

  /** Take a fresh hair mask on the next tracked frame (used by Match my hairline). */
  const requestHair = () => { lastHair = 0; };

  return { start, stop, supported, requestHair, stats, get running() { return running; }, get streaming() { return !!stream; } };
}
