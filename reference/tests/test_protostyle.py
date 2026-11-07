"""protostyle test suite: unit, property, mutation and golden-regression tests."""
import dataclasses
import json
import math
import os

import pytest

from protostyle import vec
from protostyle.drape import MAX_UNSUPPORTED_LENGTH, drape
from protostyle.parting import cornrow_paths, grid_sections, resample_polyline
from protostyle.rng import SplitMix64, derive_seed
from protostyle.scalp import HeadProxy
from protostyle.styles import PROFILES, StyleKind, StyleSpec, catmull_rom, generate
from protostyle.sweep import Mesh, rotation_minimizing_frames, tube
from protostyle.validate import digest, validate

GOLDEN = os.path.join(os.path.dirname(__file__), "..", "golden")
HEAD = HeadProxy()


def small(kind, **kw):
    base = dict(width=0.035, length=0.12)
    if kind == StyleKind.CORNROWS:
        base = dict(width=0.02, length=0.08, cornrow_rows=6)
    base.update(kw)
    return StyleSpec(kind=kind, **base)


@pytest.fixture(scope="module")
def results():
    return {k: generate(small(k)) for k in StyleKind}


# ---------------------------------------------------------------- rng

def test_splitmix64_reference_vector():
    # Canonical SplitMix64 output for seed 0 (Steele/Lea/Flood; Vigna's splitmix64.c).
    assert SplitMix64(0).next_u64() == 0xE220A8397B1DCDAF


def test_rng_unit_range_and_determinism():
    a, b = SplitMix64(42), SplitMix64(42)
    xs = [a.next_unit() for _ in range(2000)]
    assert xs == [b.next_unit() for _ in range(2000)]
    assert all(0.0 <= x < 1.0 for x in xs)
    assert 0.45 < sum(xs) / len(xs) < 0.55


def test_derive_seed_is_salt_sensitive():
    assert derive_seed(1, "a") != derive_seed(1, "b")
    assert derive_seed(1, "a") == derive_seed(1, "a")
    assert derive_seed(1, "a") != derive_seed(2, "a")


# ---------------------------------------------------------------- scalp

@pytest.mark.parametrize("theta,phi", [(0.01, 0.0), (0.7, 1.2), (1.4, -2.5), (1.9, math.pi)])
def test_points_lie_on_surface_with_outward_unit_normals(theta, phi):
    p = HEAD.point(theta, phi)
    assert abs(HEAD.implicit(p) - 1.0) < 1e-12
    n = HEAD.normal_at(p)
    assert abs(vec.length(n) - 1.0) < 1e-12
    assert vec.dot(n, vec.sub(p, HEAD.center())) > 0


def test_hairline_rises_front_to_back_and_notches_over_ears():
    front, back = HEAD.hairline_theta(0.0), HEAD.hairline_theta(math.pi)
    assert front < back
    side = HEAD.hairline_theta(math.pi / 2)
    linear = front + (back - front) * 0.5
    assert side < linear  # the ear notch


def test_collide_pushes_out_of_head_and_face():
    inside_head = HEAD.center()
    p, hit = HEAD.collide(inside_head, 0.01)
    assert hit and HEAD.implicit(p) >= 1.0 - 1e-9
    in_face = (HEAD.fx, HEAD.fy, HEAD.fz + 0.01)
    p, hit = HEAD.collide(in_face, 0.005)
    assert hit and HEAD.face_implicit(p, 0.005) >= 1.0 - 1e-9


def test_tangent_frame_orthonormal():
    for th, ph in [(0.3, 0.0), (1.0, 2.0), (1.5, -1.0)]:
        n, tb, ts = HEAD.tangent_frame(th, ph)
        for a in (n, tb, ts):
            assert abs(vec.length(a) - 1) < 1e-12
        assert abs(vec.dot(n, tb)) < 1e-12 and abs(vec.dot(n, ts)) < 1e-12 and abs(vec.dot(tb, ts)) < 1e-12


# ---------------------------------------------------------------- parting

