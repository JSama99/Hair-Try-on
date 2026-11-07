"""Write golden fixtures for the Swift port (and lock the Python reference).

Fixtures are deliberately small (wide sections, short lengths) so they are
cheap to regenerate in XCTest and small enough to review in a PR diff.

Run from reference/:  python3 tools/make_golden.py
Regenerating goldens is a *contract change*: commit it on its own, with the
diff and the reason in the message, never as a side effect of other work.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from protostyle import __version__  # noqa: E402
from protostyle.rng import SplitMix64, derive_seed  # noqa: E402
from protostyle.scalp import HeadProxy  # noqa: E402
from protostyle.styles import StyleKind, StyleSpec, generate, spec_dict  # noqa: E402
from protostyle.validate import digest, validate  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "golden")

FIXTURE_SPECS = {
    StyleKind.BOX_BRAIDS: dict(width=0.035, length=0.12, seed=0x5EED),
    StyleKind.KNOTLESS_BRAIDS: dict(width=0.035, length=0.12, seed=0x5EED),
    StyleKind.TWO_STRAND_TWISTS: dict(width=0.035, length=0.12, seed=0xB0A7),
    StyleKind.LOCS: dict(width=0.035, length=0.12, seed=0x10C5),
    StyleKind.CORNROWS: dict(width=0.02, length=0.08, seed=0xC0C0, cornrow_rows=6),
}


def r(x, nd=9):
    return round(x, nd)


def vec_r(p):
    return [r(c) for c in p]


def fixture_spec(kind):
    return StyleSpec(kind=kind, **FIXTURE_SPECS[kind])


def write(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)
        f.write("\n")
    print("wrote", os.path.relpath(path))


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = SplitMix64(0x5EED)
    write("rng_splitmix64.json", {
        "generator": "SplitMix64",
        "seed": 0x5EED,
        "u64": [str(rng.next_u64()) for _ in range(16)],
        "derive_seed": {salt: str(derive_seed(0x5EED, salt)) for salt in ["grid_sections", "noise:0", "noise:17"]},
        "note": "u64 values are decimal strings to survive JSON double precision; compare bit-exactly.",
    })

    head = HeadProxy()
    phis = [(-math.pi + k * math.pi / 8.0) for k in range(17)]
    samples = [(0.2, 0.0), (0.9, 1.0), (1.3, -2.0), (1.6, 3.0), (0.05, -0.7)]
    write("scalp.json", {
        "head": head.__dict__,
        "hairline_theta": [[r(p), r(head.hairline_theta(p))] for p in phis],
        "points": [{"theta": t, "phi": p, "point": vec_r(head.point(t, p)), "normal": vec_r(head.normal_at(head.point(t, p)))} for t, p in samples],
        "tolerance_abs": 1e-9,
    })

    jobs = [(f"style_{k.value}.json", fixture_spec(k)) for k in StyleKind]
    # Long hair reaches the face column (keep-out extruded below the face, v0.2):
    # this fixture locks that code path for the Swift and JS ports.
    jobs.append(("style_box_braids_long.json", StyleSpec(kind=StyleKind.BOX_BRAIDS, width=0.035, length=0.30, seed=0x10F6)))
    for name, spec in jobs:
        kind = spec.kind
        res = generate(spec)
        checks = validate(res)
        assert all(c.passed for c in checks), [(c.id, c.detail) for c in checks if not c.passed]
        roots = []
        for root in res.roots:
            if hasattr(root, "theta"):
                roots.append({"theta": r(root.theta), "phi": r(root.phi)})
            else:
                roots.append({"point": vec_r(root)})
        write(name, {
            "protostyle_version": __version__,
            "spec": spec_dict(spec),
            "stats": res.stats,
            "digest_sha256_q10um": digest(res),
            "roots": roots,
            "strand0_centerline_every5": [vec_r(p) for p in res.strands[0].centerline[::5]],
            "lod1_positions_head": [vec_r(p) for p in res.lod1.positions[:48]],
            "lod1_triangles_head": [list(t) for t in res.lod1.triangles[:48]],
            "checks": {c.id: c.passed for c in checks},
            "tolerance_abs_m": 2e-6,
            "note": "Swift must match stats and triangles exactly and positions within tolerance_abs_m. "
                    "The digest is a Python self-lock; Swift may differ by libm ulps at quantisation edges.",
        })


if __name__ == "__main__":
    main()
