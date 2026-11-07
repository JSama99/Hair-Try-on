// style-card.js — StyleCardV1: the look a customer wants, in a form a stylist can read.
//
// Built only from the canonical catalog (tryon.js -> catalog.json) and the salon
// config; never from a second style list. A card holds style choices and optional
// consultation preferences — never photos, image data, face measurements, phone
// numbers or e-mail addresses. validateStyleCard() enforces that with a key
// whitelist and an image-data scan, and every export path runs it first.
//
// No DOM, no network. Unit-tested in test/style-card.test.mjs.

import * as T from './tryon.js';
import { bookingPlan, cleanText } from './salon-config.js';

export const STYLE_CARD_SCHEMA = 'talonsight.style-card';
export const STYLE_CARD_VERSION = 1;
export const NOTES_MAX = 300;

export const PREFERRED_DAYS = Object.freeze({
  any: 'Any day', weekday: 'A weekday', weekend: 'A weekend', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
  thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
});
export const HAIR_SUPPLY = Object.freeze({
  salon: 'The salon provides the braiding hair',
  own: 'I will bring my own braiding hair',
  unsure: 'Not sure yet',
});

export const PREVIEW_DISCLAIMER = 'This preview is an illustration made on a 3D model or a photo. It is not a guarantee of the finished style: hair amount, parting, length, colour and install time are decided with your stylist.';

export class StyleCardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Remove anything that looks like embedded image or file data from free text. */
export function stripEmbeddedData(text) {
  return text
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*/gi, '[removed attachment]')
    .replace(/blob:[^\s]+/gi, '[removed link]')
    .replace(/[A-Za-z0-9+/=]{120,}/g, '[removed data]');
}

/** Free-text notes from the customer: plain text, bounded, no embedded data. */
export function cleanNotes(value) {
  return cleanText(stripEmbeddedData(cleanText(value, NOTES_MAX * 4)), NOTES_MAX);
}

/** 'YYYY-MM-DD' for a real calendar date, else null. */
export function cleanDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? value : null;
}

/** Limitations that apply to this look's preview (shown to the customer and the stylist). */
export function limitationsFor(style) {
  const out = [
    'Lengths longer than armpit cannot be previewed yet (no body fitting).',
    'On-screen colour varies by display; check braiding-hair colour in person.',
  ];
  if (style.kind === 'cornrows') out.push('Straight-back cornrow previews leave the sides above the ears bare; real side rows curve.');
  if (style.sizes.some((z) => z.width <= 0.012)) out.push('Very small parts are shown with simplified detail on some devices.');
  return out;
}

function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `sc_${c.randomUUID()}`;
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return `sc_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Normalise optional consultation answers; anything unknown is dropped, nothing is required. */
export function normalizeConsultation(raw = {}, { askHairSupply = true } = {}) {
  const day = typeof raw.preferredDay === 'string' ? raw.preferredDay : '';
  const date = cleanDate(raw.preferredDate);
  return {
    preferredDay: date ? null : (Object.hasOwn(PREFERRED_DAYS, day) ? day : null),
    preferredDate: date,
    hairSupply: askHairSupply && Object.hasOwn(HAIR_SUPPLY, raw.hairSupply) ? raw.hairSupply : null,
    notes: cleanNotes(raw.notes || ''),
    acknowledgedPreview: raw.acknowledgedPreview === true,
  };
}

/**
 * Create a StyleCardV1 from the studio's current look. Throws StyleCardError for a
 * look that cannot be carded (unknown style, or a length that needs body fitting).
 */
export function createStyleCard({ look, salon, consultation = {}, now = new Date(), id = newId() }) {
  const res = T.specForLook(look);
  if (!res.ok) throw new StyleCardError(res.locked ? 'locked-length' : 'invalid-look', res.message);
  const { style, size, length } = res;
  const color = T.colorById(look.color) || T.colorById(T.CATALOG.defaults.color);
  const plan = bookingPlan(salon, style.id);
  const askHairSupply = plan.service ? plan.service.askHairSupply : true;
  const card = {
    schema: STYLE_CARD_SCHEMA,
    version: STYLE_CARD_VERSION,
    id,
    createdAt: now.toISOString(),
    salonId: salon && salon.salonId ? salon.salonId : null,
    style: {
      id: style.id,
      kind: style.kind,
      name: style.name,
      size: { id: size.id, label: size.label, partWidthCm: Math.round(size.width * 1000) / 10, ...(size.rows ? { rows: size.rows } : {}) },
      length: { id: length.id, label: length.label, cm: Math.round(length.length * 100) },
      color: { id: color.id, code: color.label, name: color.name, ombre: !!color.tipHex },
    },
    description: T.caption({ style: style.id, size: size.id, length: length.id, color: color.id }),
    service: plan.service ? { name: plan.service.serviceName, description: plan.service.description } : null,
    bookingMode: plan.mode,
    directBookingApproved: plan.mode === 'direct',
    consultationRequired: plan.mode !== 'direct',
    preferences: normalizeConsultation(consultation, { askHairSupply }),
    limitations: limitationsFor(style),
    disclaimer: PREVIEW_DISCLAIMER,
  };
  const errors = validateStyleCard(card);
  if (errors.length) throw new StyleCardError('invalid-card', errors.join('; '));
  return card;
}

/** A copy of the card with new consultation answers (the look itself is unchanged). */
export function withConsultation(card, salon, consultation) {
  const plan = bookingPlan(salon, card.style.id);
  const next = { ...card, preferences: normalizeConsultation(consultation, { askHairSupply: plan.service ? plan.service.askHairSupply : true }) };
  const errors = validateStyleCard(next);
  if (errors.length) throw new StyleCardError('invalid-card', errors.join('; '));
  return next;
}

// ---------------------------------------------------------------- validation

const SHAPE = {
  schema: 'string', version: 'number', id: 'string', createdAt: 'string', salonId: 'string?',
  style: {
    id: 'string', kind: 'string', name: 'string',
    size: { id: 'string', label: 'string', partWidthCm: 'number', rows: 'number?' },
    length: { id: 'string', label: 'string', cm: 'number' },
    color: { id: 'string', code: 'string', name: 'string', ombre: 'boolean' },
  },
  description: 'string',
  service: { $nullable: true, name: 'string', description: 'string' },
  bookingMode: 'string', directBookingApproved: 'boolean', consultationRequired: 'boolean',
  preferences: { preferredDay: 'string?', preferredDate: 'string?', hairSupply: 'string?', notes: 'string', acknowledgedPreview: 'boolean' },
  limitations: 'string[]',
  disclaimer: 'string',
};

function checkShape(value, shape, path, errors) {
  if (typeof shape === 'string') {
    const optional = shape.endsWith('?');
    const type = optional ? shape.slice(0, -1) : shape;
    if (value === undefined || value === null) { if (!optional) errors.push(`${path} is missing`); return; }
    if (type === 'string[]') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) errors.push(`${path} must be a list of text`);
      return;
    }
    if (typeof value !== type) errors.push(`${path} must be ${type}`);
    return;
  }
  if (value === null && shape.$nullable) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path} must be an object`); return; }
  for (const k of Object.keys(value)) if (!Object.hasOwn(shape, k)) errors.push(`${path}.${k} is not part of StyleCardV1`);
  for (const [k, s] of Object.entries(shape)) if (k !== '$nullable') checkShape(value[k], s, `${path}.${k}`, errors);
}

