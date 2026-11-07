"""Geometry validator — the protostyle analogue of geokit's USDZ validator.

Every check has a stable ID so test reports and commit messages can cite it
(e.g. "L2: protostyle V01–V12 pass for 5/5 styles"). The Swift runtime must
ship an equivalent validator with the same IDs and thresholds.
"""
import hashlib
import math
import struct
from dataclasses import dataclass

from . import vec
from .styles import StyleKind, StyleResult, generate

LOD0_TRIANGLE_BUDGET = 900_000   # offline / hero renders
LOD1_TRIANGLE_BUDGET = 160_000   # live AR frame budget for hair (ARCHITECTURE.md §6)
QUANTUM = 1e-5                   # 10 µm, digest quantisation


@dataclass(frozen=True)
class Check:
    id: str
    name: str
    passed: bool
    detail: str


def digest(result: StyleResult) -> str:
    """SHA-256 over quantised LOD0+LOD1 positions and triangle indices."""
    h = hashlib.sha256()
    for mesh in (result.lod0, result.lod1):
        h.update(struct.pack("<Q", len(mesh.positions)))
        for p in mesh.positions:
            h.update(struct.pack("<qqq", *(int(round(c / QUANTUM)) for c in p)))
        h.update(struct.pack("<Q", len(mesh.triangles)))
        for t in mesh.triangles:
            h.update(struct.pack("<III", *t))
    return h.hexdigest()


def _tri_area(a, b, c):
    return 0.5 * vec.length(vec.cross(vec.sub(b, a), vec.sub(c, a)))


