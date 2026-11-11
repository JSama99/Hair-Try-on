// setup.js — Salon setup: fill in a form, get a validated salon.config.json. No account, no server:
// the file is built on this device and the salon (or whoever hosts the page) puts it beside the studio.

import { renderSVG } from 'uqr';
import catalog from '../../ios/Packages/HairKit/Sources/TryOnCore/Resources/catalog.json' with { type: 'json' };
import builtIn from '../salon/salon.config.json' with { type: 'json' };
import { validateSalonConfig, safeBookingUrl, MAX_SERVICES } from './salon-config.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_KEY = 'hairtryon.salonPreview.v1';

export const slug = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

/** Form values -> raw config (what salon.config.json holds). */
export function buildConfig(v) {
  const raw = {
    schemaVersion: 1,
    salonId: v.salonId || slug(v.displayName),
    displayName: v.displayName.trim(),
    isDemo: !!v.isDemo,
    booking: {},
    stylistInstructions: v.stylistInstructions.trim(),
    services: v.services.filter((s) => s.offered).map((s) => {
      const svc = { styleId: s.styleId, serviceName: s.serviceName.trim(), description: s.description.trim(), bookingMode: s.bookingMode, askHairSupply: !!s.askHairSupply };
      if (s.serviceUrl.trim()) { svc.serviceUrl = s.serviceUrl.trim(); svc.serviceUrlVerified = !!s.serviceUrlVerified; }
      return svc;
    }),
  };
  if (raw.isDemo) raw.demoNotice = v.demoNotice.trim();
  if (v.providerName.trim()) raw.booking.providerName = v.providerName.trim();
  if (v.generalUrl.trim()) raw.booking.generalUrl = v.generalUrl.trim();
  if (/^#[0-9a-f]{6}$/i.test(v.accentHex) && v.useAccent) raw.branding = { accentHex: v.accentHex };
  return raw;
}

if (typeof document !== 'undefined') {
  const rows = $('services');
  for (const style of catalog.styles) {
    const row = document.createElement('fieldset');
    row.className = 'svc';
    row.dataset.style = style.id;
    const id = (k) => `svc-${style.id}-${k}`;
    row.innerHTML = `
      <legend><label><input type="checkbox" data-k="offered" id="${id('offered')}"> <span></span></label></legend>
      <div class="svc-body">
        <label for="${id('name')}">Service name, as on your booking page</label><input type="text" data-k="serviceName" id="${id('name')}" maxlength="80">
        <label for="${id('desc')}">One line for customers</label><input type="text" data-k="description" id="${id('desc')}" maxlength="240">
        <label for="${id('mode')}">Booking</label>
        <select data-k="bookingMode" id="${id('mode')}">
          <option value="consultation">Consultation first: she sends her Style Card and waits for my reply</option>
          <option value="direct">Book directly: no consultation needed</option>
        </select>
        <label for="${id('url')}">Link straight to this service (optional)</label><input type="url" data-k="serviceUrl" id="${id('url')}" placeholder="https://">
        <label class="check"><input type="checkbox" data-k="serviceUrlVerified" id="${id('ver')}"> I opened this link and it lands on this service</label>
        <label class="check"><input type="checkbox" data-k="askHairSupply" id="${id('supply')}"> Ask who brings the braiding hair</label>
      </div>`;
    row.querySelector('legend span').textContent = style.name;
    rows.append(row);
  }

  const read = () => ({
    displayName: $('name').value, salonId: $('salon-id').value.trim(), isDemo: $('is-demo').checked, demoNotice: $('demo-notice').value,
    providerName: $('provider').value, generalUrl: $('general-url').value, stylistInstructions: $('instructions').value,
    accentHex: $('accent').value, useAccent: $('use-accent').checked,
    services: [...rows.querySelectorAll('.svc')].map((row) => {
      const g = (k) => row.querySelector(`[data-k="${k}"]`);
      return { styleId: row.dataset.style, offered: g('offered').checked, serviceName: g('serviceName').value, description: g('description').value,
        bookingMode: g('bookingMode').value, serviceUrl: g('serviceUrl').value, serviceUrlVerified: g('serviceUrlVerified').checked, askHairSupply: g('askHairSupply').checked };
    }),
  });

  function fill(raw) {
    $('name').value = raw.displayName || '';
    $('salon-id').value = raw.salonId || '';
    $('is-demo').checked = raw.isDemo === true;
    $('demo-notice').value = raw.demoNotice || '';
    $('provider').value = (raw.booking && raw.booking.providerName) || '';
    $('general-url').value = (raw.booking && raw.booking.generalUrl) || '';
    $('instructions').value = raw.stylistInstructions || '';
    $('use-accent').checked = !!(raw.branding && raw.branding.accentHex);
    if (raw.branding && /^#[0-9a-f]{6}$/i.test(raw.branding.accentHex)) $('accent').value = raw.branding.accentHex;
    for (const row of rows.querySelectorAll('.svc')) {
      const svc = (raw.services || []).find((s) => s && s.styleId === row.dataset.style);
      const g = (k) => row.querySelector(`[data-k="${k}"]`);
      g('offered').checked = !!svc;
      g('serviceName').value = svc ? svc.serviceName || '' : '';
      g('description').value = svc ? svc.description || '' : '';
      g('bookingMode').value = svc && svc.bookingMode === 'direct' ? 'direct' : 'consultation';
      g('serviceUrl').value = svc ? svc.serviceUrl || '' : '';
      g('serviceUrlVerified').checked = !!(svc && svc.serviceUrlVerified);
      g('askHairSupply').checked = svc ? svc.askHairSupply === true : true;
    }
  }

  let json = '';
  let valid = false;
  function update() {
    const v = read();
    $('demo-row').hidden = !v.isDemo;
    for (const row of rows.querySelectorAll('.svc')) row.querySelector('.svc-body').hidden = !row.querySelector('[data-k="offered"]').checked;
    if (!$('salon-id').dataset.touched) $('salon-id').placeholder = slug(v.displayName) || 'your-salon';
    const raw = buildConfig(v);
    const { errors, warnings } = validateSalonConfig(raw, catalog);
    const extra = [];
    if (v.generalUrl.trim() && !safeBookingUrl(v.generalUrl.trim())) extra.push('The booking page link must start with https:// and be a normal web address.');
    if (v.services.filter((s) => s.offered).length > MAX_SERVICES) extra.push(`Up to ${MAX_SERVICES} services.`);
    const list = $('problems');
    list.replaceChildren(...[...errors.map((e) => ['error', e]), ...extra.map((e) => ['error', e]), ...warnings.map((w) => ['warn', w])].map(([kind, text]) => {
      const li = document.createElement('li');
      li.className = kind;
      li.textContent = text;
      return li;
    }));
    valid = errors.length === 0 && extra.length === 0;
    $('verdict').textContent = valid ? (warnings.length ? 'Usable, with the notes below.' : 'Ready to use.') : 'Not usable yet: fix the items below.';
    $('verdict').className = valid ? 'ok' : 'bad';
    json = `${JSON.stringify(raw, null, 2)}\n`;
    $('json').value = json;
    for (const b of [$('download'), $('copy'), $('preview')]) b.disabled = !valid;
    document.body.dataset.valid = String(valid);
  }

  $('form').addEventListener('input', (e) => { if (e.target.id === 'salon-id') e.target.dataset.touched = '1'; update(); });
  $('download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'salon.config.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('out-status').textContent = 'Downloaded. Put the file beside the studio page (replacing the old salon.config.json). No rebuild needed.';
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(json); $('out-status').textContent = 'Copied.'; } catch { $('json').focus(); $('json').select(); $('out-status').textContent = 'Copying is blocked here. The text is selected: copy it by hand.'; }
  });
  $('preview').addEventListener('click', () => {
    try { window.sessionStorage.setItem(PREVIEW_KEY, json); window.location.href = './index.html'; } catch { $('out-status').textContent = 'This browser will not let the page hand the draft to the studio. Download the file instead.'; }
  });
  $('end-preview').addEventListener('click', () => {
    try { window.sessionStorage.removeItem(PREVIEW_KEY); } catch { /* nothing stored */ }
    $('out-status').textContent = 'Preview ended. The studio shows the saved settings again.';
  });
  $('start-blank').addEventListener('click', () => { fill({ isDemo: false, services: [] }); update(); });

  // QR poster for the salon's mirror or front desk.
  function poster() {
    const url = safeBookingUrl($('studio-url').value.trim());
    $('qr').replaceChildren();
    $('poster-name').textContent = $('name').value.trim() || 'Your salon';
    $('print').disabled = !url;
    $('qr-status').textContent = url ? url : 'Enter the https address where your studio page is hosted.';
    if (!url) return;
    const svg = new DOMParser().parseFromString(renderSVG(url, { ecc: 'M', border: 2 }), 'image/svg+xml').documentElement;
    if (svg.nodeName.toLowerCase() === 'svg') $('qr').append(document.importNode(svg, true));
  }
  $('studio-url').addEventListener('input', poster);
  $('name').addEventListener('input', poster);
  $('print').addEventListener('click', () => window.print());
  if (/^https:$/.test(window.location.protocol)) $('studio-url').value = new URL('./', window.location.href).href;

  (async () => {
    let raw = builtIn;
    try {
      const draft = window.sessionStorage.getItem(PREVIEW_KEY);
      if (draft) raw = JSON.parse(draft);
      else {
        const res = await fetch(new URL('salon.config.json', document.baseURI), { cache: 'no-cache' });
        if (res.ok) raw = await res.json();
      }
    } catch { /* start from the built-in example */ }
    fill(raw && typeof raw === 'object' ? raw : builtIn);
    update();
    poster();
    document.body.dataset.ready = 'true';
  })();
}
