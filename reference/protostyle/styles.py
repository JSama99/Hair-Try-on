"""Style catalogue v1 and the generate() entry point.

Five protective / natural styles, chosen because they (a) dominate what users
in the target market actually book and (b) are exactly what the open-source
strand generators do not cover commercially — DiffLocks' synthetic set lacks
braids entirely and is non-commercial; GaussianHaircut is CC BY-NC-SA
(see docs/RESEARCH.md §3).

    BOX_BRAIDS         3-strand plait, visible knot at the root
    KNOTLESS_BRAIDS    3-strand plait, root starts thin and feeds in
    TWO_STRAND_TWISTS  2-strand helix
    LOCS               single rope with deterministic radius variation
    CORNROWS           plaits pinned flat to the scalp along straight-back
                       parts, tails hanging from the nape

generate(spec, head) is pure: same spec + head -> identical geometry.
"""
import math
from dataclasses import dataclass, field, asdict
from enum import Enum

from . import vec
from .drape import MAX_UNSUPPORTED_LENGTH, DrapeParams, drape
from .parting import cornrow_paths, grid_sections
from .rng import SplitMix64, derive_seed
from .scalp import HeadProxy
from .sweep import Mesh, arc_lengths, rotation_minimizing_frames, tube


CORNROW_WIDTH_FRACTION = 0.93  # rows span 93% of head breadth
RELAX_MIN_MOVE = 1e-9          # m; a relax step smaller than this is not a move (v0.2)


class StyleKind(str, Enum):
    BOX_BRAIDS = "box_braids"
    KNOTLESS_BRAIDS = "knotless_braids"
    TWO_STRAND_TWISTS = "two_strand_twists"
    LOCS = "locs"
    CORNROWS = "cornrows"


@dataclass(frozen=True)
class StyleSpec:
    kind: StyleKind
    seed: int = 0x5EED
    width: float = 0.020            # section / braid width (m)
    length: float = 0.30            # hanging length past the root lift / nape (m)
    jitter: float = 0.18            # part irregularity, fraction of a section
    hairline_margin: float = 0.03   # rad inside the hairline for roots
    cornrow_rows: int = 10
    lod0_sides: int = 6
    lod1_sides: int = 6
    samples_per_period: int = 10
    has_body_proxy: bool = False    # True only when a torso collider exists

    def validate(self):
        problems = []
        if not (0.004 <= self.width <= 0.06):
            problems.append("width must be between 4 mm and 6 cm")
        if not (0.0 <= self.length <= 1.2):
            problems.append("length must be between 0 and 1.2 m")
        if self.length > MAX_UNSUPPORTED_LENGTH and not self.has_body_proxy:
            problems.append(
                f"length {self.length:.2f} m exceeds {MAX_UNSUPPORTED_LENGTH:.2f} m without a torso collider; "
                "strands would hang through the shoulders"
            )
        if not (3 <= self.lod0_sides <= 16 and 3 <= self.lod1_sides <= 16):
            problems.append("sides must be between 3 and 16")
        if not (6 <= self.samples_per_period <= 32):
            problems.append("samples_per_period must be between 6 and 32")
        if self.kind == StyleKind.CORNROWS and not (2 <= self.cornrow_rows <= 24):
            problems.append("cornrow_rows must be between 2 and 24")
        if not (0 <= self.seed < 2 ** 64):
            problems.append("seed must fit in UInt64")
        return problems


@dataclass(frozen=True)
class Profile:
    strands: int
    lateral_amp: float    # x width
    depth_amp: float      # x width
    strand_radius: float  # x width
    period: float         # x width (length of one full phase cycle)
    shell_radius: float   # x width (LOD1 envelope)


PROFILES = {
    # Plait depth/period are bounded by geometry, not taste: the strand path's
    # tightest bend (at the depth extremum) has radius ~ 1/kappa with
    # kappa = 4*D*w^2 / (1 + (A*w*0.707)^2)^1.5 (w = 2*pi/period). D = 0.09,
    # period 1.5 keeps that radius ~0.38 x width, safely above the 0.26 x width
    # strand radius, so strand tubes never self-invert (validator V13).
    StyleKind.BOX_BRAIDS: Profile(3, 0.30, 0.09, 0.26, 1.50, 0.56),
    StyleKind.KNOTLESS_BRAIDS: Profile(3, 0.30, 0.09, 0.26, 1.50, 0.56),
    StyleKind.TWO_STRAND_TWISTS: Profile(2, 0.22, 0.22, 0.24, 1.60, 0.46),
    StyleKind.LOCS: Profile(1, 0.0, 0.0, 0.40, 1.00, 0.46),
    StyleKind.CORNROWS: Profile(3, 0.30, 0.10, 0.24, 1.30, 0.54),
}


