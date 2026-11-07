# Architecture — protective-style try-on (iOS live AR + browser studio)

Working title: **Hair Try-On** (name is J-Sama's call).
Decisions (2026-09-26/27): live AR, iOS first, hair first (makeup and clothes later), open source where the licence allows.

What exists, and how far each part is verified:

| Part | Where | State |
|---|---|---|
| Reference generator (the oracle) | `reference/protostyle` | Python, 64 tests incl. golden, mutation and property tests |
| Browser studio | `web/` | built, unit + end-to-end tested, published as an artifact |
| Core library (generator port, head fit, physics, try-on logic) | `ios/Packages/HairKit` | Swift 6, compiled and tested on Linux |
| iOS app (ARKit, RealityKit, MediaPipe) | `ios/App` | written against the iOS 18 SDK, **not compiled here** (no iOS SDK in this environment) — `docs/BUILD.md` |

---

## 1. What it does

**iPhone (live):** point the front camera at yourself and see box braids, knotless braids, two-strand twists, locs or cornrows on your own head, live: braids root at your hairline (after a 3-second calibration), move when you turn, and are sized in centimetres with braiding-hair colour codes. When your own hair would still show past the style, the app says so and highlights it instead of pretending.

**Browser (studio):** the same generator on a 3D bust (a young Black woman, Monk skin tones 1–10), or on an uploaded photo: MediaPipe finds the face and the hair, the style is placed on the head, the hairline is estimated from the photo, and the same honesty check runs. Nothing leaves the tab.

Out of scope for v1: makeup, clothes (needs a body capture), afros and twist-outs (need a volumetric renderer), booking.

## 2. System

```
 ┌──────────────── iPhone, every frame (60 Hz) ───────────────────────────┐
 │ ARKit face tracking → pose + ARFaceGeometry (1,220 v)                    │
 │    ├─ HeadFitter (.arkit) → One Euro filter → settle gate (LiveSession)  │
 │    │     └─ settled new head → StyleEngine (off main, cached)            │
 │    ├─ face occluder mesh (follows expression)                            │
 │    └─ HairSimulation.advance (DFTL, 1/90 s steps) → skin LOD1 → GPU      │
 │ ~10 Hz: display-oriented frame → MediaPipe ImageSegmenter (live stream)  │
 │    ├─ calibration running → CalibrationSession → hairline fit (stored)   │
 │    └─ otherwise → style silhouette vs hair mask → honesty warning        │
 └──────────────────────────────────────────────────────────────────────────┘
 ┌──────────────── Browser studio ─────────────────────────────────────────┐
 │ protostyle.js in a Web Worker → LOD0 (≤ budget) or LOD1 → three.js        │
 │ photo: FaceLandmarker (pose matrix) + hair segmenter → place, estimate    │
 │        hairline, render silhouette, honesty check; or place by hand       │
 └──────────────────────────────────────────────────────────────────────────┘
```

## 3. Components

### 3.1 Reference generator (`reference/protostyle`, v0.2)
A clean-room procedural generator: scalp proxy → partings (brick grid or straight-back cornrow paths) → Verlet drape with follow-the-leader inextensibility, DFTL velocity correction, minimum bend radius and head/face collision → Catmull-Rom densification → curvature relaxation → rotation-minimising frames → 3-strand plaits, 2-strand helices or noise-varied ropes. Output: LOD0 per-strand tubes, LOD1 shells with UVs in plait periods, and the V01–V13 validator.

**v0.2 changes (all found while building the ports and the studio):**
1. *Face keep-out.* v0.1's ellipsoid let braids rooted at the front hairline hang straight down in front of the face (`reference/previews/styles_v0_1.png`). From the brow down the keep-out is now a face-wide slab in front of the face (strands are moved sideways only) blended continuously into the ellipsoid at the brow. Tests: `test_no_hair_hangs_in_front_of_the_face`, a mutation test proving v0.1 fails it, and continuity tests.
2. *Exact-integer `ceil`.* The root lift (0.6 w) is exactly 4 dense spacings (1.5 w / 10); `ceil(4 + 1e-16)` = 5 made the sample count depend on the last bit of `sin()`, so ports disagreed on ~60% of seeds. Ratios within 1e-9 of an integer now count as that integer.
3. *Relaxation that converges.* A pull undone by a collider no longer counts as a move; v0.1 ran every strand to the 60-iteration cap.

### 3.2 Ports
`web/src/protostyle.js` and `HairKit/ProtoStyle` reproduce the oracle's operation order exactly, including CPython ≥ 3.12's compensated `sum()` and round-half-even. Both match every golden fixture's SHA-256 digest exactly (Swift on Linux; Darwin's libm may differ by an ulp at a quantisation edge, so positions also carry a 2 µm tolerance). A 29-run seed sweep across all styles matches exactly in JS.