def test_grid_sections_inside_hairline_and_deterministic():
    a = grid_sections(HEAD, 0.025, 0.2, 7, hairline_margin=0.03)
    b = grid_sections(HEAD, 0.025, 0.2, 7, hairline_margin=0.03)
    assert a == b and len(a) > 20
    assert all(HEAD.inside_hairline(r.theta, r.phi, 0.03 - 1e-12) for r in a)
    assert [r.index for r in a] == list(range(len(a)))


def test_seed_changes_layout_but_not_count_scale():
    a = grid_sections(HEAD, 0.025, 0.3, 1)
    b = grid_sections(HEAD, 0.025, 0.3, 2)
    assert [(r.theta, r.phi) for r in a] != [(r.theta, r.phi) for r in b]
    assert abs(len(a) - len(b)) <= 0.15 * len(a)


def test_smaller_sections_mean_more_roots():
    assert len(grid_sections(HEAD, 0.015, 0.1, 1)) > 1.6 * len(grid_sections(HEAD, 0.025, 0.1, 1))


@pytest.mark.parametrize("size,jit", [(0.001, 0.1), (0.2, 0.1), (0.02, 0.9)])
def test_grid_rejects_bad_params(size, jit):
    with pytest.raises(ValueError):
        grid_sections(HEAD, size, jit, 1)


def test_cornrow_paths_uniform_and_on_scalp():
    paths = cornrow_paths(HEAD, 6, 0.9, 0.01)
    assert len(paths) == 6
    for path in paths:
        for p in path:
            assert abs(HEAD.implicit(p) - 1.0) < 1e-9
        segs = [vec.length(vec.sub(path[i + 1], path[i])) for i in range(len(path) - 1)]
        assert max(segs) - min(segs) < 2e-3
        assert path[0][2] > path[-1][2]  # runs front to back


def test_resample_keeps_endpoints():
    pts = [(0, 0, 0), (1, 0, 0), (1, 1, 0)]
    out = resample_polyline(pts, 0.3)
    assert out[0] == pts[0] and out[-1] == pts[-1]


# ---------------------------------------------------------------- drape

def test_drape_preserves_segment_length_and_clears_head():
    root = HEAD.point(0.8, 0.9)
    n = HEAD.normal_at(root)
    fixed = [root, vec.add(root, vec.mul(n, 0.01))]
    out = drape(HEAD, fixed, 0.25, 0.01, 0.008)
    assert out[:2] == fixed
    segs = [vec.length(vec.sub(out[i + 1], out[i])) for i in range(1, len(out) - 1)]
    assert max(abs(s - 0.01) for s in segs) < 1e-12  # exact inextensibility
    assert out[-1][1] < root[1] - 0.1  # it actually hangs
    for p in out[3:]:
        assert HEAD.implicit(p) > 1.0


def test_drape_zero_length_and_errors():
    f = [(0, 0.2, 0), (0, 0.21, 0)]
    assert drape(HEAD, f, 0.0, 0.01, 0.005) == f
    with pytest.raises(ValueError):
        drape(HEAD, f[:1], 0.1, 0.01, 0.005)
    with pytest.raises(ValueError):
        drape(HEAD, f, 0.1, 0.0, 0.005)


# ---------------------------------------------------------------- sweep

def test_rmf_frames_orthonormal_and_outward():
    pts = catmull_rom([(0, 0, 0), (0, -0.05, 0.01), (0.01, -0.1, 0.0), (0.0, -0.15, -0.02)], 0.004)
    T, N, B = rotation_minimizing_frames(pts, (1, 0, 0), (0, 0, 1))
    for t, n, b in zip(T, N, B):
        assert abs(vec.dot(t, n)) < 1e-9 and abs(vec.dot(t, b)) < 1e-9 and abs(vec.dot(n, b)) < 1e-9
    assert vec.dot(B[0], (0, 0, 1)) > 0


def test_tube_topology_counts():
    c = [(0, -0.01 * i, 0) for i in range(5)]
    N = [(1, 0, 0)] * 5
    B = [(0, 0, 1)] * 5
    m = tube(c, N, B, [0.002] * 5, 6, cap_tip=True)
    assert len(m.positions) == 5 * 6 + 1
    assert m.triangle_count == (5 - 1) * 6 * 2 + 6


# ---------------------------------------------------------------- styles

