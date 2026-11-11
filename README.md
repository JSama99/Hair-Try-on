# Hair Try-On — protective styles, live and in the browser

Try **knotless braids, box braids, two-strand twists, locs and cornrows** on your own head, built for Black women's hair: braids root at *your* hairline, sizes are in centimetres, colours use braiding-hair codes (1, 1B, 27, 30, 350, 613, 99J, ombrés), and when your own hair would still show past a style, the app says so instead of pretending.

- **Browser studio** (`web/`): a 3D bust of a young Black woman with Monk skin tones 1–10, your own photo, or a **live mirror** — the front camera with braids that swing as you move. MediaPipe finds the face and hair, the style is placed on your head, your hairline is matched and the honesty check runs. Nothing is uploaded: the page loads nothing from other websites, its own policy forbids connections to any other host, and it works offline once opened.
- **Easy to pass around:** any look as a link or QR code (four catalog ids, nothing personal), My looks (kept in the browser), hold-to-compare, and a stylist view that opens a customer's Style Card in 3D.
- **iPhone app** (`ios/`): live AR with ARKit face tracking, RealityKit, strand physics and a 3-second hairline calibration.
- **Salon pilot** (browser): a setup page (`setup.html`) writes the salon's settings file with no rebuild; Save My Look → a Style Card the customer shares with her stylist → booking through the salon's own Booksy / Square / Fresha link. No accounts, no backend, nothing sent automatically. See `docs/PILOT.md`.

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
| `docs/PILOT.md` | Salon pilot: configuration, customer journey, privacy boundaries, limits, demo script |
| `docs/GAPS.md` | Gap audit, the free tools researched, what was applied in v1.2, what is still open |

## Run the tests

```bash
cd reference && python3 -m pytest                              # 64 — oracle
cd web && npm install && bash tools/fetch-assets.sh && npm run build
npm test && npm run e2e                                        # 71 unit + 28 studio + 51 consultation + 26 live-mirror + 52 extras checks (studio, consultation, live mirror, extras)
cd ios/Packages/HairKit && swift test                          # 57 — on Linux add -Xlinker -lm
```

## Known limits

The browser live mirror has been verified with a synthetic camera in desktop Chromium, not yet on phones. Lengths stop at armpit until a body capture exists. Straight-back cornrows leave the sides above the ears bare. 1 cm micro braids need a hair-card LOD. A photo-based hairline estimate is good to about ±1 cm. Segmentation accuracy across Monk bands and curl patterns is not yet measured. The iPhone app code has not been compiled here — `docs/BUILD.md` lists what to check on the first device run.
