"""End-to-end tests for the built studio (web/dist) in headless Chromium.

The page is served under a CSP modelled on the artifact host (test/serve.py);
CDN requests are answered from the pinned local npm packages. The "photos" are
renders of the studio's own bust (no real person): MediaPipe detects that face,
which exercises the automatic fit, segmentation, hairline estimate and the
honesty check end to end.

Run: python3 test/e2e.py   (after node tools/build.mjs)
"""
import sys
import time
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve import server, route_cdn, LAUNCH_ARGS  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SHOTS = os.environ.get("E2E_SHOTS", "")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


def wait(pg, js, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(js):
            return True
        time.sleep(0.25)
    return False


def ready(pg, timeout=120):
    time.sleep(0.35)  # let a scheduled build start
    return wait(pg, "document.body.dataset.ready === 'true'", timeout)


def shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def new_page(browser, base, viewport=None, scheme="light"):
    pg = browser.new_page(viewport=viewport or {"width": 1280, "height": 820}, color_scheme=scheme)
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    route_cdn(pg)
    pg.goto(base)
    return pg, errors


def snapshot_photo(pg, look, hair=True, close_cropped=False):
    """Dress the bust in `look`, render it like a front-camera selfie, and keep the PNG as the 'photo'."""
    pg.click("#mode-studio")
    pg.evaluate(f"window.__tryon.setLook({look})")
    ready(pg)
    pg.click("button[data-view=front]")
    time.sleep(0.4)
    opts = "{closeCropped: true}" if close_cropped else "{}"
    pg.evaluate(f"window.__photo = null; window.__tryon.snapshot({'true' if hair else 'false'}, {opts}).then(b => {{ window.__photo = b; }})")
    wait(pg, "!!window.__photo", 10)


def load_photo_and_try(pg, look):
    pg.evaluate("delete document.body.dataset.fit; delete document.body.dataset.conflict;")
    pg.evaluate(f"window.__tryon.setLook({look})")
    pg.evaluate("window.__tryon.loadPhotoBlob(window.__photo)")
    ok = wait(pg, "document.body.dataset.fit !== undefined", 180)
    ready(pg, 180)
    wait(pg, "document.body.dataset.conflict !== undefined", 30)
    time.sleep(0.4)
    return ok


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=LAUNCH_ARGS)

        with server(allow_wasm=True) as base:
            pg, errors = new_page(browser, base)
            check("E01 studio builds the default style", ready(pg), pg.inner_text("#status"))
            check("E01 status names the braid count and detail", "braids" in pg.inner_text("#status"))
            check("E01 caption shows cm and colour code", "cm parts" in pg.inner_text("#caption") and "1B" in pg.inner_text("#caption"))
            shot(pg, "studio-desktop-light")

            for sid in ["box_braids", "two_strand_twists", "locs", "cornrows", "knotless_braids"]:
                pg.click(f"#styles >> text={pg.evaluate(f'window.__tryon.T.styleById(\"{sid}\").name')}")
                check(f"E02 {sid} builds", ready(pg), pg.inner_text("#status"))

            status = pg.inner_text("#status")
            pg.click("#colors button[aria-label^='Colour 1B/613']")
            time.sleep(0.4)
            check("E03 colour change recolours without rebuilding", pg.inner_text("#status") == status
                  and pg.evaluate("document.body.dataset.ready") == "true")
            check("E03 caption follows the colour", "1B/613" in pg.inner_text("#caption"))

            before = pg.evaluate("window.__tryon.state.look.length")
            pg.click("#lengths button:has-text('Waist')")
            time.sleep(0.2)
            banner = pg.inner_text("#banner") if pg.is_visible("#banner") else ""
            check("E04 locked length explains itself and changes nothing",
                  "body capture" in banner and pg.evaluate("window.__tryon.state.look.length") == before, banner[:60])

            pg.click("#capture")
            ok = wait(pg, "document.getElementById('capture-dialog').open && document.getElementById('capture-img').naturalWidth > 100", 10)
            dims = pg.evaluate("[document.getElementById('capture-img').naturalWidth, document.getElementById('capture-img').naturalHeight]")
            check("E05 capture opens a dialog with the look and its caption band", ok and dims[1] > dims[0] * 0.5, str(dims))
            pg.click("#capture-close")

            # Photo, automatic fit: locs in the 'photo', cornrows tried on -> her hair would still show.
            snapshot_photo(pg, "{style:'locs', size:'large', length:'shoulder'}")
            ok = load_photo_and_try(pg, "{style:'cornrows', size:'medium', length:'chin'}")
            check("E06 photo: face found and fitted automatically", ok and pg.evaluate("document.body.dataset.fit") == "auto")
            rp = pg.evaluate("window.__tryon.state.analysis.reprojPx")
            check("E06 photo: canonical face reprojects onto the detected landmarks", rp is not None and rp < 15, f"{rp:.1f} px" if rp else "none")
            ratio = float(pg.evaluate("document.body.dataset.conflictRatio || '0'"))
            check("E07 honesty: locs under cornrows are flagged", pg.evaluate("document.body.dataset.conflict") == "yes", f"ratio {ratio:.2f}")
            check("E07 honesty: banner says so", "own hair would still show" in pg.inner_text("#banner").lower())
            shot(pg, "photo-conflict")

            # Same photo, a style that covers that hair -> no warning.
            pg.evaluate("window.__tryon.setLook({style:'locs', size:'large', length:'shoulder'})")
            ready(pg)
            wait(pg, "document.body.dataset.conflict === 'no'", 20)
            ratio = float(pg.evaluate("document.body.dataset.conflictRatio || '1'"))
            check("E08 honesty: a covering style clears the warning", pg.evaluate("document.body.dataset.conflict") == "no", f"ratio {ratio:.2f}")

            # Hairline from a photo whose hair lies flat at the hairline (close-cropped, painted on the
            # scalp above the true hairline_front = 0.98). Thick styles bias the estimate low because the
            # hair hides the scalp below its roots; that limit is documented in docs/ARCHITECTURE.md.
            snapshot_photo(pg, "{style:'cornrows', size:'medium', length:'chin'}", hair=False, close_cropped=True)
            load_photo_and_try(pg, "{style:'knotless_braids', size:'medium', length:'shoulder'}")
            hl = pg.evaluate("document.body.dataset.hairline")
            # Error budget, measured: the segmenter's mask edge sits ~7 px off the true edge, and the top
            # of the forehead is foreshortened in a front view (~70 px per radian here), so a photo
            # estimate is good to about 0.1 rad (~1 cm on the scalp). The estimator itself is exact on
            # ideal masks (test/tryon.test.mjs T12, T18; HairKit HairlineTests).
            ok = hl not in (None, "default") and abs(float(hl) - 0.98) <= 0.11
            check("E09 hairline estimated from the photo within the 0.11 rad error budget (truth 0.98)", ok, f"estimate {hl}")
            shot(pg, "photo-auto")

            # Drag moves the fit.
            box = pg.query_selector("#viewport").bounding_box()
            x0 = pg.evaluate("window.__tryon.state.fit.x")
            pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            pg.mouse.down()
            pg.mouse.move(box["x"] + box["width"] / 2 + 40, box["y"] + box["height"] / 2, steps=4)
            pg.mouse.up()
            check("E10 dragging on the photo moves the fit", pg.evaluate("window.__tryon.state.fit.x") > x0 + 0.5)
            check("E11 no page errors (wasm allowed)", not errors, "; ".join(errors)[:200])
            pg.close()

        # Host without 'wasm-unsafe-eval': MediaPipe cannot start; hand placement must take over.
        with server(allow_wasm=False) as base:
            pg, errors = new_page(browser, base)
            ready(pg)
            snapshot_photo(pg, "{style:'cornrows', size:'medium', length:'chin'}")
            ok = load_photo_and_try(pg, "{style:'box_braids', size:'large', length:'shoulder'}")
            check("E12 fallback: without wasm the photo still works by hand", ok and pg.evaluate("document.body.dataset.fit") == "manual")
            check("E12 fallback: the banner explains hand placement", "place it by hand" in pg.inner_text("#banner").lower())
            check("E12 fallback: the style is shown", pg.evaluate("document.body.dataset.ready") == "true")
            shot(pg, "photo-fallback")
            check("E13 no page errors (fallback)", not errors, "; ".join(errors)[:200])
            pg.close()

        with server(allow_wasm=True) as base:
            pg, errors = new_page(browser, base, viewport={"width": 390, "height": 844}, scheme="dark")
            check("E14 phone: builds", ready(pg))
            overflow = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check("E14 phone: no horizontal scroll", overflow <= 0, f"overflow {overflow}px")
            bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
            check("E14 phone: dark theme applied", bg == "rgb(20, 16, 22)", bg)
            shot(pg, "studio-phone-dark")
            check("E15 no page errors (phone)", not errors, "; ".join(errors)[:200])
            pg.close()

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
