'use strict';
// End-to-end test: runs the real app against a fresh database, a fake Postmark API and a fake Harvest API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'invoices-test-'));
const sentEmails = [];

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

let app, base, postmark, harvestApi, cookie = '';

test.before(async () => {
  postmark = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      sentEmails.push({ token: req.headers['x-postmark-server-token'], ...JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ErrorCode: 0, Message: 'OK', MessageID: `msg-${sentEmails.length}` }));
    });
  });
  harvestApi = await startServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const u = new URL(req.url, 'http://x');
    const data = {
      '/v2/clients': { clients: [{ id: 11, name: 'Harvest Co', is_active: true, address: '1 Main St', currency: 'USD' }] },
      '/v2/contacts': { contacts: [{ id: 21, client: { id: 11 }, first_name: 'Hana', last_name: 'Vest', email: 'hana@harvest.test' }] },
      '/v2/projects': { projects: [{ id: 31, client: { id: 11 }, name: 'Old Project', code: 'OP', is_active: true, hourly_rate: 95 }] },
      '/v2/invoices': {
        invoices: [
          {
            id: 41, client: { id: 11 }, number: '207', amount: 1050, due_amount: 0, tax: 5, tax_amount: 50, tax2: null, tax2_amount: 0,
            discount: null, subject: 'Q1 work', notes: '', currency: 'USD', state: 'paid', issue_date: '2025-03-01', due_date: '2025-03-31',
            sent_at: '2025-03-01T15:00:00Z', paid_date: '2025-03-20',
            line_items: [{ kind: 'Service', description: 'Work', quantity: 10, unit_price: 100, amount: 1000, taxed: true, taxed2: false, project: { id: 31 } }],
          },
        ],
      },
      '/v2/invoices/41/payments': { invoice_payments: [{ id: 51, amount: 1050, paid_date: '2025-03-20', notes: 'cheque' }] },
      '/v2/estimates': { estimates: [] },
    }[u.pathname];
    if (req.headers.authorization !== 'Bearer htoken' || req.headers['harvest-account-id'] !== '999') {
      res.statusCode = 401;
      return res.end('{}');
    }
    if (!data) {
      res.statusCode = 404;
      return res.end('{}');
    }
    res.end(JSON.stringify({ ...data, links: { next: null } }));
  });

  process.env.ENV_FILE = path.join(tmp, 'none.env');
  process.env.DATA_DIR = tmp;
  process.env.APP_URL = 'http://invoices.test';
  process.env.ADMIN_EMAIL = 'me@example.com';
  process.env.SESSION_SECRET = 'test-secret';
  process.env.POSTMARK_SERVER_TOKEN = 'pm-token';
  process.env.POSTMARK_API_URL = urlOf(postmark);
  process.env.HARVEST_API_URL = `${urlOf(harvestApi)}/v2`;
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.TZ = 'America/Toronto';
  const { hashPassword } = require('../src/auth');
  require('../src/config').adminPasswordHash = hashPassword('correct horse battery');

  const { createApp } = require('../src/server');
  app = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  base = urlOf(app);
});

