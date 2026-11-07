// Salon configuration: validation, safe booking URLs, booking plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CATALOG } from '../src/tryon.js';
import {
  validateSalonConfig, safeBookingUrl, cleanText, bookingPlan, bookingTarget, serviceFor, offersStyle, hasSalon, NO_SALON, MAX_SERVICES,
} from '../src/salon-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = JSON.parse(readFileSync(path.join(here, '..', 'salon', 'salon.config.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('S01 the bundled demo config is valid, clearly fictional, and maps only catalog styles', () => {
  const { config, errors, warnings } = validateSalonConfig(DEMO, CATALOG);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.isDemo, true);
  assert.match(config.demoNotice, /fictional/i);
  assert.ok(config.generalUrl.startsWith('https://example.com/'), 'demo links use the reserved example.com domain');
  assert.ok(config.services.length <= MAX_SERVICES);
  for (const s of config.services) assert.ok(CATALOG.styles.some((c) => c.id === s.styleId));
  assert.equal(offersStyle(config, 'two_strand_twists'), false, 'the demo salon does not claim every catalog style');
});

test('S02 missing or malformed config falls back to NO_SALON without throwing', () => {
  for (const raw of [undefined, null, 42, [], 'salon']) {
    const r = validateSalonConfig(raw, CATALOG);
    assert.equal(r.config, NO_SALON);
    assert.ok(r.errors.length);
    assert.equal(hasSalon(r.config), false);
  }
  const bad = clone(DEMO); bad.schemaVersion = 2;
  assert.equal(validateSalonConfig(bad, CATALOG).config, NO_SALON);
  const noDemoFlag = clone(DEMO); delete noDemoFlag.isDemo;
  assert.match(validateSalonConfig(noDemoFlag, CATALOG).errors.join(), /isDemo/);
  const demoNoNotice = clone(DEMO); demoNoNotice.demoNotice = '';
  assert.match(validateSalonConfig(demoNoNotice, CATALOG).errors.join(), /demoNotice/);
  const badId = clone(DEMO); badId.salonId = 'Crown & Coil';
  assert.match(validateSalonConfig(badId, CATALOG).errors.join(), /salonId/);
});

test('S03 unsupported, duplicate and excess style mappings are dropped with a reason', () => {
  const raw = clone(DEMO);
  raw.services.push({ styleId: 'silk_press', serviceName: 'Silk press', bookingMode: 'direct' });
  raw.services.push({ styleId: 'box_braids', serviceName: 'Box braids again', bookingMode: 'direct' });
  raw.services.push({ styleId: 'two_strand_twists', serviceName: 'Twists', bookingMode: 'direct' });
  raw.services.push({ styleId: 'knotless_braids', serviceName: 'dup', bookingMode: 'direct' });
  const { config, warnings } = validateSalonConfig(raw, CATALOG);
  assert.ok(warnings.some((w) => /silk_press.*not a style/.test(w)));
  assert.ok(warnings.some((w) => /box_braids is listed twice/.test(w)));
  assert.equal(serviceFor(config, 'box_braids').serviceName, 'Box braids');
  assert.equal(config.services.length, 5);
  const six = clone(DEMO);
  six.services = CATALOG.styles.map((s) => ({ styleId: s.id, serviceName: s.name, bookingMode: 'consultation' }));
  six.services.push({ styleId: 'nope', serviceName: 'x', bookingMode: 'consultation' });
  assert.ok(validateSalonConfig(six, CATALOG).config.services.length <= MAX_SERVICES);
});

