# Gap audit, free tools, and what was applied (v1.2)

Scope: the browser studio and salon pilot as of `feature/style-card-consultation` (v1.1). Each gap was read off the code and docs, a free tool was researched for it, and the ones that could be closed without a backend, an account or an API key were closed and tested. What could not be closed honestly is listed at the end with the reason.

## 1. Gaps found, and what happened to each

| # | Gap in v1.1 | Why it mattered | Free tool / technique | Result in v1.2 |
|---|---|---|---|---|
| 1 | **No live try-on outside the iPhone app**, and the iPhone app has never been compiled. The "live AR" promise existed only on paper. | The product's core claim could not be shown on any device. | MediaPipe Face Landmarker in VIDEO mode (Apache-2.0, already pinned), `getUserMedia`, `requestVideoFrameCallback`, 1€ filter (published algorithm) | **Live mirror** in the browser: front camera, tracked head, braids placed by the same generator. Works on Android and desktop too. |
| 2 | **Hair did not move** in the browser; the physics existed only in Swift. | A rigid wig is what every filter app does. | Own code: `web/src/hairsim.js`, a twin of `HairKit/HairDynamics`, reusing the generator's constraint kernels | Braids **swing, collide with the head and settle** in the live mirror; strands stay exactly inextensible (tested in the browser). |
| 3 | The page **loaded scripts from jsDelivr and fonts from Google Fonts**. Privacy was a promise in a footer, not something a customer or salon could verify; the page also could not work offline. | "Nothing leaves the tab" was untestable, and two third parties saw every visitor's IP. | esbuild bundling (MIT), Fontsource font files (OFL-1.1), a Content-Security-Policy `<meta>` with a script hash | **Zero third-party requests** (every suite asserts it). The page's own policy sets `connect-src 'self'`: the browser itself refuses to send anything to another host (tested with a hostile `fetch` and image beacon). |
| 4 | **No offline or installable mode.** A salon tablet with weak Wi-Fi got nothing. | Salons are the pilot customer. | Service worker + web app manifest (web platform, no library) | **Installable and offline**: after the first visit the studio, photo mode and live-mirror models all load with no connection (tested). |
| 5 | **The stylist could not open a Style Card.** She received JSON or text and had to imagine the look. | The consultation was one-sided. | Existing `validateStyleCard` + a file/paste reader | **Stylist view**: open or paste the card, see the customer's exact look in 3D with her details beside it. Hostile cards are refused; notes render as text only. |
| 6 | **No way to hand a look to someone else** except a screenshot or the card file. | In-salon sharing (customer's phone to stylist's tablet) needs to be instant. | `uqr` (MIT, 0 dependencies) for QR codes drawn on the device; URL fragment (never sent to a server) | **Link and QR code** for any look. The link holds four catalog ids, nothing else; locked lengths and unknown ids are refused. |
| 7 | **One saved look at a time**, gone when the tab closed. | Customers compare; "which one did I like?" is the real question. | `localStorage`, validated on read | **My looks**: keep up to 12 looks in the browser (ids only, never an image), tap to bring one back. |
| 8 | **No before/after.** | Standard expectation of any try-on. | — | **Hold to compare** in photo and live modes. |
| 9 | **Changing the salon's settings meant a rebuild** by a developer; the JSON had to be hand-written. | The $199 setup would have been mostly typing JSON. | Same validator, a form, `uqr` | **Salon setup page** (`setup.html`): a form that produces a validated `salon.config.json`, previews it in the studio, and prints a QR poster for the mirror. The studio reads `salon.config.json` beside the page at run time: **no rebuild**. |
| 10 | **Accessibility was untested.** | Legal and practical: screen readers, voice control, low vision. | axe-core (MPL-2.0, test-only) in Playwright | Automated audit in both themes on both pages: **0 serious or critical violations**. It found and fixed two real ones (locked-chip contrast; button names that did not match their visible text, which breaks voice control). |
| 11 | No way to **print or save the card as a PDF**. | Some salons keep paper. | Print stylesheet (browser's own Save as PDF) | Printing the page prints the Style Card text only. |
| 12 | First-time users had no cue what to do. | Ease of use. | — | A three-step strip (pick, see it on you, send it) and plain-language camera errors. |

## 2. What makes it different (checked against what is on the market)

Sources checked on 2026-11-10: consumer "AI braids try-on" pages (for example [The Right Hairstyles' AI try-on](https://therighthairstyles.com/ai-braids-dreads-twists-afro-hairstyles-try-on/)) and commercial SDKs ([Banuba virtual hairstyle try-on](https://www.banuba.com/virtual-hairstyle-try-on)). The pattern: upload a photo, a generative model returns a picture; or a paid SDK recolours and swaps hair in video. None of the sources reviewed offered the following together, and several are simply impossible for a generated picture:

1. **A style a stylist can execute.** Part size in centimetres, length in centimetres, braid count, and braiding-hair colour codes (1B, 27, 30, 613, 1B/30…), from geometry that was actually built, not painted.
2. **It tells the truth.** When her own hair would still show past the style, it says so and shows where. A generator hides it.
3. **Her hairline, not a wig cap.** Matched from her photo or camera, with a stated error (about a centimetre).
4. **Privacy the browser enforces.** No upload, no account, no third-party request, and a policy that makes exfiltration fail. Works offline.
5. **Moving hair in a plain web page.** Strand physics in the live mirror, no app install.
6. **A consultation that ends in the salon's own booking page**, with a card both sides can open in 3D, and no invented prices or fake confirmations.

This is a claim about the sources reviewed, not a guarantee that no such product exists.

## 3. Tools chosen

| Tool | Version | Licence | Used for | Ships to users? |
|---|---|---|---|---|
| MediaPipe Tasks Vision (library, wasm, Face Landmarker, Hair Segmenter) | pinned in `web/assets.lock` | Apache-2.0 | face pose (photo and video), hair mask | yes, as the page's own files |
| three.js | pinned in `package.json` | MIT | rendering | yes, bundled |
| uqr | 0.1.3 | MIT | QR codes drawn locally | yes, bundled |
| Fontsource (Bricolage Grotesque, Figtree, IBM Plex Mono) | 5.3.0 | OFL-1.1 | self-hosted fonts | yes, 4 woff2 files |
| esbuild | pinned | MIT | bundling | no |
| axe-core | 4.14.0 | MPL-2.0 | accessibility audit in tests | no |
| Playwright + Chromium fake camera, ffmpeg | — | Apache-2.0 / LGPL | end-to-end tests, including a synthetic camera film made from renders of the bust | no |

Considered and not used: Workbox (a 60-line service worker does the job with no dependency); a newer MediaPipe release (the pinned wasm and models are hash-locked and the hairline tolerances were measured on them; upgrade is its own change); MediaPipe GPU delegate for the live mirror (CPU is slower but behaves the same everywhere, including headless tests).

## 4. Gaps still open, and why

| Gap | Why it is still open | What would close it |
|---|---|---|
| **Live mirror is unmeasured on real phones.** It was tested in desktop Chromium with software rendering and a synthetic camera film. | No physical device here. | Run it on two or three phones; watch frame rate and heat. A step governor already lowers solver work when a frame runs long. |
| Live mirror details: face tracking and the 1.5-second hair mask run on the main thread (a brief hitch when the mask is taken); gravity assumes the phone is upright; tracking drops past roughly 60° of head turn. | Kept simple and identical across browsers. | Move the segmenter to a worker; read device orientation for gravity. |
| **Lengths past armpit stay locked.** | Needs a torso collider. That changes the generator and its goldens in Python, JS and Swift: a contract change, not a UI feature. | MediaPipe Pose Landmarker (Apache-2.0) gives shoulders; fit a torso proxy; regenerate goldens. |
| Curved side cornrows; micro braids (≤ 1 cm) | Generator work (curved parts; hair-card LOD2). | As in `docs/ARCHITECTURE.md` §8. |
| **iPhone app never compiled**; links, My looks and the card viewer are browser-only. | No iOS SDK here. | First build on a Mac (`docs/BUILD.md`), then port `look-link.js` to TryOnCore. |
| Segmentation fairness by skin tone and curl pattern | Needs consented, stratified photos, not code. | As in `docs/BUILD.md`. |
| The stylist's reply still arrives through her own channel. | No backend is authorised, and a fake inbox would mislead. | A real backend, when authorised. |
| In a claude.ai artifact preview: no camera (file saves go through the host's confirmation prompt). | The host does not grant the camera to embedded pages. | Host the `dist/` folder on any static https host. |
