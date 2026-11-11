// look-link.js — a look as a link, and a small lookbook kept in this browser.
//
// A look is four catalog ids (style, size, length, colour). That is all a link or the lookbook
// ever holds: no photo, no notes, no name, no preferred day. The link carries the look in the URL
// *fragment* (#look=...), which browsers do not send to the server. Everything read back from a
// link or from storage is validated against the catalog; locked lengths are refused, exactly as in
// the studio.

import * as T from './tryon.js';

export const LINK_VERSION = '1';
export const LOOKBOOK_KEY = 'hairtryon.lookbook.v1';
export const LOOKBOOK_MAX = 12;

/** The look if every id exists in the catalog, belongs together and is not locked; otherwise null. */
export function validLook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const look = { style: raw.style, size: raw.size, length: raw.length, color: raw.color };
  if (Object.values(look).some((v) => typeof v !== 'string' || v.length > 40)) return null;
  const style = T.styleById(look.style);
  if (!style || !T.sizeOf(style, look.size) || !T.colorById(look.color)) return null;
  const length = T.lengthById(look.length);
  if (!length || length.requiresBody) return null;
  return T.specForLook(look).ok ? look : null;
}

export function encodeLook(look) {
  const ok = validLook(look);
  if (!ok) throw new Error('not a valid look');
  return [LINK_VERSION, ok.style, ok.size, ok.length, ok.color].map(encodeURIComponent).join('~');
}

export function decodeLook(text) {
  if (typeof text !== 'string' || text.length > 200) return null;
  let parts;
  try { parts = text.split('~').map(decodeURIComponent); } catch { return null; }
  if (parts.length !== 5 || parts[0] !== LINK_VERSION) return null;
  return validLook({ style: parts[1], size: parts[2], length: parts[3], color: parts[4] });
}

/** Read #look=... from a URL fragment (other fragment parameters are ignored). */
export function lookFromHash(hash) {
  const m = /(?:^#|&)look=([^&]*)/.exec(String(hash || ''));
  return m ? decodeLook(m[1]) : null;
}

/** A link to this page that opens on `look`. Only http(s) pages have a link worth sharing. */
export function lookUrl(look, pageUrl) {
  let u;
  try { u = new URL(pageUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return `${u.origin}${u.pathname}#look=${encodeLook(look)}`;
}

export const sameLook = (a, b) => !!a && !!b && a.style === b.style && a.size === b.size && a.length === b.length && a.color === b.color;

/** Short label for a saved look, e.g. "Knotless braids · Medium · Armpit · 1B/27". */
export function lookLabel(look) {
  const style = T.styleById(look.style);
  return [style.name, T.sizeOf(style, look.size).label, T.lengthById(look.length).label, T.colorById(look.color).label].join(' · ');
}

// ---------------------------------------------------------------- lookbook

export function readLookbook(storage) {
  if (!storage) return [];
  try {
    const raw = JSON.parse(storage.getItem(LOOKBOOK_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      const look = validLook(item);
      if (look && !out.some((o) => sameLook(o, look))) out.push(look);
      if (out.length === LOOKBOOK_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

function write(storage, looks) {
  try { storage.setItem(LOOKBOOK_KEY, JSON.stringify(looks)); return true; } catch { return false; }
}

/** Add a look (newest first). Returns {looks, added, full}. */
export function addToLookbook(storage, look) {
  const looks = readLookbook(storage);
  const ok = validLook(look);
  if (!ok || !storage) return { looks, added: false, full: false };
  if (looks.some((l) => sameLook(l, ok))) return { looks, added: false, full: false };
  if (looks.length >= LOOKBOOK_MAX) return { looks, added: false, full: true };
  const next = [ok, ...looks];
  return { looks: write(storage, next) ? next : looks, added: write(storage, next), full: false };
}

export function removeFromLookbook(storage, look) {
  const next = readLookbook(storage).filter((l) => !sameLook(l, look));
  if (storage) write(storage, next);
  return next;
}

export function clearLookbook(storage) {
  try { if (storage) storage.removeItem(LOOKBOOK_KEY); } catch { /* nothing to clear */ }
  return [];
}
