// extras-ui.js — My looks (a lookbook kept in this browser), a look as a link and QR code, and
// the stylist's side: opening a customer's Style Card to see her exact look in 3D.
//
// Wiring only. Text from a card or from storage reaches the page through textContent. Nothing here
// makes a network request; the QR code is drawn on this device.

import { renderSVG } from 'uqr';
import * as T from './tryon.js';
import { validateStyleCard, cardToText, lookFromCard } from './style-card.js';
import { validLook, lookUrl, lookLabel, sameLook, readLookbook, addToLookbook, removeFromLookbook, clearLookbook, LOOKBOOK_MAX } from './look-link.js';

const $ = (id) => document.getElementById(id);
export const CARD_FILE_MAX = 64 * 1024;

function localStore() {
  try { const s = window.localStorage; s.getItem('x'); return s; } catch { return null; }
}

/** Parse and validate Style Card text. Returns {card, look} or {error}. */
export function readCardText(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'There is no Style Card text to open.' };
  if (text.length > CARD_FILE_MAX) return { error: 'That file is too large to be a Style Card.' };
  let card;
  try { card = JSON.parse(text); } catch { return { error: 'That is not a Style Card file (it is not valid JSON). Ask the customer to use Download Style Card.' }; }
  const errors = validateStyleCard(card);
  if (errors.length) return { error: `That Style Card cannot be opened: ${errors[0]}.` };
  const look = validLook(lookFromCard(card));
  if (!look) return { error: 'That Style Card describes a look this version cannot show.' };
  return { card, look };
}

export function createExtras({ getLook, setLook, pageUrl = () => window.location.href }) {
  const el = {
    bookAdd: $('book-add'), bookClear: $('book-clear'), book: $('book'), bookCount: $('book-count'), bookHint: $('book-hint'),
    linkBtn: $('look-link'), linkDialog: $('link-dialog'), linkQr: $('link-qr'), linkUrl: $('link-url'), linkStatus: $('link-status'),
    linkCopy: $('link-copy'), linkClose: $('link-close'),
    cardFile: $('card-file'), cardPaste: $('card-paste'), cardOpen: $('card-open'), cardStatus: $('card-status'),
    viewing: $('viewing'), viewingDetails: $('viewing-details'), viewingClose: $('viewing-close'), stylist: $('stylist'),
  };
  const store = localStore();
  const BOOK_HINT = el.bookHint.textContent;
  let viewed = null;

  // ------------------------------------------------------------ lookbook

  function renderBook() {
    const looks = readLookbook(store);
    const current = getLook();
    el.book.replaceChildren(...looks.map((look) => {
      const li = document.createElement('li');
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'apply';
      apply.setAttribute('aria-current', String(sameLook(look, current)));
      const dot = document.createElement('span');
      dot.className = 'dot';
      const c = T.colorById(look.color);
      dot.style.background = c.tipHex ? `linear-gradient(180deg, ${c.hex} 0 38%, ${c.tipHex})` : c.hex;
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = lookLabel(look);
      apply.append(dot, label);
      apply.addEventListener('click', () => setLook(look));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${lookLabel(look)}`);
      remove.addEventListener('click', () => { removeFromLookbook(store, look); el.bookHint.textContent = 'Removed.'; renderBook(); });
      li.append(apply, remove);
      return li;
    }));
    el.bookCount.textContent = looks.length ? `${looks.length} of ${LOOKBOOK_MAX}` : '';
    el.bookClear.hidden = looks.length === 0;
    el.bookAdd.disabled = !store || looks.some((l) => sameLook(l, current));
    el.bookAdd.textContent = looks.some((l) => sameLook(l, current)) ? 'Kept' : 'Keep this look';
    if (!store) el.bookHint.textContent = 'This browser is not letting the page keep looks (private mode or blocked storage). Use Link and QR code instead.';
  }

  el.bookAdd.addEventListener('click', () => {
    const r = addToLookbook(store, getLook());
    el.bookHint.textContent = r.added ? 'Kept. Tap a look to bring it back.' : r.full ? `Your lookbook is full (${LOOKBOOK_MAX}). Remove one to keep another.` : BOOK_HINT;
    renderBook();
  });
  el.bookClear.addEventListener('click', () => { clearLookbook(store); el.bookHint.textContent = 'All kept looks were removed from this browser.'; renderBook(); });

  // ------------------------------------------------------------ link + QR

  function openLink() {
    const url = lookUrl(getLook(), pageUrl());
    el.linkQr.replaceChildren();
    if (!url) {
      el.linkUrl.value = '';
      el.linkUrl.hidden = true;
      el.linkQr.hidden = true;
      el.linkCopy.hidden = true;
      el.linkStatus.textContent = 'This copy of the page has no web address to link to (it was opened from a file). Use Copy description or Save My Look instead.';
    } else {
      el.linkUrl.hidden = false; el.linkQr.hidden = false; el.linkCopy.hidden = false;
      el.linkUrl.value = url;
      el.linkStatus.textContent = 'Scan it with a phone camera, or copy the link.';
      const doc = new DOMParser().parseFromString(renderSVG(url, { ecc: 'M', border: 2 }), 'image/svg+xml');
      const svg = doc.documentElement;
      if (svg && svg.nodeName.toLowerCase() === 'svg') el.linkQr.append(document.importNode(svg, true));
      el.linkQr.dataset.url = url;
    }
    if (typeof el.linkDialog.showModal === 'function') el.linkDialog.showModal(); else el.linkDialog.setAttribute('open', '');
  }
  el.linkBtn.addEventListener('click', openLink);
  el.linkClose.addEventListener('click', () => el.linkDialog.close());
  el.linkCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.linkUrl.value);
      el.linkStatus.textContent = 'Link copied.';
    } catch {
      el.linkUrl.focus();
      el.linkUrl.select();
      el.linkStatus.textContent = 'Copying is blocked here. The link is selected: copy it by hand.';
    }
  });

  // ------------------------------------------------------------ stylist: open a Style Card

  function show(text) {
    const r = readCardText(text);
    if (r.error) { el.cardStatus.textContent = r.error; return false; }
    viewed = r.card;
    setLook(r.look);
    el.viewingDetails.textContent = cardToText(r.card, null);
    el.viewing.hidden = false;
    el.cardStatus.textContent = 'Card opened. The preview now shows the customer\'s look.';
    el.cardPaste.value = '';
    document.body.dataset.viewing = r.card.id;
    el.viewing.scrollIntoView({ block: 'nearest' });
    return true;
  }
  el.cardFile.addEventListener('change', async () => {
    const f = el.cardFile.files && el.cardFile.files[0];
    el.cardFile.value = '';
    if (!f) return;
    if (f.size > CARD_FILE_MAX) { el.cardStatus.textContent = 'That file is too large to be a Style Card.'; return; }
    try { show(await f.text()); } catch { el.cardStatus.textContent = 'That file could not be read.'; }
  });
  el.cardOpen.addEventListener('click', () => show(el.cardPaste.value));
  el.viewingClose.addEventListener('click', () => {
    viewed = null;
    el.viewing.hidden = true;
    el.viewingDetails.textContent = '';
    el.cardStatus.textContent = '';
    delete document.body.dataset.viewing;
  });

  renderBook();
  return { lookChanged: renderBook, openCardText: show, get viewed() { return viewed; } };
}
