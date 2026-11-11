"""Draw the app icons (three plaited strands on the brand plum). Run: python3 tools/make-icons.py"""
import math
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "icons")
PLUM, GOLD, CREAM = (150, 38, 88), (216, 169, 78), (250, 241, 233)


def icon(size, pad):
    s = size * 4  # supersample
    img = Image.new("RGB", (s, s), PLUM)
    d = ImageDraw.Draw(img)
    x0, x1 = s * pad, s * (1 - pad)
    top, bottom = s * pad, s * (1 - pad)
    cx, amp, turns, width = (x0 + x1) / 2, (x1 - x0) * 0.2, 2.5, max(2, int(s * 0.085))
    steps = 400
    # Draw strand segments back to front by depth so the three strands read as a plait.
    segs = []
    for k, colour in enumerate((CREAM, GOLD, CREAM)):
        for i in range(steps):
            t0, t1 = i / steps, (i + 1) / steps
            ph0 = 2 * math.pi * (turns * t0 + k / 3)
            ph1 = 2 * math.pi * (turns * t1 + k / 3)
            p0 = (cx + amp * math.sin(ph0), top + (bottom - top) * t0)
            p1 = (cx + amp * math.sin(ph1), top + (bottom - top) * t1)
            segs.append((math.sin(2 * ph0), p0, p1, colour))
    for _, p0, p1, colour in sorted(segs, key=lambda q: q[0]):
        d.line([p0, p1], fill=colour, width=width)
        d.ellipse([p1[0] - width / 2, p1[1] - width / 2, p1[0] + width / 2, p1[1] + width / 2], fill=colour)
    return img.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
icon(192, 0.2).save(os.path.join(OUT, "icon-192.png"), optimize=True)
icon(512, 0.2).save(os.path.join(OUT, "icon-512.png"), optimize=True)
icon(512, 0.3).save(os.path.join(OUT, "icon-maskable-512.png"), optimize=True)
icon(180, 0.2).save(os.path.join(OUT, "apple-touch-icon.png"), optimize=True)
print("icons written to", OUT)
