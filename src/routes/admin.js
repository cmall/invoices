'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const settings = require('../settings');
const documents = require('../documents');
const email = require('../email');
const reminders = require('../reminders');
const reports = require('../reports');
const harvest = require('../harvest');
const updater = require('../updater');
const recurring = require('../recurring');
const businesses = require('../businesses');
const receipts = require('../receipts');
const { renderPdf, pdfFilename, publicUrl, renderReceiptPdf, receiptFilename } = require('../pdf');
const {
  CURRENCIES,
  parseMoney,
  parseNumber,
  today,
  isIsoDate,
  formatMoney,
  splitEmails,
} = require('../util');

const router = express.Router();
const q = (s) => encodeURIComponent(s);

// ---------- Login ----------

router.get('/login', (req, res) => {
  if (req.sessionId) return res.redirect('/');
  res.render('login', { title: 'Log in', error: '', next: String(req.query.next || '/'), setupNeeded: !config.adminPasswordHash });
});

router.post('/login', (req, res) => {
  const ip = req.ip;
  const next = String(req.body.next || '/');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const fail = (error) =>
    res.status(401).render('login', { title: 'Log in', error, next: safeNext, setupNeeded: !config.adminPasswordHash });
  if (!auth.loginAllowed(ip)) return fail('Too many attempts. Try again in 15 minutes.');
  if (!auth.checkLogin(req.body.email, req.body.password)) {
    auth.recordFailure(ip);
    return fail('Email or password is incorrect.');
  }
  auth.clearFailures(ip);
  auth.createSession(res);
  res.redirect(safeNext);
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.redirect('/login');
});

// Everything below requires login. Multipart forms check CSRF after multer parses them.
router.use(auth.requireAuth);
router.use((req, res, next) => (req.is('multipart/form-data') ? next() : auth.checkCsrf(req, res, next)));

// "Bill from" choices for every page; pickers only appear once you add a second business.
router.use((req, res, next) => {
  res.locals.businessChoices = businesses.choices();
  res.locals.multiBusiness = res.locals.businessChoices.length > 1;
  next();
});

// Form value -> business id: 'main' = main business (null), a number = that business,
// blank/absent = undefined (keep the default, e.g. the client's business).
function businessField(v) {
  if (v === undefined || v === '') return undefined;
  if (v === 'main') return null;
  const b = businesses.get(Number(v));
  return b ? b.id : undefined;
}

// ---------- Dashboard ----------

router.get('/', (req, res) => {
  const staged = recurring.stagedInvoices();
  const stagedIds = new Set(staged.map((d) => d.id));
  const drafts = documents.listDocuments('invoice', { status: 'draft' }).filter((d) => !stagedIds.has(d.id));
  const outstandingInvoices = documents.listDocuments('invoice', { status: 'outstanding' });
  const openEstimates = documents.listDocuments('estimate', { status: 'sent' });
  const recentPayments = db
    .prepare(
      `SELECT p.*, d.number, d.currency, d.id AS doc_id, c.name AS client_name FROM payments p
       JOIN documents d ON d.id = p.document_id JOIN clients c ON c.id = d.client_id
       ORDER BY p.paid_date DESC, p.id DESC LIMIT 8`,
    )
    .all();
  const year = today().slice(0, 4);
  const yr = reports.yearReport(year);
  const projects = activeProjects();
  const needsSetup = !settings.get('business_name') || !settings.get('from_email');
  res.render('dashboard', {
    title: 'Dashboard',
    drafts,
    staged,
    outstandingInvoices,
    openEstimates,
    recentPayments,
    outstanding: reports.outstanding(),
    yr,
    year,
    projects,
    needsSetup,
  });
});

// ---------- Clients ----------

function activeProjects(clientId) {
  return db
    .prepare(
      `SELECT p.*, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id
       WHERE p.archived = 0 ${clientId ? 'AND p.client_id = ?' : ''} ORDER BY c.name, p.name`,
    )
    .all(...(clientId ? [clientId] : []));
}

function taxRates(includeArchived = false) {
  return db.prepare(`SELECT * FROM tax_rates ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY archived, name`).all();
}

function clientFromBody(b) {
  const terms = String(b.payment_terms_days ?? '').trim();
  const taxIds = [].concat(b.default_tax_ids || []).map(Number).filter(Boolean);
  return {
    name: String(b.name || '').trim(),
    contact_name: String(b.contact_name || '').trim(),
    email: String(b.email || '').trim(),
    cc_emails: splitEmails(b.cc_emails).join(', '),
    address: String(b.address || '').trim(),
    currency: CURRENCIES.includes(b.currency) ? b.currency : settings.get('default_currency'),
    payment_terms_days: terms === '' ? null : Math.max(0, Math.round(Number(terms) || 0)),
    default_tax_ids: JSON.stringify(taxIds),
    notes: String(b.notes || ''),
    business_id: businessField(b.business_id) ?? null,
  };
}

