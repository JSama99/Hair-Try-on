# Research — open-source stack for live hair try-on (iOS)

**Date:** 2026-09-28 · **Scope:** what open source can carry for a live-camera, iOS-only, hair-first try-on built for Black women's hair, and where the gaps are. Every claim below was checked against the source linked beside it on the date above. Licences change; re-check before shipping.

---

## 1. The finding that shapes everything

**Open-source hair AI does not cover the styles this market actually wears, under a licence you can ship.**

| Need | Best open option | Covers braids / locs / twists? | Commercial use? |
|---|---|---|---|
| Strand hair from one image | DiffLocks (CVPR 2025) | Afro-textured **yes** (first method to recover it from one image); braids **no** — authors state the synthetic set lacks braids, ponytails, buns | **No** — non-commercial licence; commercial terms via Meshcapade ([licence](https://github.com/Meshcapade/difflocks), [paper](https://arxiv.org/html/2505.06166v1)) |
| Strand hair from video | GaussianHaircut (ECCV 2024) | Not addressed | **No** — CC BY-NC-SA 4.0, CUDA 11.8 ([repo](https://github.com/eth-ait/GaussianHaircut)) |
| Braids / locs generation | TANGLED (2025) | Yes — 457 styles, ~10% braided, explicitly targets braids and locs | Release and licence not stated in the paper ([paper](https://arxiv.org/html/2502.06392v1)) |
| Braid reconstruction | Unsupervised braided-hair reconstruction (2025) | 3-strand braids only, sinusoid model | **No code released** ([review](https://pith.science/paper/2506.23072)) |

Consequence: the protective-style geometry has to be **ours**. That is also the moat. `reference/protostyle` is a clean-room procedural generator for box braids, knotless braids, two-strand twists, locs and cornrows, built on published geometry (the three-strand sinusoid plait model, rotation-minimising frames, follow-the-leader hair dynamics) with no third-party code or weights.

## 2. Segmentation — usable, but measurably worse on the users this is for

**MediaPipe Image Segmenter** runs on iOS (`pod 'MediaPipeTasksVision'`, `ImageSegmenter`, `.liveStream` running mode with an async delegate) ([iOS guide](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter/ios)). Two relevant models ([model list](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter)):

- **HairSegmenter** — 512×512, classes `background, hair`.
- **SelfieMulticlass** — 256×256, classes `background, hair, body-skin, face-skin, clothes, others`.

Licence: Apache 2.0 ([model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf)).

**The fairness number that matters.** Google's own model card for the multiclass segmenter reports mean IoU by Monk Skin Tone band: **81.70 at MST 1–2, falling to 71.86 at MST 9–10** — a ~10-point drop at the darkest skin tones. The card does not break results out for the hair class, and does not evaluate hair texture at all. So:

- The segmenter is a reasonable **starting** component, not a trusted one.
- We need our own **Monk-stratified, hair-texture-stratified evaluation set** before it gates anything (next step: docs/BUILD.md, "Still to measure").
- If the hair-class gap persists on our set, fine-tuning on consented data is in scope; the Apache licence allows it.

**Apple's hair matte is not an option for live AR.** `AVSemanticSegmentationMatte` hair/skin/teeth mattes (iOS 13+) are produced for **photo capture** and embedded in HEIF/JPEG at half resolution; they are not delivered per video frame ([WWDC19 session 260](https://asciiwwdc.com/2019/sessions/260)).

## 3. Tracking and head shape

- **ARKit face tracking** gives a head pose and an `ARFaceGeometry` mask of **1,220 vertices**; vertex layout is not guaranteed stable across ARKit versions ([vertex study](https://www.oxfordechoes.com/ios-arkit-face-tracking-vertices/), [Apple docs](https://developer.apple.com/documentation/arkit/arfacegeometry)). The mask stops at the forehead — **there is no scalp**. Every style needs a scalp to root on, so we fit a head proxy (§4.2 of ARCHITECTURE).
- **MHR (Momentum Human Rig)** — Apache 2.0, includes a parametric head with identity parameters and a facial blendshape model ([repo](https://github.com/facebookresearch/MHR)). This is the head model under SAM 3D Body.
- **SAM 3D Body** — SAM Licence: commercial use permitted, with trade-control and no-reverse-engineering clauses, and derivatives redistributed under the same terms ([licence](https://github.com/facebookresearch/sam-3d-body/blob/main/LICENSE)). This is what TalonRig wraps. TalonRig's `Sam3DBodyBackend` has never run against real weights (weights are licence-gated and need CUDA), so it enters this product as an **offline, opt-in** head-shape capture, never on the live path.

## 4. Rendering

- **RealityKit** meshes for braids/twists/locs (LOD1 shell geometry + tiling plait normal map).
- **MetalSplatter** — MIT-licensed Gaussian-splat renderer for iOS/visionOS ([licence](https://github.com/scier/MetalSplatter/blob/main/LICENSE)). Candidate for voluminous natural styles (afros, twist-outs) where tubes are the wrong primitive. Not in v1.

## 5. Evaluation vocabulary

- **Monk Skin Tone Scale** — CC BY 4.0, commercial use with attribution ([summary](https://en.wikipedia.org/wiki/Monk_Skin_Tone_Scale), [Google](https://skintone.google/)). Every test set, dashboard and acceptance criterion in this project is stratified by MST band.
- **Hairmony** (Microsoft, 2024) — fairness-aware hairstyle classification trained purely on synthetic data; notes that parametric methods fail on coily hair, locs, buns and braids; releases synthetic training data and 1,805 real FairFace-derived evaluation annotations ([paper](https://arxiv.org/html/2410.11528v1)). Licence could not be confirmed (project page blocks automated fetch) — treat as **research-only until checked by hand**.

## 6. The market gap, stated precisely

- Current braid/loc try-on tools are **photo-based** (a render in ~10 s per image), not live ([review](https://therighthairstyles.com/ai-braids-dreads-twists-afro-hairstyles-try-on/)).
- Reported failure modes on Black hair: afro textures drift toward **looser curl patterns** than 4C; **hairline misalignment** on tilted selfies; beads, baby hair and accessories **almost always missing**; micro braids and complex cornrow designs are the weakest categories (same source).
- Live AR SDKs (e.g. Banuba) claim coily textures and braids in marketing copy but publish no evidence on textured hair ([product page](https://www.banuba.com/virtual-hairstyle-try-on)).

**Positioning that falls out of the evidence:** live, hairline-true, texture-true protective styles, with published per-Monk-band accuracy. Nobody publishes that number. We would.

## 7. Licence matrix (what may ship in the binary)

| Component | Licence | Ships in app? |
|---|---|---|
| MediaPipe Tasks + HairSegmenter / SelfieMulticlass | Apache 2.0 | **Yes** |
| ARKit / RealityKit / Vision | Apple SDK | **Yes** |
| MetalSplatter | MIT | Yes (later) |
| MHR | Apache 2.0 | Yes (server or on-device head fit) |
| SAM 3D Body (via TalonRig) | SAM Licence (commercial OK, conditions) | **Server-side only**, opt-in capture |
| protostyle (ours) | Proprietary | **Yes** — Swift port |
| DiffLocks | Non-commercial | **No** (benchmark comparison only) |
| GaussianHaircut | CC BY-NC-SA 4.0 | **No** |
| TANGLED | Unconfirmed | **No** until licence confirmed |
| Hairmony data | Unconfirmed | **No** until licence confirmed |

Components the build actually ships or loads:

| Component | Licence | Where |
|---|---|---|
| MediaPipe Tasks Vision (`@mediapipe/tasks-vision` 1.0.1, iOS pod `MediaPipeTasksVision`) | Apache 2.0 | web (CDN script + own wasm file), iOS |
| MediaPipe Face Landmarker model (`face_landmarker.task`, via `mediapipe-nodejs` 1.2.1) | Apache 2.0 (model card) | web photo mode |
| MediaPipe hair segmenter and SelfieMulticlass models (via `mtr-hair-segmentation` 1.0.0, ISC packaging) | Apache 2.0 (model cards) | web (hair), iOS (both) |
| MediaPipe canonical face mesh (`canonical_face_model.obj`) | Apache 2.0 | head fitting, studio bust, tests |
| three.js 0.186.1 | MIT | web |
| Monk Skin Tone scale swatches | published by Google (skintone.google) | bust skin tones, evaluation bands |

Project invariant: *no non-commercially-licensed model, weight or dataset in the shipping binary or training set.*

## 8. Open questions this research could not close

1. HairSegmenter (512) hair-class IoU by Monk band and by curl pattern — unmeasured anywhere public; the evaluation plan is in docs/BUILD.md.
2. Hairmony dataset licence — needs a human to read the project page.
3. TANGLED code/weights release status — check the project site by hand.
4. Real iPhone frame-time for MediaPipe HairSegmenter at 512 in `.liveStream` alongside ARKit face tracking and RealityKit rendering — must be measured on device (docs/BUILD.md, device checks).
