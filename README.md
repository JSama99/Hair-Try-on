# Hair Try-On — protective styles, live and in the browser

Try **knotless braids, box braids, two-strand twists, locs and cornrows** on your own head, built for Black women's hair: braids root at *your* hairline, sizes are in centimetres, colours use braiding-hair codes (1, 1B, 27, 30, 350, 613, 99J, ombrés), and when your own hair would still show past a style, the app says so instead of pretending.

- **Browser studio** (`web/`, published as an artifact): a 3D bust of a young Black woman with Monk skin tones 1–10, or your own photo — MediaPipe finds the face and hair, places the style, estimates your hairline and runs the honesty check. Everything stays in the tab.
- **iPhone app** (`ios/`): live AR with ARKit face tracking, RealityKit, strand physics and a 3-second hairline calibration.

| Path | What it is |
|---|---|
| `reference/protostyle/` | Python reference generator (v0.2) — the oracle both ports match |
| `reference/golden/` | Golden fixtures; `previews/` geometry renders (v0.1 shows the face-column bug v0.2 fixed) |
| `web/` | Browser studio: JS port, head fit, try-on logic, three.js app, build, tests |
| `ios/Packages/HairKit/` | Swift core: ProtoStyle, HeadFit, HairDynamics, TryOnCore — compiled and tested on Linux |
| `ios/App/` | SwiftUI + ARKit + RealityKit + MediaPipe app (not compiled in this environment) |
| `docs/ARCHITECTURE.md` | How it works, the determinism contract, measured error budgets, known limits |
| `docs/RESEARCH.md` | What open source can and cannot carry, with sources and a licence matrix |
| `docs/BUILD.md` | Commands, test results, and the on-device checklist |

## Run the tests

```bash
cd reference && python3 -m pytest                              # 64 — oracle
cd web && npm install && bash tools/fetch-assets.sh && npm run build
npm test && python3 test/e2e.py                                # 35 unit + 28 end-to-end checks
cd ios/Packages/HairKit && swift test                          # 57 — on Linux add -Xlinker -lm
```

## Known limits

Lengths stop at armpit until a body capture exists. Straight-back cornrows leave the sides above the ears bare. 1 cm micro braids need a hair-card LOD. A photo-based hairline estimate is good to about ±1 cm. Segmentation accuracy across Monk bands and curl patterns is not yet measured. The iPhone app code has not been compiled here — `docs/BUILD.md` lists what to check on the first device run.
