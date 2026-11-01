'use strict';
const db = require('./db');
const settings = require('./settings');
const { computeTotals } = require('./calc');
const { randomToken, today, addDays } = require('./util');

const INVOICE_STATUSES = ['draft', 'sent', 'partial', 'paid', 'void'];
const ESTIMATE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'invoiced'];
const PAYMENT_METHODS = {
  stripe: 'Card (Stripe)',
  etransfer: 'E-transfer',
  bank: 'Bank transfer',
  cheque: 'Cheque',
  cash: 'Cash',
  other: 'Other',
};

function logActivity(documentId, message) {
  db.prepare('INSERT INTO activity (document_id, message) VALUES (?, ?)').run(documentId, message);
}

function formatNumber(kind, n) {
  const s = settings.getAll();
  const prefix = kind === 'invoice' ? s.invoice_prefix : s.estimate_prefix;
  const pad = Math.max(0, Math.min(10, Number(s.number_padding) || 0));
  return `${prefix}${String(n).padStart(pad, '0')}`;
}

// Takes the next free number for this kind and advances the counter.
function takeNextNumber(kind) {
  const key = kind === 'invoice' ? 'invoice_next_number' : 'estimate_next_number';
  let n = Number(settings.get(key)) || 1;
  const exists = db.prepare('SELECT 1 FROM documents WHERE kind = ? AND number = ?');
  while (exists.get(kind, formatNumber(kind, n))) n++;
  settings.set(key, n + 1);
  return formatNumber(kind, n);
}

function peekNextNumber(kind) {
  const key = kind === 'invoice' ? 'invoice_next_number' : 'estimate_next_number';
  let n = Number(settings.get(key)) || 1;
  const exists = db.prepare('SELECT 1 FROM documents WHERE kind = ? AND number = ?');
  while (exists.get(kind, formatNumber(kind, n))) n++;
  return formatNumber(kind, n);
}

