'use strict';
// Invoicing from more than one business.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'invoices-biz-'));
const sent = [];
let postmark, app, base, cookie = '', csrf = '';

process.env.ENV_FILE = path.join(tmp, 'none.env');
process.env.DATA_DIR = tmp;
process.env.APP_URL = 'http://invoices.test';
process.env.ADMIN_EMAIL = 'me@example.com';
process.env.SESSION_SECRET = 'x';
process.env.POSTMARK_SERVER_TOKEN = 'pm';
process.env.TZ = 'UTC';

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
  require('../src/settings').setMany({
    business_name: 'Main Studio', business_phone: '555-MAIN', business_email: 'main@main.test', from_email: 'billing@main.test',
    invoice_prefix: 'INV-', invoice_next_number: '100',
  });
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
const idFrom = (res) => Number(res.headers.get('location').match(/\/(\d+)/)[1]);

// Text inside a PDF's (deflated) content streams.
function pdfText(buf) {
  const s = buf.toString('latin1');
  let out = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(s))) {
    try {
      out += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      /* not deflated */
    }
  }
  return out;
}

let bizId, clientId, invId;

test('add a second business with its own numbering and sender', async () => {
  await req('POST', '/login', { email: 'me@example.com', password: 'pw-for-tests-123' });
  csrf = (await (await req('GET', '/settings')).text()).match(/name="_csrf" value="([^"]+)"/)[1];

  // No picker until there is a second business.
  assert.doesNotMatch(await (await req('GET', '/clients/new')).text(), /Bill from/);

  let res = await req('POST', '/businesses', {
    business_name: 'Side Gig Ltd', business_email: 'hi@side.test', business_address: '9 Side St',
    from_email: 'billing@side.test', accent_color: '#be185d', heading_color: '#831843',
    own_numbering: '1', invoice_prefix: 'SG-', invoice_next_number: '1', estimate_prefix: 'SGE-', estimate_next_number: '1',
    payment_instructions: 'Pay Side Gig by e-transfer',
  });
  bizId = idFrom(res);
  assert.match(await (await req('GET', '/businesses')).text(), /Side Gig Ltd/);
  assert.match(await (await req('GET', '/clients/new')).text(), /Bill from/);

  // Logo for this business only.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('_csrf', csrf);
  fd.append('logo', new Blob([png], { type: 'image/png' }), 'l.png');
  res = await fetch(`${base}/businesses/${bizId}/logo`, { method: 'POST', headers: { cookie }, body: fd, redirect: 'manual' });
  assert.match(res.headers.get('location'), /Logo%20uploaded/);
  assert.strictEqual((await fetch(`${base}/logo?b=${bizId}`)).status, 200);
  assert.strictEqual((await fetch(`${base}/logo`)).status, 404, 'main business still has no logo');
});

test("clients default to a business; invoices use that business's numbering and details", async () => {
  let res = await req('POST', '/clients', { name: 'Side Client', email: 'c@client.test', currency: 'CAD', business_id: String(bizId) });
  clientId = idFrom(res);
  res = await req('POST', '/invoices', { client_id: clientId, business_id: '' });
  invId = idFrom(res);
  const documents = require('../src/documents');
  let doc = documents.getDocument(invId);
  assert.strictEqual(doc.business_id, bizId);
  assert.strictEqual(doc.number, 'SG-1');

  // Main-business numbering is untouched.
  res = await req('POST', '/invoices', { client_id: clientId, business_id: 'main' });
  const mainInv = documents.getDocument(idFrom(res));
  assert.strictEqual(mainInv.business_id, null);
  assert.strictEqual(mainInv.number, 'INV-100');

  documents.replaceLines(invId, [{ description: 'Gig work', quantity: 2, unit_price_cents: 5000 }]);
  documents.recalc(invId);

  const html = await (await req('GET', `/invoices/${invId}`)).text();
  assert.match(html, /9 Side St/);
  assert.doesNotMatch(html, /555-MAIN/, "main business's phone is not shown");
  assert.match(html, /Pay Side Gig by e-transfer/);
  assert.match(html, /logo\?b=/);

  const pdf = pdfText(Buffer.from(await (await req('GET', `/invoices/${invId}/pdf`)).arrayBuffer()));
  assert.ok(pdf.length > 0);

  res = await req('POST', `/invoices/${invId}/send`, { purpose: 'invoice', to: 'c@client.test', subject: 'Invoice', body: 'Hi', attach_pdf: '1' });
  assert.match(res.headers.get('location'), /msg=Email/);
  const mail = sent[sent.length - 1];
  assert.match(mail.From, /"Side Gig Ltd" <billing@side\.test>/);
  assert.match(mail.Attachments[0].Name, /Side-Gig-Ltd-Invoice-SG-1\.pdf/);
  assert.match(mail.HtmlBody, /logo\?b=/);

  doc = documents.getDocument(invId);
  const pub = await (await fetch(`${base}/i/${doc.public_token}`)).text();
  assert.match(pub, /Side Gig Ltd/);
  assert.match(pub, /--accent:#be185d/);
  assert.doesNotMatch(pub, /Main Studio/);
});

test('reports and lists split by business', async () => {
  require('../src/documents').addPayment(invId, { amount_cents: 10000, method: 'cheque' });
  const year = require('../src/util').today().slice(0, 4);
  const reports = require('../src/reports');
  const all = reports.yearReport(year);
  assert.ok(all.byBusiness.some((b) => b.name === 'Side Gig Ltd' && b.total === 10000 && b.collected === 10000));
  assert.strictEqual(reports.yearReport(year, 'main').invoices.length, 0, 'the main-business invoice is still a draft');
  assert.strictEqual(reports.yearReport(year, String(bizId)).invoices.length, 1);

  let html = await (await req('GET', `/reports?business=${bizId}`)).text();
  assert.match(html, /Reports \d{4} · Side Gig Ltd/);
  html = await (await req('GET', '/reports')).text();
  assert.match(html, /By business/);
  const csv = await (await req('GET', `/reports/${year}/invoices.csv?business=${bizId}`)).text();
  assert.match(csv, /SG-1,Side Gig Ltd,Side Client/);

  html = await (await req('GET', `/invoices?business=${bizId}`)).text();
  assert.match(html, /SG-1/);
  assert.doesNotMatch(html, /INV-100/);
});

test('recurring invoices keep their business', async () => {
  const { addDays, today } = require('../src/util');
  const res = await req('POST', '/recurring', {
    client_id: clientId, business_id: String(bizId), name: 'Side retainer', subject: '{{month}}', currency: 'CAD',
    frequency: 'monthly', interval_count: '1', start_date: addDays(today(), 1), ends: 'never', send_mode: 'review', stage_days: '3',
    lines_json: JSON.stringify([{ description: 'Retainer', quantity: '1', unit_price: '100' }]), taxes_json: '[]',
  });
  const pid = Number(res.headers.get('location').match(/\/recurring\/(\d+)/)[1]);
  await require('../src/recurring').runOnce();
  const inv = require('../src/db').prepare('SELECT * FROM documents WHERE recurring_id = ?').get(pid);
  assert.strictEqual(inv.business_id, bizId);
  assert.strictEqual(inv.number, 'SG-2');
});

test('archiving hides a business from choices but keeps its invoices', async () => {
  assert.match(await (await req('GET', '/invoices/new')).text(), /Bill from/);
  await req('POST', `/businesses/${bizId}/archive`, {});
  assert.doesNotMatch(await (await req('GET', '/invoices/new')).text(), /Bill from/);
  assert.strictEqual((await req('GET', `/invoices/${invId}`)).status, 200);
});