@dataclass
class Strand:
    root_index: int
    centerline: list
    radius_max: float
    free_from_s: float = 0.0  # arc length where the pinned prefix ends and hanging begins


@dataclass
class StyleResult:
    spec: StyleSpec
    head: HeadProxy
    roots: list
    strands: list
    lod0: Mesh
    lod1: Mesh
    stats: dict = field(default_factory=dict)


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3.0 - 2.0 * t)


def _ceil_count(ratio):
    """ceil() that ignores rounding noise at exact integers (v0.2).

    The root lift is 0.6 x width and the dense spacing 1.5 x width / 10, so the
    first segment is exactly 4 spacings (6 for locs). Plain ceil() turned
    4 + 1e-16 into 5: whether a strand got an extra sample depended on the last
    bit of sin(), so ports could not match. Ratios within 1e-9 of an integer
    count as that integer.
    """
    return max(1, int(math.ceil(ratio - 1e-9)))


def catmull_rom(points, spacing):
    """Uniform Catmull-Rom densification to ~`spacing`.

    Every control point is emitted *exactly* (bitwise), not re-evaluated at
    t = 1 — the polynomial at t = 1 is only equal to p2 up to rounding, and
    callers locate pinned control points in the output by identity.
    """
    return catmull_rom_indexed(points, spacing)[0]


def catmull_rom_indexed(points, spacing):
    """As catmull_rom, also returning the dense index of each control point."""
    if len(points) < 2:
        return list(points), list(range(len(points)))
    out = [points[0]]
    idx = [0]
    n = len(points)
    for i in range(n - 1):
        p0 = points[max(0, i - 1)]
        p1 = points[i]
        p2 = points[i + 1]
        p3 = points[min(n - 1, i + 2)]
        seg = vec.length(vec.sub(p2, p1))
        steps = _ceil_count(seg / spacing)
        for k in range(1, steps):
            t = k / steps
            t2, t3 = t * t, t * t * t
            c = []
            for d in range(3):
                c.append(0.5 * ((2.0 * p1[d]) + (-p0[d] + p2[d]) * t + (2.0 * p0[d] - 5.0 * p1[d] + 4.0 * p2[d] - p3[d]) * t2 + (-p0[d] + 3.0 * p1[d] - 3.0 * p2[d] + p3[d]) * t3))
            out.append(tuple(c))
        out.append(p2)
        idx.append(len(out) - 1)
    return out, idx


def relax_curvature(head, points, min_radius, clearance, spacing, keep=1, iterations=60):
    """Remove bends tighter than `min_radius` from a dense centreline.

    The coarse drape leaves a kink where the pinned root lift meets the hanging
    chain; a swept tube inverts on the inside of any bend tighter than its
    radius (validator V13). Offending samples get a Laplacian pull toward
    their neighbours' midpoint, then are re-projected out of the head/face;
    the polyline is finally resampled to uniform arc length so plait phase
    stays evenly resolved (validator V05). The first `keep` samples (the root,
    or a whole pinned cornrow path) never move.
    """
    from .parting import resample_polyline
    pts = list(points)
    n = len(pts)
    for _ in range(iterations):
        moved = False
        for i in range(keep, n - 1):
            a, b, c = pts[i - 1], pts[i], pts[i + 1]
            u, v = vec.sub(b, a), vec.sub(c, b)
            lu, lv = vec.length(u), vec.length(v)
            if lu < 1e-12 or lv < 1e-12:
                continue
            ang = math.acos(max(-1.0, min(1.0, vec.dot(u, v) / (lu * lv))))
            if ang < 1e-9 or 0.5 * (lu + lv) / ang >= min_radius:
                continue
            mid = vec.mul(vec.add(a, c), 0.5)
            q, _ = head.collide(vec.add(b, vec.mul(vec.sub(mid, b), 0.6)), clearance)
            if vec.length(vec.sub(q, b)) < RELAX_MIN_MOVE:
                # The collider undid the pull: this bend is held by the head or
                # face and cannot be relaxed. v0.1 counted it as a move, so every
                # strand ran all 60 iterations re-testing borderline bends.
                continue
            pts[i] = q
            moved = True
        if not moved:
            break
    head_part = pts[:keep]
    tail = resample_polyline(pts[keep - 1:], spacing)
    return head_part + tail[1:]