function clientDefaultTaxes(client) {
  let ids = [];
  try {
    ids = JSON.parse(client.default_tax_ids || '[]');
  } catch {
    ids = [];
  }
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT * FROM tax_rates WHERE id IN (${ids.map(() => '?').join(',')}) AND archived = 0`)
    .all(...ids);
  return ids
    .map((id) => rows.find((r) => r.id === Number(id)))
    .filter(Boolean)
    .map((r) => ({ tax_rate_id: r.id, name: r.name, rate: r.rate, reg_number: r.reg_number }));
}

function createDocument(kind, clientId, extra = {}) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new Error('Client not found');
  const s = settings.getAll();
  const issueDate = today();
  const terms = client.payment_terms_days ?? Number(s.payment_terms_days);
  const dueDate =
    kind === 'invoice' ? addDays(issueDate, terms) : addDays(issueDate, Number(s.estimate_valid_days) || 30);

  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO documents (kind, number, client_id, status, subject, issue_date, due_date, currency,
          notes, terms, public_token)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kind,
        takeNextNumber(kind),
        client.id,
        extra.subject || '',
        issueDate,
        dueDate,
        client.currency || s.default_currency,
        kind === 'invoice' ? s.default_invoice_notes : s.default_estimate_notes,
        kind === 'invoice' ? s.default_invoice_terms : '',
        randomToken(),
      );
    const id = Number(info.lastInsertRowid);
    replaceTaxes(id, clientDefaultTaxes(client));
    logActivity(id, `${kind === 'invoice' ? 'Invoice' : 'Estimate'} created`);
    recalc(id);
    return id;
  })();
}

function replaceLines(documentId, lines) {
  db.prepare('DELETE FROM line_items WHERE document_id = ?').run(documentId);
  const insert = db.prepare(
    `INSERT INTO line_items (document_id, position, item_date, project_id, kind, description, quantity,
      unit_price_cents, taxable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  lines.forEach((l, i) =>
    insert.run(
      documentId,
      i,
      l.item_date || null,
      l.project_id || null,
      l.kind || 'Service',
      l.description || '',
      Number(l.quantity) || 0,
      Math.round(Number(l.unit_price_cents) || 0),
      l.taxable === undefined || Number(l.taxable) ? 1 : 0,
    ),
  );
}

function replaceTaxes(documentId, taxes) {
  db.prepare('DELETE FROM document_taxes WHERE document_id = ?').run(documentId);
  const insert = db.prepare(
    `INSERT INTO document_taxes (document_id, position, tax_rate_id, name, rate, reg_number, fixed_amount_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  taxes.forEach((t, i) =>
    insert.run(
      documentId,
      i,
      t.tax_rate_id || null,
      t.name || 'Tax',
      Number(t.rate) || 0,
      t.reg_number || '',
      t.fixed_amount_cents ?? null,
    ),
  );
}

function addLine(documentId, line) {
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM line_items WHERE document_id = ?').get(documentId).p;
  db.prepare(
    `INSERT INTO line_items (document_id, position, item_date, project_id, kind, description, quantity,
      unit_price_cents, taxable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    documentId,
    pos,
    line.item_date || null,
    line.project_id || null,
    line.kind || 'Service',
    line.description || '',
    Number(line.quantity) || 0,
    Math.round(Number(line.unit_price_cents) || 0),
    line.taxable === undefined || Number(line.taxable) ? 1 : 0,
  );
  recalc(documentId);
}

// Recomputes cached totals and, for invoices, the payment-driven status.
function recalc(documentId) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!doc) return;
  const lines = db.prepare('SELECT * FROM line_items WHERE document_id = ? ORDER BY position, id').all(documentId);
  const taxes = db.prepare('SELECT * FROM document_taxes WHERE document_id = ? ORDER BY position, id').all(documentId);
  const t = computeTotals(lines, taxes, doc.discount_percent);
  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE document_id = ?').get(documentId).s;

  let status = doc.status;
  let paidAt = doc.paid_at;
  if (doc.kind === 'invoice' && status !== 'draft' && status !== 'void') {
    if (paid > 0 && paid >= t.total) {
      status = 'paid';
      if (!paidAt) {
        const last = db.prepare('SELECT MAX(paid_date) AS d FROM payments WHERE document_id = ?').get(documentId);
        paidAt = last.d || today();
      }
    } else {
      status = paid > 0 ? 'partial' : 'sent';
      paidAt = null;
    }
  }

  db.prepare(
    `UPDATE documents SET subtotal_cents = ?, discount_cents = ?, tax_cents = ?, total_cents = ?, paid_cents = ?,
       status = ?, paid_at = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(t.subtotal, t.discount, t.tax, t.total, paid, status, paidAt, documentId);
}

function decorate(doc) {
  if (!doc) return doc;
  doc.balance_cents = doc.total_cents - doc.paid_cents;
  doc.is_overdue =
    doc.kind === 'invoice' &&
    (doc.status === 'sent' || doc.status === 'partial') &&
    !!doc.due_date &&
    doc.due_date < today() &&
    doc.balance_cents > 0;
  doc.display_status = doc.is_overdue ? 'overdue' : doc.status === 'draft' && doc.auto_send_on ? 'scheduled' : doc.status;
  doc.is_editable = doc.status === 'draft' || doc.status === 'sent' || doc.status === 'partial';
  return doc;
}

function getDocument(id) {
  const doc = db
    .prepare(
      `SELECT d.*, c.name AS client_name FROM documents d JOIN clients c ON c.id = d.client_id WHERE d.id = ?`,
    )
    .get(id);
  if (!doc) return null;
  return loadDetail(doc);
}

function getByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const doc = db
    .prepare(
      `SELECT d.*, c.name AS client_name FROM documents d JOIN clients c ON c.id = d.client_id WHERE d.public_token = ?`,
    )
    .get(token);
  return doc ? loadDetail(doc) : null;
}

function loadDetail(doc) {
  doc.client = db.prepare('SELECT * FROM clients WHERE id = ?').get(doc.client_id);
  doc.lines = db
    .prepare(
      `SELECT li.*, p.name AS project_name FROM line_items li LEFT JOIN projects p ON p.id = li.project_id
       WHERE li.document_id = ? ORDER BY li.position, li.id`,
    )
    .all(doc.id);
  doc.taxes = db.prepare('SELECT * FROM document_taxes WHERE document_id = ? ORDER BY position, id').all(doc.id);
  const t = computeTotals(doc.lines, doc.taxes, doc.discount_percent);
  doc.lines.forEach((l, i) => (l.amount_cents = t.lineAmounts[i]));
  doc.taxes.forEach((tx, i) => (tx.amount_cents = t.taxAmounts[i]));
  doc.payments = db.prepare('SELECT * FROM payments WHERE document_id = ? ORDER BY paid_date, id').all(doc.id);
  doc.activity = db.prepare('SELECT * FROM activity WHERE document_id = ? ORDER BY id DESC').all(doc.id);
  doc.emails = db.prepare('SELECT * FROM email_log WHERE document_id = ? ORDER BY id DESC').all(doc.id);
  doc.has_dates = doc.lines.some((l) => l.item_date);
  return decorate(doc);
}

function listDocuments(kind, filters = {}) {
  const where = ['d.kind = ?'];
  const params = [kind];
  if (filters.client_id) {
    where.push('d.client_id = ?');
    params.push(filters.client_id);
  }
  if (filters.year) {
    where.push("substr(d.issue_date, 1, 4) = ?");
    params.push(String(filters.year));
  }
  if (filters.status === 'overdue') {
    where.push("d.status IN ('sent','partial') AND d.due_date < ? AND d.total_cents > d.paid_cents");
    params.push(today());
  } else if (filters.status === 'outstanding') {
    where.push("d.status IN ('sent','partial')");
  } else if (filters.status) {
    where.push('d.status = ?');
    params.push(filters.status);
  }
  if (filters.q) {
    where.push('(d.number LIKE ? OR d.subject LIKE ? OR c.name LIKE ?)');
    const q = `%${filters.q}%`;
    params.push(q, q, q);
  }
  return db
    .prepare(
      `SELECT d.*, c.name AS client_name FROM documents d JOIN clients c ON c.id = d.client_id
       WHERE ${where.join(' AND ')} ORDER BY d.issue_date DESC, d.id DESC`,
    )
    .all(...params)
    .map(decorate);
}

function updateDocument(id, fields, lines, taxes) {
  db.transaction(() => {
    db.prepare(
      `UPDATE documents SET number = ?, client_id = ?, subject = ?, po_number = ?, issue_date = ?, due_date = ?,
         currency = ?, discount_percent = ?, notes = ?, terms = ? WHERE id = ?`,
    ).run(
      fields.number,
      fields.client_id,
      fields.subject,
      fields.po_number,
      fields.issue_date,
      fields.due_date || null,
      fields.currency,
      fields.discount_percent,
      fields.notes,
      fields.terms,
      id,
    );
    replaceLines(id, lines);
    replaceTaxes(id, taxes);
    recalc(id);
  })();
}

function markSent(id) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!doc) return;
  if (doc.status === 'draft') {
    db.prepare("UPDATE documents SET status = 'sent', sent_at = COALESCE(sent_at, datetime('now')), auto_send_on = NULL WHERE id = ?").run(id);
  } else {
    db.prepare("UPDATE documents SET sent_at = COALESCE(sent_at, datetime('now')) WHERE id = ?").run(id);
  }
  recalc(id);
}

function revertToDraft(id) {
  db.prepare("UPDATE documents SET status = 'draft', voided_at = NULL WHERE id = ?").run(id);
  recalc(id);
  logActivity(id, 'Marked as draft');
}

function voidInvoice(id) {
  db.prepare("UPDATE documents SET status = 'void', voided_at = datetime('now') WHERE id = ? AND kind = 'invoice'").run(id);
  logActivity(id, 'Invoice voided');
}

function deleteDocument(id) {
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
}

function addPayment(documentId, p) {
  const info = db
    .prepare(
      `INSERT INTO payments (document_id, amount_cents, paid_date, method, reference, notes, stripe_session_id, harvest_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      documentId,
      p.amount_cents,
      p.paid_date || today(),
      p.method || 'other',
      p.reference || '',
      p.notes || '',
      p.stripe_session_id || null,
      p.harvest_id || null,
    );
  recalc(documentId);
  return Number(info.lastInsertRowid);
}

function deletePayment(documentId, paymentId) {
  db.prepare('DELETE FROM payments WHERE id = ? AND document_id = ?').run(paymentId, documentId);
  recalc(documentId);
}

function duplicate(id) {
  const src = getDocument(id);
  if (!src) throw new Error('Not found');
  const newId = createDocument(src.kind, src.client_id, { subject: src.subject });
  db.transaction(() => {
    db.prepare(
      'UPDATE documents SET po_number = ?, currency = ?, discount_percent = ?, notes = ?, terms = ? WHERE id = ?',
    ).run(src.po_number, src.currency, src.discount_percent, src.notes, src.terms, newId);
    replaceLines(newId, src.lines.map((l) => ({ ...l, item_date: null })));
    replaceTaxes(newId, src.taxes.map((t) => ({ ...t, fixed_amount_cents: null })));
    recalc(newId);
  })();
  logActivity(newId, `Copied from ${src.number}`);
  return newId;
}

function convertEstimateToInvoice(estimateId) {
  const est = getDocument(estimateId);
  if (!est || est.kind !== 'estimate') throw new Error('Estimate not found');
  if (est.converted_invoice_id) return est.converted_invoice_id;
  const invoiceId = createDocument('invoice', est.client_id, { subject: est.subject });
  db.transaction(() => {
    db.prepare(
      'UPDATE documents SET po_number = ?, currency = ?, discount_percent = ?, source_estimate_id = ? WHERE id = ?',
    ).run(est.po_number, est.currency, est.discount_percent, est.id, invoiceId);
    replaceLines(invoiceId, est.lines);
    replaceTaxes(invoiceId, est.taxes.map((t) => ({ ...t, fixed_amount_cents: null })));
    recalc(invoiceId);
    db.prepare("UPDATE documents SET status = 'invoiced', converted_invoice_id = ? WHERE id = ?").run(invoiceId, est.id);
  })();
  const inv = db.prepare('SELECT number FROM documents WHERE id = ?').get(invoiceId);
  logActivity(est.id, `Converted to invoice ${inv.number}`);
  logActivity(invoiceId, `Created from estimate ${est.number}`);
  return invoiceId;
}

function setEstimateResponse(id, accepted) {
  if (accepted) {
    db.prepare("UPDATE documents SET status = 'accepted', accepted_at = datetime('now'), declined_at = NULL WHERE id = ?").run(id);
  } else {
    db.prepare("UPDATE documents SET status = 'declined', declined_at = datetime('now'), accepted_at = NULL WHERE id = ?").run(id);
  }
}

module.exports = {
  INVOICE_STATUSES,
  ESTIMATE_STATUSES,
  PAYMENT_METHODS,
  logActivity,
  peekNextNumber,
  takeNextNumber,
  createDocument,
  replaceLines,
  replaceTaxes,
  addLine,
  recalc,
  getDocument,
  getByToken,
  listDocuments,
  updateDocument,
  markSent,
  revertToDraft,
  voidInvoice,
  deleteDocument,
  addPayment,
  deletePayment,
  duplicate,
  convertEstimateToInvoice,
  setEstimateResponse,
};
