# Salon pilot: visual consultation and booking handoff

**Discover your look. See it on yourself. Share it with your stylist. Book with confidence.**

Status: implemented and tested in the browser studio (branch `feature/style-card-consultation`). The business benefits (fewer back-and-forth messages, better-prepared bookings) are **hypotheses for the pilot to test**, not results.

---

## A. What was implemented

Journey: **choose a style → preview it → Save My Look → Style Card → consultation details → share with the stylist → book through the salon's own provider.** No account, no backend, no booking system.

| File | Change |
|---|---|
| `web/salon/salon.config.json` | **New.** The pilot salon: one clearly fictional demo salon, four existing styles mapped to services (two direct, two consultation first), `example.com` links only. |
| `web/src/salon-config.js` | **New.** Validates the config against the catalog at startup; https-only booking links; drops unknown, duplicate or excess (> 5) style mappings with reasons; direct booking only by explicit salon decision *and* with a link; falls back to "no salon" so the studio never breaks. |
| `web/src/style-card.js` | **New.** `StyleCardV1`, built from the canonical catalog through `tryon.js` (no second style list). Optional consultation answers; key-whitelist validation that rejects image or file data; stable JSON and plain-text exports. |
| `web/src/consult-ui.js` | **New.** The Save My Look → share → booking UI. Wiring only; all text via `textContent`; no network calls. |
| `web/src/app.js` | Small integration: load and validate the config, offered-style dots, look-change notifications, capture source (photo vs bust), test hooks. Footer now says which external resources load. |
| `web/src/index.template.html` | Salon banner, Save My Look, Style Card panel, share and booking boxes; phone-layout fixes. |
| `web/test/salon-config.test.mjs`, `style-card.test.mjs` | **New.** 15 unit tests. |
| `web/test/e2e_consult.py` | **New.** 51 end-to-end checks over the whole journey. |

Unchanged: the generator (`protostyle.js`), head fit, try-on logic (`tryon.js`), worker, rendering, the catalog, every Swift and Python file. Locked lengths (mid-back, waist) stay locked and cannot be put on a Style Card.

Assumptions: one salon per deployment; the salon's booking provider is reached by a public https link; customers share by their own phone apps.

## B. Run the browser app

```bash
cd web
npm install                    # esbuild; three and tasks-vision copies are used by the tests
bash tools/fetch-assets.sh     # pinned MediaPipe models and wasm (SHA-256 checked)
npm run build                  # -> dist/index.html (+ models, wasm)
python3 -m http.server -d dist 8000   # open http://localhost:8000
```

Tests: `npm test` (unit), `npm run e2e` (both browser suites; needs `pip install playwright`).

## C. Configure a pilot salon

Edit `web/salon/salon.config.json`, then `npm run build`. Every field is checked at startup; problems are listed in the browser console and the page falls back safely.

```json
{
  "schemaVersion": 1,
  "salonId": "lowercase-letters-digits-hyphens",
  "displayName": "As the salon writes its name",
  "isDemo": false,
  "booking": { "providerName": "Booksy", "generalUrl": "https://booksy.com/..." },
  "stylistInstructions": "One or two lines shown to customers.",
  "services": [
    { "styleId": "knotless_braids", "serviceName": "Knotless braids (medium)", "description": "...",
      "bookingMode": "direct", "serviceUrl": "https://booksy.com/...", "serviceUrlVerified": true, "askHairSupply": true },
    { "styleId": "locs", "serviceName": "Loc consultation", "description": "...", "bookingMode": "consultation", "askHairSupply": true }
  ],
  "branding": { "accentHex": "#962658" }
}
```

- **`styleId`** must be one of the catalog's five: `knotless_braids`, `box_braids`, `two_strand_twists`, `locs`, `cornrows`. Up to five services. A salon only "offers" what it lists.
- **`bookingMode`**: `direct` only for services the salon has approved for booking without a consultation. Everything else is `consultation`. Without any usable link, `direct` is downgraded to `consultation`.
- **`serviceUrl`** is used only when `serviceUrlVerified` is `true` (the salon has opened it and it lands on that service). Otherwise customers get the general link with "choose the service there".
- Links must be `https://` with a real host name: no `http:`, `javascript:`, `data:`, raw IPs, `localhost` or embedded credentials.
- **`isDemo`** must be stated. A demo salon must carry a `demoNotice`; the page shows a Demo badge.
- Never put prices, deposits, availability or guarantees in the config: the page has nowhere to show them on purpose.

## D. The customer journey