router.get('/clients', (req, res) => {
  const showArchived = req.query.archived === '1';
  const clients = db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id AND d.kind = 'invoice') AS invoice_count,
         (SELECT COALESCE(SUM(total_cents - paid_cents), 0) FROM documents d
            WHERE d.client_id = c.id AND d.kind = 'invoice' AND d.status IN ('sent','partial')) AS balance_cents
       FROM clients c WHERE c.archived = ? ORDER BY c.name COLLATE NOCASE`,
    )
    .all(showArchived ? 1 : 0);
  res.render('clients/index', { title: 'Clients', clients, showArchived });
});

router.get('/clients/new', (req, res) => {
  res.render('clients/form', {
    title: 'New client',
    client: { currency: settings.get('default_currency'), default_tax_ids: '[]' },
    taxRates: taxRates(),
    currencies: CURRENCIES,
  });
});

router.post('/clients', (req, res) => {
  const c = clientFromBody(req.body);
  if (!c.name) return res.redirect(`/clients/new?err=${q('Name is required')}`);
  const info = db
    .prepare(
      `INSERT INTO clients (name, contact_name, email, cc_emails, address, currency, payment_terms_days, default_tax_ids, notes, business_id)
       VALUES (@name, @contact_name, @email, @cc_emails, @address, @currency, @payment_terms_days, @default_tax_ids, @notes, @business_id)`,
    )
    .run(c);
  res.redirect(`/clients/${info.lastInsertRowid}?msg=${q('Client added')}`);
});

function loadClient(req, res, next) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).render('error', { title: 'Not found', message: 'Client not found.' });
  req.client = client;
  next();
}

router.get('/clients/:id', loadClient, (req, res) => {
  const projects = db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY archived, name').all(req.client.id);
  res.render('clients/show', {
    title: req.client.name,
    client: req.client,
    projects,
    invoices: documents.listDocuments('invoice', { client_id: req.client.id }),
    estimates: documents.listDocuments('estimate', { client_id: req.client.id }),
    taxRates: taxRates(true),
  });
});

router.get('/clients/:id/edit', loadClient, (req, res) => {
  res.render('clients/form', { title: `Edit ${req.client.name}`, client: req.client, taxRates: taxRates(), currencies: CURRENCIES });
});

router.post('/clients/:id', loadClient, (req, res) => {
  const c = clientFromBody(req.body);
  if (!c.name) return res.redirect(`/clients/${req.client.id}/edit?err=${q('Name is required')}`);
  db.prepare(
    `UPDATE clients SET name = @name, contact_name = @contact_name, email = @email, cc_emails = @cc_emails, address = @address,
       currency = @currency, payment_terms_days = @payment_terms_days, default_tax_ids = @default_tax_ids, notes = @notes,
       business_id = @business_id
     WHERE id = @id`,
  ).run({ ...c, id: req.client.id });
  res.redirect(`/clients/${req.client.id}?msg=${q('Client saved')}`);
});

router.post('/clients/:id/archive', loadClient, (req, res) => {
  const archived = req.client.archived ? 0 : 1;
  db.prepare('UPDATE clients SET archived = ? WHERE id = ?').run(archived, req.client.id);
  res.redirect(`/clients/${req.client.id}?msg=${q(archived ? 'Client archived' : 'Client restored')}`);
});

router.post('/clients/:id/delete', loadClient, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE client_id = ?').get(req.client.id).n;
  if (count) return res.redirect(`/clients/${req.client.id}?err=${q('This client has invoices or estimates. Archive it instead.')}`);
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.client.id);
  res.redirect(`/clients?msg=${q('Client deleted')}`);
});

// ---------- Projects ----------

function projectFromBody(b) {
  return {
    name: String(b.name || '').trim(),
    code: String(b.code || '').trim(),
    hourly_rate_cents: parseMoney(b.hourly_rate),
  };
}

router.post('/clients/:id/projects', loadClient, (req, res) => {
  const p = projectFromBody(req.body);
  if (!p.name) return res.redirect(`/clients/${req.client.id}?err=${q('Project name is required')}`);
  db.prepare('INSERT INTO projects (client_id, name, code, hourly_rate_cents) VALUES (?, ?, ?, ?)').run(
    req.client.id,
    p.name,
    p.code,
    p.hourly_rate_cents,
  );
  res.redirect(`/clients/${req.client.id}?msg=${q('Project added')}#projects`);
});

function loadProject(req, res, next) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).render('error', { title: 'Not found', message: 'Project not found.' });
  req.project = project;
  next();
}

router.get('/projects', (req, res) => {
  const projects = db
    .prepare(
      `SELECT p.*, c.name AS client_name, c.currency FROM projects p JOIN clients c ON c.id = p.client_id
       ORDER BY p.archived, c.name COLLATE NOCASE, p.name COLLATE NOCASE`,
    )
    .all();
  const clients = db.prepare('SELECT id, name FROM clients WHERE archived = 0 ORDER BY name COLLATE NOCASE').all();
  res.render('projects/index', { title: 'Projects', projects, clients });
});

router.post('/projects', (req, res) => {
  const p = projectFromBody(req.body);
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.body.client_id);
  if (!p.name || !client) return res.redirect(`/projects?err=${q('Choose a client and enter a project name')}`);
  db.prepare('INSERT INTO projects (client_id, name, code, hourly_rate_cents) VALUES (?, ?, ?, ?)').run(
    client.id,
    p.name,
    p.code,
    p.hourly_rate_cents,
  );
  res.redirect(`/projects?msg=${q('Project added')}`);
});

router.get('/projects/:id/edit', loadProject, (req, res) => {
  const clients = db.prepare('SELECT id, name FROM clients ORDER BY name COLLATE NOCASE').all();
  res.render('projects/form', { title: `Edit ${req.project.name}`, project: req.project, clients });
});

router.post('/projects/:id', loadProject, (req, res) => {
  const p = projectFromBody(req.body);
  const clientId = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.body.client_id)?.id || req.project.client_id;
  if (!p.name) return res.redirect(`/projects/${req.project.id}/edit?err=${q('Name is required')}`);
  db.prepare('UPDATE projects SET client_id = ?, name = ?, code = ?, hourly_rate_cents = ? WHERE id = ?').run(
    clientId,
    p.name,
    p.code,
    p.hourly_rate_cents,
    req.project.id,
  );
  res.redirect(`/clients/${clientId}?msg=${q('Project saved')}#projects`);
});

router.post('/projects/:id/archive', loadProject, (req, res) => {
  db.prepare('UPDATE projects SET archived = ? WHERE id = ?').run(req.project.archived ? 0 : 1, req.project.id);
  res.redirect(`/clients/${req.project.client_id}?msg=${q(req.project.archived ? 'Project restored' : 'Project archived')}#projects`);
});

// ---------- Invoices & estimates ----------

