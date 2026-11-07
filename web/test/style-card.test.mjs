// StyleCardV1: creation from the catalog, consultation answers, validation, export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as T from '../src/tryon.js';
import { validateSalonConfig, NO_SALON } from '../src/salon-config.js';
import {
  createStyleCard, withConsultation, validateStyleCard, cardToJSON, cardToText, cardFileName, lookFromCard,
  normalizeConsultation, cleanNotes, cleanDate, StyleCardError, STYLE_CARD_SCHEMA, NOTES_MAX, PREVIEW_DISCLAIMER,
} from '../src/style-card.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SALON = validateSalonConfig(JSON.parse(readFileSync(path.join(here, '..', 'salon', 'salon.config.json'), 'utf8')), T.CATALOG).config;
const NOW = new Date('2026-11-07T20:00:00Z');
const make = (look, consultation, salon = SALON) => createStyleCard({ look, salon, consultation, now: NOW, id: 'sc_test' });

test('C01 a card records the current look from the canonical catalog', () => {
  const look = { style: 'knotless_braids', size: 'small', length: 'armpit', color: '1B/27' };
  const c = make(look);
  assert.equal(c.schema, STYLE_CARD_SCHEMA);
  assert.equal(c.version, 1);
  assert.equal(c.id, 'sc_test');
  assert.equal(c.createdAt, '2026-11-07T20:00:00.000Z');
  assert.equal(c.salonId, 'demo-crown-and-coil');
  assert.deepEqual(c.style, {
    id: 'knotless_braids', kind: 'knotless_braids', name: 'Knotless braids',
    size: { id: 'small', label: 'Small', partWidthCm: 1.2 },
    length: { id: 'armpit', label: 'Armpit', cm: 34 },
    color: { id: '1B/27', code: '1B/27', name: 'Off black to honey blonde', ombre: true },
  });
  assert.equal(c.description, T.caption(look), 'the caption is the studio\'s own');
  assert.deepEqual(lookFromCard(c), look);
  assert.deepEqual(validateStyleCard(c), []);
});

test('C02 every unlocked look in every family makes a valid card; cornrows record rows', () => {
  let n = 0;
  for (const s of T.STYLES) for (const z of s.sizes) for (const l of T.LENGTHS.filter((x) => !x.requiresBody)) {
    const c = make({ style: s.id, size: z.id, length: l.id, color: '1' });
    assert.deepEqual(validateStyleCard(c), [], `${s.id}/${z.id}/${l.id}`);
    if (s.kind === 'cornrows') assert.equal(c.style.size.rows, z.rows);
    else assert.equal(c.style.size.rows, undefined);
    n++;
  }
  assert.ok(n >= 50);
  const corn = make({ style: 'cornrows', size: 'medium', length: 'chin', color: '1' });
  assert.ok(corn.limitations.some((x) => /sides above the ears/.test(x)));
});

test('C03 restricted lengths cannot be carded', () => {
  for (const l of T.LENGTHS.filter((x) => x.requiresBody)) {
    assert.throws(() => make({ style: 'box_braids', size: 'medium', length: l.id, color: '1' }),
      (e) => e instanceof StyleCardError && e.code === 'locked-length' && /body capture/.test(e.message));
  }
  assert.throws(() => make({ style: 'silk_press', size: 'x', length: 'chin', color: '1' }), (e) => e.code === 'invalid-look');
});

test('C04 direct vs consultation vs not offered follows the salon config only', () => {
  const direct = make({ style: 'knotless_braids', size: 'medium', length: 'armpit', color: '1' });
  assert.equal(direct.bookingMode, 'direct');
  assert.equal(direct.directBookingApproved, true);
  assert.equal(direct.consultationRequired, false);
  assert.equal(direct.service.name, 'Knotless braids');
  const consult = make({ style: 'locs', size: 'medium', length: 'shoulder', color: '1' });
  assert.equal(consult.bookingMode, 'consultation');
  assert.equal(consult.directBookingApproved, false);
  assert.equal(consult.consultationRequired, true);
  const notOffered = make({ style: 'two_strand_twists', size: 'medium', length: 'shoulder', color: '1' });
  assert.equal(notOffered.bookingMode, 'not-offered');
  assert.equal(notOffered.service, null);
  assert.equal(notOffered.consultationRequired, true);
  const none = make({ style: 'locs', size: 'medium', length: 'shoulder', color: '1' }, {}, NO_SALON);
  assert.equal(none.bookingMode, 'no-salon');
  assert.equal(none.salonId, null);
  // Customer answers never change the booking mode.
  const eager = withConsultation(consult, SALON, { acknowledgedPreview: true, notes: 'Approved by stylist already!' });
  assert.equal(eager.bookingMode, 'consultation');
  assert.equal(eager.directBookingApproved, false);
});