class _ValueNoise:
    """1-D lattice value noise, lattice every `cell` metres, cosine interp."""

    def __init__(self, seed: int, cell: float, count: int):
        rng = SplitMix64(seed)
        self.cell = cell
        self.values = [rng.next_signed() for _ in range(count + 2)]

    def __call__(self, s: float) -> float:
        x = max(0.0, s / self.cell)
        i = int(math.floor(x))
        i = min(i, len(self.values) - 2)
        f = x - i
        w = (1.0 - math.cos(f * math.pi)) * 0.5
        return self.values[i] * (1.0 - w) + self.values[i + 1] * w


def _radius_profile(kind, s, total, width, strand_radius, noise):
    r = strand_radius * width
    if kind == StyleKind.BOX_BRAIDS:
        r *= 1.0 + 0.28 * math.exp(-((s / 0.010) ** 2))           # the knot
    elif kind == StyleKind.KNOTLESS_BRAIDS:
        r *= 0.45 + 0.55 * smoothstep(0.0, 0.035, s)               # fed-in root
    elif kind == StyleKind.LOCS:
        r *= 1.0 + 0.12 * noise(s)
    taper_start = total * 0.94
    if s > taper_start and total > 0.0:
        r *= 1.0 - 0.45 * smoothstep(taper_start, total, s)
    return r


def _feed_scale(kind, s):
    if kind == StyleKind.KNOTLESS_BRAIDS:
        return 0.45 + 0.55 * smoothstep(0.0, 0.035, s)
    return 1.0


def _strand_offset(kind, profile, strand, s, width):
    if profile.strands == 1:
        wob = 0.04 * width * math.sin(2.0 * math.pi * s / (profile.period * width))
        return wob, 0.0
    omega = 2.0 * math.pi / (profile.period * width)
    if profile.strands == 3:
        phase = omega * s + 2.0 * math.pi * strand / 3.0
        return profile.lateral_amp * width * math.sin(phase), profile.depth_amp * width * math.sin(2.0 * phase)
    phase = omega * s + math.pi * strand
    return profile.lateral_amp * width * math.cos(phase), profile.depth_amp * width * math.sin(phase)


def _sweep_strands(spec, profile, centerline, lateral0, outward, noise, lod0, lod1):
    T, N, B = rotation_minimizing_frames(centerline, lateral0, outward)
    s_vals = arc_lengths(centerline)
    total = s_vals[-1]
    w = spec.width
    r_max = 0.0
    for strand in range(profile.strands):
        centers, radii = [], []
        for k, s in enumerate(s_vals):
            lat, dep = _strand_offset(spec.kind, profile, strand, s, w)
            scale = _feed_scale(spec.kind, s)
            centers.append(vec.add(centerline[k], vec.add(vec.mul(N[k], lat * scale), vec.mul(B[k], dep * scale))))
            r = _radius_profile(spec.kind, s, total, w, profile.strand_radius, noise)
            radii.append(r)
            r_max = max(r_max, r)
        # Rings must be perpendicular to the strand itself, not the braid axis:
        # plait strands run at up to ~50 deg to the axis, and axis-aligned rings
        # would be skewed enough to cross. Frames per strand, seeded from the
        # braid's lateral axis so all strands share an orientation reference.
        _, Ns, Bs = rotation_minimizing_frames(centers, N[0], outward) if profile.strands > 1 else (None, N, B)
        lod0.extend(tube(centers, Ns, Bs, radii, spec.lod0_sides, cap_tip=True, v_scale=1.0 / (profile.period * w), s_values=s_vals))
    # LOD1 shell: one tube around the centreline, every 4th sample, UV v in plait periods.
    idx = list(range(0, len(centerline), 4))
    if idx[-1] != len(centerline) - 1:
        idx.append(len(centerline) - 1)
    shell_c = [centerline[i] for i in idx]
    shell_r = []
    for i in idx:
        s = s_vals[i]
        base = profile.shell_radius * w * _feed_scale(spec.kind, s)
        if spec.kind == StyleKind.LOCS:
            base *= 1.0 + 0.12 * noise(s)
        if s > total * 0.94:
            base *= 1.0 - 0.45 * smoothstep(total * 0.94, total, s)
        shell_r.append(base)
    lod1.extend(tube(shell_c, [N[i] for i in idx], [B[i] for i in idx], shell_r, spec.lod1_sides, cap_tip=True,
                     v_scale=1.0 / (profile.period * w), s_values=[s_vals[i] for i in idx]))
    return r_max