function parseJsonArray(s) {
  try {
    const v = JSON.parse(String(s || '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function linesFromBody(b) {
  return parseJsonArray(b.lines_json)
    .map((l) => ({
      item_date: isIsoDate(l.item_date) ? l.item_date : null,
      project_id: Number(l.project_id) || null,
      kind: String(l.kind || 'Service').slice(0, 40),
      description: String(l.description || ''),
      quantity: parseNumber(l.quantity, 0),
      unit_price_cents: parseMoney(l.unit_price) ?? 0,
      taxable: l.taxable === false || l.taxable === 0 || l.taxable === '0' ? 0 : 1,
    }))
    .filter((l) => l.description.trim() || l.unit_price_cents || l.project_id);
}

function taxesFromBody(b) {
  return parseJsonArray(b.taxes_json)
    .map((t) => ({
      tax_rate_id: Number(t.tax_rate_id) || null,
      name: String(t.name || '').trim() || 'Tax',
      rate: parseNumber(t.rate, 0),
      reg_number: String(t.reg_number || '').trim(),
      fixed_amount_cents: t.fixed_amount_cents === null || t.fixed_amount_cents === undefined ? null : Number(t.fixed_amount_cents),
    }));
}

function documentRoutes(kind) {
  const base = kind === 'invoice' ? '/invoices' : '/estimates';
  const label = kind === 'invoice' ? 'Invoice' : 'Estimate';
  const plural = kind === 'invoice' ? 'Invoices' : 'Estimates';

  const load = (req, res, next) => {
    const doc = documents.getDocument(req.params.id);
    if (!doc || doc.kind !== kind) return res.status(404).render('error', { title: 'Not found', message: `${label} not found.` });
    req.doc = doc;
    next();
  };

  router.get(base, (req, res) => {
    const filters = {
      status: String(req.query.status || ''),
      year: /^\d{4}$/.test(req.query.year || '') ? req.query.year : '',
      client_id: Number(req.query.client_id) || '',
      business: String(req.query.business || ''),
      q: String(req.query.q || '').trim(),
    };
    const docs = documents.listDocuments(kind, filters);
    const totals = {};
    for (const d of docs) {
      if (d.status === 'void' || d.status === 'draft') continue;
      totals[d.currency] = totals[d.currency] || { total: 0, balance: 0 };
      totals[d.currency].total += d.total_cents;
      totals[d.currency].balance += kind === 'invoice' ? d.balance_cents : 0;
    }
    const years = db.prepare('SELECT DISTINCT substr(issue_date,1,4) AS y FROM documents WHERE kind = ? ORDER BY y DESC').all(kind).map((r) => r.y);
    const clients = db.prepare('SELECT id, name FROM clients ORDER BY name COLLATE NOCASE').all();
    res.render('documents/index', { title: plural, kind, base, label, plural, docs, filters, years, clients, totals });
  });

  router.get(`${base}/new`, (req, res) => {
    const clients = db.prepare('SELECT * FROM clients WHERE archived = 0 ORDER BY name COLLATE NOCASE').all();
    res.render('documents/new', { title: `New ${label.toLowerCase()}`, kind, base, label, clients, clientId: Number(req.query.client_id) || '' });
  });

  router.post(base, (req, res) => {
    const clientId = Number(req.body.client_id);
    if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId)) {
      return res.redirect(`${base}/new?err=${q('Choose a client first')}`);
    }
    const id = documents.createDocument(kind, clientId, {
      subject: String(req.body.subject || '').trim(),
      business_id: businessField(req.body.business_id),
    });
    res.redirect(`${base}/${id}/edit`);
  });

  router.get(`${base}/:id`, load, (req, res) => {
    const recurringProfile = req.doc.recurring_id ? db.prepare('SELECT id, name, subject, send_mode FROM recurring WHERE id = ?').get(req.doc.recurring_id) : null;
    res.render('documents/show', {
      recurringProfile,
      biz: businesses.effective(req.doc.business_id),
      businessName: businesses.nameOf(req.doc.business_id),
      title: `${label} ${req.doc.number}`,
      doc: req.doc,
      kind,
      base,
      label,
      publicLink: publicUrl(req.doc),
      projects: activeProjects(req.doc.client_id),
      paymentMethods: documents.PAYMENT_METHODS,
      emailReady: email.isConfigured(),
      today: today(),
    });
  });

  router.get(`${base}/:id/edit`, load, (req, res) => {
    res.render('documents/edit', {
      title: `Edit ${label.toLowerCase()} ${req.doc.number}`,
      doc: req.doc,
      kind,
      base,
      label,
      clients: db.prepare('SELECT id, name, currency FROM clients WHERE archived = 0 OR id = ? ORDER BY name COLLATE NOCASE').all(req.doc.client_id),
      projects: activeProjects(),
      taxRates: taxRates(),
      currencies: CURRENCIES,
    });
  });

  router.post(`${base}/:id`, load, (req, res) => {
    const b = req.body;
    const fields = {
      number: String(b.number || '').trim(),
      client_id: Number(b.client_id) || req.doc.client_id,
      subject: String(b.subject || '').trim(),
      po_number: String(b.po_number || '').trim(),
      issue_date: isIsoDate(b.issue_date) ? b.issue_date : req.doc.issue_date,
      due_date: isIsoDate(b.due_date) ? b.due_date : null,
      currency: CURRENCIES.includes(b.currency) ? b.currency : req.doc.currency,
      discount_percent: Math.min(100, Math.max(0, parseNumber(b.discount_percent, 0))),
      notes: String(b.notes || ''),
      terms: String(b.terms || ''),
      business_id: businessField(b.business_id),
    };
    if (!fields.number) return res.redirect(`${base}/${req.doc.id}/edit?err=${q('Number is required')}`);
    if (req.doc.paid_cents && fields.currency !== req.doc.currency) {
      return res.redirect(`${base}/${req.doc.id}/edit?err=${q('Currency cannot change after payments are recorded')}`);
    }
    try {
      documents.updateDocument(req.doc.id, fields, linesFromBody(b), taxesFromBody(b));
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        return res.redirect(`${base}/${req.doc.id}/edit?err=${q(`${label} number ${fields.number} is already used`)}`);
      }
      throw err;
    }
    const dest = b.after === 'send' ? `${base}/${req.doc.id}/send` : `${base}/${req.doc.id}`;
    res.redirect(`${dest}?msg=${q(`${label} saved`)}`);
  });

  // Quick add a single line, e.g. while work is ongoing on a draft invoice.
  router.post(`${base}/:id/lines`, load, (req, res) => {
    const b = req.body;
    const project = Number(b.project_id) ? db.prepare('SELECT * FROM projects WHERE id = ?').get(b.project_id) : null;
    let price = parseMoney(b.unit_price);
    if (price === null && project && project.hourly_rate_cents != null) price = project.hourly_rate_cents;
    const line = {
      item_date: isIsoDate(b.item_date) ? b.item_date : null,
      project_id: project ? project.id : null,
      kind: String(b.kind || 'Service').slice(0, 40),
      description: String(b.description || '').trim(),
      quantity: parseNumber(b.quantity, 1),
      unit_price_cents: price ?? 0,
      taxable: b.taxable === '0' ? 0 : 1,
    };
    if (!line.description && !line.unit_price_cents) {
      return res.redirect(`${b.return_to === 'dashboard' ? '/' : `${base}/${req.doc.id}`}?err=${q('Enter a description or a price')}`);
    }
    documents.addLine(req.doc.id, line);
    const msg = `Line added to ${req.doc.number}`;
    res.redirect(b.return_to === 'dashboard' ? `/?msg=${q(msg)}` : `${base}/${req.doc.id}?msg=${q(msg)}#lines`);
  });

  router.post(`${base}/:id/lines/:lineId/delete`, load, (req, res) => {
    db.prepare('DELETE FROM line_items WHERE id = ? AND document_id = ?').run(req.params.lineId, req.doc.id);
    documents.recalc(req.doc.id);
    res.redirect(`${base}/${req.doc.id}?msg=${q('Line removed')}#lines`);
  });

  router.get(`${base}/:id/pdf`, load, async (req, res) => {
    const buf = await renderPdf(req.doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${pdfFilename(req.doc)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });

  router.get(`${base}/:id/send`, load, (req, res) => {
    const purpose = req.query.purpose === 'reminder' && kind === 'invoice' ? 'reminder' : kind;
    res.render('documents/send', {
      title: `Send ${label.toLowerCase()} ${req.doc.number}`,
      doc: req.doc,
      kind,
      base,
      label,
      purpose,
      draft: email.defaultsFor(purpose, req.doc),
      emailReady: email.isConfigured(),
    });
  });

  router.post(`${base}/:id/send`, load, async (req, res) => {
    const b = req.body;
    const purpose = b.purpose === 'reminder' && kind === 'invoice' ? 'reminder' : kind;
    if (!req.doc.lines.length) return res.redirect(`${base}/${req.doc.id}/send?err=${q('Add at least one line first')}`);
    // Mark sent first so the attached PDF and public link show the right status.
    const wasDraft = req.doc.status === 'draft';
    if (purpose !== 'reminder') documents.markSent(req.doc.id);
    const doc = documents.getDocument(req.doc.id);
    try {
      await email.sendDocumentEmail(doc, {
        purpose,
        to: b.to,
        cc: b.cc,
        subject: String(b.subject || '').trim() || `${label} ${doc.number}`,
        body: String(b.body || ''),
        attachPdf: b.attach_pdf === '1',
      });
    } catch (err) {
      if (wasDraft) db.prepare("UPDATE documents SET status = 'draft', sent_at = NULL WHERE id = ?").run(doc.id);
      return res.redirect(`${base}/${doc.id}/send?purpose=${purpose}&err=${q(`Email not sent: ${err.message}`)}`);
    }
    if (purpose === 'reminder') {
      db.prepare('UPDATE documents SET reminder_count = reminder_count + 1, last_reminder_at = ? WHERE id = ?').run(today(), doc.id);
      documents.logActivity(doc.id, `Reminder emailed to ${splitEmails(b.to).join(', ')}`);
    } else {
      documents.logActivity(doc.id, `${label} emailed to ${splitEmails(b.to).concat(splitEmails(b.cc)).join(', ')}`);
    }
    res.redirect(`${base}/${doc.id}?msg=${q('Email sent')}`);
  });

  router.post(`${base}/:id/mark-sent`, load, (req, res) => {
    documents.markSent(req.doc.id);
    documents.logActivity(req.doc.id, 'Marked as sent');
    res.redirect(`${base}/${req.doc.id}?msg=${q('Marked as sent')}`);
  });

  router.post(`${base}/:id/revert-draft`, load, (req, res) => {
    documents.revertToDraft(req.doc.id);
    res.redirect(`${base}/${req.doc.id}?msg=${q('Moved back to draft')}`);
  });

  router.post(`${base}/:id/duplicate`, load, (req, res) => {
    const id = documents.duplicate(req.doc.id);
    res.redirect(`${base}/${id}/edit?msg=${q(`Copied from ${req.doc.number}`)}`);
  });

  router.post(`${base}/:id/delete`, load, (req, res) => {
    if (req.doc.payments.length) {
      return res.redirect(`${base}/${req.doc.id}?err=${q('Delete the payments first, or void the invoice instead')}`);
    }
    documents.deleteDocument(req.doc.id);
    res.redirect(`${base}?msg=${q(`${label} ${req.doc.number} deleted`)}`);
  });

  if (kind === 'invoice') {
    router.post(`${base}/:id/void`, load, (req, res) => {
      documents.voidInvoice(req.doc.id);
      res.redirect(`${base}/${req.doc.id}?msg=${q('Invoice voided')}`);
    });

    router.post(`${base}/:id/payments`, load, async (req, res) => {
      const amount = parseMoney(req.body.amount);
      if (!amount || amount <= 0) return res.redirect(`${base}/${req.doc.id}?err=${q('Enter a payment amount')}#payments`);
      if (req.doc.status === 'draft') documents.markSent(req.doc.id);
      const method = documents.PAYMENT_METHODS[req.body.method] ? req.body.method : 'other';
      const paymentId = documents.addPayment(req.doc.id, {
        amount_cents: amount,
        paid_date: isIsoDate(req.body.paid_date) ? req.body.paid_date : today(),
        method,
        reference: String(req.body.reference || '').trim(),
        notes: String(req.body.notes || '').trim(),
      });
      documents.logActivity(req.doc.id, `Payment of ${formatMoney(amount, req.doc.currency)} recorded (${documents.PAYMENT_METHODS[method]})`);
      if (req.body.send_receipt === '1') {
        const doc = documents.getDocument(req.doc.id);
        const payment = doc.payments.find((p) => p.id === paymentId);
        try {
          await receipts.send(doc, payment);
          return res.redirect(`${base}/${req.doc.id}?msg=${q(`Payment recorded and receipt emailed to ${doc.client.email}`)}#payments`);
        } catch (err) {
          return res.redirect(`${base}/${req.doc.id}?err=${q(`Payment recorded, but the receipt was not sent: ${err.message}`)}#payments`);
        }
      }
      res.redirect(`${base}/${req.doc.id}?msg=${q('Payment recorded')}#payments`);
    });

    const loadPayment = (req, res, next) => {
      req.payment = receipts.findPayment(req.doc, req.params.paymentId);
      if (!req.payment) return res.status(404).render('error', { title: 'Not found', message: 'Payment not found.' });
      next();
    };

    router.get(`${base}/:id/payments/:paymentId/receipt.pdf`, load, loadPayment, async (req, res) => {
      const buf = await renderReceiptPdf(req.doc, req.payment);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${receiptFilename(req.doc, req.payment)}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    });

    router.get(`${base}/:id/payments/:paymentId/receipt`, load, loadPayment, (req, res) => {
      res.render('documents/send', {
        title: `Send receipt for ${formatMoney(req.payment.amount_cents, req.doc.currency)}`,
        doc: req.doc,
        kind,
        base,
        label,
        purpose: 'receipt',
        draft: receipts.defaults(req.doc, req.payment),
        emailReady: email.isConfigured(),
        action: `${base}/${req.doc.id}/payments/${req.payment.id}/receipt`,
        pdfLink: `${base}/${req.doc.id}/payments/${req.payment.id}/receipt.pdf`,
        attachLabel: 'Attach receipt PDF',
      });
    });

    router.post(`${base}/:id/payments/:paymentId/receipt`, load, loadPayment, async (req, res) => {
      const b = req.body;
      try {
        await receipts.send(req.doc, req.payment, {
          to: b.to,
          cc: b.cc,
          subject: String(b.subject || '').trim(),
          body: String(b.body || ''),
          attachPdf: b.attach_pdf === '1',
        });
      } catch (err) {
        return res.redirect(`${base}/${req.doc.id}/payments/${req.payment.id}/receipt?err=${q(`Receipt not sent: ${err.message}`)}`);
      }
      res.redirect(`${base}/${req.doc.id}?msg=${q('Receipt sent')}#payments`);
    });

    router.post(`${base}/:id/payments/:paymentId/delete`, load, (req, res) => {
      const p = req.doc.payments.find((x) => x.id === Number(req.params.paymentId));
      if (p) {
        documents.deletePayment(req.doc.id, p.id);
        documents.logActivity(req.doc.id, `Payment of ${formatMoney(p.amount_cents, req.doc.currency)} deleted`);
      }
      res.redirect(`${base}/${req.doc.id}?msg=${q('Payment deleted')}#payments`);
    });
  } else {
    router.post(`${base}/:id/convert`, load, (req, res) => {
      const invoiceId = documents.convertEstimateToInvoice(req.doc.id);
      res.redirect(`/invoices/${invoiceId}/edit?msg=${q(`Invoice created from estimate ${req.doc.number}`)}`);
    });

    router.post(`${base}/:id/mark-accepted`, load, (req, res) => {
      documents.setEstimateResponse(req.doc.id, true);
      documents.logActivity(req.doc.id, 'Marked as accepted');
      res.redirect(`${base}/${req.doc.id}?msg=${q('Marked as accepted')}`);
    });

    router.post(`${base}/:id/mark-declined`, load, (req, res) => {
      documents.setEstimateResponse(req.doc.id, false);
      documents.logActivity(req.doc.id, 'Marked as declined');
      res.redirect(`${base}/${req.doc.id}?msg=${q('Marked as declined')}`);
    });
  }
}

documentRoutes('invoice');
documentRoutes('estimate');

// ---------- Automatic send on staged invoices ----------

router.post('/invoices/:id/auto-send', (req, res) => {
  const doc = documents.getDocument(req.params.id);
  if (!doc || doc.kind !== 'invoice') return res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
  if (doc.status !== 'draft') return res.redirect(`/invoices/${doc.id}?err=${q('Only draft invoices can be scheduled')}`);
  if (req.body.action === 'cancel') {
    db.prepare('UPDATE documents SET auto_send_on = NULL WHERE id = ?').run(doc.id);
    documents.logActivity(doc.id, 'Automatic send cancelled');
    return res.redirect(`/invoices/${doc.id}?msg=${q('Automatic send cancelled. It will wait for you to send it.')}`);
  }
  const date = isIsoDate(req.body.date) ? req.body.date : null;
  if (!date || date < today()) return res.redirect(`/invoices/${doc.id}?err=${q('Choose today or a future date')}`);
  db.prepare('UPDATE documents SET auto_send_on = ? WHERE id = ?').run(date, doc.id);
  documents.logActivity(doc.id, `Scheduled to be emailed automatically on ${date}`);
  res.redirect(`/invoices/${doc.id}?msg=${q('Automatic send scheduled')}`);
});

// ---------- Recurring invoices ----------

function profileFromBody(b) {
  const frequency = Object.keys(recurring.FREQUENCIES).includes(b.frequency) ? b.frequency : 'monthly';
  const ends = String(b.ends || 'never');
  return {
    client_id: Number(b.client_id),
    name: String(b.name || '').trim(),
    subject: String(b.subject || '').trim(),
    po_number: String(b.po_number || '').trim(),
    currency: CURRENCIES.includes(b.currency) ? b.currency : settings.get('default_currency'),
    discount_percent: Math.min(100, Math.max(0, parseNumber(b.discount_percent, 0))),
    notes: String(b.notes || ''),
    terms: String(b.terms || ''),
    lines: linesFromBody(b).map(({ item_date, ...l }) => l),
    taxes: taxesFromBody(b).map((t) => ({ ...t, fixed_amount_cents: null })),
    frequency,
    interval_count: Math.min(52, Math.max(1, Math.round(parseNumber(b.interval_count, 1)))),
    start_date: isIsoDate(b.start_date) ? b.start_date : today(),
    end_date: ends === 'date' && isIsoDate(b.end_date) ? b.end_date : null,
    max_count: ends === 'count' ? Math.max(1, Math.round(parseNumber(b.max_count, 1))) : null,
    business_id: businessField(b.business_id),
    send_mode: b.send_mode === 'auto' ? 'auto' : 'review',
    stage_days: Math.min(60, Math.max(0, Math.round(parseNumber(b.stage_days, 3)))),
    notify_owner: b.notify_owner === '1',
  };
}

function profileFormLocals(profile, title) {
  return {
    title,
    profile,
    clients: db.prepare('SELECT id, name, currency FROM clients WHERE archived = 0 OR id = ? ORDER BY name COLLATE NOCASE').all(profile.client_id || 0),
    projects: activeProjects(),
    taxRates: taxRates(),
    currencies: CURRENCIES,
    frequencies: recurring.FREQUENCIES,
  };
}

router.get('/recurring', (req, res) => {
  const profiles = recurring.listProfiles();
  const staged = recurring.stagedInvoices().map((d) => ({ ...d, balance_cents: d.total_cents - d.paid_cents }));
  res.render('recurring/index', { title: 'Recurring', profiles, staged, emailReady: email.isConfigured() });
});

router.get('/recurring/new', (req, res) => {
  const clients = db.prepare('SELECT * FROM clients WHERE archived = 0 ORDER BY name COLLATE NOCASE').all();
  if (!clients.length) return res.redirect(`/clients/new?err=${q('Add a client first')}`);
  let profile = {
    client_id: Number(req.query.client_id) || clients[0].id,
    name: '',
    subject: '{{month}} {{year}}',
    po_number: '',
    discount_percent: 0,
    notes: settings.get('default_invoice_notes'),
    terms: settings.get('default_invoice_terms'),
    lines: [],
    taxes: [],
    frequency: 'monthly',
    interval_count: 1,
    start_date: today(),
    end_date: null,
    max_count: null,
    send_mode: 'review',
    stage_days: 3,
    notify_owner: 1,
  };
  const from = Number(req.query.from) ? documents.getDocument(req.query.from) : null;
  if (from && from.kind === 'invoice') {
    profile = {
      ...profile,
      client_id: from.client_id,
      business_id: from.business_id || null,
      name: from.subject || '',
      subject: from.subject,
      po_number: from.po_number,
      discount_percent: from.discount_percent,
      notes: from.notes,
      terms: from.terms,
      lines: from.lines.map((l) => ({ project_id: l.project_id, kind: l.kind, description: l.description, quantity: l.quantity, unit_price_cents: l.unit_price_cents, taxable: l.taxable })),
      taxes: from.taxes.map((t) => ({ tax_rate_id: t.tax_rate_id, name: t.name, rate: t.rate, reg_number: t.reg_number })),
    };
  }
  const client = clients.find((c) => c.id === profile.client_id) || clients[0];
  profile.currency = from ? from.currency : client.currency;
  if (!from) {
    try {
      const ids = JSON.parse(client.default_tax_ids || '[]').map(Number);
      profile.taxes = taxRates().filter((t) => ids.includes(t.id)).map((t) => ({ tax_rate_id: t.id, name: t.name, rate: t.rate, reg_number: t.reg_number }));
    } catch {
      /* ignore */
    }
  }
  res.render('recurring/form', profileFormLocals(profile, 'New recurring invoice'));
});

router.post('/recurring', (req, res) => {
  const data = profileFromBody(req.body);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(data.client_id);
  if (!client) return res.redirect(`/recurring/new?err=${q('Choose a client')}`);
  if (data.business_id === undefined) data.business_id = client.business_id || null;
  const id = recurring.saveProfile(null, data);
  recurring.skipPastOccurrences(id);
  res.redirect(`/recurring/${id}?msg=${q('Recurring invoice saved')}`);
});

function loadProfile(req, res, next) {
  const p = recurring.getProfile(req.params.id);
  if (!p) return res.status(404).render('error', { title: 'Not found', message: 'Recurring invoice not found.' });
  req.profile = p;
  next();
}

router.get('/recurring/:id', loadProfile, (req, res) => {
  const p = req.profile;
  const invoices = db
    .prepare(`SELECT d.*, c.name AS client_name FROM documents d JOIN clients c ON c.id = d.client_id WHERE d.recurring_id = ? ORDER BY d.issue_date DESC, d.id DESC`)
    .all(p.id)
    .map((d) => {
      d.balance_cents = d.total_cents - d.paid_cents;
      d.display_status = d.status === 'draft' && d.auto_send_on ? 'scheduled' : d.status;
      return d;
    });
  const upcoming = p.active ? recurring.upcomingDates(p, 6) : [];
  res.render('recurring/show', { title: p.name || p.subject || 'Recurring invoice', p, invoices, upcoming, periodVars: recurring.periodVars(p.next_date || today()) });
});

router.get('/recurring/:id/edit', loadProfile, (req, res) => {
  res.render('recurring/form', profileFormLocals(req.profile, `Edit ${req.profile.name || 'recurring invoice'}`));
});

router.post('/recurring/:id', loadProfile, (req, res) => {
  const data = profileFromBody(req.body);
  if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(data.client_id)) return res.redirect(`/recurring/${req.profile.id}/edit?err=${q('Choose a client')}`);
  if (data.business_id === undefined) data.business_id = req.profile.business_id || null;
  const startChanged = data.start_date !== req.profile.start_date;
  recurring.saveProfile(req.profile.id, data);
  if (startChanged) recurring.skipPastOccurrences(req.profile.id);
  res.redirect(`/recurring/${req.profile.id}?msg=${q('Recurring invoice saved')}`);
});

router.post('/recurring/:id/toggle', loadProfile, (req, res) => {
  const resume = !req.profile.active;
  recurring.setActive(req.profile.id, resume);
  // Resuming never creates a backlog for the time it was paused.
  if (resume) recurring.skipPastOccurrences(req.profile.id);
  res.redirect(`/recurring/${req.profile.id}?msg=${q(resume ? 'Resumed' : 'Paused')}`);
});

router.post('/recurring/:id/generate', loadProfile, async (req, res) => {
  if (!req.profile.next_date) return res.redirect(`/recurring/${req.profile.id}?err=${q('This schedule has finished')}`);
  const id = recurring.generateNext(req.profile.id);
  res.redirect(`/invoices/${id}?msg=${q('Next invoice created. Review it below.')}`);
});

router.post('/recurring/:id/delete', loadProfile, (req, res) => {
  recurring.deleteProfile(req.profile.id);
  res.redirect(`/recurring?msg=${q('Recurring invoice deleted. Invoices it already created are kept.')}`);
});

// ---------- Reports ----------

router.get('/reports', (req, res) => {
  const years = reports.years();
  const thisYear = today().slice(0, 4);
  if (!years.includes(thisYear)) years.unshift(thisYear);
  const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : thisYear;
  const business = req.query.business === 'main' || businesses.get(Number(req.query.business)) ? String(req.query.business) : '';
  const title = `Reports ${year}${business ? ` · ${businesses.nameOf(business === 'main' ? null : Number(business))}` : ''}`;
  res.render('reports', { title, years, year, business, r: reports.yearReport(year, business), outstanding: reports.outstanding() });
});

router.get('/reports/:year/:file', (req, res) => {
  const year = req.params.year;
  if (!/^\d{4}$/.test(year)) return res.status(404).end();
  const business = req.query.business === 'main' || businesses.get(Number(req.query.business)) ? String(req.query.business) : '';
  const csv = req.params.file === 'invoices.csv' ? reports.invoicesCsv(year, business) : req.params.file === 'payments.csv' ? reports.paymentsCsv(year, business) : null;
  if (!csv) return res.status(404).end();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.file.replace('.csv', '')}-${year}.csv"`);
  res.send(csv);
});

