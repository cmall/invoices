'use strict';
// One-time import from Harvest (API v2) of clients, contacts, projects, invoices (with payments) and estimates.
// Create a Personal Access Token at https://id.getharvest.com/developers to get the token and account ID.
const db = require('./db');
const settings = require('./settings');
const documents = require('./documents');
const { randomToken } = require('./util');

const API = process.env.HARVEST_API_URL || 'https://api.harvestapp.com/v2';

const cents = (n) => Math.round((Number(n) || 0) * 100);
const sqliteTime = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) : null);

async function fetchAll(path, key, auth) {
  const out = [];
  let url = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=2000`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Harvest-Account-Id': String(auth.accountId),
        'User-Agent': 'Invoices (self-hosted invoicing app)',
        Accept: 'application/json',
      },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 15);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Harvest ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    out.push(...(body[key] || []));
    url = body.links && body.links.next;
  }
  return out;
}

function mapInvoiceStatus(inv) {
  if (inv.state === 'draft') return 'draft';
  if (inv.state === 'closed' && Number(inv.due_amount) > 0) return 'void';
  return 'sent'; // recalc() turns this into partial/paid from the imported payments
}

function insertDocument(kind, h, clientId, status, taxNames, projectMap) {
  const info = db
    .prepare(
      `INSERT INTO documents (kind, number, client_id, status, subject, po_number, issue_date, due_date, currency,
         discount_percent, notes, public_token, sent_at, accepted_at, declined_at, harvest_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      kind,
      String(h.number || h.id),
      clientId,
      status,
      h.subject || '',
      h.purchase_order || '',
      h.issue_date,
      kind === 'invoice' ? h.due_date || null : null,
      h.currency || 'USD',
      Number(h.discount) || 0,
      h.notes || '',
      randomToken(),
      sqliteTime(h.sent_at),
      sqliteTime(h.accepted_at),
      sqliteTime(h.declined_at),
      h.id,
    );
  const id = Number(info.lastInsertRowid);
  documents.replaceLines(
    id,
    (h.line_items || []).map((l) => ({
      project_id: l.project ? projectMap.get(l.project.id) || null : null,
      kind: l.kind || 'Service',
      description: l.description || '',
      quantity: Number(l.quantity) || 0,
      unit_price_cents: cents(l.unit_price),
      taxable: l.taxed || l.taxed2 ? 1 : 0,
    })),
  );
  const taxes = [];
  if (h.tax) taxes.push({ name: taxNames[0], rate: Number(h.tax), fixed_amount_cents: cents(h.tax_amount) });
  if (h.tax2) taxes.push({ name: taxNames[1], rate: Number(h.tax2), fixed_amount_cents: cents(h.tax2_amount) });
  documents.replaceTaxes(id, taxes);
  return id;
}