function* strings(v) {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* strings(x);
}

/** [] for a valid card; otherwise readable problems. Rejects any image or file data. */
export function validateStyleCard(card) {
  const errors = [];
  checkShape(card, SHAPE, 'card', errors);
  if (errors.length) return errors;
  if (card.schema !== STYLE_CARD_SCHEMA || card.version !== STYLE_CARD_VERSION) errors.push('not a StyleCardV1');
  if (!T.styleById(card.style.id)) errors.push('card.style.id is not in the catalog');
  if (!T.colorById(card.style.color.id)) errors.push('card.style.color.id is not in the catalog');
  const len = T.lengthById(card.style.length.id);
  if (!len) errors.push('card.style.length.id is not in the catalog');
  else if (len.requiresBody) errors.push('card.style.length needs body fitting and cannot be carded');
  if (!['direct', 'consultation', 'not-offered', 'no-salon'].includes(card.bookingMode)) errors.push('card.bookingMode is unknown');
  if (card.directBookingApproved !== (card.bookingMode === 'direct') || card.consultationRequired === card.directBookingApproved) {
    errors.push('booking flags disagree with bookingMode');
  }
  if (card.preferences.notes.length > NOTES_MAX) errors.push('notes are too long');
  if (card.preferences.preferredDate && !cleanDate(card.preferences.preferredDate)) errors.push('preferredDate is not a date');
  for (const s of strings(card)) {
    if (/data:[a-z]+\/[a-z0-9.+-]+;base64,|blob:|[A-Za-z0-9+/=]{120,}/i.test(s)) { errors.push('card contains embedded image or file data'); break; }
    if (s.length > 2000) { errors.push('card contains an over-long field'); break; }
  }
  return errors;
}

// ---------------------------------------------------------------- export

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Stable, pretty JSON for download (keys sorted so two exports of one card are identical). */
export function cardToJSON(card) {
  const errors = validateStyleCard(card);
  if (errors.length) throw new StyleCardError('invalid-card', errors.join('; '));
  return `${JSON.stringify(sortKeys(card), null, 2)}\n`;
}

export function cardFileName(card) {
  return `style-card-${card.style.id.replace(/_/g, '-')}-${card.createdAt.slice(0, 10)}.json`;
}

const MODE_LINE = {
  direct: 'Booking: the salon lists this service as bookable directly.',
  consultation: 'Booking: consultation first. Please confirm before I book.',
  'not-offered': 'Booking: this style is not on the salon\'s list. Please tell me if you can do it.',
  'no-salon': 'Booking: no salon selected.',
};

/** Plain-text consultation summary for copying or sharing (no HTML, no image). */
export function cardToText(card, salon) {
  const errors = validateStyleCard(card);
  if (errors.length) throw new StyleCardError('invalid-card', errors.join('; '));
  const p = card.preferences;
  const lines = [
    salon && salon.salonId ? `Style Card for ${salon.displayName}${salon.isDemo ? ' (demo salon)' : ''}` : 'Style Card',
    '',
    `Look: ${card.description}`,
  ];
  if (card.service) lines.push(`Service: ${card.service.name}`);
  lines.push(MODE_LINE[card.bookingMode]);
  if (p.preferredDate) lines.push(`Preferred date: ${p.preferredDate}`);
  else if (p.preferredDay) lines.push(`Preferred day: ${PREFERRED_DAYS[p.preferredDay]}`);
  if (p.hairSupply) lines.push(`Braiding hair: ${HAIR_SUPPLY[p.hairSupply]}`);
  if (p.notes) lines.push(`Notes: ${p.notes}`);
  lines.push('', `Preview note: ${card.disclaimer}`, `Card ${card.id} · ${card.createdAt.slice(0, 10)}`);
  return lines.join('\n');
}

/** The look a card describes, for restoring the studio. */
export const lookFromCard = (card) => ({ style: card.style.id, size: card.style.size.id, length: card.style.length.id, color: card.style.color.id });