// ---------- Settings ----------

router.get('/settings', (req, res) => {
  res.render('settings', {
    title: 'Settings',
    taxRates: taxRates(true),
    currencies: CURRENCIES,
    nextInvoice: documents.peekNextNumber('invoice'),
    nextEstimate: documents.peekNextNumber('estimate'),
    webhookUrl: `${config.appUrl}/webhooks/stripe`,
    schedule: reminders.reminderSchedule(),
  });
});

router.post('/settings', (req, res) => {
  const b = req.body;
  const allowed = { ...settings.DEFAULTS };
  delete allowed.logo_file;
  const update = {};
  for (const key of Object.keys(allowed)) {
    if (key in b) update[key] = String(b[key]);
  }
  // Checkboxes are absent when unchecked; the form sends a hidden list of the ones it shows.
  for (const key of String(b._checkboxes || '').split(',').filter(Boolean)) {
    if (key in allowed) update[key] = b[key] === '1' ? '1' : '0';
  }
  if (update.default_currency && !CURRENCIES.includes(update.default_currency)) delete update.default_currency;
  for (const k of ['accent_color', 'heading_color']) {
    if (k in update && !/^#[0-9a-f]{6}$/i.test(update[k])) delete update[k];
  }
  if ('invoice_font' in update && !['modern', 'classic'].includes(update.invoice_font)) delete update.invoice_font;
  if ('logo_size' in update && !['small', 'medium', 'large'].includes(update.logo_size)) delete update.logo_size;
  for (const k of ['invoice_next_number', 'estimate_next_number']) {
    if (k in update) update[k] = String(Math.max(1, Math.round(Number(update[k]) || 1)));
  }
  settings.setMany(update);
  res.redirect(`/settings?msg=${q('Settings saved')}${b._section ? `#${encodeURIComponent(b._section)}` : ''}`);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// Validates an uploaded logo and writes it to the data folder. Returns { name } or { error }.
function storeLogo(f, prefix = 'logo') {
  if (!f) return { error: 'Choose an image file' };
  const isPng = f.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpg = f.buffer[0] === 0xff && f.buffer[1] === 0xd8;
  if (!isPng && !isJpg) return { error: 'Logo must be a PNG or JPEG image' };
  const name = `${prefix}-${Date.now()}.${isPng ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(config.dataDir, name), f.buffer);
  return { name };
}

function removeLogo(name) {
  if (name && /^[\w.-]+$/.test(name)) fs.rmSync(path.join(config.dataDir, name), { force: true });
}

router.post('/settings/logo', upload.single('logo'), auth.checkCsrf, (req, res) => {
  const r = storeLogo(req.file);
  if (r.error) return res.redirect(`/settings?err=${q(r.error)}#branding`);
  const old = settings.get('logo_file');
  settings.set('logo_file', r.name);
  if (old && old !== r.name) removeLogo(old);
  res.redirect(`/settings?msg=${q('Logo uploaded')}#branding`);
});

router.post('/settings/logo/delete', (req, res) => {
  const old = settings.get('logo_file');
  if (old) fs.rmSync(path.join(config.dataDir, old), { force: true });
  settings.set('logo_file', '');
  res.redirect(`/settings?msg=${q('Logo removed')}#branding`);
});

router.post('/settings/taxes', (req, res) => {
  const name = String(req.body.name || '').trim();
  const rate = parseNumber(req.body.rate, NaN);
  if (!name || !Number.isFinite(rate)) return res.redirect(`/settings?err=${q('Enter a tax name and rate')}#taxes`);
  db.prepare('INSERT INTO tax_rates (name, rate, reg_number) VALUES (?, ?, ?)').run(name, rate, String(req.body.reg_number || '').trim());
  res.redirect(`/settings?msg=${q('Tax rate added')}#taxes`);
});

router.post('/settings/taxes/:id', (req, res) => {
  const name = String(req.body.name || '').trim();
  const rate = parseNumber(req.body.rate, NaN);
  if (!name || !Number.isFinite(rate)) return res.redirect(`/settings?err=${q('Enter a tax name and rate')}#taxes`);
  db.prepare('UPDATE tax_rates SET name = ?, rate = ?, reg_number = ? WHERE id = ?').run(
    name,
    rate,
    String(req.body.reg_number || '').trim(),
    req.params.id,
  );
  res.redirect(`/settings?msg=${q('Tax rate saved (existing invoices keep their original rate)')}#taxes`);
});

router.post('/settings/taxes/:id/archive', (req, res) => {
  db.prepare('UPDATE tax_rates SET archived = 1 - archived WHERE id = ?').run(req.params.id);
  res.redirect(`/settings?msg=${q('Tax rate updated')}#taxes`);
});

router.post('/settings/test-email', async (req, res) => {
  const s = settings.getAll();
  const to = s.business_email || s.from_email;
  try {
    if (!config.postmarkToken) throw new Error('POSTMARK_SERVER_TOKEN is not set in .env');
    if (!s.from_email) throw new Error('Set the From email address first');
    await email.postmarkSend({
      From: s.from_email,
      To: to,
      Subject: 'Test email from your invoicing app',
      TextBody: 'Postmark is set up correctly. Invoices you send will come from this address.',
    });
    res.redirect(`/settings?msg=${q(`Test email sent to ${to}`)}#email`);
  } catch (err) {
    res.redirect(`/settings?err=${q(err.message)}#email`);
  }
});

router.post('/settings/run-reminders', async (req, res) => {
  const due = reminders.dueReminders().length;
  await reminders.runOnce();
  res.redirect(`/settings?msg=${q(`Reminder check finished (${due} due)`)}#reminders`);
});


// ---------- Businesses ----------

function businessFromBody(b) {
  const out = {};
  for (const k of [...businesses.IDENTITY_KEYS, ...businesses.FALLBACK_KEYS, ...businesses.NUMBERING_KEYS]) {
    if (k in b) out[k] = String(b[k] ?? '').trim();
  }
  for (const k of ['accent_color', 'heading_color']) if (out[k] && !/^#[0-9a-f]{6}$/i.test(out[k])) out[k] = '';
  if (out.invoice_font && !['modern', 'classic'].includes(out.invoice_font)) out.invoice_font = '';
  if (out.logo_size && !['small', 'medium', 'large'].includes(out.logo_size)) out.logo_size = '';
  for (const k of ['invoice_next_number', 'estimate_next_number']) if (out[k]) out[k] = String(Math.max(1, Math.round(Number(out[k]) || 1)));
  out.own_numbering = b.own_numbering === '1' ? '1' : '0';
  return out;
}

router.get('/businesses', (req, res) => {
  const counts = new Map(
    db.prepare("SELECT business_id, COUNT(*) AS n FROM documents WHERE kind = 'invoice' GROUP BY business_id").all().map((r) => [r.business_id, r.n]),
  );
  res.render('businesses/index', { title: 'Businesses', list: businesses.list({ includeArchived: true }), counts, main: businesses.effective(null) });
});

router.get('/businesses/new', (req, res) => {
  res.render('businesses/form', { title: 'Add a business', biz: { own_numbering: '0' }, main: businesses.effective(null) });
});

router.post('/businesses', (req, res) => {
  const data = businessFromBody(req.body);
  if (!data.business_name) return res.redirect(`/businesses/new?err=${q('Enter the business or person name')}`);
  const id = businesses.save(null, data);
  res.redirect(`/businesses/${id}?msg=${q('Business added. Upload a logo below if it has one.')}`);
});

function loadBusiness(req, res, next) {
  const b = businesses.get(Number(req.params.id));
  if (!b) return res.status(404).render('error', { title: 'Not found', message: 'Business not found.' });
  req.biz = b;
  next();
}

router.get('/businesses/:id', loadBusiness, (req, res) => {
  res.render('businesses/form', {
    title: req.biz.name,
    biz: req.biz,
    main: businesses.effective(null),
    nextInvoice: documents.peekNextNumber('invoice', req.biz.id),
    nextEstimate: documents.peekNextNumber('estimate', req.biz.id),
  });
});

router.post('/businesses/:id', loadBusiness, (req, res) => {
  const data = businessFromBody(req.body);
  if (!data.business_name) return res.redirect(`/businesses/${req.biz.id}?err=${q('Enter the business or person name')}`);
  businesses.save(req.biz.id, data);
  res.redirect(`/businesses/${req.biz.id}?msg=${q('Business saved')}`);
});

router.post('/businesses/:id/logo', upload.single('logo'), auth.checkCsrf, loadBusiness, (req, res) => {
  const r = storeLogo(req.file, `logo-b${req.biz.id}`);
  if (r.error) return res.redirect(`/businesses/${req.biz.id}?err=${q(r.error)}#branding`);
  const old = req.biz.logo_file;
  businesses.setField(req.biz.id, 'logo_file', r.name);
  if (old && old !== r.name) removeLogo(old);
  res.redirect(`/businesses/${req.biz.id}?msg=${q('Logo uploaded')}#branding`);
});

router.post('/businesses/:id/logo/delete', loadBusiness, (req, res) => {
  removeLogo(req.biz.logo_file);
  businesses.setField(req.biz.id, 'logo_file', '');
  res.redirect(`/businesses/${req.biz.id}?msg=${q('Logo removed')}#branding`);
});

router.post('/businesses/:id/archive', loadBusiness, (req, res) => {
  businesses.setArchived(req.biz.id, !req.biz.archived);
  res.redirect(`/businesses?msg=${q(req.biz.archived ? 'Business restored' : 'Business archived. Its invoices are kept.')}`);
});

// ---------- Import ----------

router.get('/import', (req, res) => {
  res.render('import', { title: 'Import from Harvest', result: null, error: '' });
});

router.post('/import', async (req, res) => {
  const b = req.body;
  try {
    if (!b.token || !b.account_id) throw new Error('Enter your Harvest token and account ID');
    const result = await harvest.runImport({
      token: b.token,
      accountId: b.account_id,
      taxName1: String(b.tax_name_1 || 'Tax').trim(),
      taxName2: String(b.tax_name_2 || 'Tax 2').trim(),
      continueNumbering: b.continue_numbering === '1',
    });
    res.render('import', { title: 'Import from Harvest', result, error: '' });
  } catch (err) {
    res.render('import', { title: 'Import from Harvest', result: null, error: err.message });
  }
});

// ---------- Updates ----------

router.get('/updates', async (req, res) => {
  res.render('updates', {
    title: 'Updates',
    version: await updater.currentVersion(),
    check: updater.cachedCheck(),
    job: updater.jobStatus(),
  });
});

router.post('/updates/check', async (req, res) => {
  await updater.check();
  res.redirect('/updates');
});

router.post('/updates/source', (req, res) => {
  if (req.body.action === 'reset') {
    settings.setMany({ update_repo: '', update_branch: '' });
    return res.redirect(`/updates?msg=${q('Updates will come from the original repository again')}`);
  }
  const branch = String(req.body.branch || '').trim() || 'main';
  if (!/^[\w][\w./-]*$/.test(branch) || branch.includes('..')) return res.redirect(`/updates?err=${q('That branch name is not valid')}`);
  let repo = '';
  try {
    repo = updater.normalizeRepo(req.body.repo);
  } catch (err) {
    return res.redirect(`/updates?err=${q(err.message)}`);
  }
  settings.setMany({ update_repo: repo, update_branch: branch === 'main' ? '' : branch });
  res.redirect(`/updates?msg=${q('Update source saved. Click "Check for updates" to try it.')}#source`);
});

router.post('/updates/run', (req, res) => {
  try {
    updater.startUpdate();
    res.redirect('/updates');
  } catch (err) {
    res.redirect(`/updates?err=${q(err.message)}`);
  }
});

router.get('/updates/status', async (req, res) => {
  const v = await updater.currentVersion();
  res.json({ sha: v.sha || null, job: updater.jobStatus() });
});

// ---------- Backup ----------

router.get('/backup', async (req, res) => {
  const file = path.join(config.dataDir, `download-${Date.now()}.db`);
  try {
    await db.backup(file);
    res.download(file, `invoices-backup-${today()}.db`, () => fs.rmSync(file, { force: true }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
});

module.exports = router;