### 3.3 Head fit (`headfit.js`, `HairKit/HeadFit`)
Closed-form from the face mesh: breadth → `rx`; face height × 0.56 → `ry`; `rz = 0.97 ry`; placed so the front hairline point lands on the top-of-forehead vertex. The face keep-out runs brow to below the chin and nose + 2 cm back to behind the head centre, then grows just enough that every face vertex hair could reach is inside it. Presets: MediaPipe's mesh reaches the hairline; ARKit's stops ~1.5 cm lower. JS and Swift agree to 1e-12. On iPhone the fit is One-Euro filtered (30-frame warm-up) and a rebuild happens only when the head has moved > 2 mm *and* settled (< 0.1 mm per frame): a still head costs exactly one build.

### 3.4 Hairline
`HairlineObserver` walks down meridians of the proxy, labels samples hair / skin / other / unseen from the segmentation, and takes the end of the **last** confirmed hair run followed by confirmed skin (run length 6 on device, 3 in the browser). "Last", not "first": cornrow parts run along the meridians and show skin above the real hairline. `HairlineCalibrator` inverts `hairline_theta` per meridian and takes the median; side meridians give the ear notch. `CalibrationSession` pools 30 frames (median per meridian, needs a quarter of the meridians and five front ones).
**Error budget (measured):** on ideal masks the estimate is exact; from a photo it is good to about **±0.1 rad (~1 cm)**, because the segmenter's mask edge sits a few pixels off and the forehead top is steeply foreshortened in a front view. Thick hair at the hairline biases the estimate toward the crown (the hair hides the scalp below its roots), which is why onboarding asks for hair pulled back or a wrap.

### 3.5 Live physics (`HairKit/HairDynamics`)
Coarse chains (one node per drape segment, ~1 cm) continue the reference solver: Verlet in world space (gravity world −Y), collisions in the head frame through the current pose, pass order bend → collide → follow-the-leader so every step ends exactly inextensible and all corrections feed DFTL. Fixed 1/90 s steps, at most 6 per frame (no spiral of death). `settle()` runs 2.5 s invisibly on install: the oracle's 220-step drape can leave a strand still sliding (up to ~8 cm), and the runtime's equilibrium sags a median 7 mm more than the 10-pass reference. LOD1 shells are skinned to the chains by minimal rotation per segment; rest and rigid motion reproduce the shell to 1e-6 m.

### 3.6 Honesty check
Her hair mask vs the style's silhouette at mask resolution (256 on the long side). The silhouette is closed by a 1.2% dilation first: segmenters label the whole hair region, gaps between braids included, so an un-closed strand silhouette made even a perfect match read as 28% uncovered. Warning enters above 12% uncovered and leaves below 8%; a near-empty hair mask ("wrapped", < 5% of the head area) never warns. Same thresholds in `catalog.json` for both platforms.

### 3.7 Rendering
- **iPhone:** LOD1 shells in a RealityKit `LowLevelMesh` (buffer 0 position/normal/tangent rewritten per frame; uv0/uv1 static), `CustomMaterial` with `HairSurface.metal`: plait lobes from uv0, grooves, fibre streaks, ombré from a 64×1 gradient. Occluders: tracked face mesh + head ellipsoid (`OcclusionMaterial`).
- **Browser:** LOD0 tubes when they fit the triangle budget (1.6 M desktop, 0.7 M touch devices), otherwise LOD1 with a plait bump map; MeshPhysicalMaterial with low sheen (off-black must read as off-black). Photo mode uses depth-only occluders (face, pressed skull, neck, shoulders) placed by MediaPipe's pose matrix (column-major, 63° vertical FOV, verified by reprojection: 4.8 px on the test render).

