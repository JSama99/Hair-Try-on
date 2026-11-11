"""End-to-end test of the live mirror with a fake camera.

Chromium plays an MJPEG file as the camera. The film is made here from renders of the studio's own
bust (no real person) turning her head left and right, so MediaPipe tracks a moving face and the
strand physics has something to react to.

Run: python3 test/e2e_live.py   (after node tools/build.mjs; needs ffmpeg)
"""
import base64
import os
import subprocess
import sys
import tempfile
import time
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve import server, route_cdn, LAUNCH_ARGS, THIRD_PARTY  # noqa: E402
from e2e import check, wait, ready, shot, results  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

FRAMES = 24
SEG_ERR = """(() => { const s = window.__tryon.sim; if (!s) return -1; let worst = 0;
  for (let k = 0; k < s.chains.counts.length; k++) for (let i = s.chains.pinned[k]; i < s.chains.counts[k]; i++) {
    const j = 3 * (s.offsets[k] + i), p = s.positions;
    worst = Math.max(worst, Math.abs(Math.hypot(p[j] - p[j - 3], p[j + 1] - p[j - 2], p[j + 2] - p[j - 1]) - s.chains.ds[k])); }
  return worst; })()"""


def make_film(p, base, out_dir):
    """Render the close-cropped bust turning +-0.3 rad as JPEG frames, then pack them as MJPEG."""
    browser = p.chromium.launch(args=LAUNCH_ARGS)
    pg = browser.new_page(viewport={"width": 1120, "height": 540})
    route_cdn(pg)
    pg.goto(base)
    ready(pg)
    # A light style keeps the software renderer quick; the film shows the bust without hair anyway.
    pg.evaluate("window.__tryon.setLook({style: 'box_braids', size: 'jumbo', length: 'chin'})")
    ready(pg)
    for i in range(FRAMES):
        yaw = 0.3 * math.sin(2 * math.pi * i / FRAMES)
        data = pg.evaluate("""async (yaw) => { const b = await window.__tryon.snapshot(false, { closeCropped: true, yaw, type: 'image/jpeg' });
            const buf = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const x of buf) s += String.fromCharCode(x); return btoa(s); }""", yaw)
        with open(os.path.join(out_dir, f"f{i:03d}.jpg"), "wb") as f:
            f.write(base64.b64decode(data))
    browser.close()
    film = os.path.join(out_dir, "selfie.mjpeg")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-framerate", "10", "-i", os.path.join(out_dir, "f%03d.jpg"),
                    "-vf", "crop=ih*4/3:ih,scale=640:480", "-c:v", "mjpeg", "-q:v", "3", "-f", "mjpeg", film], check=True)
    return film


