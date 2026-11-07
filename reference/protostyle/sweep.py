"""Sweep a draped centreline into strand geometry.

Frames are rotation-minimising (double reflection, Wang et al., ACM TOG 2008):
no twist accumulates from the frame itself, so all visible twist comes from the
style's own phase function. The initial lateral axis is the root's scalp
side-tangent, flipped if needed so the binormal (the braid's "depth" axis)
faces away from the head.

Plait model: the three-strand braid follows the published sinusoidal braid
model (lateral = A sin(wt + 2*pi*i/3), depth = B sin(2(wt + 2*pi*i/3))) used in
single-view braided-hair reconstruction work. Twists are a two-strand helix;
locs a single tube with deterministic radius noise. All are clean-room
implementations of standard geometry — no third-party code or weights.
"""
import math
from dataclasses import dataclass, field

from . import vec


@dataclass
class Mesh:
    positions: list = field(default_factory=list)
    triangles: list = field(default_factory=list)
    uvs: list = field(default_factory=list)
    normals: list = field(default_factory=list)  # analytic unit normals (tube radial / tip tangent)

    def extend(self, other: "Mesh"):
        base = len(self.positions)
        self.positions.extend(other.positions)
        self.uvs.extend(other.uvs)
        self.normals.extend(other.normals)
        self.triangles.extend((a + base, b + base, c + base) for a, b, c in other.triangles)

    @property
    def triangle_count(self):
        return len(self.triangles)


def tangents(points):
    n = len(points)
    if n < 2:
        raise ValueError("need at least two points")
    out = []
    for i in range(n):
        a = points[max(0, i - 1)]
        b = points[min(n - 1, i + 1)]
        out.append(vec.normalize(vec.sub(b, a)))
    return out


def rotation_minimizing_frames(points, lateral0, outward):
    """Return (T, N, B) lists. N starts as lateral0 projected off T0.

    `outward` is the scalp normal at the root: if T0 x N0 points into the head
    we flip N0 so the depth axis B always faces outward at the root.
    """
    T = tangents(points)
    n0 = vec.sub(lateral0, vec.mul(T[0], vec.dot(lateral0, T[0])))
    if vec.length(n0) < 1e-9:
        # lateral0 parallel to the tangent: pick any perpendicular.
        alt = (1.0, 0.0, 0.0) if abs(T[0][0]) < 0.9 else (0.0, 1.0, 0.0)
        n0 = vec.sub(alt, vec.mul(T[0], vec.dot(alt, T[0])))
    n0 = vec.normalize(n0)
    if vec.dot(vec.cross(T[0], n0), outward) < 0.0:
        n0 = vec.mul(n0, -1.0)
    N = [n0]
    for i in range(len(points) - 1):
        v1 = vec.sub(points[i + 1], points[i])
        c1 = vec.dot(v1, v1)
        if c1 < 1e-24:
            N.append(N[-1])
            continue
        rL = vec.sub(N[i], vec.mul(v1, 2.0 / c1 * vec.dot(v1, N[i])))
        tL = vec.sub(T[i], vec.mul(v1, 2.0 / c1 * vec.dot(v1, T[i])))
        v2 = vec.sub(T[i + 1], tL)
        c2 = vec.dot(v2, v2)
        r_next = rL if c2 < 1e-24 else vec.sub(rL, vec.mul(v2, 2.0 / c2 * vec.dot(v2, rL)))
        # Re-orthogonalise against drift.
        r_next = vec.normalize(vec.sub(r_next, vec.mul(T[i + 1], vec.dot(r_next, T[i + 1]))))
        N.append(r_next)
    B = [vec.cross(T[i], N[i]) for i in range(len(points))]
    return T, N, B


def arc_lengths(points):
    s = [0.0]
    for i in range(1, len(points)):
        s.append(s[-1] + vec.length(vec.sub(points[i], points[i - 1])))
    return s


def clamp_to_curvature(centers, radii, factor: float = 0.9):
    """Limit each ring radius to `factor` x the local centreline curvature radius.

    Consecutive rings of a swept tube cross each other on the inside of any
    bend tighter than the tube radius, which inverts faces (validator V13) and
    shows as black holes under back-face culling. Real hair compresses on the
    inside of a tight bend, so pinching the ring is both the correct fix and
    the physically plausible look.
    """
    n = len(centers)
    out = list(radii)
    for k in range(1, n - 1):
        u = vec.sub(centers[k], centers[k - 1])
        v = vec.sub(centers[k + 1], centers[k])
        lu, lv = vec.length(u), vec.length(v)
        if lu < 1e-12 or lv < 1e-12:
            continue
        ang = math.acos(max(-1.0, min(1.0, vec.dot(u, v) / (lu * lv))))
        if ang < 1e-9:
            continue
        r_curv = 0.5 * (lu + lv) / ang
        if out[k] > factor * r_curv:
            out[k] = factor * r_curv
    return out


def tube(centers, N, B, radii, sides: int, cap_tip: bool, v_scale: float = 1.0, s_values=None):
    """Tube around per-sample strand centres using the centreline frame (N, B)."""
    if sides < 3:
        raise ValueError("sides must be >= 3")
    m = Mesh()
    rings = len(centers)
    radii = clamp_to_curvature(centers, radii)
    for k in range(rings):
        c, n, b, r = centers[k], N[k], B[k], radii[k]
        v = (s_values[k] if s_values is not None else k) * v_scale
        for j in range(sides):
            a = 2.0 * math.pi * j / sides
            ca, sa = math.cos(a), math.sin(a)
            radial = vec.add(vec.mul(n, ca), vec.mul(b, sa))
            m.positions.append(vec.add(c, vec.mul(radial, r)))
            m.normals.append(radial)
            m.uvs.append((j / sides, v))
    for k in range(rings - 1):
        r0, r1 = k * sides, (k + 1) * sides
        for j in range(sides):
            j1 = (j + 1) % sides
            # Counter-clockwise seen from outside, so RealityKit/Metal back-face
            # culling keeps the outer surface (validator V13).
            m.triangles.append((r0 + j, r1 + j1, r1 + j))
            m.triangles.append((r0 + j, r0 + j1, r1 + j1))
    if cap_tip:
        tip_index = len(m.positions)
        t = vec.normalize(vec.sub(centers[-1], centers[-2]))
        m.positions.append(vec.add(centers[-1], vec.mul(t, radii[-1] * 0.6)))
        m.normals.append(t)
        m.uvs.append((0.5, ((s_values[-1] if s_values is not None else rings - 1)) * v_scale))
        base = (rings - 1) * sides
        for j in range(sides):
            m.triangles.append((base + j, base + (j + 1) % sides, tip_index))
    return m
