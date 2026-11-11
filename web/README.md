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
| `src/salon-config.js`, `salon/salon.config.json` | the pilot salon: services mapped to catalog styles, booking links, validation |
| `src/style-card.js` | StyleCardV1: build, validate, export (JSON / text); never contains images |
| `src/consult-ui.js` | Save My Look, consultation details, sharing, booking handoff (see docs/PILOT.md) |
| `src/hairsim.js` | live strand physics and LOD1 skinning (twin of HairKit `HairDynamics`), 1€ pose filter |
| `src/live.js` | live mirror: camera, face tracking in video mode, periodic hair mask |
| `src/look-link.js` | a look as a link (`#look=…`), My looks storage; validated against the catalog |
| `src/extras-ui.js` | My looks, link and QR dialog, stylist's Style Card viewer |
| `src/setup.js`, `src/setup.template.html` | salon setup page: form → validated `salon.config.json`, preview, QR poster |
| `src/sw.js` | service worker: the page's own files, cached for offline use |
| `tools/build.mjs` | esbuild bundle inlined into `dist/index.html`; models as hash-checked JSON |
| `test/*.test.mjs` | node unit tests (oracle parity, logic) |
| `test/e2e.py`, `test/serve.py` | Playwright end to end under an artifact-like CSP, CDN served from pinned local packages |
| `test/e2e_live.py` | live mirror with a fake camera (a film rendered from the bust): tracking, physics, hairline, capture, camera release |
| `test/e2e_extras.py` | links and QR (decoded), My looks, card viewer, setup page, runtime salon settings, offline, the page's own CSP, axe-core, print, phone |
| `test/e2e_consult.py` | the consultation journey end to end (share/clipboard present and absent, hostile config, phone) |

Everything the page needs is in `dist/`: three.js is bundled, MediaPipe (library, wasm, models) and the fonts are the page's own files, and the tests fail on any request to another host. `node tools/build.mjs` adds a Content-Security-Policy `<meta>` (`connect-src 'self'`, the inline script allowed by hash); `ARTIFACT=1 node tools/build.mjs` leaves it out for hosts that wrap the page. If the host refuses WebAssembly compilation, photo mode falls back to placing the style by hand; if there is no camera, the live mirror says so.

The test "photos" are renders of the studio's own bust; no real person's image is used anywhere.
