"""Point-splat preview renderer for protostyle output (inspection only, not runtime).

Renders LOD0 geometry on the head proxy with a z-buffer and Lambert + rim
lighting so a human can judge silhouette and plait read at a glance. The proxy
head is shaded in a deep skin tone (Monk scale ~9) on purpose: the default
render target of this product is the user it was built for.

Usage: python -m tools.render_preview  (writes previews/*.png)
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from protostyle.scalp import HeadProxy  # noqa: E402
from protostyle.styles import StyleKind, StyleSpec, generate  # noqa: E402

SKIN = np.array([0.30, 0.19, 0.13])      # deep brown, ~Monk 9
HAIR = np.array([0.13, 0.085, 0.06])     # 1B off-black (brown undertone reads in light)
BG = np.array([0.93, 0.91, 0.88])


def vertex_normals(pos, tris):
    fn = np.cross(pos[tris[:, 1]] - pos[tris[:, 0]], pos[tris[:, 2]] - pos[tris[:, 0]])
    vn = np.zeros_like(pos)
    for k in range(3):
        np.add.at(vn, tris[:, k], fn)
    ln = np.linalg.norm(vn, axis=1, keepdims=True)
    ln[ln == 0] = 1
    return vn / ln


def head_points(head: HeadProxy, n=260):
    th = np.linspace(0.0, math.pi * 0.86, n)
    ph = np.linspace(-math.pi, math.pi, 2 * n, endpoint=False)
    T, P = np.meshgrid(th, ph, indexing="ij")
    x = head.cx + head.rx * np.sin(T) * np.sin(P)
    y = head.cy + head.ry * np.cos(T)
    z = head.cz + head.rz * np.sin(T) * np.cos(P)
    pts = np.stack([x, y, z], -1).reshape(-1, 3)
    c = np.array([head.cx, head.cy, head.cz])
    d = pts - c
    nrm = d / np.array([head.rx ** 2, head.ry ** 2, head.rz ** 2])
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    # neck
    a = np.linspace(-math.pi, math.pi, 420, endpoint=False)
    h = np.linspace(-0.22, -0.05, 260)
    A, Hh = np.meshgrid(a, h, indexing="ij")
    nx, nz = 0.050 * np.sin(A), head.cz + 0.045 * np.cos(A)
    neck = np.stack([nx, Hh + head.cy, nz], -1).reshape(-1, 3)
    nn = np.stack([np.sin(A), np.zeros_like(A), np.cos(A)], -1).reshape(-1, 3)
    ft = np.linspace(0, math.pi, n)
    fp = np.linspace(-math.pi * 0.5, math.pi * 0.5, n)
    FT, FP = np.meshgrid(ft, fp, indexing="ij")
    fc = np.array([head.fx, head.fy, head.fz]); fr = np.array([head.frx, head.fry, head.frz])
    fd = np.stack([np.sin(FT) * np.sin(FP), np.cos(FT), np.sin(FT) * np.cos(FP)], -1).reshape(-1, 3)
    face = fc + fd * fr
    fn = (face - fc) / fr ** 2
    fn /= np.linalg.norm(fn, axis=1, keepdims=True)
    # Show only the part of the keep-out that reads as a face (below the brow,
    # outside the cranium) so the preview is not a double egg.
    dh = (face - c) / np.array([head.rx, head.ry, head.rz])
    keep = (np.sum(dh * dh, axis=1) > 1.0) & (face[:, 1] < head.fy + 0.55 * head.fry)
    face, fn = face[keep], fn[keep]
    return np.vstack([pts, neck, face]), np.vstack([nrm, nn, fn])


def render(result, yaw_deg, size=560, scale=900.0, pitch_deg=-8.0):
    pos = np.array(result.lod0.positions)
    tris = np.array(result.lod0.triangles, dtype=np.int64)
    hn = vertex_normals(pos, tris)
    hp, hnrm = head_points(result.head)
    P = np.vstack([hp, pos])
    N = np.vstack([hnrm, hn])
    C = np.vstack([np.tile(SKIN, (len(hp), 1)), np.tile(HAIR, (len(pos), 1))])
    yaw = math.radians(yaw_deg)
    Ry = np.array([[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]])
    pt = math.radians(pitch_deg)
    Rx = np.array([[1, 0, 0], [0, math.cos(pt), -math.sin(pt)], [0, math.sin(pt), math.cos(pt)]])
    R = Rx @ Ry
    Pr, Nr = P @ R.T, N @ R.T
    light = np.array([-0.45, 0.65, 0.62]); light /= np.linalg.norm(light)
    lam = np.clip(Nr @ light, 0, 1)
    rim = np.clip(1.0 - np.abs(Nr[:, 2]), 0, 1) ** 3
    spec = np.clip(Nr @ light, 0, 1) ** 24
    shade = C * (0.28 + 0.78 * lam[:, None]) + 0.10 * rim[:, None] + 0.10 * spec[:, None]
    u = (Pr[:, 0] * scale + size / 2).astype(int)
    v = (-(Pr[:, 1] - 0.0) * scale + size * 0.33).astype(int)
    img = np.tile(BG, (size, size, 1)).astype(float)
    zbuf = np.full((size, size), -1e9)
    order = np.argsort(Pr[:, 2])
    for du in (-1, 0, 1):
        for dv in (-1, 0, 1):
            uu, vv = u[order] + du, v[order] + dv
            ok = (uu >= 0) & (uu < size) & (vv >= 0) & (vv < size)
            idx = order[ok]
            uu, vv = uu[ok], vv[ok]
            z = Pr[idx, 2]
            better = z > zbuf[vv, uu]
            zbuf[vv[better], uu[better]] = z[better]
            img[vv[better], uu[better]] = shade[idx[better]]
    return np.clip(img, 0, 1)


def main():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out = os.path.join(os.path.dirname(__file__), "..", "previews")
    os.makedirs(out, exist_ok=True)
    kinds = list(StyleKind)
    fig, axes = plt.subplots(2, len(kinds), figsize=(3.2 * len(kinds), 6.6), dpi=130)
    for i, k in enumerate(kinds):
        res = generate(StyleSpec(kind=k))
        for j, yaw in enumerate((32, 180)):
            ax = axes[j][i]
            ax.imshow(render(res, yaw))
            ax.set_axis_off()
            if j == 0:
                ax.set_title(k.value.replace("_", " "), fontsize=11)
        print(k.value, res.stats)
    fig.suptitle("protostyle v0.2 — LOD0 on head proxy (front ¾ / back)", fontsize=12)
    fig.tight_layout()
    path = os.path.join(out, "styles_v0_2.png")
    fig.savefig(path, facecolor=BG)
    print("wrote", os.path.abspath(path))


if __name__ == "__main__":
    main()
