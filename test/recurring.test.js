'use strict';
// Recurring invoices: schedule maths, staging, automatic sending and the pages.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'invoices-recurring-'));
const sent = [];
let postmark, app, base, cookie = '', csrf = '';

process.env.ENV_FILE = path.join(tmp, 'none.env');
process.env.DATA_DIR = tmp;
process.env.APP_URL = 'http://invoices.test';
process.env.ADMIN_EMAIL = 'me@example.com';
process.env.SESSION_SECRET = 'x';
process.env.POSTMARK_SERVER_TOKEN = 'pm';
process.env.TZ = 'UTC';

const { addDays, today } = require('../src/util');

test.before(async () => {
  postmark = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        sent.push(JSON.parse(b));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m${sent.length}` }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env.POSTMARK_API_URL = `http://127.0.0.1:${postmark.address().port}`;
  const { hashPassword } = require('../src/auth');
  require('../src/config').adminPasswordHash = hashPassword('pw-for-tests-123');
  require('../src/settings').setMany({ business_name: 'Acme', from_email: 'billing@acme.test', business_email: 'me@acme.test' });
  const { createApp } = require('../src/server');
  app = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(() => {
  app && app.close();
  postmark && postmark.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const recurring = () => require('../src/recurring');
const db = () => require('../src/db');
const documents = () => require('../src/documents');

function client(email = 'pay@client.test') {
  return Number(db().prepare("INSERT INTO clients (name, email, currency, default_tax_ids) VALUES ('Client Co', ?, 'CAD', '[]')").run(email).lastInsertRowid);
}

function profile(overrides) {
  return recurring().saveProfile(null, {
    client_id: overrides.client_id,
    name: 'Retainer',
    subject: 'Retainer – {{month}} {{year}}',
    currency: 'CAD',
    lines: [{ kind: 'Service', description: 'Support for {{month}}', quantity: 1, unit_price_cents: 100000, taxable: 1 }],
    taxes: [{ name: 'GST', rate: 5 }],
    frequency: 'monthly',
    interval_count: 1,
    start_date: today(),
    send_mode: 'review',
    stage_days: 3,
    notify_owner: false,
    ...overrides,
  });
}

test('schedule maths keeps the day of month and handles short months', () => {
  const r = recurring();
  const p = { start_date: '2027-01-31', frequency: 'monthly', interval_count: 1 };
  assert.deepStrictEqual([0, 1, 2, 3].map((n) => r.occurrenceDate(p, n)), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  assert.strictEqual(r.occurrenceDate({ start_date: '2028-02-29', frequency: 'yearly', interval_count: 1 }, 1), '2029-02-28');
  assert.strictEqual(r.occurrenceDate({ start_date: '2027-01-15', frequency: 'quarterly', interval_count: 1 }, 2), '2027-07-15');
  assert.strictEqual(r.occurrenceDate({ start_date: '2027-01-01', frequency: 'weekly', interval_count: 2 }, 3), '2027-02-12');
  assert.strictEqual(r.computeNext({ start_date: '2027-01-01', frequency: 'monthly', interval_count: 1, generated_count: 3, max_count: 3 }), null);
  assert.strictEqual(r.computeNext({ start_date: '2027-01-01', frequency: 'monthly', interval_count: 1, generated_count: 2, end_date: '2027-02-15' }), null);
  assert.match(r.describeSchedule({ start_date: '2027-01-31', frequency: 'monthly', interval_count: 1 }), /Every month on the 31st \(or last day\)/);
  assert.strictEqual(r.periodVars('2027-03-01').last_month, 'February 2027');
});

test('review mode: staged as a draft inside the staging window, never sent', async () => {
  const c = client();
  const start = addDays(today(), 5);
  const id = profile({ client_id: c, start_date: start, stage_days: 3 });
  let r = await recurring().runOnce({ now: today() });
  assert.strictEqual(db().prepare('SELECT COUNT(*) n FROM documents WHERE recurring_id = ?').get(id).n, 0, 'too early');
  r = await recurring().runOnce({ now: addDays(today(), 2) });
  assert.strictEqual(r.generated, 1);
  const inv = db().prepare('SELECT * FROM documents WHERE recurring_id = ?').get(id);
  assert.strictEqual(inv.status, 'draft');
  assert.strictEqual(inv.auto_send_on, null);
  assert.strictEqual(inv.issue_date, start);
  const month = new Date(`${start}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', timeZone: 'UTC' });
  assert.strictEqual(inv.subject, `Retainer – ${month} ${start.slice(0, 4)}`);
  assert.strictEqual(inv.total_cents, 105000);
  assert.match(documents().getDocument(inv.id).lines[0].description, new RegExp(`Support for ${month}`));
  assert.strictEqual(recurring().getProfile(id).generated_count, 1);
});

test('auto mode: staged early, emailed on the invoice date', async () => {
  const c = client();
  const start = addDays(today(), 2);
  const id = profile({ client_id: c, start_date: start, send_mode: 'auto', stage_days: 3 });
  const before = sent.length;
  await recurring().runOnce({ now: today() });
  const inv = db().prepare('SELECT * FROM documents WHERE recurring_id = ?').get(id);
  assert.strictEqual(inv.status, 'draft');
  assert.strictEqual(inv.auto_send_on, start);
  assert.strictEqual(sent.length, before, 'not sent before its date');

  await recurring().runOnce({ now: start });
  const after = documents().getDocument(inv.id);
  assert.strictEqual(after.status, 'sent');
  assert.strictEqual(after.auto_send_on, null);
  const mail = sent[sent.length - 1];
  assert.strictEqual(mail.To, 'pay@client.test');
  assert.strictEqual(mail.Attachments[0].ContentType, 'application/pdf');
  assert.ok(after.activity.some((a) => /emailed automatically/.test(a.message)));
});

test('catch-up after downtime: missed invoices are created but old ones are not auto-sent', async () => {
  const c = client();
  const start = addDays(today(), -65);
  const id = profile({ client_id: c, start_date: start, send_mode: 'auto', stage_days: 0 });
  const before = sent.length;
  const r = await recurring().runOnce({ now: today() });
  assert.ok(r.generated >= 3, `generated ${r.generated}`);
  const invs = db().prepare('SELECT * FROM documents WHERE recurring_id = ? ORDER BY issue_date').all(id);
  const old = invs.filter((d) => d.issue_date < addDays(today(), -3));
  assert.ok(old.length >= 2);
  for (const d of old) {
    assert.strictEqual(d.status, 'draft', 'late invoices wait for review');
    assert.strictEqual(d.auto_send_on, null);
  }
  assert.ok(sent.length - before <= invs.length - old.length);
});

test('automatic send is skipped (not retried) when the client has no email', async () => {
  const c = client('');
  const id = profile({ client_id: c, start_date: today(), send_mode: 'auto', stage_days: 0 });
  await recurring().runOnce({ now: today() });
  const inv = documents().getDocument(db().prepare('SELECT id FROM documents WHERE recurring_id = ?').get(id).id);
  assert.strictEqual(inv.status, 'draft');
  assert.strictEqual(inv.auto_send_on, null);
  assert.ok(inv.activity.some((a) => /Automatic send skipped: the client has no email address/.test(a.message)));
});

test('max count stops the schedule; pausing stops generation', async () => {
  const c = client();
  const id = profile({ client_id: c, start_date: today(), frequency: 'weekly', max_count: 1, stage_days: 0 });
  await recurring().runOnce({ now: addDays(today(), 30) });
  assert.strictEqual(db().prepare('SELECT COUNT(*) n FROM documents WHERE recurring_id = ?').get(id).n, 1);
  assert.strictEqual(recurring().getProfile(id).next_date, null);

  const id2 = profile({ client_id: c, start_date: today(), stage_days: 0 });
  recurring().setActive(id2, false);
  await recurring().runOnce({ now: today() });
  assert.strictEqual(db().prepare('SELECT COUNT(*) n FROM documents WHERE recurring_id = ?').get(id2).n, 0);
});

async function req(method, p, form) {
  const headers = { cookie };
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({ _csrf: csrf, ...form }).toString();
  }
  const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
}

test('pages: create a profile from an invoice, view, edit, generate, schedule and cancel', async () => {
  await req('POST', '/login', { email: 'me@example.com', password: 'pw-for-tests-123' });
  csrf = (await (await req('GET', '/settings')).text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const c = client();

  // An ordinary invoice to start from.
  let res = await req('POST', '/invoices', { client_id: c });
  const invId = Number(res.headers.get('location').match(/\/(\d+)/)[1]);
  documents().replaceLines(invId, [{ description: 'Hosting', quantity: 1, unit_price_cents: 2500 }]);
  documents().recalc(invId);

  res = await req('GET', `/recurring/new?from=${invId}`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /Hosting/);

  res = await req('POST', '/recurring', {
    client_id: c, name: 'Hosting', subject: 'Hosting {{month}}', currency: 'CAD', frequency: 'monthly', interval_count: '1',
    start_date: addDays(today(), 10), ends: 'count', max_count: '12', send_mode: 'auto', stage_days: '5', notify_owner: '1',
    lines_json: JSON.stringify([{ description: 'Hosting', quantity: '1', unit_price: '25' }]), taxes_json: '[]',
  });
  assert.strictEqual(res.status, 302);
  const pid = Number(res.headers.get('location').match(/\/recurring\/(\d+)/)[1]);
  const p = recurring().getProfile(pid);
  assert.strictEqual(p.max_count, 12);
  assert.strictEqual(p.send_mode, 'auto');
  assert.strictEqual(p.total_cents, 2500);

  for (const url of ['/recurring', `/recurring/${pid}`, `/recurring/${pid}/edit`, '/']) {
    const r = await req('GET', url);
    assert.strictEqual(r.status, 200, url);
  }

  const before = sent.length;
  res = await req('POST', `/recurring/${pid}/generate`, {});
  const newInv = Number(res.headers.get('location').match(/\/invoices\/(\d+)/)[1]);
  const html = await (await req('GET', `/invoices/${newInv}`)).text();
  assert.match(html, /Scheduled to email automatically/);
  assert.ok(sent.length > before, 'owner notified that the invoice is ready');

  await req('POST', `/invoices/${newInv}/auto-send`, { action: 'cancel' });
  assert.strictEqual(documents().getDocument(newInv).auto_send_on, null);
  assert.match(await (await req('GET', `/invoices/${newInv}`)).text(), /Staged for your review/);

  res = await req('POST', `/invoices/${newInv}/auto-send`, { date: addDays(today(), 1) });
  assert.strictEqual(documents().getDocument(newInv).auto_send_on, addDays(today(), 1));
  assert.strictEqual(documents().getDocument(newInv).display_status, 'scheduled');

  res = await req('POST', `/recurring/${pid}/toggle`, {});
  assert.strictEqual(recurring().getProfile(pid).active, 0);
  res = await req('POST', `/recurring/${pid}/delete`, {});
  assert.strictEqual(recurring().getProfile(pid), null);
  assert.ok(documents().getDocument(newInv), 'created invoices are kept');
});
