// consult-ui.js — Save My Look -> Style Card -> Share With Stylist -> booking handoff.
//
// Wiring only: the rules live in style-card.js and salon-config.js. Every string
// from the salon config or the customer reaches the page through textContent,
// never innerHTML. Nothing here makes a network request: sharing happens only
// through the customer's own copy, download or share-sheet action, and booking
// opens the salon's own page in a new tab.
//
// Session storage keeps only the saved look and two non-sensitive choices
// (preferred day, hair supply) so a reload does not lose them; notes and images
// are never stored. "Delete saved look" clears it.

import { saveFile } from './save-file.js';
import * as T from './tryon.js';
import { bookingPlan, hasSalon, offersStyle } from './salon-config.js';
import {
  createStyleCard, withConsultation, cardToJSON, cardToText, cardFileName, lookFromCard, StyleCardError,
} from './style-card.js';

const STORAGE_KEY = 'hairtryon.savedLook.v1';
const $ = (id) => document.getElementById(id);

function safeStorage() {
  try { return window.sessionStorage; } catch { return null; }
}

export function createConsultation({ getLook, setLook, getCapture, onNotice }) {
  const el = {
    salon: $('salon'), salonName: $('salon-name'), salonDemo: $('salon-demo'), salonNote: $('salon-note'), offeredKey: $('offered-key'),
    save: $('save-look'), consult: $('consult'), tag: $('booking-tag'), summary: $('look-summary'),
    changed: $('look-changed'), update: $('update-look'), restore: $('restore-look'),
    form: $('consult-form'), day: $('pref-day'), date: $('pref-date'), supplyField: $('supply-field'), notes: $('notes'),
    notesCount: $('notes-count'), ack: $('ack'), includeRow: $('include-img-row'), include: $('include-img'), imgNote: $('img-note'),
    share: $('share-card'), copy: $('copy-card'), download: $('download-card'), gate: $('gate-hint'), status: $('share-status'),
    manual: $('manual-copy'), text: $('card-text'),
    booking: $('booking'), bookTitle: $('booking-title'), bookBody: $('booking-body'), bookNote: $('booking-link-note'),
    bookLink: $('book-link'), bookStatus: $('booking-status'), del: $('delete-card'),
  };
  let salon = null;
  let card = null;

  // ---------------------------------------------------------------- salon

  function setSalon(config) {
    salon = config;
    el.salon.hidden = !hasSalon(salon);
    el.offeredKey.hidden = !hasSalon(salon);
    if (hasSalon(salon)) {
      el.salonName.textContent = `Booking with ${salon.displayName}`;
      el.salonDemo.hidden = !salon.isDemo;
      el.salonNote.textContent = salon.isDemo ? salon.demoNotice : salon.stylistInstructions;
    }
    if (card) refresh();
  }

  const isOffered = (styleId) => offersStyle(salon, styleId);

  // ---------------------------------------------------------------- save / edit

  function consultationFromForm() {
    const supply = el.form.querySelector('input[name="supply"]:checked');
    return {
      preferredDay: el.day.value || null,
      preferredDate: el.date.value || null,
      hairSupply: supply ? supply.value : null,
      notes: el.notes.value,
      acknowledgedPreview: el.ack.checked,
    };
  }

  function persist() {
    const st = safeStorage();
    if (!st) return;
    try {
      if (!card) { st.removeItem(STORAGE_KEY); return; }
      const p = card.preferences;
      // Only the look and two non-sensitive choices; never notes, never images.
      st.setItem(STORAGE_KEY, JSON.stringify({ look: lookFromCard(card), preferredDay: p.preferredDay, hairSupply: p.hairSupply }));
    } catch { /* storage full or blocked: the card still works for this page */ }
  }

  function save({ focus = true } = {}) {
    try {
      card = createStyleCard({ look: getLook(), salon, consultation: card ? consultationFromForm() : {} });
    } catch (e) {
      const msg = e instanceof StyleCardError ? e.message : 'This look could not be saved.';
      onNotice(msg);
      return null;
    }
    el.consult.hidden = false;
    refresh();
    persist();
    el.status.textContent = '';
    flash(el.save, 'Saved ✓', 'Save My Look');
    if (focus) {
      el.consult.focus({ preventScroll: true });
      el.consult.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
    return card;
  }

  function flash(button, text, restore) {
    button.textContent = text;
    clearTimeout(button._flash);
    button._flash = setTimeout(() => { button.textContent = restore; }, 1600);
  }

  /** Called by the studio whenever the look changes. */
  function lookChanged() {
    if (!card) return;
    const cur = getLook(), saved = lookFromCard(card);
    el.changed.hidden = cur.style === saved.style && cur.size === saved.size && cur.length === saved.length && cur.color === saved.color;
  }

  function onFormInput() {
    if (!card) return;
    if (el.date.value) el.day.value = '';
    card = withConsultation(card, salon, consultationFromForm());
    el.notesCount.textContent = `${el.notes.value.length} / 300`;
    refresh();
    persist();
  }

  // ---------------------------------------------------------------- render

  function refresh() {
    if (!card) return;
    // The salon may have changed since the card was made: rebuild the booking part.
    card = createStyleCard({ look: lookFromCard(card), salon, consultation: consultationFromForm(), id: card.id, now: new Date(card.createdAt) });
    const s = card.style;
    const bits = [s.name, s.size.rows ? `${s.size.rows} rows` : `${s.size.label} · ${s.size.partWidthCm} cm`, `${s.length.label} · ${s.length.cm} cm`, `Colour ${s.color.code}`];
    el.summary.replaceChildren(...bits.map((b) => { const span = document.createElement('span'); span.textContent = b; return span; }));
    el.supplyField.hidden = !(bookingPlan(salon, s.id).service ? bookingPlan(salon, s.id).service.askHairSupply : true);
    el.text.value = cardToText(card, salon);
    el.consult.dataset.print = el.text.value; // the print stylesheet prints this text (Print or Save as PDF)

    const cap = getCapture();
    el.includeRow.hidden = !cap;
    if (!cap) el.include.checked = false;
    else el.imgNote.textContent = cap.source === 'photo'
      ? 'It shows your photo and may identify you. Once shared, it stays wherever you send it.'
      : 'It shows the 3D model, not you.';

    const ready = el.ack.checked;
    for (const b of [el.share, el.copy, el.download]) {
      b.disabled = !ready;
      b.setAttribute('aria-describedby', 'gate-hint');
    }
    el.gate.hidden = ready;
    renderBooking(ready);
    lookChanged();
  }

  function renderBooking(ready) {
    const plan = bookingPlan(salon, card.style.id);
    const name = hasSalon(salon) ? salon.displayName : 'the salon';
    const provider = hasSalon(salon) ? salon.providerName : 'the booking page';
    el.booking.className = `booking ${plan.mode === 'direct' ? 'direct' : 'waiting'}`;
    el.bookStatus.textContent = '';
    let title, body, linkLabel = 'Book Appointment', tag, tagClass = 'tag';
    switch (plan.mode) {
      case 'direct':
        title = 'Ready to book';
        body = `${name} lists this service as bookable directly. ${plan.service.description}`.trim();
        tag = 'Book directly'; tagClass = 'tag direct';
        break;
      case 'consultation':
        title = 'Awaiting stylist confirmation';
        body = `${name} asks to see your Style Card before booking ${plan.service.serviceName}. Share it with them first. This app cannot see their reply: once they confirm, book here.`;
        linkLabel = 'Book after your stylist confirms';
        tag = 'Consultation first';
        break;
      case 'not-offered':
        title = 'Ask before booking';
        body = `${name} does not list ${card.style.name.toLowerCase()} as one of its services. Share your Style Card and ask whether they can do it.`;
        linkLabel = 'Book after your stylist confirms';
        tag = 'Not on the salon’s list';
        break;
      default:
        title = 'No salon selected';
        body = 'Share your Style Card with your stylist and book with them directly.';
        tag = 'Style Card';
    }
    el.tag.className = tagClass;
    el.tag.textContent = tag;
    el.bookTitle.textContent = title;
    el.bookBody.textContent = body;
    if (plan.url) {
      el.bookLink.hidden = false;
      el.bookLink.href = plan.url;  // already validated https by salon-config.js
      el.bookLink.textContent = linkLabel;
      el.bookLink.setAttribute('aria-disabled', String(!ready));
      el.bookLink.tabIndex = ready ? 0 : -1;
      el.bookNote.textContent = `${plan.urlKind === 'general'
        ? `This opens ${provider}'s general booking page: choose ${plan.service ? `"${plan.service.serviceName}"` : 'your service'} there. `
        : `This opens ${provider} at the ${plan.service.serviceName} service. `}Availability, prices, deposits and confirmation are handled there. Your Style Card is not sent automatically; share it yourself.`;
    } else {
      el.bookLink.hidden = true;
      el.bookLink.removeAttribute('href');
      el.bookNote.textContent = hasSalon(salon) ? `${name} has not added a booking link yet. Contact them directly.` : '';
    }
  }

  // ---------------------------------------------------------------- share / export

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    }
    return false;
  }

  function manualFallback(reason) {
    el.manual.open = true;
    el.text.focus();
    el.text.select();
    el.status.textContent = `${reason} The text is selected below: copy it with your keyboard or long-press.`;
  }

  async function onCopy() {
    const text = cardToText(card, salon);
    if (await copyText(text)) el.status.textContent = 'Consultation copied. Paste it into a message to your stylist.';
    else manualFallback('Copying is blocked here.');
  }

  async function onDownload() {
    const name = cardFileName(card);
    const how = await saveFile(name, new Blob([cardToJSON(card)], { type: 'application/json' }));
    el.status.textContent = how === 'declined' ? 'Nothing was saved. Use Copy consultation instead, or try again.'
      : how === 'saved' ? `Style Card saved as ${name}.`
        : `Style Card saved as ${name}. If nothing downloaded, this browser blocks downloads here: use Copy consultation instead.`;
  }

  async function onShare() {
    const text = cardToText(card, salon);
    const data = { title: `Style Card: ${card.style.name}`, text };
    const cap = el.include.checked ? getCapture() : null;
    if (cap) {
      const file = new File([cap.blob], `style-preview-${card.style.id}.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) data.files = [file];
      else el.status.textContent = 'This device cannot share images; sharing the text only.';
    }
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(data);
        el.status.textContent = `Handed to your share sheet${data.files ? ' with the preview image' : ''}. Delivery is up to the app you picked; this page cannot see whether your stylist received it.`;
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') { el.status.textContent = 'Sharing cancelled. Nothing was sent.'; return; }
      }
    }
    if (await copyText(text)) el.status.textContent = 'Sharing is not available in this browser, so the consultation was copied instead. Paste it into a message to your stylist.';
    else manualFallback('Sharing and copying are not available in this browser.');
  }

  function onBookClick(e) {
    if (!el.ack.checked || el.bookLink.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    const provider = hasSalon(salon) ? salon.providerName : 'the booking page';
    el.bookStatus.textContent = `Opened ${provider} in a new tab. Your appointment is booked only when ${provider} confirms it.`;
  }

  function deleteCard() {
    card = null;
    el.form.reset();
    el.notesCount.textContent = '0 / 300';
    el.consult.hidden = true;
    el.manual.open = false;
    el.text.value = '';
    delete el.consult.dataset.print;
    persist();
    el.save.focus();
    onNotice('Saved look deleted from this browser.');
  }

  // ---------------------------------------------------------------- wire

  el.save.addEventListener('click', () => save());
  el.update.addEventListener('click', () => save({ focus: false }));
  el.restore.addEventListener('click', () => { if (card) setLook(lookFromCard(card)); });
  el.form.addEventListener('input', onFormInput);
  el.form.addEventListener('change', onFormInput);
  el.form.addEventListener('submit', (e) => e.preventDefault());
  el.copy.addEventListener('click', () => onCopy().catch(() => manualFallback('Copying failed.')));
  el.download.addEventListener('click', onDownload);
  el.share.addEventListener('click', () => onShare().catch(() => manualFallback('Sharing failed.')));
  el.bookLink.addEventListener('click', onBookClick);
  el.include.addEventListener('change', () => { el.status.textContent = ''; });
  el.del.addEventListener('click', deleteCard);

  /** Restore a look saved earlier in this browser session (no notes, no images). */
  function restoreSession() {
    const st = safeStorage();
    let saved = null;
    try { saved = st && JSON.parse(st.getItem(STORAGE_KEY) || 'null'); } catch { saved = null; }
    if (!saved || !saved.look) return false;
    try {
      card = createStyleCard({ look: saved.look, salon, consultation: { preferredDay: saved.preferredDay, hairSupply: saved.hairSupply } });
    } catch { persist(); return false; }
    if (card.preferences.preferredDay) el.day.value = card.preferences.preferredDay;
    if (card.preferences.hairSupply) {
      const r = el.form.querySelector(`input[name="supply"][value="${card.preferences.hairSupply}"]`);
      if (r) r.checked = true;
    }
    el.consult.hidden = false;
    refresh();
    return true;
  }

  return {
    setSalon, isOffered, lookChanged, restoreSession, refresh: () => card && refresh(),
    get card() { return card; },
  };
}
