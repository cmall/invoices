'use strict';
// Businesses you invoice from. The main business is configured in Settings; additional ones
// store their own details and fall back to the main business for anything left unset.
const db = require('./db');
const settings = require('./settings');

// Per-business details. Identity fields always come from the business itself (even if blank),
// so another company never shows your main phone number or address.
const IDENTITY_KEYS = ['business_name', 'business_email', 'business_phone', 'business_address', 'business_website', 'payment_instructions'];
// These fall back to the main business when left blank.
const FALLBACK_KEYS = ['from_email', 'from_name', 'accent_color', 'heading_color', 'invoice_font', 'logo_size', 'default_invoice_notes', 'default_invoice_terms', 'default_estimate_notes'];
const NUMBERING_KEYS = ['invoice_prefix', 'invoice_next_number', 'estimate_prefix', 'estimate_next_number'];
const ALL_KEYS = [...IDENTITY_KEYS, ...FALLBACK_KEYS, ...NUMBERING_KEYS, 'logo_file', 'own_numbering'];

function parse(row) {
  if (!row) return null;
  let profile = {};
  try {
    profile = JSON.parse(row.profile || '{}');
  } catch {
    profile = {};
  }
  return { id: row.id, archived: row.archived, ...profile, name: profile.business_name || `Business #${row.id}` };
}

function get(id) {
  if (!id) return null;
  return parse(db.prepare('SELECT * FROM businesses WHERE id = ?').get(id));
}

function list({ includeArchived = false } = {}) {
  return db
    .prepare(`SELECT * FROM businesses ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY archived, id`)
    .all()
    .map(parse);
}

function hasAdditional() {
  return Boolean(db.prepare('SELECT 1 FROM businesses WHERE archived = 0 LIMIT 1').get());
}

// Options for "bill from" pickers: the main business first.
function choices(currentId) {
  const main = { id: null, name: settings.get('business_name') || 'Main business', primary: true };
  const others = list().concat(currentId && !list().some((b) => b.id === Number(currentId)) ? [get(currentId)].filter(Boolean) : []);
  return [main, ...others];
}

// Settings as they apply to documents from this business.
function effective(id) {
  const base = settings.getAll();
  const b = get(id);
  if (!b) return { ...base, business_id: null, logo_url: base.logo_file ? `/logo?v=${encodeURIComponent(base.logo_file)}` : '' };
  const out = { ...base, business_id: b.id };
  for (const k of IDENTITY_KEYS) out[k] = b[k] ?? '';
  for (const k of FALLBACK_KEYS) if (b[k] !== undefined && b[k] !== '') out[k] = b[k];
  if (!/^#[0-9a-f]{6}$/i.test(out.accent_color)) out.accent_color = base.accent_color;
  if (!/^#[0-9a-f]{6}$/i.test(out.heading_color)) out.heading_color = base.heading_color;
  out.logo_file = b.logo_file || '';
  out.logo_url = b.logo_file ? `/logo?b=${b.id}&v=${encodeURIComponent(b.logo_file)}` : '';
  out.own_numbering = b.own_numbering === '1';
  if (out.own_numbering) {
    for (const k of NUMBERING_KEYS) if (b[k] !== undefined && b[k] !== '') out[k] = b[k];
    if (b.invoice_prefix !== undefined) out.invoice_prefix = b.invoice_prefix;
    if (b.estimate_prefix !== undefined) out.estimate_prefix = b.estimate_prefix;
  }
  return out;
}

function save(id, data) {
  const current = id ? get(id) || {} : {};
  const profile = {};
  for (const k of ALL_KEYS) {
    if (k in data) profile[k] = String(data[k] ?? '');
    else if (k in current) profile[k] = current[k];
  }
  const json = JSON.stringify(profile);
  if (id) {
    db.prepare('UPDATE businesses SET profile = ? WHERE id = ?').run(json, id);
    return Number(id);
  }
  return Number(db.prepare('INSERT INTO businesses (profile) VALUES (?)').run(json).lastInsertRowid);
}

function setField(id, key, value) {
  const b = get(id);
  if (!b) return;
  save(id, { [key]: value });
}

function setArchived(id, archived) {
  db.prepare('UPDATE businesses SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
}

// Numbering: read and advance the counter wherever this business keeps it.
function numbering(id, kind) {
  const s = effective(id);
  const useOwn = Boolean(s.business_id && s.own_numbering);
  return {
    prefix: kind === 'invoice' ? s.invoice_prefix : s.estimate_prefix,
    next: Number(kind === 'invoice' ? s.invoice_next_number : s.estimate_next_number) || 1,
    padding: Math.max(0, Math.min(10, Number(s.number_padding) || 0)),
    setNext(n) {
      const key = kind === 'invoice' ? 'invoice_next_number' : 'estimate_next_number';
      if (useOwn) setField(id, key, String(n));
      else settings.set(key, n);
    },
  };
}

function nameOf(id) {
  if (!id) return settings.get('business_name') || 'Main business';
  const b = get(id);
  return b ? b.name : 'Main business';
}

module.exports = { IDENTITY_KEYS, FALLBACK_KEYS, NUMBERING_KEYS, ALL_KEYS, get, list, hasAdditional, choices, effective, save, setField, setArchived, numbering, nameOf };