def main():
    with tempfile.TemporaryDirectory() as tmp, server() as base, sync_playwright() as p:
        film = make_film(p, base, tmp)
        check("L00 fake-camera film made from bust renders", os.path.getsize(film) > 100_000, f"{os.path.getsize(film) // 1024} KB")

        browser = p.chromium.launch(args=LAUNCH_ARGS + ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-video-capture={film}"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 820}, permissions=["camera"])
        pg = ctx.new_page()
        errors, posts = [], []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("request", lambda r: posts.append(r.url) if r.method not in ("GET", "HEAD") else None)
        route_cdn(pg)
        pg.goto(base)
        ready(pg)

        pg.click("#mode-live")
        ok = wait(pg, "document.body.dataset.sim === 'on' && document.body.dataset.ready === 'true'", 120)
        check("L01 live mode rebuilds with simulation chains", ok and pg.evaluate("document.body.dataset.sim === 'on' && document.body.dataset.lod === '1'"), pg.evaluate("document.body.dataset.sim + ' lod ' + document.body.dataset.lod + ' ' + document.getElementById('status').textContent"))
        check("L01 camera is off until asked", pg.evaluate("!window.__tryon.live.streaming && document.getElementById('cam').hidden"))
        check("L01 privacy line is shown", "Nothing is recorded or sent" in pg.inner_text("#live-hint"))

        pg.click("#live-start")
        ok = wait(pg, "document.body.dataset.live === 'tracking'", 120)
        check("L02 camera starts and the face is tracked", ok, pg.evaluate("document.body.dataset.live"))
        check("L03 camera picture shown mirrored at its own size", pg.evaluate(
            "(() => { const l = window.__tryon.live; return l.size && l.size.w === 640 && l.size.h === 480 && !document.getElementById('cam').hidden && document.getElementById('viewport').classList.contains('mirror'); })()"))
        time.sleep(2.0)
        m = pg.evaluate("window.__tryon.rigMatrix")
        check("L04 head pose is plausible (35-60 cm from the camera)", -60 < m[14] < -30, f"z {m[14]:.1f} cm")
        check("L04 style is drawn on the tracked head", pg.evaluate("window.__tryon.hairVisible"))
        shot(pg, "live_tracking")

        speeds, steps0 = [], pg.evaluate("window.__tryon.live.simSteps")
        for _ in range(24):
            speeds.append(pg.evaluate("window.__tryon.live.maxSpeed"))
            time.sleep(0.12)
        steps1 = pg.evaluate("window.__tryon.live.simSteps")
        check("L05 physics steps while tracking", steps1 > steps0 + 20, f"{steps1 - steps0} steps in ~3 s")
        check("L05 hair moves as the head turns", max(speeds) > 0.02, f"peak {max(speeds):.3f} m/s")
        err = pg.evaluate(SEG_ERR)
        check("L06 strands stay inextensible in the browser", 0 <= err < 1e-6, f"{err:.2e} m")
        check("L06 no NaN in the skinned mesh", pg.evaluate(
            "(() => { const s = window.__tryon.sim; for (const v of s.positions) if (!Number.isFinite(v)) return false; return true; })()"))

        ok = wait(pg, "['yes','no'].includes(document.body.dataset.conflict) && window.__tryon.live.stats.hairMasks > 0", 30)
        check("L07 honest-preview check runs on the camera picture", ok, pg.evaluate("document.body.dataset.conflict + ' ratio ' + document.body.dataset.conflictRatio"))

        box = pg.locator("#compare").bounding_box()
        pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        pg.mouse.down()
        time.sleep(0.3)
        hidden = not pg.evaluate("window.__tryon.hairVisible")
        pg.mouse.up()
        time.sleep(0.3)
        check("L08 hold to compare hides the style, release brings it back", hidden and pg.evaluate("window.__tryon.hairVisible"))

        pg.click("#live-hairline")
        ok = wait(pg, "document.body.dataset.hairline !== undefined", 30)
        hl = pg.evaluate("document.body.dataset.hairline")
        base_hl = pg.evaluate("window.__tryon.BASE_HEAD.hairline_front")
        check("L09 match my hairline answers", ok, f"hairline {hl} (bust {base_hl:.3f})")
        if hl not in (None, "default"):
            check("L09 matched hairline is near the bust's real one", abs(float(hl) - base_hl) < 0.2, f"off by {abs(float(hl) - base_hl):.3f} rad")
            time.sleep(1.5)
            check("L09 style is rebuilt at the matched hairline", ready(pg, 120) and pg.evaluate("document.body.dataset.sim === 'on' && Math.abs(window.__tryon.state.head.hairline_front - window.__tryon.live.hairline) < 1e-9"))
        else:
            check("L09 an unclear hairline is explained, not guessed", "not clear enough" in pg.inner_text("#banner"))
        wait(pg, "document.body.dataset.live === 'tracking'", 30)

        pg.click("#capture")
        ok = wait(pg, "document.getElementById('capture-dialog').open && document.getElementById('capture-img').naturalWidth > 100", 20)
        check("L10 capture works in the live mirror", ok)
        pg.click("#capture-close")

        pg.click("#live-start")
        ok = wait(pg, "document.body.dataset.live === 'off'", 10)
        check("L11 turning the camera off releases it", ok and pg.evaluate(
            "!window.__tryon.live.streaming && document.getElementById('cam').srcObject === null && document.getElementById('cam').hidden && !document.getElementById('viewport').classList.contains('mirror')"))

        pg.click("#live-start")
        wait(pg, "document.body.dataset.live === 'tracking'", 60)
        pg.click("#mode-studio")
        check("L12 leaving the mode turns the camera off", pg.evaluate("!window.__tryon.live.streaming && document.getElementById('cam').srcObject === null"))
        check("L12 the bust is rebuilt at full detail, without the simulation", wait(pg, "document.body.dataset.sim === 'off' && document.body.dataset.ready === 'true'", 120))

        check("L13 no page errors", not errors, "; ".join(errors[:3]))
        check("L13 nothing was sent (no POST/PUT)", not posts, "; ".join(posts[:3]))
        browser.close()

        # A device with no camera: a clear message, and the rest of the studio keeps working.
        browser = p.chromium.launch(args=LAUNCH_ARGS)
        pg = browser.new_page(viewport={"width": 1280, "height": 820})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        route_cdn(pg)
        pg.goto(base)
        ready(pg)
        pg.click("#mode-live")
        wait(pg, "document.body.dataset.sim === 'on' && document.body.dataset.ready === 'true'", 120)
        pg.click("#live-start")
        ok = wait(pg, "document.body.dataset.live === 'error'", 20)
        text = pg.inner_text("#banner")
        check("L14 no camera: explained in plain words", ok and ("camera" in text.lower()) and "Your photo" in text, text[:90])
        pg.click("#mode-studio")
        check("L14 the studio still works afterwards", ready(pg) and not errors, "; ".join(errors[:2]))
        browser.close()

        check("L15 the page contacted no other host", not THIRD_PARTY, "; ".join(THIRD_PARTY[:3]))

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