### 3.8 Salon pilot (browser)
`salon-config.js` validates one salon's services (existing style ids only, ≤ 5, https booking links); `style-card.js` turns the current look into a `StyleCardV1` (catalog-derived, image-free by validation); `consult-ui.js` handles Save My Look, sharing and the booking handoff without any network request. Direct booking exists only where the salon's config says so; nothing infers stylist approval. Details: `docs/PILOT.md`.

### 3.9 Catalog
`ios/Packages/HairKit/Sources/TryOnCore/Resources/catalog.json` is the single source for both platforms: five styles with sizes in cm (cornrows by row count), lengths (chin 12 cm, shoulder 22, armpit 34; mid-back and waist locked until a body capture exists), 15 braiding-hair colours (1, 1B, 2, 4, 30, 350, 27, 613, 99J, grey and five 1B ombrés), Monk skin tones, honesty thresholds. Captions for the stylist are word-for-word identical on both platforms (tested).

## 4. Frame budget (iPhone, 16.7 ms)

| Stage | Budget | Notes |
|---|---|---|
| Head fit + filter | 0.3 ms | closed form |
| Physics | 1.5 ms | ~100–170 chains × ~25–40 nodes |
| Skinning + upload | 1.5 ms | LOD1 ≤ 160k triangles (V07) |
| Render | 6 ms | |
| Segmentation | async, ~10 Hz | one frame in flight, 1 s watchdog |

These are targets; they are measured on device (`docs/BUILD.md`).

## 5. Package layout

```
reference/            Python oracle, goldens, previews, canonical face mesh (Apache-2.0)
web/                  browser studio: src/, tools/build.mjs, test/ (node + Playwright), assets.lock
ios/Packages/HairKit  ProtoStyle · HeadFit · HairDynamics · TryOnCore (no ARKit/RealityKit imports)
ios/App               SwiftUI app: AR engine, LowLevelMesh, Metal shader, MediaPipe adapter, views
ios/project.yml       XcodeGen spec; Podfile; scripts/ (bootstrap, fetch-models, sync-fixtures)
```

Dependency rule: ProtoStyle depends on nothing; only the app imports ARKit/RealityKit/MediaPipe.

## 6. Level of detail

| LOD | Geometry | Use | Budget |
|---|---|---|---|
| LOD0 | per-strand tubes | browser studio, captures | ≤ 900k (validator); browser budget 1.6 M / 0.7 M |
| LOD1 | one shell per root + plait shading | iPhone live | ≤ 160k |
| LOD2 (planned) | hair cards | micro braids ≤ 1 cm | — |

1 cm braids exceed the live LOD1 budget (a test pins this), hence LOD2.

## 7. Determinism contract

- Randomness: SplitMix64 and `derive_seed` (FNV-1a) only; bit-exact (`golden/rng_splitmix64.json`).
- Same operation order as the Python, CPython `sum()` and `round()` semantics included.
- Stats and triangle indices exact; positions within 2 µm; digest exact on glibc (Linux CI) and in JS.
- Known limit: any threshold algorithm has inputs that sit exactly on a boundary. v0.2 removed the two systematic ones (integer `ceil`, non-converging relaxation); a 29-run sweep shows none left on the tested specs.
- Regenerating goldens is a contract change: its own commit, with the diff and the reason.

## 8. Known limits

1. Straight-back cornrows leave the sides above the ears bare; real side rows curve (curved parts: backlog).
2. No torso collider: lengths stop at armpit (0.34 m; the generator refuses > 0.40 m without a body proxy).
3. Micro braids need LOD2.
4. Segmentation fairness by Monk band and curl pattern is unmeasured (the public model card reports a ~10-point IoU drop at MST 9–10 for the multiclass model, not broken out for hair).
5. Photo hairline estimate: ±0.1 rad; thick hair at the hairline biases it toward the crown.
6. iOS app code is uncompiled here; on-device checks are listed in `docs/BUILD.md`.
7. The browser studio's automatic fit needs the host to allow WebAssembly compilation; otherwise it falls back to placing the style by hand (tested).
