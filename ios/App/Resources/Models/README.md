# Bundled models

`scripts/fetch-models.sh` downloads these and refuses any file whose SHA-256 differs from `models.lock`.

| File | Classes | Use |
|---|---|---|
| `selfie_multiclass_256x256.tflite` | 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other | default: hair and skin in one pass (hairline calibration needs skin) |
| `hair_segmenter.tflite` | 0 background, 1 hair | fallback when the multiclass model is missing |

Both are Google MediaPipe models (Apache-2.0 model cards). Google's `latest` URL can change; the
pinned hashes are the builds the app was tested with, also published byte-identical on npm
(`mtr-hair-segmentation@1.0.0`, ISC), which the script uses when Google's file differs or is unreachable.
Segmentation fairness on textured hair is not yet measured by Monk band (docs/RESEARCH.md).