test('S04 direct booking only when the salon says so and a link exists', () => {
  const { config } = validateSalonConfig(DEMO, CATALOG);
  assert.equal(bookingPlan(config, 'knotless_braids').mode, 'direct');
  assert.equal(bookingPlan(config, 'box_braids').mode, 'direct');
  assert.equal(bookingPlan(config, 'locs').mode, 'consultation');
  assert.equal(bookingPlan(config, 'two_strand_twists').mode, 'not-offered');
  assert.equal(bookingPlan(NO_SALON, 'locs').mode, 'no-salon');

  const unknownMode = clone(DEMO); unknownMode.services[0].bookingMode = 'instant';
  const r = validateSalonConfig(unknownMode, CATALOG);
  assert.equal(bookingPlan(r.config, 'knotless_braids').mode, 'consultation');
  assert.ok(r.warnings.some((w) => /treated as consultation/.test(w)));

  const noLinks = clone(DEMO); delete noLinks.booking.generalUrl; delete noLinks.services[1].serviceUrl;
  const r2 = validateSalonConfig(noLinks, CATALOG);
  assert.equal(bookingPlan(r2.config, 'box_braids').mode, 'consultation', 'direct without any link degrades');
  assert.equal(bookingPlan(r2.config, 'knotless_braids').mode, 'direct', 'its own verified link is enough');
});

test('S05 service-specific link only when verified; otherwise the general link', () => {
  const { config } = validateSalonConfig(DEMO, CATALOG);
  const k = bookingPlan(config, 'knotless_braids');
  assert.equal(k.urlKind, 'service');
  assert.match(k.url, /knotless-braids$/);
  const b = bookingPlan(config, 'box_braids');
  assert.equal(b.urlKind, 'general');
  assert.equal(b.url, config.generalUrl);
  const unverified = clone(DEMO); unverified.services[0].serviceUrlVerified = false;
  const r = validateSalonConfig(unverified, CATALOG);
  assert.equal(bookingPlan(r.config, 'knotless_braids').urlKind, 'general');
  assert.ok(r.warnings.some((w) => /serviceUrlVerified/.test(w)));
  assert.deepEqual(bookingTarget(NO_SALON, null), { url: null, kind: null });
});

test('S06 unsafe booking URLs are rejected', () => {
  for (const u of [
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>',
    'http://booksy.com/salon', 'ftp://example.com/x', '//example.com/book', '/book', 'example.com/book',
    'https://user:pass@example.com/', 'https://localhost/book', 'https://127.0.0.1/book', 'https://[::1]/book',
    'https://exa mple.com/', 'https://example.com/"onmouseover=1', 'https://intranet/book', 'https://x.internal/b',
    '', null, 42, `https://example.com/${'a'.repeat(3000)}`,
  ]) assert.equal(safeBookingUrl(u), null, String(u).slice(0, 40));
  for (const u of ['https://booksy.com/en-us/123_crown-coil', 'https://squareup.com/appointments/book/abc/xyz',
    'https://www.fresha.com/a/crown-coil-atlanta', 'https://book.example.org/path?service=knotless#top']) {
    assert.ok(safeBookingUrl(u), u);
  }
  const raw = clone(DEMO); raw.booking.generalUrl = 'javascript:alert(document.cookie)';
  const r = validateSalonConfig(raw, CATALOG);
  assert.equal(r.config.generalUrl, null);
  assert.ok(r.warnings.some((w) => /generalUrl is not a safe/.test(w)));
});

test('S07 config text is cleaned (control and bidi characters, length)', () => {
  assert.equal(cleanText('  Crown\u0000 &‮ Coil  ', 80), 'Crown & Coil');
  assert.equal(cleanText('x'.repeat(100), 10), 'x'.repeat(10));
  assert.equal(cleanText(undefined, 10), '');
  const raw = clone(DEMO); raw.displayName = '<img src=x onerror=alert(1)>';
  // Kept as literal text: the UI renders it with textContent, never as HTML.
  assert.equal(validateSalonConfig(raw, CATALOG).config.displayName, '<img src=x onerror=alert(1)>');
  const branded = clone(DEMO); branded.branding = { accentHex: 'red;background:url(x)' };
  assert.equal(validateSalonConfig(branded, CATALOG).config.branding, null);
});
