"""Head proxy and scalp parameterisation.

ARKit's ARFaceGeometry is a 1,220-vertex face mask: it stops at the forehead and
has no scalp. Every protective style needs a scalp to root on, so the runtime
fits this ellipsoidal proxy to the tracked face (runtime fit: see
docs/ARCHITECTURE.md §4.2) and, when a TalonRig capture exists, replaces the
radii with the MHR head-identity fit (§4.3).

Coordinate frame = ARKit face-anchor frame: metres, +Y up, +Z out of the face
(toward the camera), +X toward the subject's left.

Scalp parameters (theta, phi):
  theta  polar angle from the crown (+Y). 0 = crown, pi/2 = equator.
  phi    azimuth about +Y. 0 = front (+Z), +pi/2 = subject's left (+X),
         +/-pi = back (-Z).
"""
import math
from dataclasses import dataclass

from . import vec


@dataclass(frozen=True)
class HeadProxy:
    # Semi-axes (m). Defaults: adult head breadth ~15 cm, length ~19.5 cm.
    rx: float = 0.076
    ry: float = 0.100
    rz: float = 0.097
    # Ellipsoid centre relative to the face-anchor origin (m).
    cx: float = 0.0
    cy: float = 0.025
    cz: float = -0.030
    # Hairline polar angles (rad): front (forehead), back (nape), and how far
    # the hairline rises over the ears.
    hairline_front: float = 0.98
    hairline_back: float = 1.95
    ear_notch: float = 0.30
    ear_notch_width: float = 0.38
    # Face keep-out: an ellipsoid enclosing the tracked face mask (brow to
    # chin, cheek to cheek); from the brow down it becomes a face-wide slab in
    # front of the face and an elliptic cylinder behind it (_push_out_face).
    # Hanging hair may frame the face but never hang over it: v0.1 had the
    # ellipsoid only, and front-hairline braids fell straight down in front of
    # the face. The slab sends them to the sides, as a stylist lays them.
    fx: float = 0.0
    fy: float = -0.030
    fz: float = 0.028
    frx: float = 0.070
    fry: float = 0.100
    frz: float = 0.078

    def center(self):
        return (self.cx, self.cy, self.cz)

    def point(self, theta: float, phi: float):
        st = math.sin(theta)
        return (
            self.cx + self.rx * st * math.sin(phi),
            self.cy + self.ry * math.cos(theta),
            self.cz + self.rz * st * math.cos(phi),
        )

    def normal_at(self, p):
        """Outward unit normal at a surface point (gradient of the implicit)."""
        d = vec.sub(p, self.center())
        return vec.normalize((d[0] / (self.rx * self.rx), d[1] / (self.ry * self.ry), d[2] / (self.rz * self.rz)))

    def implicit(self, p) -> float:
        """<1 inside, 1 on the surface, >1 outside."""
        d = vec.sub(p, self.center())
        return (d[0] / self.rx) ** 2 + (d[1] / self.ry) ** 2 + (d[2] / self.rz) ** 2

    def project_outside(self, p, clearance: float):
        """Push p out to at least `clearance` metres outside the head ellipsoid.

        Radial projection onto the inflated ellipsoid (semi-axes + clearance):
        exact enough at braid scale and branch-simple on the GPU.
        """
        return _push_out(p, self.center(), (self.rx + clearance, self.ry + clearance, self.rz + clearance))

    def project_outside_face(self, p, clearance: float):
        return _push_out_face(p, (self.fx, self.fy, self.fz), (self.frx + clearance, self.fry + clearance, self.frz + clearance))

    def collide(self, p, clearance: float):
        """Resolve p against every collider (head, then face). Order is part of the contract."""
        p, hit_h = self.project_outside(p, clearance)
        p, hit_f = self.project_outside_face(p, clearance)
        return p, (hit_h or hit_f)

    def face_implicit(self, p, clearance: float = 0.0) -> float:
        """<1 inside the face keep-out (see _push_out_face for its shape)."""
        d = vec.sub(p, (self.fx, self.fy, self.fz))
        r0, r1, r2 = self.frx + clearance, self.fry + clearance, self.frz + clearance
        top = FACE_SLAB_TOP * r1
        ax, az = d[0] / r0, d[2] / r2
        if d[1] > top:
            ay = d[1] / r1
            return ax * ax + ay * ay + az * az
        dy = d[1] if d[1] > 0.0 else 0.0
        ay = dy / r1
        if d[2] > 0.0:
            return ax * ax + ay * ay + (dy / top) * (az * az)
        return ax * ax + ay * ay + az * az

    def hairline_theta(self, phi: float) -> float:
        """Polar angle of the hairline at azimuth phi (grows front -> back)."""
        base = self.hairline_front + (self.hairline_back - self.hairline_front) * (1.0 - math.cos(phi)) * 0.5
        side = abs(phi)
        notch = self.ear_notch * math.exp(-(((side - math.pi * 0.5) / self.ear_notch_width) ** 2))
        return base - notch

    def inside_hairline(self, theta: float, phi: float, margin: float = 0.0) -> bool:
        return theta <= self.hairline_theta(phi) - margin

    def tangent_frame(self, theta: float, phi: float):
        """(normal, t_back, t_side) orthonormal frame at a scalp point.

        t_back points away from the face along the scalp (increasing theta at
        the front); t_side completes a right-handed frame. At the crown the
        frame is continuous because we build it from a fixed reference axis.
        """
        p = self.point(theta, phi)
        n = self.normal_at(p)
        ref = (0.0, 0.0, -1.0)  # "toward the back of the head"
        t_back = vec.sub(ref, vec.mul(n, vec.dot(ref, n)))
        if vec.length(t_back) < 1e-9:
            t_back = vec.sub((1.0, 0.0, 0.0), vec.mul(n, n[0]))
        t_back = vec.normalize(t_back)
        t_side = vec.normalize(vec.cross(n, t_back))
        return n, t_back, t_side