def generate(spec: StyleSpec, head: HeadProxy = HeadProxy(), drape_params: DrapeParams = DrapeParams()) -> StyleResult:
    problems = spec.validate()
    if problems:
        raise ValueError("; ".join(problems))
    profile = PROFILES[spec.kind]
    w = spec.width
    period = profile.period * w
    dense_spacing = period / spec.samples_per_period
    drape_segment = max(0.5 * w, 0.008)
    clearance = profile.shell_radius * w
    lod0, lod1 = Mesh(), Mesh()
    strands = []

    if spec.kind == StyleKind.CORNROWS:
        paths = cornrow_paths(head, spec.cornrow_rows, CORNROW_WIDTH_FRACTION, drape_segment, hairline_margin=spec.hairline_margin)
        roots = []
        for ri, path in enumerate(paths):
            lifted = [vec.add(p, vec.mul(head.normal_at(_to_surface(head, p)), 0.35 * w)) for p in path]
            coarse = drape(head, lifted, spec.length, drape_segment, clearance, drape_params, min_bend_radius=1.25 * clearance)
            dense, ctrl = catmull_rom_indexed(coarse, dense_spacing)
            keep = ctrl[len(lifted) - 1] + 1  # the whole pinned on-scalp path stays put
            dense = relax_curvature(head, dense, 1.1 * clearance, 0.9 * clearance, dense_spacing, keep=keep)
            outward = head.normal_at(_to_surface(head, path[0]))
            t0 = vec.normalize(vec.sub(path[1], path[0]))
            lateral0 = vec.normalize(vec.cross(outward, t0))
            noise = _ValueNoise(derive_seed(spec.seed, f"noise:{ri}"), 0.02, int(len(dense) * dense_spacing / 0.02) + 4)
            r_max = _sweep_strands(spec, profile, dense, lateral0, outward, noise, lod0, lod1)
            strands.append(Strand(ri, dense, r_max, _polyline_length(lifted)))
            roots.append(path[0])
        root_records = roots
    else:
        root_records = grid_sections(head, w, spec.jitter, spec.seed, hairline_margin=spec.hairline_margin)
        lift = 0.6 * w
        for root in root_records:
            fixed = [root.point, vec.add(root.point, vec.mul(_part_direction(root), lift))]
            coarse = drape(head, fixed, spec.length, drape_segment, clearance, drape_params, min_bend_radius=1.25 * clearance)
            dense = relax_curvature(head, catmull_rom(coarse, dense_spacing), 1.1 * clearance, 0.9 * clearance,
                                    dense_spacing, keep=1)
            noise = _ValueNoise(derive_seed(spec.seed, f"noise:{root.index}"), 0.02,
                                int((spec.length + lift) / 0.02) + 6)
            r_max = _sweep_strands(spec, profile, dense, root.t_side, root.normal, noise, lod0, lod1)
            strands.append(Strand(root.index, dense, r_max, lift))

    lengths = [arc_lengths(s.centerline)[-1] for s in strands]
    stats = {
        "kind": spec.kind.value,
        "roots": len(strands),
        "strands_per_root": profile.strands,
        "lod0_vertices": len(lod0.positions),
        "lod0_triangles": lod0.triangle_count,
        "lod1_vertices": len(lod1.positions),
        "lod1_triangles": lod1.triangle_count,
        "mean_length_m": round(sum(lengths) / len(lengths), 6) if lengths else 0.0,
    }
    return StyleResult(spec, head, root_records, strands, lod0, lod1, stats)


def _part_direction(root):
    """Initial direction hair leaves the scalp: the scalp normal swept back.

    Stylists part and lay front sections back; the sweep is strongest at the
    front hairline (phi ~ 0) and vanishes at the sides and back.
    """
    sweep = 1.1 * max(0.0, math.cos(root.phi))
    return vec.normalize(vec.add(root.normal, vec.mul(root.t_back, sweep)))


def _polyline_length(points):
    return sum(vec.length(vec.sub(points[i], points[i - 1])) for i in range(1, len(points)))


def _to_surface(head: HeadProxy, p):
    d = vec.sub(p, head.center())
    k = math.sqrt((d[0] / head.rx) ** 2 + (d[1] / head.ry) ** 2 + (d[2] / head.rz) ** 2)
    return vec.add(head.center(), vec.mul(d, 1.0 / k))


def spec_dict(spec: StyleSpec) -> dict:
    d = asdict(spec)
    d["kind"] = spec.kind.value
    return d
