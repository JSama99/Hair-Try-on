# Build, test, run

## What has been verified, and how

| Suite | Command | Result at hand-off |
|---|---|---|
| Python oracle | `cd reference && python3 -m pytest` | 64 passed |
| JS port + try-on logic | `cd web && npm test` | 35 passed |
| Browser end to end (Playwright, CSP modelled on the artifact host) | `cd web && npm run build && python3 test/e2e.py` | 28/28 checks |
| HairKit (Swift 6.0.3 on Linux) | `cd ios/Packages/HairKit && swift test` (Linux: add `-Xlinker -lm`) | 57 passed |
| iOS app | Xcode, on a device | **not compiled here** — see below |

## Browser studio

```bash
cd web
npm install                 # esbuild, three (for tests), @mediapipe/tasks-vision (for tests)
bash tools/fetch-assets.sh  # pinned models + wasm from npm, SHA-256 checked (assets.lock)
npm run build               # dist/index.html + dist/models/*.json + dist/mediapipe/*.wasm
npm test                    # node unit tests
python3 test/e2e.py         # needs: pip install playwright (Chromium is pre-installed here)
```

`dist/` is published as an artifact. Models ship as JSON `{sha256, base64}` because the host serves standard web media types only; the page verifies the hash after decoding.

## iPhone app

Requirements: macOS with Xcode 16+ (iOS 18 SDK), XcodeGen, CocoaPods, an iPhone with a TrueDepth front camera.

```bash
cd ios
bash scripts/bootstrap.sh   # fetch-models.sh, xcodegen generate (runs pod install)
open HairTryOn.xcworkspace  # set your signing team, run on the device
```

`scripts/fetch-models.sh` takes Google's `latest` model when its SHA-256 matches the pin and otherwise the byte-identical npm copy; it never installs an unpinned file.

### First on-device run: what to check

The app layer was written against the documented iOS 18 APIs but could not be compiled in this environment. Expect a short round of compile fixes. Then verify, in order:

| ID | Check | How |
|---|---|---|
| D1 | Compiles with Swift 6 strict concurrency | build; fix any `Sendable`/actor diagnostics in `TryOnEngine` delegate hops |
| D2 | Hair sits on the head and follows it | turn and nod; braids stay rooted, swing, settle within ~1 s |
| D3 | Occlusion | turn 90°: back braids hide behind the head, front ones stay visible |
| D4 | Overlay orientation | raise a hand on one side with loose hair visible; the amber wash must be on the same side. If mirrored, flip `DisplayFrameRenderer.screenIsMirrored` |
| D5 | Calibration | Hairline → Match my hairline with hair pulled back; braids should move to your hairline |
| D6 | Honesty | with hair down, try cornrows: the warning appears; with a bonnet it must not |
| D7 | Frame time | Instruments: hair update + render within the budget in docs/ARCHITECTURE.md §4, 5 minutes without thermal throttling |
| D8 | Shader | plait lobes visible on LOD1 shells; ombré runs root to tip |

### Independent review of the uncompiled app layer

A separate reviewer checked `ios/App` against Apple's and MediaPipe's documentation (LowLevelMesh, CustomMaterial, the RealityKit surface-shader API, ARKit, MediaPipe Tasks, Swift 6 concurrency, SwiftUI). Fixed after review:

1. Probable Swift 6 compile error: the non-Sendable `ARFrame` captured into `MainActor.assumeIsolated`.
2. A stale in-flight build could land after a cached style (now cancelled first).
3. Rapid colour taps could finish out of order (one tracked material task, cancelled on change).
4. Camera frames were rendered for segmentation while the segmenter was busy (now skipped).
5. The shader passed a screen-space gradient to the tangent-space `set_normal` (now analytic in uv).
6. Control Centre or a banner reset tracking and rebuilt the style (now only a return from the background does).
7. The head-area silhouette used the current face mesh with an older camera snapshot (now snapshotted).
8. Build: user-script sandboxing off for CocoaPods; MediaPipe linked as dynamic frameworks, as in Google's samples; an explicit bitangent in the hair mesh.

Still to confirm on the device: D4 (overlay mirroring) and D8 (the relief reads as plaits).

## Still to measure (needs people and data, not code)

1. **Segmentation fairness:** hair-class IoU by Monk band (1–10) and curl pattern on a consented, stratified set. The public card reports a ~10-point drop at MST 9–10 for the multiclass model overall.
2. **Realism review (the layer no test can pass):** stylists and users across Monk bands judge the styles, the hairline and the honesty warning threshold (12% / 8%).
3. **Device floor:** which iPhones hold the frame budget.

## Regenerating cross-language fixtures

```bash
cd reference && python3 tools/make_golden.py     # goldens (a contract change: its own commit)
cd ios && bash scripts/sync-fixtures.sh          # canonical face + head-fit expectations for HairKit
```
