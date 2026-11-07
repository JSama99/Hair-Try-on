"""Parting layouts: where each braid / twist / loc / cornrow is rooted.

Two layouts cover the v1 style catalogue:

* grid_sections  — box braids, knotless, twists, locs. A brick-offset grid of
  roughly square sections of side `section_size`, laid out in scalp (theta, phi)
  space with row circumference scaling, seeded jitter, and hairline clipping.
* cornrow_paths  — straight-back cornrows. Each row lives in a constant-x plane
  and runs front hairline -> over the top -> nape, resampled to uniform arc
  length.
"""
import math
from dataclasses import dataclass

from . import vec
from .rng import SplitMix64, derive_seed
from .scalp import HeadProxy


@dataclass(frozen=True)
class Root:
    index: int
    theta: float
    phi: float
    point: tuple
    normal: tuple
    t_back: tuple
    t_side: tuple


def _mean_radius(head: HeadProxy) -> float:
    return (head.rx + head.ry + head.rz) / 3.0


def grid_sections(head: HeadProxy, section_size: float, jitter: float, seed: int, hairline_margin: float = 0.0):
    if not (0.004 <= section_size <= 0.08):
        raise ValueError("section_size must be between 4 mm and 8 cm")
    if not (0.0 <= jitter <= 0.45):
        raise ValueError("jitter must be in [0, 0.45]")
    rng = SplitMix64(derive_seed(seed, "grid_sections"))
    r_mean = _mean_radius(head)
    d_theta = section_size / r_mean
    theta_max = head.hairline_back  # the lowest the hairline ever goes
    roots = []
    row = 0
    theta = d_theta * 0.5
    while theta < theta_max:
        circ = 2.0 * math.pi * r_mean * math.sin(theta)
        cols = max(1, int(round(circ / section_size)))
        step = 2.0 * math.pi / cols
        offset = 0.5 * step if (row % 2 == 1) else 0.0
        for c in range(cols):
            phi = -math.pi + (c + 0.5) * step + offset
            # Draw jitter unconditionally so the RNG stream does not depend on
            # the hairline test (keeps layouts stable when hairline params move).
            jt = rng.next_signed() * jitter * d_theta
            jp = rng.next_signed() * jitter * step
            th = theta + jt
            ph = phi + jp
            if ph > math.pi:
                ph -= 2.0 * math.pi
            if ph <= -math.pi:
                ph += 2.0 * math.pi
            if th <= 0.0:
                th = 1e-4
            if not head.inside_hairline(th, ph, margin=hairline_margin):
                continue
            p = head.point(th, ph)
            n, tb, ts = head.tangent_frame(th, ph)
            roots.append(Root(len(roots), th, ph, p, n, tb, ts))
        theta += d_theta
        row += 1
    return roots


def _theta_phi_of(head: HeadProxy, p):
    d = vec.sub(p, head.center())
    nx, ny, nz = d[0] / head.rx, d[1] / head.ry, d[2] / head.rz
    theta = math.acos(max(-1.0, min(1.0, ny / math.sqrt(nx * nx + ny * ny + nz * nz))))
    phi = math.atan2(nx, nz)
    return theta, phi


def _to_surface(head: HeadProxy, p):
    """Radially re-project a chord point back onto the ellipsoid."""
    d = vec.sub(p, head.center())
    k = math.sqrt((d[0] / head.rx) ** 2 + (d[1] / head.ry) ** 2 + (d[2] / head.rz) ** 2)
    return vec.add(head.center(), vec.mul(d, 1.0 / k))


def resample_polyline(points, spacing: float):
    """Uniform arc-length resampling; always keeps the first and last point."""
    if len(points) < 2:
        return list(points)
    seg = [vec.length(vec.sub(points[i + 1], points[i])) for i in range(len(points) - 1)]
    total = sum(seg)
    n = max(1, int(math.ceil(total / spacing - 1e-9)))  # ignore rounding noise at exact integers (v0.2)
    out = [points[0]]
    target_step = total / n
    i, acc = 0, 0.0
    for k in range(1, n):
        target = k * target_step
        while acc + seg[i] < target:
            acc += seg[i]
            i += 1
        t = (target - acc) / seg[i]
        out.append(vec.lerp(points[i], points[i + 1], t))
    out.append(points[-1])
    return out


def cornrow_paths(head: HeadProxy, rows: int, width_fraction: float, spacing: float, hairline_margin: float = 0.02):
    """Straight-back cornrow centre paths on the scalp surface (not offset)."""
    if not (2 <= rows <= 24):
        raise ValueError("rows must be between 2 and 24")
    if not (0.2 <= width_fraction <= 0.95):
        raise ValueError("width_fraction must be in [0.2, 0.95]")
    paths = []
    for k in range(rows):
        u = -1.0 + (2.0 * k + 1.0) / rows  # evenly spaced in (-1, 1)
        x = u * width_fraction * head.rx
        s = math.sqrt(max(0.0, 1.0 - (x / head.rx) ** 2))
        inside_run = []
        best = []
        samples = 480
        for i in range(samples + 1):
            a = -0.2 + (math.pi + 0.9) * i / samples  # front, over the top, down the back
            p = (head.cx + x, head.cy + head.ry * s * math.sin(a), head.cz + head.rz * s * math.cos(a))
            th, ph = _theta_phi_of(head, p)
            if head.inside_hairline(th, ph, margin=hairline_margin):
                inside_run.append(p)
            else:
                if len(inside_run) > len(best):
                    best = inside_run
                inside_run = []
        if len(inside_run) > len(best):
            best = inside_run
        if len(best) < 2:
            continue
        paths.append([_to_surface(head, q) for q in resample_polyline(best, spacing)])
    return paths
