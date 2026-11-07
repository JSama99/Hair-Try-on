# Braid Try-On Studio (browser)

A single page: three.js renders styles generated on the device by `src/protostyle.js` (an exact port of `reference/protostyle` v0.2) in a Web Worker.

| File | Role |
|---|---|
| `src/protostyle.js` | generator port; Float64Array drape; digest; `generateSteps`/`generateAsync` |
| `src/headfit.js` | fits the scalp proxy to a face mesh (twin of HairKit `HeadFitter`) |
| `src/canonical-face.js` | MediaPipe canonical face mesh in metres (generated, Apache-2.0) |
| `src/tryon.js` | catalog access, colour, honesty check, captions, MediaPipe camera maths, hairline estimate, mask helpers |
| `src/mesh-tools.js` | bust and occluder geometry: hole-free face, pressed skull, feminine sculpt, eyes, brows, lips, shoulders, hoops |
| `src/worker.js` | generation off the main thread with a triangle budget (LOD0 or LOD1) |
| `src/app.js` | UI, scene, photo pipeline, capture |
| `tools/build.mjs` | esbuild bundle inlined into `dist/index.html`; models as hash-checked JSON |
| `test/*.test.mjs` | node unit tests (oracle parity, logic) |
| `test/e2e.py`, `test/serve.py` | Playwright end to end under an artifact-like CSP, CDN served from pinned local packages |

Photo mode loads MediaPipe Tasks Vision 1.0.1 from jsDelivr (scripts) and the wasm binary and models from the page's own files. If the host refuses WebAssembly compilation, the page falls back to placing the style by hand.

The test "photos" are renders of the studio's own bust; no real person's image is used anywhere.
