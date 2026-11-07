// salon-config.js — one pilot salon's services and booking links, validated at startup.
//
// The config is data a salon approves (web/salon/salon.config.json, bundled at build
// time). It maps EXISTING catalog style ids to the salon's services; it never adds
// styles, prices, availability or guarantees. Anything invalid is dropped with a
// reason, and a broken config falls back to "no salon" so the studio keeps working.
//
// No DOM, no network: pure functions, unit-tested in test/salon-config.test.mjs.

export const SALON_SCHEMA_VERSION = 1;
export const MAX_SERVICES = 5;
export const BOOKING_MODES = Object.freeze(['direct', 'consultation']);

const LIMITS = Object.freeze({ id: 64, name: 80, description: 400, instructions: 400, url: 2048, provider: 60 });

/** Plain text from untrusted input: no control characters, collapsed whitespace, bounded length. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/**
 * A booking URL the page may open: absolute https, a real host name, no credentials,
 * no other scheme (javascript:, data:, http:, ...). Returns the normalised URL or null.
 */
export function safeBookingUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > LIMITS.url || /[\s<>"'`]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname;
  if (!host || !host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return null; // no raw IPs
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  return u.toString();
}

/** The fallback when no usable salon config exists: the studio works, booking is off. */
export const NO_SALON = Object.freeze({
  salonId: null, displayName: '', isDemo: false, demoNotice: '', providerName: '',
  generalUrl: null, stylistInstructions: '', services: [], branding: null,
});

/**
 * Validate a raw config against the catalog. Returns {config, errors, warnings}.
 * `errors` mean the whole config was rejected (config = NO_SALON); `warnings` mean
 * individual entries were dropped or degraded.
 */
export function validateSalonConfig(raw, catalog) {
  const errors = [], warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: NO_SALON, errors: ['salon config is missing or not an object'], warnings };
  if (raw.schemaVersion !== SALON_SCHEMA_VERSION) errors.push(`schemaVersion must be ${SALON_SCHEMA_VERSION}`);
  const salonId = cleanText(raw.salonId, LIMITS.id);
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(salonId)) errors.push('salonId must be 2-64 lowercase letters, digits or hyphens');
  const displayName = cleanText(raw.displayName, LIMITS.name);
  if (!displayName) errors.push('displayName is required');
  if (typeof raw.isDemo !== 'boolean') errors.push('isDemo must be true or false (say plainly whether the salon is real)');
  if (raw.isDemo === true && !cleanText(raw.demoNotice, LIMITS.description)) errors.push('a demo salon needs a demoNotice');
  if (!Array.isArray(raw.services)) errors.push('services must be a list');
  if (errors.length) return { config: NO_SALON, errors, warnings };

  const booking = raw.booking && typeof raw.booking === 'object' ? raw.booking : {};
  const generalUrl = booking.generalUrl === undefined || booking.generalUrl === null ? null : safeBookingUrl(booking.generalUrl);
  if (booking.generalUrl && !generalUrl) warnings.push('booking.generalUrl is not a safe https URL and was ignored');
  if (!generalUrl) warnings.push('no general booking link: customers will be told to contact the salon directly');

  const styleIds = new Set(catalog.styles.map((s) => s.id));
  const seen = new Set();
  const services = [];
  raw.services.forEach((svc, i) => {
    const where = `services[${i}]`;
    if (!svc || typeof svc !== 'object') { warnings.push(`${where} is not an object and was dropped`); return; }
    const styleId = typeof svc.styleId === 'string' ? svc.styleId : '';
    if (!styleIds.has(styleId)) { warnings.push(`${where}: "${cleanText(styleId, 40)}" is not a style in the catalog and was dropped`); return; }
    if (seen.has(styleId)) { warnings.push(`${where}: ${styleId} is listed twice; the later entry was dropped`); return; }
    if (services.length >= MAX_SERVICES) { warnings.push(`${where}: the pilot supports up to ${MAX_SERVICES} services; dropped`); return; }
    const serviceName = cleanText(svc.serviceName, LIMITS.name);
    if (!serviceName) { warnings.push(`${where}: serviceName is required; dropped`); return; }
    let bookingMode = svc.bookingMode;
    if (!BOOKING_MODES.includes(bookingMode)) {
      warnings.push(`${where}: bookingMode must be "direct" or "consultation"; treated as consultation`);
      bookingMode = 'consultation';
    }
    // Direct booking must be an explicit salon decision AND have somewhere to book.
    let serviceUrl = null;
    if (svc.serviceUrl !== undefined && svc.serviceUrl !== null) {
      const u = safeBookingUrl(svc.serviceUrl);
      if (!u) warnings.push(`${where}: serviceUrl is not a safe https URL and was ignored`);
      else if (svc.serviceUrlVerified !== true) warnings.push(`${where}: serviceUrl is not marked serviceUrlVerified and was ignored`);
      else serviceUrl = u;
    }
    if (bookingMode === 'direct' && !serviceUrl && !generalUrl) {
      warnings.push(`${where}: direct booking needs a booking link; treated as consultation`);
      bookingMode = 'consultation';
    }
    seen.add(styleId);
    services.push(Object.freeze({
      styleId, serviceName, bookingMode, serviceUrl,
      description: cleanText(svc.description, LIMITS.description),
      askHairSupply: svc.askHairSupply === true,
    }));
  });
  if (!services.length) warnings.push('no valid services: every style will be "ask the salon first"');

  const accent = raw.branding && typeof raw.branding.accentHex === 'string' && /^#[0-9a-f]{6}$/i.test(raw.branding.accentHex)
    ? raw.branding.accentHex : null;
  const config = Object.freeze({
    salonId, displayName, isDemo: raw.isDemo,
    demoNotice: raw.isDemo ? cleanText(raw.demoNotice, LIMITS.description) : '',
    providerName: cleanText(booking.providerName, LIMITS.provider) || 'the salon\'s booking page',
    generalUrl,
    stylistInstructions: cleanText(raw.stylistInstructions, LIMITS.instructions),
    services: Object.freeze(services),
    branding: accent ? Object.freeze({ accentHex: accent }) : null,
  });
  return { config, errors, warnings };
}

export const hasSalon = (config) => !!(config && config.salonId);
export const serviceFor = (config, styleId) => (config ? config.services.find((s) => s.styleId === styleId) || null : null);
export const offersStyle = (config, styleId) => !!serviceFor(config, styleId);

/**
 * How a look can be booked at this salon. Never infers approval from anything the
 * customer did: only the salon's own config makes a service "direct".
 *   mode 'direct'        salon marked this service directly bookable
 *   mode 'consultation'  salon wants to see the Style Card first
 *   mode 'not-offered'   the salon does not list this style
 *   mode 'no-salon'      no valid salon config
 */
export function bookingPlan(config, styleId) {
  if (!hasSalon(config)) return { mode: 'no-salon', service: null, url: null, urlKind: null };
  const service = serviceFor(config, styleId);
  if (!service) return { mode: 'not-offered', service: null, url: null, urlKind: null };
  const target = bookingTarget(config, service);
  return { mode: service.bookingMode, service, url: target.url, urlKind: target.kind };
}

/** Service-specific link when the salon verified one, else the general link, else none. */
export function bookingTarget(config, service) {
  if (service && service.serviceUrl) return { url: service.serviceUrl, kind: 'service' };
  if (config && config.generalUrl) return { url: config.generalUrl, kind: 'general' };
  return { url: null, kind: null };
}
