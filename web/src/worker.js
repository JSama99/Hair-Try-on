// worker.js — runs protostyle off the main thread. The build inlines this file
// as a blob: Worker (the artifact CSP allows blob: workers).
//
// Request:  {id, spec, head, triangleBudget}
// Progress: {id, progress}
// Reply:    {id, lod: 0|1, positions, normals, uvs, fracs, strandIds, indices, stats, ms}
//           typed arrays are transferred, not copied.

import { generateSteps, HeadProxy, PROFILES } from './protostyle.js';

/** Upper-bound estimate of LOD0 triangles (cornrow paths add their on-scalp run, ~0.3 m). */
export function estimateLod0Triangles(spec, roots) {
  const profile = PROFILES[spec.kind];
  const spacing = (profile.period * spec.width) / spec.samples_per_period;
  const run = spec.length + (spec.kind === 'cornrows' ? 0.30 : 0.6 * spec.width);
  const rings = Math.ceil(run / spacing) + 1;
  return roots * profile.strands * rings * spec.lod0_sides * 2;
}

export function packMesh(mesh) {
  return {
    positions: Float32Array.from(mesh.positions),
    normals: Float32Array.from(mesh.normals),
    uvs: Float32Array.from(mesh.uvs),
    fracs: Float32Array.from(mesh.fracs),
    strandIds: Float32Array.from(mesh.strandIds),
    indices: Uint32Array.from(mesh.triangles),
  };
}

export function runJob({ spec, head, triangleBudget = 1_500_000 }, onProgress) {
  const t0 = performance.now();
  const headProxy = new HeadProxy(head);
  // Decide the level of detail before generating so we never build what we will not draw:
  // LOD1 is always built (it is cheap); LOD0 only when it fits the triangle budget.
  const probe = generateSteps({ ...spec, length: 0 }, headProxy, { includeLOD0: false });
  let r;
  do { r = probe.next(); } while (!r.done);
  const est = estimateLod0Triangles(spec, r.value.stats.roots);
  const includeLOD0 = est <= triangleBudget;
  const it = generateSteps(spec, headProxy, { includeLOD0 });
  let res;
  for (;;) {
    const step = it.next();
    if (step.done) { res = step.value; break; }
    onProgress(step.value.done / Math.max(1, step.value.total));
  }
  const mesh = includeLOD0 ? res.lod0 : res.lod1;
  return { lod: includeLOD0 ? 0 : 1, ...packMesh(mesh), stats: res.stats, estimate: est, ms: performance.now() - t0 };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    const { id } = e.data;
    try {
      let last = 0;
      const out = runJob(e.data, (p) => {
        const now = performance.now();
        if (now - last > 50) { last = now; self.postMessage({ id, progress: p }); }
      });
      self.postMessage({ id, ...out }, [out.positions.buffer, out.normals.buffer, out.uvs.buffer, out.fracs.buffer, out.strandIds.buffer, out.indices.buffer]);
    } catch (err) {
      self.postMessage({ id, error: String(err && err.message ? err.message : err) });
    }
  };
}
