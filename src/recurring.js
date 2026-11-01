'use strict';
// Recurring invoices: profiles generate draft invoices ahead of their date ("staging"),
// which are either sent automatically on the invoice date or left for you to review and send.
const db = require('./db');
const config = require('./config');
const settings = require('./settings');
const documents = require('./documents');
const email = require('./email');
const { today, addDays, daysBetween, formatMoney, formatDate, fillTemplate, isIsoDate } = require('./util');

const FREQUENCIES = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };
// Missed automatic sends older than this many days are left for review instead of being emailed late.
const LATE_SEND_GRACE_DAYS = 3;

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

// Date of occurrence n (0-based), always counted from the start date so day-of-month never drifts
// (a schedule starting on Jan 31 gives Feb 28, Mar 31, Apr 30, ...).
function occurrenceDate(profile, n) {
  const start = profile.start_date;
  const every = Math.max(1, Number(profile.interval_count) || 1);
  if (profile.frequency === 'weekly') return addDays(start, 7 * every * n);
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[profile.frequency] * every * n;
  const [y, m, d] = start.split('-').map(Number);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

// Next issue date for a profile, or null once it has finished.
function computeNext(profile) {
  const n = profile.generated_count;
  if (profile.max_count && n >= profile.max_count) return null;
  const date = occurrenceDate(profile, n);
  if (profile.end_date && date > profile.end_date) return null;
  return date;
}

function upcomingDates(profile, count = 5) {
  const out = [];
  for (let n = profile.generated_count; out.length < count; n++) {
    if (profile.max_count && n >= profile.max_count) break;
    const d = occurrenceDate(profile, n);
    if (profile.end_date && d > profile.end_date) break;
    out.push(d);
  }
  return out;
}

function describeSchedule(p) {
  const every = Math.max(1, Number(p.interval_count) || 1);
  const unit = FREQUENCIES[p.frequency];
  let text = every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
  if (p.frequency === 'weekly') {
    text += ` on ${new Date(`${p.start_date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', timeZone: 'UTC' })}`;
  } else {
    const day = Number(p.start_date.slice(8, 10));
    text += day >= 29 ? ` on the ${ordinal(day)} (or last day)` : ` on the ${ordinal(day)}`;
  }
  if (p.max_count) text += `, ${p.max_count} times`;
  if (p.end_date) text += `, until ${formatDate(p.end_date)}`;
  return text;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Placeholders for subject, line descriptions and notes, based on the invoice date.
function periodVars(issueDate) {
  const d = new Date(`${issueDate}T12:00:00Z`);
  const month = d.toLocaleDateString('en-CA', { month: 'long', timeZone: 'UTC' });
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15));
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15));
  const name = (x) => x.toLocaleDateString('en-CA', { month: 'long', timeZone: 'UTC' });
  return {
    month,
    year: String(d.getUTCFullYear()),
    quarter: `Q${Math.floor(d.getUTCMonth() / 3) + 1}`,
    date: formatDate(issueDate),
    last_month: `${name(prev)} ${prev.getUTCFullYear()}`,
    next_month: `${name(next)} ${next.getUTCFullYear()}`,
  };
}