def _push_out(p, center, radii):
    d = vec.sub(p, center)
    k = (d[0] / radii[0]) ** 2 + (d[1] / radii[1]) ** 2 + (d[2] / radii[2]) ** 2
    if k >= 1.0:
        return p, False
    if k < 1e-18:
        return vec.add(center, (0.0, 0.0, -radii[2])), True  # dead centre: push to the back
    s = 1.0 / math.sqrt(k)
    return vec.add(center, vec.mul(d, s)), True


FACE_SLAB_TOP = 0.6  # fraction of the keep-out semi-height above its centre where the slab starts (brow line)


def _push_out_face(p, center, radii):
    """Face keep-out (v0.2).

    Above the brow (d.y > FACE_SLAB_TOP * ry): the face ellipsoid.
    From the brow down, behind the face plane (d.z <= 0): the ellipsoid's
    horizontal slice (an elliptic cylinder below the centre), pushed out in x, z.
    From the brow down, in front of the face plane (d.z > 0): a slab extending
    forward, inside where (x/rx)^2 + (y/ry)^2 + t (z/rz)^2 < 1 with
    t = y / brow (0 below the centre: no depth limit; 1 at the brow: exactly
    the ellipsoid). A strand inside it is moved sideways (x only), never up or
    back. The blend makes the keep-out continuous everywhere (no ledge at the
    brow or at the face plane).

    v0.1 used the ellipsoid alone, and braids rooted at the front hairline hung
    straight down in front of the face (previews/styles_v0_1.png).
    """
    d = vec.sub(p, center)
    top = FACE_SLAB_TOP * radii[1]
    if d[1] > top:
        return _push_out(p, center, radii)
    dy = d[1] if d[1] > 0.0 else 0.0
    q = 1.0 - (dy / radii[1]) ** 2
    ax = d[0] / radii[0]
    az = d[2] / radii[2]
    if d[2] > 0.0:
        lim = q - (dy / top) * (az * az)
        if ax * ax >= lim:
            return p, False
        w = radii[0] * math.sqrt(lim)
        return (center[0] + (w if d[0] >= 0.0 else -w), p[1], p[2]), True
    k = ax * ax + az * az
    if k >= q:
        return p, False
    if k < 1e-18:
        return (center[0] + radii[0] * math.sqrt(q), p[1], p[2]), True
    s = math.sqrt(q / k)
    return (center[0] + d[0] * s, p[1], center[2] + d[2] * s), True