test('C05 consultation answers are optional, validated and bounded', () => {
  const empty = make({ style: 'box_braids', size: 'large', length: 'shoulder', color: '4' });
  assert.deepEqual(empty.preferences, { preferredDay: null, preferredDate: null, hairSupply: null, notes: '', acknowledgedPreview: false });
  const c = withConsultation(empty, SALON, { preferredDay: 'sat', hairSupply: 'own', notes: '  Middle part please  ', acknowledgedPreview: true });
  assert.deepEqual(c.preferences, { preferredDay: 'sat', preferredDate: null, hairSupply: 'own', notes: 'Middle part please', acknowledgedPreview: true });
  const dated = withConsultation(empty, SALON, { preferredDay: 'sat', preferredDate: '2026-11-21' });
  assert.equal(dated.preferredDate ?? dated.preferences.preferredDate, '2026-11-21');
  assert.equal(dated.preferences.preferredDay, null, 'a date replaces the day');
  const junk = normalizeConsultation({ preferredDay: 'someday', preferredDate: '2026-02-30', hairSupply: 'free', notes: 5, acknowledgedPreview: 'yes', phone: '555-0100', email: 'a@b.c' });
  assert.deepEqual(junk, { preferredDay: null, preferredDate: null, hairSupply: null, notes: '', acknowledgedPreview: false });
  const cornrows = make({ style: 'cornrows', size: 'medium', length: 'chin', color: '1' }, { hairSupply: 'own' });
  assert.equal(cornrows.preferences.hairSupply, null, 'not asked where the salon does not ask');
  assert.equal(cleanNotes('long note '.repeat(60)).length <= NOTES_MAX, true);
  assert.equal(cleanNotes('x'.repeat(130)), '[removed data]', 'an unbroken 120+ character run is treated as data, not text');
  assert.equal(cleanDate('2028-02-29'), '2028-02-29');
  assert.equal(cleanDate('2027-02-29'), null);
});

test('C06 no photo, image data or contact details can reach a card or its exports', () => {
  const look = { style: 'knotless_braids', size: 'medium', length: 'armpit', color: '1' };
  const fakePhoto = `data:image/png;base64,${'iVBORw0KGgo'.repeat(40)}`;
  const c = make(look, { notes: `see ${fakePhoto} and blob:https://x/123 thanks`, phone: '555-0100', email: 'me@x.com', photo: fakePhoto });
  assert.match(c.preferences.notes, /^see \[removed attachment\] and \[removed link\] thanks$/);
  const json = cardToJSON(c), text = cardToText(c, SALON);
  for (const out of [json, text]) {
    assert.doesNotMatch(out, /data:image|base64|blob:|555-0100|me@x\.com/);
  }
  assert.deepEqual(Object.keys(c).sort(), ['bookingMode', 'consultationRequired', 'createdAt', 'description', 'directBookingApproved', 'disclaimer', 'id', 'limitations', 'preferences', 'salonId', 'schema', 'service', 'style', 'version']);
  // A tampered card is refused by every export path.
  const tampered = { ...c, preview: fakePhoto };
  assert.ok(validateStyleCard(tampered).some((e) => /not part of StyleCardV1/.test(e)));
  assert.throws(() => cardToJSON(tampered));
  assert.throws(() => cardToText(tampered, SALON));
  const smuggled = { ...c, description: `${c.description} ${'A'.repeat(200)}` };
  assert.ok(validateStyleCard(smuggled).includes('card contains embedded image or file data'));
});

test('C07 validation catches broken cards', () => {
  const c = make({ style: 'locs', size: 'large', length: 'chin', color: '613' });
  assert.ok(validateStyleCard({ ...c, version: 2 }).includes('not a StyleCardV1'));
  assert.ok(validateStyleCard({ ...c, style: { ...c.style, id: 'silk_press' } }).length);
  assert.ok(validateStyleCard({ ...c, style: { ...c.style, length: { id: 'waist', label: 'Waist', cm: 75 } } }).some((e) => /body fitting/.test(e)));
  assert.ok(validateStyleCard({ ...c, directBookingApproved: true }).includes('booking flags disagree with bookingMode'));
  assert.ok(validateStyleCard({ ...c, preferences: { ...c.preferences, notes: 'x'.repeat(NOTES_MAX + 1) } }).includes('notes are too long'));
  assert.ok(validateStyleCard(null).length);
});

test('C08 exports: stable JSON, readable text with the disclaimer, safe file name', () => {
  const c = withConsultation(make({ style: 'locs', size: 'large', length: 'shoulder', color: '1B/30' }), SALON,
    { preferredDay: 'weekend', hairSupply: 'unsure', notes: '<script>alert(1)</script>', acknowledgedPreview: true });
  const json = cardToJSON(c);
  assert.equal(json, cardToJSON(JSON.parse(json)), 'round-trips byte for byte');
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(c)));
  const text = cardToText(c, SALON);
  assert.match(text, /^Style Card for Crown & Coil Studio \(demo salon\)/);
  assert.match(text, /Booking: consultation first/);
  assert.match(text, /Preferred day: A weekend/);
  assert.match(text, /Braiding hair: Not sure yet/);
  assert.match(text, /Notes: <script>alert\(1\)<\/script>/, 'kept as literal text; never rendered as HTML');
  assert.ok(text.includes(PREVIEW_DISCLAIMER));
  assert.equal(cardFileName(c), 'style-card-locs-2026-11-07.json');
});