def validate(result: StyleResult, check_determinism: bool = True):
    spec, head = result.spec, result.head
    checks = []

    def add(cid, name, ok, detail):
        checks.append(Check(cid, name, bool(ok), detail))

    # V01 finite
    bad = sum(1 for m in (result.lod0, result.lod1) for p in m.positions if not vec.is_finite(p))
    add("V01", "all vertex positions finite", bad == 0, f"{bad} non-finite")

    # V02 roots on scalp (grid styles) / cornrow starts on scalp
    worst = 0.0
    for r in result.roots:
        p = r.point if hasattr(r, "point") else r
        worst = max(worst, abs(head.implicit(p) - 1.0))
    add("V02", "roots lie on the scalp surface", worst < 1e-9, f"max |f-1| = {worst:.3e}")

    # V03 roots inside hairline
    outside = 0
    if spec.kind != StyleKind.CORNROWS:
        for r in result.roots:
            if not head.inside_hairline(r.theta, r.phi, margin=spec.hairline_margin - 1e-12):
                outside += 1
    add("V03", "roots inside the hairline", outside == 0, f"{outside} outside")

    # V04 no penetration of the head by hanging centreline nodes
    from .styles import PROFILES
    clearance = PROFILES[spec.kind].shell_radius * spec.width
    worst_pen = 0.0
    from .sweep import arc_lengths
    join_tolerance = max(0.5 * spec.width, 0.008)  # one drape segment past the pinned prefix
    for s in result.strands:
        s_vals = arc_lengths(s.centerline)
        for p, sv in zip(s.centerline, s_vals):
            if sv <= s.free_from_s + join_tolerance:
                continue
            d = vec.sub(p, head.center())
            k = (d[0] / (head.rx + clearance * 0.9)) ** 2 + (d[1] / (head.ry + clearance * 0.9)) ** 2 + (d[2] / (head.rz + clearance * 0.9)) ** 2
            if k < 1.0:
                worst_pen = max(worst_pen, 1.0 - k)
            kf = head.face_implicit(p, clearance * 0.9)
            if kf < 1.0:
                worst_pen = max(worst_pen, 1.0 - kf)
    add("V04", "hanging centrelines clear head and face by >= 90% of strand envelope", worst_pen == 0.0, f"worst implicit deficit {worst_pen:.3e}")

    # V05 sample spacing stable (Catmull-Rom output within bounds)
    period = PROFILES[spec.kind].period * spec.width
    target = period / spec.samples_per_period
    worst_ratio = 0.0
    for s in result.strands:
        for i in range(1, len(s.centerline)):
            seg = vec.length(vec.sub(s.centerline[i], s.centerline[i - 1]))
            worst_ratio = max(worst_ratio, seg / target)
    add("V05", "dense sample spacing <= 1.35x target (plait resolved)", worst_ratio <= 1.35, f"max ratio {worst_ratio:.3f}")

    # V06 triangle indices valid, no degenerate triangles
    deg, oob = 0, 0
    for m in (result.lod0, result.lod1):
        n = len(m.positions)
        for a, b, c in m.triangles:
            if not (0 <= a < n and 0 <= b < n and 0 <= c < n) or len({a, b, c}) < 3:
                oob += 1
                continue
            if _tri_area(m.positions[a], m.positions[b], m.positions[c]) < 1e-14:
                deg += 1
    add("V06", "triangles valid and non-degenerate", deg == 0 and oob == 0, f"{oob} invalid, {deg} degenerate")

    # V07 budgets
    add("V07", "triangle budgets (LOD0 <= 900k, LOD1 <= 160k)",
        result.lod0.triangle_count <= LOD0_TRIANGLE_BUDGET and result.lod1.triangle_count <= LOD1_TRIANGLE_BUDGET,
        f"LOD0 {result.lod0.triangle_count}, LOD1 {result.lod1.triangle_count}")

    # V08 radius sanity: every strand has positive max radius; a UV and normal per vertex
    ok_r = all(s.radius_max > 0.0 for s in result.strands) and all(
        len(m.uvs) == len(m.positions) == len(m.normals) for m in (result.lod0, result.lod1))
    add("V08", "positive strand radii; a UV and normal per vertex", ok_r, f"{len(result.strands)} strands")

    # V09 determinism
    if check_determinism:
        again = generate(spec, head)
        d1, d2 = digest(result), digest(again)
        add("V09", "regeneration is bit-identical (quantised digest)", d1 == d2, d1[:16])
    else:
        add("V09", "regeneration is bit-identical (quantised digest)", True, "skipped")

    # V10 length policy
    add("V10", "length policy respected (no torso -> <= 0.40 m)", not spec.validate(), "spec valid")

    # V11 plausible section count
    n = len(result.strands)
    if spec.kind == StyleKind.CORNROWS:
        ok_n = abs(n - spec.cornrow_rows) <= 1
        expect = f"{spec.cornrow_rows}±1 rows"
    else:
        area = 0.55 * 4.0 * math.pi * ((head.rx * head.ry + head.ry * head.rz + head.rz * head.rx) / 3.0)
        est = area / (spec.width * spec.width)
        ok_n = 0.45 * est <= n <= 1.6 * est
        expect = f"~{est:.0f}"
    add("V11", "section count plausible for width", ok_n, f"{n} (expected {expect})")

    # V12 left/right balance
    if spec.kind != StyleKind.CORNROWS:
        left = sum(1 for r in result.roots if r.phi > 1e-6 and r.phi < math.pi - 1e-6)
        right = sum(1 for r in result.roots if r.phi < -1e-6 and r.phi > -math.pi + 1e-6)
        bal = abs(left - right) / max(1, max(left, right))
        add("V12", "left/right root balance within 15%", bal <= 0.15, f"L {left} / R {right}")
    else:
        xs = [r[0] for r in result.roots]
        bal = abs(sum(1 for x in xs if x > 0) - sum(1 for x in xs if x < 0))
        add("V12", "left/right root balance within 15%", bal <= 1, f"imbalance {bal}")
    # V13 winding: faces point the same way as the analytic normals (outward)
    worst = 1.0
    for m in (result.lod0, result.lod1):
        if not m.triangles:
            continue
        agree = 0
        for a, b, c in m.triangles:
            pa, pb, pc = m.positions[a], m.positions[b], m.positions[c]
            fn = vec.cross(vec.sub(pb, pa), vec.sub(pc, pa))
            avg = vec.add(vec.add(m.normals[a], m.normals[b]), m.normals[c])
            if vec.dot(fn, avg) > 0.0:
                agree += 1
        worst = min(worst, agree / len(m.triangles))
    add("V13", "outward winding (>= 99.5% of faces agree with analytic normals)", worst >= 0.995, f"worst agreement {worst:.4f}")
    return checks


def all_passed(checks):
    return all(c.passed for c in checks)