def test_spec_length_policy_requires_body_proxy():
    long = StyleSpec(kind=StyleKind.BOX_BRAIDS, length=MAX_UNSUPPORTED_LENGTH + 0.1)
    assert long.validate()
    with pytest.raises(ValueError):
        generate(long)
    assert not dataclasses.replace(long, has_body_proxy=True).validate()


@pytest.mark.parametrize("bad", [dict(width=0.001), dict(lod0_sides=2), dict(samples_per_period=3), dict(seed=-1)])
def test_spec_rejects_bad_values(bad):
    assert StyleSpec(kind=StyleKind.LOCS, **bad).validate()


@pytest.mark.parametrize("kind", list(StyleKind))
def test_every_style_passes_every_check(results, kind):
    checks = validate(results[kind])
    failed = [(c.id, c.detail) for c in checks if not c.passed]
    assert not failed
    assert [c.id for c in checks] == [f"V{i:02d}" for i in range(1, 14)]


def test_strand_counts_follow_profiles(results):
    for kind, res in results.items():
        per_ring = res.spec.lod0_sides
        assert res.stats["strands_per_root"] == PROFILES[kind].strands
        assert res.stats["lod0_vertices"] % 1 == 0 and per_ring > 0


def test_knotless_root_thinner_than_box_knot(results):
    def root_ring_radius(res):
        pos = res.lod0.positions
        sides = res.spec.lod0_sides
        c = [sum(p[i] for p in pos[:sides]) / sides for i in range(3)]
        return vec.length(vec.sub(pos[0], tuple(c)))
    assert root_ring_radius(results[StyleKind.KNOTLESS_BRAIDS]) < 0.6 * root_ring_radius(results[StyleKind.BOX_BRAIDS])


def test_locs_have_radius_variation(results):
    res = results[StyleKind.LOCS]
    sides = res.spec.lod0_sides
    radii = []
    pos = res.lod0.positions
    for k in range(0, 40):
        ring = pos[k * sides:(k + 1) * sides]
        c = tuple(sum(p[i] for p in ring) / sides for i in range(3))
        radii.append(vec.length(vec.sub(ring[0], c)))
    assert max(radii) / min(radii) > 1.08


def test_cornrow_rows_count_and_tails_hang(results):
    res = results[StyleKind.CORNROWS]
    assert res.stats["roots"] == 6
    for s in res.strands:
        assert s.centerline[-1][1] < s.centerline[0][1]


def test_digest_stable_and_seed_sensitive():
    a = generate(small(StyleKind.TWO_STRAND_TWISTS, seed=11))
    b = generate(small(StyleKind.TWO_STRAND_TWISTS, seed=11))
    c = generate(small(StyleKind.TWO_STRAND_TWISTS, seed=12))
    assert digest(a) == digest(b) != digest(c)


def test_lod1_is_the_live_budget(results):
    for res in results.values():
        assert res.lod1.triangle_count * 4 < res.lod0.triangle_count or res.spec.kind == StyleKind.LOCS


# ---------------------------------------------------------------- mutation: the validator must catch breakage

def _fresh(kind=StyleKind.BOX_BRAIDS):
    return generate(small(kind))


def _failed(res):
    return {c.id for c in validate(res, check_determinism=False) if not c.passed}


def test_validator_catches_nan():
    res = _fresh()
    res.lod1.positions[3] = (float("nan"), 0.0, 0.0)
    assert "V01" in _failed(res)


def test_validator_catches_root_off_scalp():
    res = _fresh()
    r0 = res.roots[0]
    res.roots[0] = dataclasses.replace(r0, point=vec.add(r0.point, (0, 0.01, 0)))
    assert "V02" in _failed(res)


def test_validator_catches_degenerate_triangle():
    res = _fresh()
    a, b, c = res.lod0.triangles[0]
    res.lod0.triangles[0] = (a, a, c)
    assert "V06" in _failed(res)


def test_validator_catches_penetration():
    res = _fresh()
    s = res.strands[0]
    s.centerline[-1] = HEAD.center()
    assert "V04" in _failed(res)


def test_validator_catches_inverted_winding():
    res = _fresh()
    res.lod1.triangles[:] = [(a, c, b) for a, b, c in res.lod1.triangles]
    assert "V13" in _failed(res)