async function runImport({ token, accountId, taxName1 = 'Tax', taxName2 = 'Tax 2', continueNumbering = false, log = () => {} }) {
  const auth = { token: String(token).trim(), accountId: String(accountId).trim() };
  const result = { clients: 0, projects: 0, invoices: 0, estimates: 0, payments: 0, skipped: 0, warnings: [] };
  const taxNames = [taxName1 || 'Tax', taxName2 || 'Tax 2'];

  log('Fetching clients, contacts and projects…');
  const [hClients, hContacts, hProjects] = await Promise.all([
    fetchAll('/clients', 'clients', auth),
    fetchAll('/contacts', 'contacts', auth),
    fetchAll('/projects', 'projects', auth),
  ]);
  log('Fetching invoices and estimates…');
  const hInvoices = await fetchAll('/invoices', 'invoices', auth);
  const hEstimates = await fetchAll('/estimates', 'estimates', auth).catch((err) => {
    result.warnings.push(`Estimates not imported: ${err.message}`);
    return [];
  });

  // Payments need one request per invoice; only fetch where something was paid.
  const paymentsByInvoice = new Map();
  for (const inv of hInvoices) {
    if (cents(inv.amount) - cents(inv.due_amount) > 0) {
      paymentsByInvoice.set(inv.id, await fetchAll(`/invoices/${inv.id}/payments`, 'invoice_payments', auth));
    }
  }

  log('Saving…');
  db.transaction(() => {
    const clientMap = new Map(db.prepare('SELECT harvest_id, id FROM clients WHERE harvest_id IS NOT NULL').all().map((r) => [r.harvest_id, r.id]));
    for (const c of hClients) {
      if (clientMap.has(c.id)) {
        result.skipped++;
        continue;
      }
      const contact = hContacts.find((k) => k.client && k.client.id === c.id && k.email) || hContacts.find((k) => k.client && k.client.id === c.id);
      const ccs = hContacts
        .filter((k) => k.client && k.client.id === c.id && k.email && k !== contact)
        .map((k) => k.email);
      const info = db
        .prepare(
          `INSERT INTO clients (name, contact_name, email, cc_emails, address, currency, archived, harvest_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.name,
          contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '',
          contact?.email || '',
          ccs.join(', '),
          c.address || '',
          c.currency || settings.get('default_currency'),
          c.is_active ? 0 : 1,
          c.id,
        );
      clientMap.set(c.id, Number(info.lastInsertRowid));
      result.clients++;
    }

    const projectMap = new Map(db.prepare('SELECT harvest_id, id FROM projects WHERE harvest_id IS NOT NULL').all().map((r) => [r.harvest_id, r.id]));
    for (const p of hProjects) {
      if (projectMap.has(p.id)) {
        result.skipped++;
        continue;
      }
      const clientId = p.client && clientMap.get(p.client.id);
      if (!clientId) continue;
      const info = db
        .prepare('INSERT INTO projects (client_id, name, code, hourly_rate_cents, archived, harvest_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(clientId, p.name, p.code || '', p.hourly_rate != null ? cents(p.hourly_rate) : null, p.is_active ? 0 : 1, p.id);
      projectMap.set(p.id, Number(info.lastInsertRowid));
      result.projects++;
    }

    const existsDoc = db.prepare('SELECT 1 FROM documents WHERE kind = ? AND (harvest_id = ? OR number = ?)');
    for (const inv of hInvoices) {
      const clientId = inv.client && clientMap.get(inv.client.id);
      if (!clientId) {
        result.warnings.push(`Invoice ${inv.number}: client not found, skipped`);
        continue;
      }
      if (existsDoc.get('invoice', inv.id, String(inv.number || inv.id))) {
        result.skipped++;
        continue;
      }
      const id = insertDocument('invoice', inv, clientId, mapInvoiceStatus(inv), taxNames, projectMap);
      for (const p of paymentsByInvoice.get(inv.id) || []) {
        db.prepare(
          `INSERT OR IGNORE INTO payments (document_id, amount_cents, paid_date, method, reference, notes, harvest_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          cents(p.amount),
          p.paid_date || (p.paid_at || '').slice(0, 10) || inv.issue_date,
          p.payment_gateway && p.payment_gateway.name ? 'stripe' : 'other',
          p.payment_gateway?.name || '',
          p.notes || '',
          p.id,
        );
        result.payments++;
      }
      documents.recalc(id);
      if (inv.paid_date) db.prepare('UPDATE documents SET paid_at = ? WHERE id = ? AND status = ?').run(inv.paid_date, id, 'paid');
      documents.logActivity(id, 'Imported from Harvest');
      const d = db.prepare('SELECT total_cents FROM documents WHERE id = ?').get(id);
      if (Math.abs(d.total_cents - cents(inv.amount)) > 1) {
        result.warnings.push(`Invoice ${inv.number}: total differs from Harvest (${cents(inv.amount) / 100} vs ${d.total_cents / 100})`);
      }
      result.invoices++;
    }

    const estimateStatus = { draft: 'draft', sent: 'sent', accepted: 'accepted', declined: 'declined' };
    for (const est of hEstimates) {
      const clientId = est.client && clientMap.get(est.client.id);
      if (!clientId) continue;
      if (existsDoc.get('estimate', est.id, String(est.number || est.id))) {
        result.skipped++;
        continue;
      }
      const id = insertDocument('estimate', est, clientId, estimateStatus[est.state] || 'draft', taxNames, projectMap);
      documents.recalc(id);
      documents.logActivity(id, 'Imported from Harvest');
      result.estimates++;
    }

    if (continueNumbering) {
      for (const [kind, list] of [['invoice', hInvoices], ['estimate', hEstimates]]) {
        const nums = list.map((d) => Number(d.number)).filter((n) => Number.isInteger(n));
        if (nums.length) {
          settings.set(`${kind}_prefix`, '');
          settings.set(`${kind}_next_number`, Math.max(...nums) + 1);
        }
      }
    }
  })();

  return result;
}

module.exports = { runImport };