test.after(() => {
  app && app.close();
  postmark && postmark.close();
  harvestApi && harvestApi.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function req(method, p, form, extraHeaders = {}) {
  const headers = { cookie, ...extraHeaders };
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
}
const get = (p) => req('GET', p);
let csrf = '';
const post = (p, form = {}) => req('POST', p, { _csrf: csrf, ...form });
const idFrom = (res) => Number(res.headers.get('location').match(/\/(\d+)/)[1]);

test('login and setup', async () => {
  let res = await get('/');
  assert.strictEqual(res.status, 302);
  res = await req('POST', '/login', { email: 'me@example.com', password: 'wrong' });
  assert.strictEqual(res.status, 401);
  res = await req('POST', '/login', { email: 'me@example.com', password: 'correct horse battery' });
  assert.strictEqual(res.status, 302);
  const page = await (await get('/settings')).text();
  csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];

  res = await req('POST', '/settings', { business_name: 'Nope' });
  assert.strictEqual(res.status, 403, 'POST without CSRF token is rejected');

  res = await post('/settings', {
    business_name: 'Acme Studio',
    business_email: 'billing@acme.test',
    business_address: '123 Street\nToronto ON',
    from_email: 'billing@acme.test',
  });
  assert.strictEqual(res.status, 302);
  await post('/settings', { _checkboxes: 'reminders_enabled', reminders_enabled: '1', reminder_days: '3, 14' });
  await post('/settings/taxes', { name: 'GST', rate: '5', reg_number: '123456789 RT0001' });
  await post('/settings/taxes', { name: 'PST', rate: '7' });
});

let clientId, projectId, invoiceId;

test('clients and projects', async () => {
  let res = await post('/clients', {
    name: 'Globex',
    contact_name: 'Hank',
    email: 'hank@globex.test',
    currency: 'CAD',
    default_tax_ids: '1',
    address: '1 Globex Way',
  });
  clientId = idFrom(res);
  res = await post(`/clients/${clientId}/projects`, { name: 'Website', hourly_rate: '120' });
  assert.strictEqual(res.status, 302);
  const html = await (await get(`/clients/${clientId}`)).text();
  assert.match(html, /Website/);
  assert.match(html, /\$120\.00\/hr/);
  projectId = 1;
});

test('invoice: create, edit lines, quick add, totals', async () => {
  let res = await post('/invoices', { client_id: clientId, subject: 'November work' });
  invoiceId = idFrom(res);
  assert.match(await (await get(`/invoices/${invoiceId}/edit`)).text(), /GST/, 'client default tax applied');

  const lines = [
    { item_date: '2026-11-02', project_id: projectId, kind: 'Service', description: 'Design', quantity: '1.5', unit_price: '120', taxable: true },
    { kind: 'Expense', description: 'Hosting', quantity: '1', unit_price: '50', taxable: false },
  ];
  const taxes = [{ tax_rate_id: 1, name: 'GST', rate: 5, reg_number: '123456789 RT0001' }];
  res = await post(`/invoices/${invoiceId}`, {
    number: 'INV-1001', client_id: clientId, currency: 'CAD', issue_date: '2026-11-01', due_date: '2026-12-01',
    lines_json: JSON.stringify(lines), taxes_json: JSON.stringify(taxes), notes: 'Thanks', terms: '',
  });
  assert.strictEqual(res.status, 302);

  // Quick-add uses the project's rate when no price is given.
  res = await post(`/invoices/${invoiceId}/lines`, { project_id: projectId, quantity: '2', description: 'Dev', item_date: '2026-11-03' });
  assert.strictEqual(res.status, 302);

  const documents = require('../src/documents');
  const doc = documents.getDocument(invoiceId);
  assert.strictEqual(doc.lines.length, 3);
  assert.strictEqual(doc.subtotal_cents, 18000 + 5000 + 24000);
  assert.strictEqual(doc.tax_cents, 2100); // 5% of the 420.00 taxable
  assert.strictEqual(doc.total_cents, 49100);
  assert.strictEqual(doc.status, 'draft');

  // Drafts are not visible to clients.
  assert.strictEqual((await fetch(`${base}/i/${doc.public_token}`)).status, 404);
});

test('PDF renders', async () => {
  const res = await get(`/invoices/${invoiceId}/pdf`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
  fs.writeFileSync(path.join(tmp, 'invoice.pdf'), buf);
});

test('send invoice by email with PDF attached', async () => {
  const before = sentEmails.length;
  const res = await post(`/invoices/${invoiceId}/send`, {
    purpose: 'invoice', to: 'hank@globex.test', cc: '', subject: 'Invoice INV-1001', body: 'Hi Hank', attach_pdf: '1',
  });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /msg=Email/);
  const mail = sentEmails[before];
  assert.strictEqual(mail.token, 'pm-token');
  assert.strictEqual(mail.To, 'hank@globex.test');
  assert.strictEqual(mail.Bcc, 'billing@acme.test');
  assert.match(mail.From, /Acme Studio/);
  assert.strictEqual(mail.Attachments[0].ContentType, 'application/pdf');
  assert.match(mail.HtmlBody, /View and pay invoice/);
  const doc = require('../src/documents').getDocument(invoiceId);
  assert.strictEqual(doc.status, 'sent');

  const pub = await fetch(`${base}/i/${doc.public_token}`);
  assert.strictEqual(pub.status, 200);
  const html = await pub.text();
  assert.match(html, /\$491\.00/);
  assert.match(html, /Pay \$491\.00 online/);
});

test('Stripe webhook records payment once and emails a receipt', async () => {
  const Stripe = require('stripe');
  const stripe = Stripe('sk_test_dummy');
  const event = {
    id: 'evt_1', object: 'event', type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', object: 'checkout.session', payment_status: 'paid', amount_total: 49100, currency: 'cad', payment_intent: 'pi_1', metadata: { document_id: String(invoiceId) } } },
  };
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
  const before = sentEmails.length;
  const send = () => fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
  assert.strictEqual((await send()).status, 200);
  assert.strictEqual((await send()).status, 200); // retry is idempotent

  const bad = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=bad' }, body: payload });
  assert.strictEqual(bad.status, 400);

  const doc = require('../src/documents').getDocument(invoiceId);
  assert.strictEqual(doc.payments.length, 1);
  assert.strictEqual(doc.status, 'paid');
  assert.strictEqual(doc.balance_cents, 0);
  await new Promise((r) => setTimeout(r, 300));
  const subjects = sentEmails.slice(before).map((m) => m.Subject);
  assert.ok(subjects.some((s) => /Payment received for invoice INV-1001/.test(s)), 'receipt to client');
  assert.ok(subjects.some((s) => /Payment received: \$491\.00/.test(s)), 'notification to owner');
});

test('manual payments and partial status', async () => {
  let res = await post('/invoices', { client_id: clientId });
  const id = idFrom(res);
  await post(`/invoices/${id}`, {
    number: 'INV-2000', client_id: clientId, currency: 'CAD', issue_date: '2026-09-01', due_date: '2026-10-01',
    lines_json: JSON.stringify([{ description: 'Retainer', quantity: '1', unit_price: '1000' }]), taxes_json: '[]',
  });
  await post(`/invoices/${id}/mark-sent`);
  await post(`/invoices/${id}/payments`, { amount: '400', paid_date: '2026-10-15', method: 'etransfer' });
  const documents = require('../src/documents');
  let doc = documents.getDocument(id);
  assert.strictEqual(doc.status, 'partial');
  assert.strictEqual(doc.balance_cents, 60000);
  assert.ok(doc.is_overdue);

  // Overdue reminder goes out once, then not again the same day.
  const reminders = require('../src/reminders');
  const before = sentEmails.length;
  await reminders.runOnce();
  assert.strictEqual(sentEmails.length, before + 1);
  assert.match(sentEmails[before].Subject, /overdue/);
  await reminders.runOnce();
  assert.strictEqual(sentEmails.length, before + 1);
  doc = documents.getDocument(id);
  assert.strictEqual(doc.reminder_count, 1);

  await post(`/invoices/${id}/payments`, { amount: '600', method: 'cheque' });
  assert.strictEqual(documents.getDocument(id).status, 'paid');
});

test('estimate: send, client accepts, convert to invoice', async () => {
  let res = await post('/estimates', { client_id: clientId, subject: 'Phase 2' });
  const id = idFrom(res);
  await post(`/estimates/${id}`, {
    number: 'EST-1001', client_id: clientId, currency: 'CAD', issue_date: '2026-11-01', due_date: '2026-12-01',
    lines_json: JSON.stringify([{ description: 'Build', quantity: '10', unit_price: '120' }]),
    taxes_json: JSON.stringify([{ name: 'GST', rate: 5 }]),
  });
  res = await post(`/estimates/${id}/send`, { purpose: 'estimate', to: 'hank@globex.test', subject: 'Estimate', body: 'Hi', attach_pdf: '1' });
  assert.match(res.headers.get('location'), /msg=Email/);
  const documents = require('../src/documents');
  const est = documents.getDocument(id);
  const page = await (await fetch(`${base}/e/${est.public_token}`)).text();
  assert.match(page, /Accept estimate/);
  res = await fetch(`${base}/e/${est.public_token}/accept`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Hank', redirect: 'manual' });
  assert.strictEqual(res.status, 303);
  assert.strictEqual(documents.getDocument(id).status, 'accepted');

  res = await post(`/estimates/${id}/convert`);
  const invId = idFrom(res);
  const inv = documents.getDocument(invId);
  assert.strictEqual(inv.kind, 'invoice');
  assert.strictEqual(inv.total_cents, 126000);
  assert.strictEqual(documents.getDocument(id).status, 'invoiced');
});

test('pages render without errors', async () => {
  for (const p of ['/', '/invoices', '/invoices?status=overdue', '/estimates', '/clients', '/projects', '/reports', '/reports?year=2026', '/settings', '/import', `/invoices/${invoiceId}`, `/invoices/${invoiceId}/edit`, `/invoices/${invoiceId}/send`, '/invoices/new', `/clients/${clientId}/edit`, '/projects/1/edit']) {
    const res = await get(p);
    assert.strictEqual(res.status, 200, `${p} -> ${res.status}`);
  }
  const csv = await (await get('/reports/2026/invoices.csv')).text();
  assert.match(csv, /INV-1001,Acme Studio,Globex/);
});

test('reports: tax totals', () => {
  const r = require('../src/reports').yearReport('2026');
  const cad = r.byCurrency.find((c) => c.currency === 'CAD');
  assert.strictEqual(cad.total, 49100 + 100000);
  const gst = r.taxes.find((t) => t.name === 'GST');
  assert.strictEqual(gst.amount, 2100);
  const collected = r.collected.find((c) => c.currency === 'CAD');
  assert.strictEqual(collected.amount, 49100 + 100000);
  assert.strictEqual(collected.tax, 2100);
});

test('Harvest import', async () => {
  let res = await post('/import', { token: 'htoken', account_id: '999', tax_name_1: 'GST', continue_numbering: '1' });
  let html = await res.text();
  assert.match(html, /Imported 1 clients, 1 projects, 1 invoices \(1 payments\)/);
  const db = require('../src/db');
  const inv = db.prepare("SELECT * FROM documents WHERE number = '207'").get();
  assert.strictEqual(inv.status, 'paid');
  assert.strictEqual(inv.total_cents, 105000);
  assert.strictEqual(inv.currency, 'USD');
  const client = db.prepare("SELECT * FROM clients WHERE harvest_id = 11").get();
  assert.strictEqual(client.email, 'hana@harvest.test');
  assert.strictEqual(require('../src/settings').get('invoice_next_number'), '208');

  res = await post('/import', { token: 'htoken', account_id: '999' });
  html = await res.text();
  assert.match(html, /Imported 0 clients/);
});

test('branding: logo upload, colours and fonts', async () => {
  // 1x1 transparent PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('_csrf', csrf);
  fd.append('logo', new Blob([png], { type: 'image/png' }), 'logo.png');
  let res = await fetch(`${base}/settings/logo`, { method: 'POST', headers: { cookie }, body: fd, redirect: 'manual' });
  assert.match(res.headers.get('location'), /Logo%20uploaded/);
  assert.strictEqual((await fetch(`${base}/logo`)).headers.get('content-type'), 'image/png');

  // Non-image uploads are rejected.
  const bad = new FormData();
  bad.append('_csrf', csrf);
  bad.append('logo', new Blob(['<svg/>'], { type: 'image/png' }), 'x.png');
  res = await fetch(`${base}/settings/logo`, { method: 'POST', headers: { cookie }, body: bad, redirect: 'manual' });
  assert.match(res.headers.get('location'), /err=/);

  await post('/settings', { accent_color: '#0f766e', heading_color: 'red;}body{', invoice_font: 'classic', logo_size: 'huge' });
  const settings = require('../src/settings');
  assert.strictEqual(settings.get('accent_color'), '#0f766e');
  assert.strictEqual(settings.get('heading_color'), '#1e3a5f', 'invalid colour ignored');
  assert.strictEqual(settings.get('invoice_font'), 'classic');
  assert.strictEqual(settings.get('logo_size'), 'medium', 'invalid size ignored');

  const pdf = Buffer.from(await (await get(`/invoices/${invoiceId}/pdf`)).arrayBuffer());
  assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
  assert.match(pdf.toString('latin1'), /Times-Bold/);
});

test('CSS and JS links carry a version for cache busting', async () => {
  const html = await (await get('/')).text();
  const m = html.match(/\/static\/app\.css\?v=([0-9a-f]{10})/);
  assert.ok(m, 'versioned stylesheet link');
  assert.match(html, new RegExp(`/static/app\\.js\\?v=${m[1]}`));
  const css = await fetch(`${base}/static/app.css?v=${m[1]}`);
  assert.strictEqual(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});