def test_tube_normals_are_unit_and_radial():
    c = [(0, -0.01 * i, 0) for i in range(3)]
    m = tube(c, [(1, 0, 0)] * 3, [(0, 0, 1)] * 3, [0.002] * 3, 8, cap_tip=False)
    for p, n in zip(m.positions, m.normals):
        assert abs(vec.length(n) - 1) < 1e-12
        axis = (0.0, p[1], 0.0)
        assert vec.dot(n, vec.sub(p, axis)) > 0


def test_validator_catches_budget_overrun():
    res = _fresh()
    res.lod1.triangles.extend(res.lod1.triangles * 60)
    assert "V07" in _failed(res)


# ---------------------------------------------------------------- golden regression lock

def _golden(name):
    with open(os.path.join(GOLDEN, name)) as f:
        return json.load(f)


def test_golden_rng():
    g = _golden("rng_splitmix64.json")
    rng = SplitMix64(g["seed"])
    assert [str(rng.next_u64()) for _ in range(16)] == g["u64"]
    for salt, val in g["derive_seed"].items():
        assert str(derive_seed(g["seed"], salt)) == val


def test_golden_scalp():
    g = _golden("scalp.json")
    for phi, th in g["hairline_theta"]:
        assert abs(HEAD.hairline_theta(phi) - th) < 1e-8
    for s in g["points"]:
        p = HEAD.point(s["theta"], s["phi"])
        assert max(abs(a - b) for a, b in zip(p, s["point"])) < 1e-8


@pytest.mark.parametrize("name", [f"style_{k.value}.json" for k in StyleKind] + ["style_box_braids_long.json"])
def test_golden_styles(name):
    g = _golden(name)
    res = generate(StyleSpec(**{**g["spec"], "kind": StyleKind(g["spec"]["kind"])}))
    assert res.stats == g["stats"]
    assert digest(res) == g["digest_sha256_q10um"]
    tol = g["tolerance_abs_m"]
    for p, q in zip(res.strands[0].centerline[::5], g["strand0_centerline_every5"]):
        assert max(abs(a - b) for a, b in zip(p, q)) < tol
    assert [list(t) for t in res.lod1.triangles[:48]] == g["lod1_triangles_head"]


def test_micro_braids_exceed_live_budget_by_design():
    """1 cm braids blow the LOD1 live budget: the finding that forces the
    hair-card LOD tier (ARCHITECTURE.md §6). If this ever passes, the budget or
    the LOD scheme changed and the architecture doc must be updated with it."""
    res = generate(StyleSpec(kind=StyleKind.BOX_BRAIDS, width=0.01, length=0.2))
    failed = {c.id for c in validate(res, check_determinism=False) if not c.passed}
    assert failed == {"V07"}


def test_catmull_rom_emits_control_points_exactly():
    pts = [(0.0, 0.0, 0.0), (0.013, -0.021, 0.004), (0.017, -0.05, -0.002), (0.011, -0.08, 0.009)]
    dense, idx = __import__("protostyle.styles", fromlist=["x"]).catmull_rom_indexed(pts, 0.003)
    assert [dense[i] for i in idx] == pts  # bitwise identity, not approximate


def test_cornrow_pinned_path_is_never_moved():
    """Regression: pinned cornrow points must survive densification + curvature relax untouched."""
    res = generate(small(StyleKind.CORNROWS))
    from protostyle.parting import cornrow_paths
    from protostyle.styles import CORNROW_WIDTH_FRACTION, _to_surface
    spec = res.spec
    paths = cornrow_paths(HEAD, spec.cornrow_rows, CORNROW_WIDTH_FRACTION, max(0.5 * spec.width, 0.008),
                          hairline_margin=spec.hairline_margin)
    for strand, path in zip(res.strands, paths):
        lifted = [vec.add(p, vec.mul(HEAD.normal_at(_to_surface(HEAD, p)), 0.35 * spec.width)) for p in path]
        for p in lifted:
            assert p in strand.centerline


# ---------------------------------------------------------------- face column (v0.2)

