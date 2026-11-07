"""Deterministic rest-pose drape for hanging hair (braids, twists, locs, cornrow tails).

A position-based-dynamics (Verlet) chain: fixed prefix nodes are pinned (root +
lift node, or a whole on-scalp cornrow path), free nodes fall under gravity and
are constrained by exact follow-the-leader inextensibility, a soft bend
constraint, and collision
against the head proxy and the face keep-out, both inflated by the strand's
thickness.

Everything is fixed-step and fixed-order, so the Swift runtime port produces the
same rest pose (within libm ulp noise — see ARCHITECTURE.md §9). The runtime
then continues simulating from this rest pose for live motion; the reference
only defines the rest pose and the solver semantics.

Known v1 limit: there is no torso collider. ARKit face tracking gives no body,
so strands longer than `MAX_UNSUPPORTED_LENGTH` would hang through the shoulders.
The generator refuses such lengths unless a body proxy is supplied (roadmap:
TalonRig / SAM 3D Body torso capture, ARCHITECTURE.md §4.3).
"""
import math
from dataclasses import dataclass

from . import vec
from .scalp import HeadProxy

MAX_UNSUPPORTED_LENGTH = 0.40  # metres below the root before the torso would matter


@dataclass(frozen=True)
class DrapeParams:
    steps: int = 220
    passes: int = 10
    gravity: float = 9.81
    dt: float = 1.0 / 90.0
    damping: float = 0.985
    bend_stiffness: float = 0.35
    ftl_damping: float = 0.9


def _bend(pos, n_fixed, ds, stiffness, min_radius):
    """Minimum-bend-radius constraint across each joint (i-2, i-1, i).

    A joint with incoming length l1 and outgoing l2 may turn at most
    phi = (l1 + l2) / (2 R) radians (arc length over radius), which fixes a
    minimum chord |p[i] - p[i-2]| by the law of cosines. With R = 0 this
    degenerates to the soft 'no folding back' constraint (phi = ~20 deg).
    Pinned nodes never move; the free end takes the whole correction.
    """
    for i in range(max(n_fixed, 2), len(pos)):
        a, m, b = pos[i - 2], pos[i - 1], pos[i]
        l1 = vec.length(vec.sub(m, a))
        l2 = ds
        phi = (l1 + l2) / (2.0 * min_radius) if min_radius > 0.0 else 0.35
        phi = min(phi, 2.6)
        rest = math.sqrt(max(0.0, l1 * l1 + l2 * l2 + 2.0 * l1 * l2 * math.cos(phi)))
        d = vec.sub(b, a)
        dist = vec.length(d)
        if dist >= rest or dist < 1e-12:
            continue
        corr = (dist - rest) / dist * stiffness
        if i - 2 < n_fixed:
            pos[i] = vec.sub(b, vec.mul(d, corr))
        else:
            half = vec.mul(d, 0.5 * corr)
            pos[i - 2] = vec.add(a, half)
            pos[i] = vec.sub(b, half)


def _follow_the_leader(pos, n_fixed, ds):
    """Inextensibility by follow-the-leader (Mueller et al., "Fast Simulation of
    Inextensible Hair and Fur", VRIPHYS 2012): walk root -> tip placing each
    node exactly ds from its predecessor. Exact, O(n), and the standard GPU
    hair solver step — which is why the runtime port uses the same scheme.

    Returns per-node correction vectors (zero for pinned nodes) for the DFTL
    velocity correction.
    """
    corr = [(0.0, 0.0, 0.0)] * len(pos)
    for i in range(n_fixed, len(pos)):
        d = vec.sub(pos[i], pos[i - 1])
        dist = vec.length(d)
        if dist < 1e-12:
            d, dist = (0.0, -1.0, 0.0), 1.0
        target = vec.add(pos[i - 1], vec.mul(d, ds / dist))
        corr[i] = vec.sub(target, pos[i])
        pos[i] = target
    return corr


def drape(head: HeadProxy, fixed, free_length: float, segment: float, clearance: float, params: DrapeParams = DrapeParams(),
          min_bend_radius: float = 0.0):
    """Return the settled polyline: fixed prefix followed by free nodes.

    fixed        list of >= 2 points; the last two define the initial free direction.
    free_length  metres of hanging length after the fixed prefix (may be 0).
    segment      target segment length (m).
    clearance    minimum distance from the head surface (strand half-thickness).
    min_bend_radius  hair this thick cannot bend tighter than this (m). The
                 swept tube self-intersects (inverted faces, validator V13)
                 if the centreline curves tighter than the tube radius, so
                 callers pass >= the strand envelope radius.
    """
    if len(fixed) < 2:
        raise ValueError("drape needs at least two fixed points")
    if segment <= 0.0:
        raise ValueError("segment must be positive")
    if free_length < 0.0:
        raise ValueError("free_length must be >= 0")
    n_free = int(round(free_length / segment))
    if n_free == 0:
        return list(fixed)
    ds = free_length / n_free

    direction = vec.normalize(vec.sub(fixed[-1], fixed[-2]))
    pos = list(fixed)
    for i in range(1, n_free + 1):
        pos.append(vec.add(fixed[-1], vec.mul(direction, ds * i)))
    prev = list(pos)
    n_fixed = len(fixed)
    g = (0.0, -params.gravity * params.dt * params.dt, 0.0)

    for _ in range(params.steps):
        # Integrate free nodes.
        for i in range(n_fixed, len(pos)):
            p = pos[i]
            v = vec.mul(vec.sub(p, prev[i]), params.damping)
            prev[i] = p
            pos[i] = vec.add(vec.add(p, v), g)
        acc = [(0.0, 0.0, 0.0)] * len(pos)
        for _ in range(params.passes):
            c = _follow_the_leader(pos, n_fixed, ds)
            acc = [vec.add(a, b) for a, b in zip(acc, c)]
            _bend(pos, n_fixed, ds, params.bend_stiffness, min_bend_radius)
            for i in range(n_fixed, len(pos)):
                pos[i], _ = head.collide(pos[i], clearance)
        # DFTL velocity correction: node i gives back the FTL push its child
        # received, which removes the artificial energy FTL would otherwise add.
        for i in range(n_fixed, len(pos) - 1):
            prev[i] = vec.add(prev[i], vec.mul(acc[i + 1], params.ftl_damping))  # v += -s * d(child)
    # Final settle: alternate collision and exact inextensibility, ending on
    # follow-the-leader so every free segment is exactly ds long.
    for _ in range(6):
        _bend(pos, n_fixed, ds, 1.0, min_bend_radius)
        for i in range(n_fixed, len(pos)):
            pos[i], _ = head.collide(pos[i], clearance)
        _follow_the_leader(pos, n_fixed, ds)
    return pos