function parseJson(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function getProfile(id) {
  const p = db
    .prepare('SELECT r.*, c.name AS client_name, c.email AS client_email FROM recurring r JOIN clients c ON c.id = r.client_id WHERE r.id = ?')
    .get(id);
  if (!p) return null;
  return decorate(p);
}

function decorate(p) {
  p.lines = parseJson(p.lines_json);
  p.taxes = parseJson(p.taxes_json);
  const { computeTotals } = require('./calc');
  const t = computeTotals(p.lines, p.taxes, p.discount_percent);
  p.total_cents = t.total;
  p.schedule_text = describeSchedule(p);
  p.finished = !p.next_date;
  return p;
}

function listProfiles() {
  return db
    .prepare(
      `SELECT r.*, c.name AS client_name, c.email AS client_email FROM recurring r JOIN clients c ON c.id = r.client_id
       ORDER BY r.active DESC, r.next_date IS NULL, r.next_date, r.id`,
    )
    .all()
    .map(decorate);
}

function saveProfile(id, data) {
  const fields = {
    client_id: data.client_id,
    name: data.name,
    subject: data.subject,
    po_number: data.po_number || '',
    currency: data.currency,
    discount_percent: data.discount_percent || 0,
    notes: data.notes || '',
    terms: data.terms || '',
    lines_json: JSON.stringify(data.lines || []),
    taxes_json: JSON.stringify(data.taxes || []),
    frequency: data.frequency,
    interval_count: data.interval_count,
    start_date: data.start_date,
    end_date: data.end_date || null,
    max_count: data.max_count || null,
    send_mode: data.send_mode,
    stage_days: data.stage_days,
    notify_owner: data.notify_owner ? 1 : 0,
  };
  if (!id) {
    const info = db
      .prepare(
        `INSERT INTO recurring (${Object.keys(fields).join(', ')}) VALUES (${Object.keys(fields).map((k) => `@${k}`).join(', ')})`,
      )
      .run(fields);
    id = Number(info.lastInsertRowid);
  } else {
    const existing = db.prepare('SELECT * FROM recurring WHERE id = ?').get(id);
    // Changing the start date restarts the count from that date.
    if (existing.start_date !== fields.start_date) db.prepare('UPDATE recurring SET generated_count = 0 WHERE id = ?').run(id);
    db.prepare(`UPDATE recurring SET ${Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }
  refreshNextDate(id);
  return id;
}

function refreshNextDate(id) {
  const p = db.prepare('SELECT * FROM recurring WHERE id = ?').get(id);
  if (!p) return;
  db.prepare('UPDATE recurring SET next_date = ? WHERE id = ?').run(computeNext(p), id);
}

// If a profile was edited to start in the past, don't generate a backlog: move to the first date
// that is today or later (or within the staging window).
function skipPastOccurrences(id) {
  const p = db.prepare('SELECT * FROM recurring WHERE id = ?').get(id);
  if (!p) return;
  let n = p.generated_count;
  const t = today();
  while (true) {
    const d = occurrenceDate(p, n);
    if (p.max_count && n >= p.max_count) break;
    if (p.end_date && d > p.end_date) break;
    if (d >= t) break;
    n++;
    if (n > 5000) break;
  }
  db.prepare('UPDATE recurring SET generated_count = ? WHERE id = ?').run(n, id);
  refreshNextDate(id);
}

function setActive(id, active) {
  db.prepare('UPDATE recurring SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

function deleteProfile(id) {
  db.prepare('DELETE FROM recurring WHERE id = ?').run(id);
}

// Creates the invoice for the profile's next date. Returns the new invoice id.
function generateNext(id, { now = today() } = {}) {
  const p = getProfile(id);
  if (!p || !p.next_date) return null;
  const issueDate = p.next_date;
  const vars = { ...periodVars(issueDate), client_name: p.client_name };
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
  const terms = client.payment_terms_days ?? Number(settings.get('payment_terms_days'));

  const invoiceId = db.transaction(() => {
    const newId = documents.createDocument('invoice', p.client_id, { subject: fillTemplate(p.subject, vars) });
    const autoSend = p.send_mode === 'auto' && daysBetween(issueDate, now) <= LATE_SEND_GRACE_DAYS ? issueDate : null;
    db.prepare(
      `UPDATE documents SET issue_date = ?, due_date = ?, po_number = ?, currency = ?, discount_percent = ?, notes = ?, terms = ?,
         recurring_id = ?, auto_send_on = ? WHERE id = ?`,
    ).run(
      issueDate,
      addDays(issueDate, terms),
      p.po_number,
      p.currency,
      p.discount_percent,
      fillTemplate(p.notes, vars),
      fillTemplate(p.terms, vars),
      p.id,
      autoSend,
      newId,
    );
    documents.replaceLines(
      newId,
      p.lines.map((l) => ({ ...l, item_date: null, description: fillTemplate(l.description, vars) })),
    );
    documents.replaceTaxes(newId, p.taxes.map((t) => ({ ...t, fixed_amount_cents: null })));
    documents.recalc(newId);
    db.prepare("UPDATE recurring SET generated_count = generated_count + 1, last_generated_at = datetime('now') WHERE id = ?").run(p.id);
    refreshNextDate(p.id);
    const note =
      p.send_mode === 'auto'
        ? autoSend
          ? `will be emailed automatically on ${formatDate(autoSend)}`
          : 'its automatic send date has passed, so it is waiting for you to review and send'
        : 'waiting for you to review and send';
    documents.logActivity(newId, `Created from recurring profile "${p.name || p.subject || p.client_name}"; ${note}`);
    return { newId, autoSend };
  })();

  if (p.notify_owner) {
    const inv = documents.getDocument(invoiceId.newId);
    const when = invoiceId.autoSend ? `It will be emailed to ${p.client_email || 'the client'} automatically on ${formatDate(invoiceId.autoSend)} unless you change it.` : 'Review it and send it when you are ready.';
    email.notifyOwner(
      `Invoice ${inv.number} for ${p.client_name} is ready (${formatMoney(inv.total_cents, inv.currency)})`,
      `A recurring invoice has been prepared:\n\n${inv.number} · ${p.client_name} · ${formatMoney(inv.total_cents, inv.currency)}\nInvoice date: ${formatDate(inv.issue_date)}\n\n${when}\n\n${config.appUrl}/invoices/${inv.id}`,
    );
  }
  return invoiceId.newId;
}

// Emails a staged invoice whose automatic send date has arrived.
async function autoSend(docId) {
  const doc = documents.getDocument(docId);
  if (!doc || doc.status !== 'draft' || !doc.auto_send_on) return false;
  db.prepare('UPDATE documents SET auto_send_on = NULL WHERE id = ?').run(doc.id);
  const fail = (reason) => {
    documents.logActivity(doc.id, `Automatic send skipped: ${reason}. Send it manually.`);
    email.notifyOwner(
      `Invoice ${doc.number} was not sent automatically`,
      `Invoice ${doc.number} for ${doc.client.name} could not be sent automatically: ${reason}.\n\nOpen it to send it yourself:\n${config.appUrl}/invoices/${doc.id}`,
    );
    return false;
  };
  if (!doc.lines.length) return fail('it has no line items');
  if (!doc.client.email) return fail('the client has no email address');
  if (!email.isConfigured()) return fail('email (Postmark) is not set up');

  documents.markSent(doc.id);
  const sent = documents.getDocument(doc.id);
  const d = email.defaultsFor('invoice', sent);
  try {
    await email.sendDocumentEmail(sent, { purpose: 'invoice', ...d, attachPdf: true });
  } catch (err) {
    db.prepare("UPDATE documents SET status = 'draft', sent_at = NULL WHERE id = ?").run(doc.id);
    return fail(err.message);
  }
  documents.logActivity(doc.id, `Invoice emailed automatically to ${[d.to, d.cc].filter(Boolean).join(', ')}`);
  return true;
}

let running = false;
async function runOnce({ now = today() } = {}) {
  if (running) return { generated: 0, sent: 0 };
  running = true;
  let generated = 0;
  let sent = 0;
  try {
    // 1. Stage invoices whose date is within each profile's staging window (catching up on any missed).
    const due = db.prepare('SELECT id, next_date, stage_days FROM recurring WHERE active = 1 AND next_date IS NOT NULL').all();
    for (const p of due) {
      let guard = 0;
      let cur = db.prepare('SELECT next_date, stage_days FROM recurring WHERE id = ?').get(p.id);
      while (cur && cur.next_date && addDays(cur.next_date, -Math.max(0, cur.stage_days)) <= now && guard++ < 24) {
        try {
          generateNext(p.id, { now });
          generated++;
        } catch (err) {
          console.error(`Recurring profile ${p.id} failed:`, err.message);
          break;
        }
        cur = db.prepare('SELECT next_date, stage_days FROM recurring WHERE id = ?').get(p.id);
      }
    }
    // 2. Send staged invoices whose automatic send date has arrived.
    const toSend = db
      .prepare("SELECT id FROM documents WHERE kind = 'invoice' AND status = 'draft' AND auto_send_on IS NOT NULL AND auto_send_on <= ?")
      .all(now);
    for (const d of toSend) {
      if (await autoSend(d.id)) sent++;
    }
  } finally {
    running = false;
  }
  return { generated, sent };
}

function stagedInvoices() {
  return db
    .prepare(
      `SELECT d.*, c.name AS client_name, r.name AS recurring_name FROM documents d
       JOIN clients c ON c.id = d.client_id LEFT JOIN recurring r ON r.id = d.recurring_id
       WHERE d.kind = 'invoice' AND d.status = 'draft' AND (d.recurring_id IS NOT NULL OR d.auto_send_on IS NOT NULL)
       ORDER BY COALESCE(d.auto_send_on, d.issue_date), d.id`,
    )
    .all();
}

function validDate(s) {
  return isIsoDate(s) ? s : null;
}

module.exports = {
  FREQUENCIES,
  occurrenceDate,
  computeNext,
  upcomingDates,
  describeSchedule,
  periodVars,
  getProfile,
  listProfiles,
  saveProfile,
  skipPastOccurrences,
  setActive,
  deleteProfile,
  generateNext,
  autoSend,
  runOnce,
  stagedInvoices,
  validDate,
};
