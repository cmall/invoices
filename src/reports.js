'use strict';
const db = require('./db');
const { computeTotals } = require('./calc');

function years() {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(issue_date, 1, 4) AS y FROM documents WHERE kind = 'invoice'
       UNION SELECT DISTINCT substr(paid_date, 1, 4) FROM payments ORDER BY 1 DESC`,
    )
    .all();
  return rows.map((r) => r.y).filter(Boolean);
}

function bucket(map, key, init) {
  if (!map.has(key)) map.set(key, init());
  return map.get(key);
}

// business: '' = all, 'main' = the main business, or a business id.
function businessWhere(business, alias = 'd') {
  if (business === 'main') return { sql: ` AND ${alias}.business_id IS NULL`, params: [] };
  if (Number(business)) return { sql: ` AND ${alias}.business_id = ?`, params: [Number(business)] };
  return { sql: '', params: [] };
}

function yearReport(year, business = '') {
  const y = String(year);
  const bw = businessWhere(business);
  const invoices = db
    .prepare(
      `SELECT d.*, c.name AS client_name FROM documents d JOIN clients c ON c.id = d.client_id
       WHERE d.kind = 'invoice' AND d.status NOT IN ('draft','void') AND substr(d.issue_date, 1, 4) = ?${bw.sql}
       ORDER BY d.issue_date, d.id`,
    )
    .all(y, ...bw.params);

  const taxStmt = db.prepare('SELECT * FROM document_taxes WHERE document_id = ? ORDER BY position, id');
  const lineStmt = db.prepare('SELECT quantity, unit_price_cents, taxable FROM line_items WHERE document_id = ?');

  // Accrual basis: everything invoiced in the year.
  const byCurrency = new Map();
  const taxes = new Map();
  const clients = new Map();
  const months = new Map();
  for (const inv of invoices) {
    const cur = bucket(byCurrency, inv.currency, () => ({ count: 0, subtotal: 0, discount: 0, tax: 0, total: 0, paid: 0 }));
    cur.count++;
    cur.subtotal += inv.subtotal_cents;
    cur.discount += inv.discount_cents;
    cur.tax += inv.tax_cents;
    cur.total += inv.total_cents;
    cur.paid += inv.paid_cents;

    const t = computeTotals(lineStmt.all(inv.id), taxStmt.all(inv.id), inv.discount_percent);
    taxStmt.all(inv.id).forEach((tx, i) => {
      const k = `${inv.currency}|${tx.name}|${tx.rate}|${tx.reg_number}`;
      const b = bucket(taxes, k, () => ({ currency: inv.currency, name: tx.name, rate: tx.rate, reg_number: tx.reg_number, taxable: 0, amount: 0 }));
      b.taxable += t.taxableBase;
      b.amount += t.taxAmounts[i];
    });

    const cl = bucket(clients, `${inv.client_id}|${inv.currency}`, () => ({ name: inv.client_name, currency: inv.currency, count: 0, total: 0, paid: 0 }));
    cl.count++;
    cl.total += inv.total_cents;
    cl.paid += inv.paid_cents;

    const m = bucket(months, `${inv.issue_date.slice(0, 7)}|${inv.currency}`, () => ({ month: inv.issue_date.slice(0, 7), currency: inv.currency, invoiced: 0, collected: 0 }));
    m.invoiced += inv.total_cents;
  }

  // Cash basis: payments received in the year, with the tax share of each payment.
  const payments = db
    .prepare(
      `SELECT p.*, d.number, d.currency, d.total_cents, d.tax_cents, d.id AS doc_id, d.business_id, c.name AS client_name
       FROM payments p JOIN documents d ON d.id = p.document_id JOIN clients c ON c.id = d.client_id
       WHERE substr(p.paid_date, 1, 4) = ?${bw.sql} ORDER BY p.paid_date, p.id`,
    )
    .all(y, ...bw.params);
  const collected = new Map();
  const cashTaxes = new Map();
  for (const p of payments) {
    const cur = bucket(collected, p.currency, () => ({ count: 0, amount: 0, tax: 0 }));
    cur.count++;
    cur.amount += p.amount_cents;
    const share = p.total_cents > 0 ? p.amount_cents / p.total_cents : 0;
    const docTaxes = taxStmt.all(p.doc_id);
    const t = computeTotals(lineStmt.all(p.doc_id), docTaxes, db.prepare('SELECT discount_percent FROM documents WHERE id = ?').get(p.doc_id).discount_percent);
    docTaxes.forEach((tx, i) => {
      const amt = Math.round(t.taxAmounts[i] * share);
      cur.tax += amt;
      const b = bucket(cashTaxes, `${p.currency}|${tx.name}|${tx.rate}|${tx.reg_number}`, () => ({ currency: p.currency, name: tx.name, rate: tx.rate, reg_number: tx.reg_number, amount: 0 }));
      b.amount += amt;
    });
    const m = bucket(months, `${p.paid_date.slice(0, 7)}|${p.currency}`, () => ({ month: p.paid_date.slice(0, 7), currency: p.currency, invoiced: 0, collected: 0 }));
    m.collected += p.amount_cents;
  }

  // Totals per business (invoiced on issue date, collected on payment date).
  const byBusiness = new Map();
  const bizName = (id) => require('./businesses').nameOf(id);
  for (const inv of invoices) {
    const b = bucket(byBusiness, `${inv.business_id || 0}|${inv.currency}`, () => ({ name: bizName(inv.business_id), currency: inv.currency, count: 0, total: 0, tax: 0, collected: 0 }));
    b.count++;
    b.total += inv.total_cents;
    b.tax += inv.tax_cents;
  }
  for (const p of payments) {
    const b = bucket(byBusiness, `${p.business_id || 0}|${p.currency}`, () => ({ name: bizName(p.business_id), currency: p.currency, count: 0, total: 0, tax: 0, collected: 0 }));
    b.collected += p.amount_cents;
  }

  const sortBy = (arr, f) => arr.sort((a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0));
  return {
    year: y,
    invoices,
    payments,
    byCurrency: [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v })),
    taxes: sortBy([...taxes.values()], (t) => `${t.currency}${t.name}`),
    collected: [...collected.entries()].map(([currency, v]) => ({ currency, ...v })),
    cashTaxes: sortBy([...cashTaxes.values()], (t) => `${t.currency}${t.name}`),
    clients: [...clients.values()].sort((a, b) => b.total - a.total),
    months: sortBy([...months.values()], (m) => `${m.month}${m.currency}`),
    byBusiness: [...byBusiness.values()],
  };
}

function outstanding() {
  return db
    .prepare(
      `SELECT currency, COUNT(*) AS count, SUM(total_cents - paid_cents) AS balance FROM documents
       WHERE kind = 'invoice' AND status IN ('sent','partial') GROUP BY currency`,
    )
    .all();
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function invoicesCsv(year, business = '') {
  const r = yearReport(year, business);
  const bizName = (id) => require('./businesses').nameOf(id);
  const header = ['Number', 'Business', 'Client', 'Subject', 'Issue date', 'Due date', 'Status', 'Currency', 'Subtotal', 'Discount', 'Tax', 'Total', 'Paid', 'Balance'];
  const rows = r.invoices.map((i) => [
    i.number, bizName(i.business_id), i.client_name, i.subject, i.issue_date, i.due_date, i.status, i.currency,
    (i.subtotal_cents / 100).toFixed(2), (i.discount_cents / 100).toFixed(2), (i.tax_cents / 100).toFixed(2),
    (i.total_cents / 100).toFixed(2), (i.paid_cents / 100).toFixed(2), ((i.total_cents - i.paid_cents) / 100).toFixed(2),
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

function paymentsCsv(year, business = '') {
  const r = yearReport(year, business);
  const bizName = (id) => require('./businesses').nameOf(id);
  const header = ['Date', 'Business', 'Invoice', 'Client', 'Currency', 'Amount', 'Method', 'Reference'];
  const rows = r.payments.map((p) => [p.paid_date, bizName(p.business_id), p.number, p.client_name, p.currency, (p.amount_cents / 100).toFixed(2), p.method, p.reference]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

module.exports = { years, yearReport, outstanding, invoicesCsv, paymentsCsv };