1. **Explore and customise.** Pick a style (dots mark the salon's services), size in cm, length, braiding-hair colour code. Locked lengths explain why.
2. **Try it on.** On the 3D bust (Monk skin tones 1–10) or her own photo. Photo mode, manual fitting and the "your own hair would still show" warning are unchanged.
3. **Save My Look.** Creates a Style Card from the current look and opens it. Changing the look afterwards shows "You changed the look": update the card, or go back to the saved look. Nothing is lost.
4. **Details for the stylist (optional).** Preferred day or date, who supplies braiding hair (only where the salon asks), notes (300 characters), and a tick to confirm she understands a preview is not a guarantee. Sharing and booking wait for that tick.
5. **Share With Stylist.** The page says exactly what is shared. Share sheet (phones), Copy consultation, Download Style Card (`.json`). Where neither sharing nor copying is available, the text is shown and selected to copy by hand. A captured preview image is shared only if she ticks the box, with a warning when it comes from her photo.
6. **Booking handoff.**
   - *Direct service:* "Ready to book" → the salon's link (service-specific when verified). The page states that availability, prices, deposits and confirmation are handled by the provider, and that the Style Card is not sent automatically.
   - *Consultation first, or a style the salon doesn't list:* "Awaiting stylist confirmation" / "Ask before booking". The page says it cannot see the stylist's reply and to book after the stylist confirms.
   - Clicking the link reports "booked only when the provider confirms it". The app never marks anything confirmed.

## E. Privacy and data boundaries

| Data | Where it goes |
|---|---|
| Her photo | Stays in the tab (decoded, analysed and drawn locally). Never stored, never sent, never in a URL. |
| Captured preview image | In memory. Leaves only if she ticks "Also share my captured preview image" and then shares; flagged "may identify you" when it comes from her photo. |
| Style Card (style, size, length, colour, optional day, hair supply, notes) | Only where she copies, downloads or shares it herself. Contains no image, face data, phone number or e-mail (enforced by validation and tests). |
| Session storage | The saved look plus preferred day and hair supply, for this browser session only. No notes, no images. "Delete saved look" clears it. |
| External booking provider | Receives only what any visitor following a link sends (the page URL and her browser's normal request). No Style Card, no referrer (`rel="noreferrer"`). |
| Network | The page loads three.js and MediaPipe scripts from jsDelivr and fonts from Google Fonts (those services see her IP address and the request, not her data). Models and wasm load from the page's own host. The consultation flow makes **no** requests (tested: no POST/PUT, no new hosts). |

**Before real customer photos or real salon details are used:** confirm the hosting origin and its logs; decide whether to self-host fonts and scripts (removes the jsDelivr/Google requests); publish a short privacy notice; get the salon's written approval of every config field; open each booking link on a phone; and remove the Demo flag only for a real, consenting salon.

## F. Known limitations

- No stylist approval inside the app: "awaiting confirmation" ends when the stylist replies through her own channel.
- No booking-status sync and no appointment confirmation: opening the provider's page is not a booking.
- No server-side consultations, no multi-salon accounts, no admin dashboard (one salon per build).
- No pricing, deposits or availability, by design.
- Restricted lengths (mid-back, waist) cannot be previewed or carded (no body fitting).
- Previews do not guarantee the physical result; photo hairline estimates are good to about ±1 cm.
- Downloads are blocked inside some embedded viewers (for example a claude.ai artifact preview); the page then says to copy instead.
- The salon config is baked in at build time: changing it means a rebuild.

## G. iOS parity (next, without touching the AR engine)

1. **Shared data:** move `salon.config.json` next to `catalog.json` in `HairKit/TryOnCore/Resources`; add `SalonConfig` (Codable + the same validation rules) and `StyleCardV1` (Codable, same field names and schema string) to TryOnCore. Port `salon-config.test.mjs` and `style-card.test.mjs` cases to XCTest; add a cross-language fixture (a card exported by the web build must decode in Swift and re-export byte-identically).
2. **Store:** `TryOnStore` gains `savedCard: StyleCardV1?` and intents `saveLook()`, `updateConsultation(_:)`, `deleteCard()`. It reads `look` and `catalog` exactly as the web reads `state.look`.
3. **UI:** a `StyleCardSheet` (SwiftUI `Form`: day/date picker, hair-supply picker, notes, acknowledgement) presented from `ControlPanel`; `ShareLink(item: text)` and, opt-in, the captured image (the capture already exists in `CapturedLook`); `Link` / `openURL` for booking after the same https validation.
4. **No engine changes:** ARKit, RealityKit, the shader and HairKit physics are untouched; the card only reads the look.

## H. Two-minute demonstration script

*(Desktop or phone, demo build. Say up front: "This is a fictional salon. Everything you'll see runs in the browser; nothing is sent anywhere.")*

| Time | Do | Say | Demonstrated / future |
|---|---|---|---|
| 0:00 | Point at the banner and the dots on the style chips | "The salon decides which styles it offers." | Demonstrated |
| 0:15 | Pick Knotless braids → Medium → Armpit → colour 1B/27; rotate the bust; switch skin tone | "She sees the size in centimetres and the real braiding-hair colour code." | Demonstrated |
| 0:35 | *(optional)* Your photo → choose a hair-pulled-back photo | "Her own photo, processed on her phone." | Demonstrated |
| 0:50 | Save My Look | "One tap turns the look into a Style Card." | Demonstrated |
| 1:00 | Saturday, "I'll bring my own", a note, tick the box | "Only what a stylist needs. No phone number, no photo." | Demonstrated |
| 1:15 | Share With Stylist (or Copy consultation) | "She sends it through the app she already uses with you, e.g. text or Instagram." | Demonstrated (copy/share sheet). Automatic delivery to the salon: **future** |
| 1:30 | Book Appointment → the booking page opens | "Your booking page, your prices, your deposits. We don't touch them." | Demonstrated (link handoff). Booking status in the app: **future** |
| 1:45 | Switch to Locs → Update my card | "For services you want to discuss first, she waits for your OK. The app never pretends you approved." | Demonstrated |

## Pilot measurement (with consent, no tracking code)

Measure by hand during the pilot; the build has no analytics on purpose.

| Measure | How |
|---|---|
| Style selection completion, Style Cards created | Ask pilot customers to share the card with the salon; the salon counts cards received (each card has a unique `id`). |
| Consultation completion | Count received cards with the acknowledgement and at least one answer. |
| Booking-page visits | The salon's own provider dashboard (most show referral or link traffic); the app does not report clicks. |
| Stylist handling time | Stylist logs minutes per inquiry for two weeks before and during the pilot (same weekdays). |
| Confirmed appointments | Only appointments the salon confirms in its booking system, matched by card id or date. |
| Customer feedback | Three-question form after the appointment (clarity, accuracy of the preview, would use again). |
| Willingness to pay | Ask the salon at the end: would they pay the $199 setup (a test price, not a validated rate), and what would make it worth more. |

No billing, subscriptions or payment code is part of this milestone.
