"""Close-up of single strands per style: does the plait / twist / rope read?"""
import math, os, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from protostyle.sweep import Mesh, rotation_minimizing_frames  # noqa
from protostyle.styles import PROFILES, StyleKind, StyleSpec, _ValueNoise, _sweep_strands  # noqa
from protostyle.rng import derive_seed  # noqa
from render_preview import vertex_normals, HAIR, BG  # noqa


def strand_mesh(kind, width=0.02, length=0.09):
    spec = StyleSpec(kind=kind, width=width, lod0_sides=12, samples_per_period=24)
    prof = PROFILES[kind]
    n = 400
    cl = [(0.0, -length * i / n, 0.0) for i in range(n + 1)]
    lod0, lod1 = Mesh(), Mesh()
    noise = _ValueNoise(derive_seed(spec.seed, "noise:0"), 0.02, 12)
    _sweep_strands(spec, prof, cl, (1.0, 0.0, 0.0), (0.0, 0.0, 1.0), noise, lod0, lod1)
    return lod0


def draw(mesh, size=(260, 700), scale=6200.0):
    pos = np.array(mesh.positions); tris = np.array(mesh.triangles)
    nrm = vertex_normals(pos, tris)
    # rasterise triangles properly (small mesh): barycentric fill with z-buffer
    H, W = size[1], size[0]
    img = np.tile(BG, (H, W, 1)).astype(float); zb = np.full((H, W), -1e9)
    L = np.array([-0.4, 0.5, 0.77]); L /= np.linalg.norm(L)
    sx = pos[:, 0] * scale + W / 2; sy = -pos[:, 1] * scale + 60
    for t in tris:
        xs, ys = sx[t], sy[t]
        x0, x1 = int(max(0, np.floor(xs.min()))), int(min(W - 1, np.ceil(xs.max())))
        y0, y1 = int(max(0, np.floor(ys.min()))), int(min(H - 1, np.ceil(ys.max())))
        if x1 < x0 or y1 < y0: continue
        X, Y = np.meshgrid(np.arange(x0, x1 + 1) + .5, np.arange(y0, y1 + 1) + .5)
        d = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
        if abs(d) < 1e-12: continue
        a = ((ys[1] - ys[2]) * (X - xs[2]) + (xs[2] - xs[1]) * (Y - ys[2])) / d
        b = ((ys[2] - ys[0]) * (X - xs[2]) + (xs[0] - xs[2]) * (Y - ys[2])) / d
        c = 1 - a - b
        m = (a >= 0) & (b >= 0) & (c >= 0)
        if not m.any(): continue
        z = a * pos[t[0], 2] + b * pos[t[1], 2] + c * pos[t[2], 2]
        nn = a[..., None] * nrm[t[0]] + b[..., None] * nrm[t[1]] + c[..., None] * nrm[t[2]]
        nn /= np.linalg.norm(nn, axis=-1, keepdims=True) + 1e-12
        lam = np.clip(nn @ L, 0, 1); sp = np.clip(nn @ L, 0, 1) ** 30
        col = np.array([0.20, 0.13, 0.09]) * (0.25 + 1.5 * lam[..., None]) + 0.30 * sp[..., None]  # lighter than HAIR so crossings read
        yy, xx = np.nonzero(m); yy += y0; xx += x0
        zz = z[m]; better = zz > zb[yy, xx]
        zb[yy[better], xx[better]] = zz[better]
        img[yy[better], xx[better]] = np.clip(col[m][better], 0, 1)
    return img


def main():
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    kinds = [StyleKind.BOX_BRAIDS, StyleKind.KNOTLESS_BRAIDS, StyleKind.TWO_STRAND_TWISTS, StyleKind.LOCS]
    fig, ax = plt.subplots(1, 4, figsize=(9, 6.4), dpi=130)
    for a, k in zip(ax, kinds):
        a.imshow(draw(strand_mesh(k))); a.set_axis_off(); a.set_title(k.value.replace("_", " "), fontsize=10)
    fig.suptitle("protostyle v0.1 — single-strand LOD0 close-up (2 cm width, root at top)", fontsize=11)
    fig.tight_layout()
    out = os.path.join(os.path.dirname(__file__), "..", "previews", "strand_closeups_v0_2.png")
    fig.savefig(out, facecolor=BG); print("wrote", os.path.abspath(out))


if __name__ == "__main__":
    main()
