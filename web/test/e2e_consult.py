"""End-to-end tests for the consultation and booking-handoff journey (web/dist).

Explore -> customise -> try on -> Save My Look -> Style Card -> consultation details
-> share (copy / download / share sheet / fallbacks) -> booking handoff.

Same harness as test/e2e.py: artifact-like CSP, CDN served from pinned local packages.
example.com booking pages are answered locally, so no request leaves the machine.

Run: python3 test/e2e_consult.py   (after node tools/build.mjs)
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serve import server, route_cdn, LAUNCH_ARGS  # noqa: E402
from e2e import check, wait, ready, results, snapshot_photo, load_photo_and_try  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DEMO = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "salon", "salon.config.json")))
SHOTS = os.environ.get("E2E_SHOTS", "")

SHARE_STUB = """
window.__shared = [];
navigator.share = async (data) => { window.__shared.push({ title: data.title, text: data.text, files: (data.files || []).map(f => [f.name, f.type, f.size]) }); };
navigator.canShare = (data) => true;
"""
NO_SHARE_NO_CLIPBOARD = """
delete Navigator.prototype.share; delete Navigator.prototype.canShare;
Object.defineProperty(Navigator.prototype, 'clipboard', { get() { return undefined; }, configurable: true });
"""


def open_page(browser, base, init=None, viewport=None, permissions=None):
    ctx = browser.new_context(viewport=viewport or {"width": 1280, "height": 900}, accept_downloads=True)
    if permissions:
        ctx.grant_permissions(permissions, origin=base.rstrip("/"))
    if init:
        ctx.add_init_script(init)
    pg = ctx.new_page()
    errors, requests = [], []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("request", lambda r: requests.append((r.method, r.url)))
    route_cdn(pg)
    ctx.route("https://example.com/**", lambda route: route.fulfill(status=200, body="<!doctype html><title>Demo booking</title><p>demo", headers={"content-type": "text/html"}))
    pg.goto(base)
    ready(pg)
    return ctx, pg, errors, requests


def style_click(pg, name):
    pg.click(f"#styles button:has-text('{name}')")


def card(pg):
    return pg.evaluate("JSON.parse(JSON.stringify(window.__tryon.card))")


def main():
    with sync_playwright() as p, server(allow_wasm=True) as base:
        browser = p.chromium.launch(args=LAUNCH_ARGS)

        # ---------------------------------------------------------------- main journey (share sheet available)
        ctx, pg, errors, requests = open_page(browser, base, init=SHARE_STUB, permissions=["clipboard-read", "clipboard-write"])
        check("J00 salon banner names the demo salon and says it is fictional",
              "Crown & Coil" in pg.inner_text("#salon") and pg.is_visible("#salon-demo") and "fictional" in pg.inner_text("#salon-note"))
        offered = pg.evaluate("[...document.querySelectorAll('#styles button')].filter(b => b.querySelector('.offered')).map(b => b.textContent.replace(', offered by this salon', ''))")
        check("J00 only the salon's styles are marked as offered", sorted(offered) == sorted(["Knotless braids", "Box braids", "Locs", "Cornrows"]), str(offered))

        style_click(pg, "Box braids")
        pg.click("#sizes button:has-text('Large')")
        pg.click("#lengths button:has-text('Shoulder')")
        pg.click("#colors button[aria-label^='Colour 27,']")
        check("J01 select and customise a style; the studio previews it", ready(pg), pg.inner_text("#status"))
        check("J02 consultation card hidden until the look is saved", not pg.is_visible("#consult"))

        pg.click("#save-look")
        time.sleep(0.3)
        c = card(pg)
        ok = (pg.is_visible("#consult") and c["style"]["id"] == "box_braids" and c["style"]["size"]["id"] == "large"
              and c["style"]["length"]["id"] == "shoulder" and c["style"]["color"]["code"] == "27"
              and c["description"] == pg.inner_text("#caption"))
        check("J03 Save My Look creates a StyleCardV1 matching the studio", ok, c["description"])
        check("J03 keyboard focus moves to the card", pg.evaluate("document.activeElement.id") == "consult")
        check("J03 summary shows the saved look", "Large · 2.4 cm" in pg.inner_text("#look-summary") and "Colour 27" in pg.inner_text("#look-summary"))

        disabled = pg.evaluate("['share-card','copy-card','download-card'].every(id => document.getElementById(id).disabled)")
        check("J04 sharing and booking wait for the preview acknowledgement",
              disabled and pg.is_visible("#gate-hint") and pg.get_attribute("#book-link", "aria-disabled") == "true")

        pg.select_option("#pref-day", "sat")
        pg.check("input[name=supply][value=own]")
        pg.fill("#notes", "Middle part <b>please</b>")
        pg.check("#ack")
        time.sleep(0.2)
        c = card(pg)
        check("J05 consultation details update the card",
              c["preferences"] == {"preferredDay": "sat", "preferredDate": None, "hairSupply": "own", "notes": "Middle part <b>please</b>", "acknowledgedPreview": True},
              json.dumps(c["preferences"]))
        check("J05 notes counter tracks input", pg.inner_text("#notes-count") == "25 / 300")
        pg.fill("#pref-date", "2026-11-21")
        time.sleep(0.2)
        c = card(pg)
        check("J05 a date replaces the day", c["preferences"]["preferredDate"] == "2026-11-21" and c["preferences"]["preferredDay"] is None)

        pg.click("#copy-card")
        time.sleep(0.3)
        clip = pg.evaluate("navigator.clipboard.readText()")
        check("J06 copy puts the readable consultation on the clipboard",
              "Look: Box braids, large (2.4 cm parts), shoulder length, colour 27" in clip and "Preferred date: 2026-11-21" in clip
              and "Braiding hair: I will bring my own" in clip and "illustration" in clip, clip.splitlines()[0] if clip else "")
        check("J06 copy feedback", "copied" in pg.inner_text("#share-status").lower())

        with pg.expect_download() as dl:
            pg.click("#download-card")
        d = dl.value
        body = open(d.path()).read()
        data = json.loads(body)
        check("J07 download produces a StyleCardV1 JSON file", d.suggested_filename == "style-card-box-braids-" + data["createdAt"][:10] + ".json"
              and data["schema"] == "talonsight.style-card" and data["version"] == 1, d.suggested_filename)
        check("J07 the downloaded card has no image data", "data:image" not in body and "base64" not in body and "blob:" not in body)

        pg.click("#share-card")
        time.sleep(0.3)
        shared = pg.evaluate("window.__shared")
        check("J08 Share With Stylist hands text (no image) to the share sheet", len(shared) == 1 and not shared[0]["files"] and "Box braids" in shared[0]["text"])
        check("J08 share feedback does not claim delivery", "cannot see whether your stylist received it" in pg.inner_text("#share-status"))

        pg.click("#capture")
        wait(pg, "document.getElementById('capture-dialog').open", 10)
        pg.click("#capture-close")
        check("J09 after a capture the card offers the image, opt-in, with a studio disclosure",
              pg.is_visible("#include-img-row") and not pg.is_checked("#include-img") and "3D model, not you" in pg.inner_text("#include-img-row"))
        pg.check("#include-img")
        pg.click("#share-card")
        time.sleep(0.3)
        shared = pg.evaluate("window.__shared")
        check("J09 the image is shared only after the customer opts in", len(shared) == 2 and len(shared[1]["files"]) == 1 and shared[1]["files"][0][1] == "image/png")

        href = pg.get_attribute("#book-link", "href")
        rel = pg.get_attribute("#book-link", "rel") or ""
        check("J10 direct service: general booking link, new tab, no opener", href == DEMO["booking"]["generalUrl"]
              and pg.get_attribute("#book-link", "target") == "_blank" and "noopener" in rel and "noreferrer" in rel, href)
        check("J10 the page says to pick the service there and that confirmation is external",
              "choose \"Box braids\" there" in pg.inner_text("#booking-link-note") and "confirmation are handled there" in pg.inner_text("#booking-link-note"))
        check("J10 direct booking is labelled as such", pg.inner_text("#booking-title") == "Ready to book" and pg.inner_text("#booking-tag").lower() == "book directly")
        with ctx.expect_page() as newp:
            pg.click("#book-link")
        booked = newp.value
        booked.wait_for_load_state()
        check("J10 Book Appointment opens the salon's booking page", booked.url == DEMO["booking"]["generalUrl"], booked.url)
        check("J10 opening the page is not reported as a booking", "booked only when" in pg.inner_text("#booking-status"))
        check("J10 the card is never marked confirmed", "confirm" not in json.dumps(card(pg)).lower().replace("confirms", ""))
        booked.close()

        # Return to the studio: change the look, the saved card stays, then restore.
        pg.click("#colors button[aria-label^='Colour 613,']")
        time.sleep(0.2)
        check("J11 changing the look after saving keeps the card and says so",
              pg.is_visible("#look-changed") and card(pg)["style"]["color"]["code"] == "27")
        pg.click("#restore-look")
        time.sleep(0.3)
        check("J11 'Back to saved look' restores the studio", pg.evaluate("window.__tryon.state.look.color") == "27" and not pg.is_visible("#look-changed"))
        check("J11 consultation answers survive the round trip", pg.input_value("#notes") == "Middle part <b>please</b>" and pg.is_checked("#ack"))
        ready(pg)

        style_click(pg, "Knotless braids")
        ready(pg)
        pg.click("#save-look")
        time.sleep(0.3)
        check("J12 a verified service link is used when the salon set one",
              pg.get_attribute("#book-link", "href") == DEMO["services"][0]["serviceUrl"] and "at the Knotless braids service" in pg.inner_text("#booking-link-note"))

        style_click(pg, "Locs")
        ready(pg)
        pg.click("#update-look")
        time.sleep(0.3)
        c = card(pg)
        check("J13 consultation-first service: awaiting confirmation, never approved",
              pg.inner_text("#booking-title") == "Awaiting stylist confirmation" and c["consultationRequired"] and not c["directBookingApproved"]
              and pg.inner_text("#book-link") == "Book after your stylist confirms")
        check("J13 the consultation path explains the app cannot see the reply", "cannot see their reply" in pg.inner_text("#booking-body"))

        style_click(pg, "Two-strand twists")
        ready(pg)
        pg.click("#update-look")
        time.sleep(0.3)
        check("J14 a style the salon does not list says ask first", pg.inner_text("#booking-title") == "Ask before booking" and card(pg)["bookingMode"] == "not-offered")

        before = card(pg)["style"]["length"]["id"]
        pg.click("#lengths button:has-text('Waist')")
        time.sleep(0.2)
        check("J15 locked lengths stay locked and never reach a card",
              "body capture" in pg.inner_text("#banner") and card(pg)["style"]["length"]["id"] == before and pg.evaluate("window.__tryon.state.look.length") != "waist")

        stored = pg.evaluate("sessionStorage.getItem('hairtryon.savedLook.v1')")
        check("J16 session storage keeps only the look and two choices (no notes, no image)",
              stored is not None and "Middle part" not in stored and "data:" not in stored and set(json.loads(stored)) == {"look", "preferredDay", "hairSupply"}, stored)
        pg.reload()
        ready(pg)
        check("J16 a reload restores the saved look for this session", pg.is_visible("#consult") and card(pg)["style"]["id"] == "two_strand_twists")
        pg.click("#delete-card")
        check("J17 Delete saved look clears the card and session storage",
              not pg.is_visible("#consult") and pg.evaluate("sessionStorage.getItem('hairtryon.savedLook.v1')") is None)

        posts = [r for r in requests if r[0] != "GET"]
        external = sorted({r[1].split('/')[2] for r in requests if not r[1].startswith(base)})
        check("J18 the journey sends nothing: no POST/PUT, only script, font and the opened booking page",
              not posts and set(external) <= {"cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com", "example.com"}, f"{posts[:2]} {external}")
        check("J19 no page errors (main journey)", not errors, "; ".join(errors)[:200])
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, "consult-journey.png"))
        ctx.close()

        # ---------------------------------------------------------------- no share sheet, no clipboard
        ctx, pg, errors, _ = open_page(browser, base, init=NO_SHARE_NO_CLIPBOARD)
        pg.click("#save-look")
        pg.check("#ack")
        pg.click("#share-card")
        time.sleep(0.3)
        sel = pg.evaluate("(() => { const t = document.getElementById('card-text'); return document.activeElement === t && t.selectionEnd - t.selectionStart === t.value.length && t.value.startsWith('Style Card for Crown & Coil'); })()")
        check("J20 without share or clipboard: the text is shown and selected to copy by hand",
              pg.evaluate("document.getElementById('manual-copy').open") and sel and "copy it with your keyboard" in pg.inner_text("#share-status"))
        pg.click("#copy-card")
        time.sleep(0.2)
        check("J20 Copy consultation falls back the same way", "Copying is blocked here" in pg.inner_text("#share-status"))
        check("J21 no page errors (no share/clipboard)", not errors, "; ".join(errors)[:200])
        ctx.close()

        # ---------------------------------------------------------------- salon configuration edge cases
        ctx, pg, errors, _ = open_page(browser, base)
        no_links = json.loads(json.dumps(DEMO))
        no_links["booking"].pop("generalUrl")
        for s in no_links["services"]:
            s.pop("serviceUrl", None)
        pg.evaluate("raw => window.__tryon.setSalonConfig(raw)", no_links)
        pg.click("#save-look")
        pg.check("#ack")
        time.sleep(0.2)
        check("J22 no booking link configured: no link, honest instruction, direct degraded to consultation",
              not pg.is_visible("#book-link") and "has not added a booking link" in pg.inner_text("#booking-link-note") and card(pg)["bookingMode"] == "consultation")

        evil = json.loads(json.dumps(DEMO))
        evil["displayName"] = "<img src=x onerror=\"window.__xss=1\">Salon"
        evil["booking"]["generalUrl"] = "javascript:window.__xss=2"
        evil["services"][0]["serviceUrl"] = "javascript:window.__xss=3"
        evil["services"][0]["description"] = "<script>window.__xss=4</script>"
        pg.evaluate("raw => window.__tryon.setSalonConfig(raw)", evil)
        style_click(pg, "Knotless braids")
        ready(pg)
        pg.click("#save-look")
        time.sleep(0.3)
        href = pg.get_attribute("#book-link", "href")
        check("J23 hostile config: markup stays text, javascript: links never reach the page",
              pg.evaluate("window.__xss") is None and "<img" in pg.inner_text("#salon-name") and (href is None or href.startswith("https://"))
              and not pg.is_visible("#book-link"), str(href))

        pg.evaluate("window.__tryon.setSalonConfig(null)")
        time.sleep(0.2)
        check("J24 a broken config falls back to no salon; the studio and card still work",
              not pg.is_visible("#salon") and card(pg)["bookingMode"] == "no-salon" and pg.evaluate("document.body.dataset.ready") == "true")
        check("J25 no page errors (config cases)", not errors, "; ".join(errors)[:200])
        ctx.close()

        # ---------------------------------------------------------------- photo mode still works, image disclosure
        ctx, pg, errors, _ = open_page(browser, base, init=SHARE_STUB)
        snapshot_photo(pg, "{style:'cornrows', size:'medium', length:'chin'}", hair=False, close_cropped=True)
        ok = load_photo_and_try(pg, "{style:'knotless_braids', size:'medium', length:'shoulder'}")
        check("J26 photo mode still fits automatically", ok and pg.evaluate("document.body.dataset.fit") == "auto")
        pg.click("#save-look")
        pg.check("#ack")
        pg.click("#capture")
        wait(pg, "document.getElementById('capture-dialog').open", 10)
        pg.click("#capture-close")
        time.sleep(0.2)
        check("J27 a photo capture is flagged as possibly identifying",
              "may identify you" in pg.inner_text("#include-img-row") and not pg.is_checked("#include-img"))
        pg.click("#share-card")
        time.sleep(0.3)
        check("J27 the photo is not shared unless the customer ticks the box", pg.evaluate("window.__shared[0].files.length") == 0)
        check("J27 the card itself never contains the photo", "data:" not in json.dumps(card(pg)))
        check("J28 no page errors (photo)", not errors, "; ".join(errors)[:200])
        ctx.close()

        # ---------------------------------------------------------------- phone layout
        ctx, pg, errors, _ = open_page(browser, base, viewport={"width": 390, "height": 844})
        pg.click("#save-look")
        time.sleep(0.3)
        overflow = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        small = pg.evaluate("""[...document.querySelectorAll('#consult button:not([hidden]), #consult select, #consult input[type=date]')]
            .filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height).filter(h => h < 36).length""")
        check("J29 phone: no horizontal scroll and comfortable touch targets", overflow <= 0 and small == 0, f"overflow {overflow}, small {small}")
        ctx.close()
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