def _in_face_column(head, p, shrink=0.8):
    """In front of the face, within 80% of its half-breadth, below the brow line."""
    from protostyle.scalp import FACE_SLAB_TOP
    d = (p[0] - head.fx, p[1] - head.fy, p[2] - head.fz)
    return d[1] < FACE_SLAB_TOP * head.fry and d[2] > 0.0 and abs(d[0]) < shrink * head.frx


@pytest.mark.parametrize("kind", [StyleKind.BOX_BRAIDS, StyleKind.KNOTLESS_BRAIDS, StyleKind.LOCS, StyleKind.TWO_STRAND_TWISTS])
def test_no_hair_hangs_in_front_of_the_face(kind):
    """v0.1 let front-hairline braids hang straight down in front of the face
    (visible in previews/styles_v0_1.png). Full-length hair must now leave the
    space in front of the face, from the brow down, empty."""
    res = generate(StyleSpec(kind=kind, length=0.30))
    bad = sum(1 for s in res.strands for p in s.centerline if _in_face_column(res.head, p))
    assert bad == 0


def test_face_slab_pushes_sideways_only():
    head = HeadProxy()
    p = (0.01, head.fy - 0.10, head.fz + 0.02)
    q, hit = head.project_outside_face(p, 0.0)
    assert hit and q[1] == p[1] and q[2] == p[2] and q[0] == head.fx + head.frx  # below the centre: full width
    assert abs(head.face_implicit(q) - 1.0) < 1e-12
    left, _ = head.project_outside_face((head.fx - 0.01, head.fy - 0.1, head.fz + 0.02), 0.0)
    assert left[0] == head.fx - head.frx
    behind, hit = head.project_outside_face((head.fx + 0.01, head.fy - 0.2, head.fz - 0.01), 0.0)
    assert hit and behind[1] == head.fy - 0.2 and abs(head.face_implicit(behind) - 1.0) < 1e-12
    on_axis, hit = head.project_outside_face((head.fx, head.fy - 0.2, head.fz), 0.0)
    assert hit and on_axis[0] > head.fx
    above = (head.fx, head.fy + 0.9 * head.fry, head.fz + 0.01)  # forehead: ellipsoid rule
    q, hit = head.project_outside_face(above, 0.0)
    assert hit and abs(head.face_implicit(q) - 1.0) < 1e-12


def test_face_slab_is_continuous_with_the_ellipsoid_at_the_brow():
    from protostyle.scalp import FACE_SLAB_TOP
    head = HeadProxy()
    dy = FACE_SLAB_TOP * head.fry
    for x in (0.0, 0.03, 0.05):
        for z in (1e-6, 0.02, 0.05, 0.09):
            just_above = head.face_implicit((head.fx + x, head.fy + dy + 1e-9, head.fz + z))
            just_below = head.face_implicit((head.fx + x, head.fy + dy - 1e-9, head.fz + z))
            assert abs(just_above - just_below) < 1e-6, (x, z)
        # and across the face plane
        front = head.face_implicit((head.fx + x, head.fy + 0.3 * dy, head.fz + 1e-12))
        back = head.face_implicit((head.fx + x, head.fy + 0.3 * dy, head.fz - 1e-12))
        assert abs(front - back) < 1e-9


def test_face_column_would_have_failed_v01():
    """Mutation check: with v0.1's plain ellipsoid keep-out the column test fails."""
    import protostyle.scalp as scalp_mod
    original = scalp_mod.HeadProxy.project_outside_face
    try:
        scalp_mod.HeadProxy.project_outside_face = lambda self, p, c: scalp_mod._push_out(
            p, (self.fx, self.fy, self.fz), (self.frx + c, self.fry + c, self.frz + c))
        res = generate(StyleSpec(kind=StyleKind.BOX_BRAIDS, length=0.30))
        bad = sum(1 for s in res.strands for p in s.centerline if _in_face_column(res.head, p))
        assert bad > 0
    finally:
        scalp_mod.HeadProxy.project_outside_face = original


def test_ceil_count_ignores_rounding_noise():
    from protostyle.styles import _ceil_count
    assert _ceil_count(4.0 + 1e-15) == 4 and _ceil_count(4.0 - 1e-15) == 4 and _ceil_count(4.01) == 5
    assert _ceil_count(0.0) == 1
