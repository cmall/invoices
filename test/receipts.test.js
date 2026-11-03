'use strict';
// Payment receipts: PDF, sending on demand, sending when recording a payment, online payments.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'invoices-receipts-'));
const sent = [];
let postmark, app, base, cookie = '', csrf = '';

process.env.ENV_FILE = path.join(tmp, 'none.env');
process.env.DATA_DIR = tmp;
process.env.APP_URL = 'http://invoices.test';
process.env.ADMIN_EMAIL = 'me@example.com';
process.env.SESSION_SECRET = 'x';
process.env.POSTMARK_SERVER_TOKEN = 'pm';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
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
  require('../src/settings').setMany({ business_name: 'Acme', from_email: 'billing@acme.test', bcc_self: '0' });
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

const documents = () => require('../src/documents');
let invId;

test('setup: an invoice that has been sent', async () => {
  await req('POST', '/login', { email: 'me@example.com', password: 'pw-for-tests-123' });
  csrf = (await (await req('GET', '/settings')).text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const cid = Number(require('../src/db').prepare("INSERT INTO clients (name, email, currency) VALUES ('Globex', 'ap@globex.test', 'CAD')").run().lastInsertRowid);
  invId = documents().createDocument('invoice', cid, { subject: 'Website' });
  documents().replaceLines(invId, [{ description: 'Build', quantity: 1, unit_price_cents: 100000 }]);
  documents().replaceTaxes(invId, [{ name: 'GST', rate: 5, reg_number: '123456789 RT0001' }]);
  documents().recalc(invId);
  documents().markSent(invId);
});

test('recording a payment can email a receipt with a receipt PDF', async () => {
  const html = await (await req('GET', `/invoices/${invId}`)).text();
  assert.match(html, /Email a receipt to ap@globex\.test/);

  const before = sent.length;
  const res = await req('POST', `/invoices/${invId}/payments`, { amount: '400', paid_date: '2026-11-02', method: 'etransfer', reference: 'ET-77', send_receipt: '1' });
  assert.match(res.headers.get('location'), /receipt%20emailed/);
  assert.strictEqual(sent.length, before + 1);
  const mail = sent[sent.length - 1];
  assert.strictEqual(mail.To, 'ap@globex.test');
  assert.match(mail.Subject, /Payment received for invoice/);
  assert.match(mail.TextBody, /e-transfer payment of \$400\.00 on November 2, 2026/);
  assert.match(mail.TextBody, /remaining balance is \$650\.00/);
  assert.match(mail.Attachments[0].Name, /Acme-Receipt-INV-\d+-R1\.pdf/);
  assert.strictEqual(Buffer.from(mail.Attachments[0].Content, 'base64').subarray(0, 4).toString(), '%PDF');
  assert.doesNotMatch(mail.HtmlBody, /View and pay invoice/, 'receipt button does not ask to pay');

  const p = documents().getDocument(invId).payments[0];
  assert.ok(p.receipt_sent_at);
  assert.match(await (await req('GET', `/invoices/${invId}`)).text(), /Receipt sent/);
});

test('a payment recorded without the checkbox sends nothing', async () => {
  const before = sent.length;
  await req('POST', `/invoices/${invId}/payments`, { amount: '100', method: 'cheque' });
  assert.strictEqual(sent.length, before);
  assert.strictEqual(documents().getDocument(invId).payments[1].receipt_sent_at, null);
});

test('send (or resend) a receipt for any payment, with an editable message', async () => {
  const p = documents().getDocument(invId).payments[1];
  let res = await req('GET', `/invoices/${invId}/payments/${p.id}/receipt`);
  assert.strictEqual(res.status, 200);
  const page = await res.text();
  assert.match(page, /Send receipt/);
  assert.match(page, /\$100\.00/);

  res = await req('GET', `/invoices/${invId}/payments/${p.id}/receipt.pdf`);
  assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /Receipt-INV-\d+-R2\.pdf/);

  const before = sent.length;
  res = await req('POST', `/invoices/${invId}/payments/${p.id}/receipt`, {
    to: 'ap@globex.test', cc: 'boss@globex.test', subject: 'Your receipt', body: 'Thanks for the cheque!', attach_pdf: '1',
  });
  assert.match(res.headers.get('location'), /Receipt%20sent/);
  const mail = sent[before];
  assert.strictEqual(mail.Subject, 'Your receipt');
  assert.strictEqual(mail.Cc, 'boss@globex.test');
  assert.strictEqual(mail.TextBody, 'Thanks for the cheque!');
  assert.match(mail.Attachments[0].Name, /R2\.pdf/);
  assert.ok(documents().getDocument(invId).payments[1].receipt_sent_at);
  assert.ok(documents().getDocument(invId).activity.some((a) => /Receipt INV-\d+-R2 for \$100\.00 emailed/.test(a.message)));

  assert.strictEqual((await req('GET', `/invoices/${invId}/payments/99999/receipt`)).status, 404);
});

test('online payments email a receipt automatically (and can be turned off)', async () => {
  const Stripe = require('stripe');
  const stripe = Stripe('sk_test_dummy');
  const doc = documents().getDocument(invId);
  const hook = async (id, amount) => {
    const payload = JSON.stringify({
      id: `evt_${id}`, object: 'event', type: 'checkout.session.completed',
      data: { object: { id, object: 'checkout.session', payment_status: 'paid', amount_total: amount, currency: 'cad', payment_intent: `pi_${id}`, metadata: { document_id: String(doc.id) } } },
    });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
    return fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
  };

  require('../src/settings').set('auto_receipt_online', '0');
  let before = sent.length;
  await hook('cs_off', 10000);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!sent.slice(before).some((m) => m.To === 'ap@globex.test'), 'no client receipt when turned off');

  require('../src/settings').set('auto_receipt_online', '1');
  before = sent.length;
  await hook('cs_on', 45000);
  await new Promise((r) => setTimeout(r, 400));
  const receipt = sent.slice(before).find((m) => m.To === 'ap@globex.test');
  assert.ok(receipt, 'client receipt sent');
  assert.match(receipt.TextBody, /card payment of \$450\.00/);
  assert.match(receipt.Attachments[0].Name, /Receipt-INV-\d+-R4\.pdf/);
  assert.strictEqual(documents().getDocument(invId).status, 'paid');
});

// Characters drawn in a PDF: pdfkit writes text as hex strings inside (deflated) content streams.
function drawnBytes(buf) {
  const zlib = require('zlib');
  const s = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(s))) {
    let content;
    try {
      content = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const h of content.match(/<([0-9a-fA-F]+)>/g) || []) {
      // PDF readers pad an odd-length hex string with 0 (so "41d" reads as 0x41 0xD0, a stray "Ð").
      const hex = h.slice(1, -1);
      out.push(...Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex'));
    }
  }
  return out;
}

test('addresses typed with Windows line breaks print cleanly; website shown without https://', async () => {
  const db = require('../src/db');
  const { renderPdf, renderReceiptPdf } = require('../src/pdf');
  require('../src/settings').setMany({ business_address: '3876 Pandora St\r\nBurnaby BC\r\nV5C 2A5', business_website: 'https://rosser.example/' });
  const cid = Number(db.prepare('INSERT INTO clients (name, address, currency) VALUES (?, ?, ?)').run('Client', '724 Lorimer Road\r\nVictoria, BC\r\nV9B 6G3', 'CAD').lastInsertRowid);
  const id = documents().createDocument('invoice', cid);
  documents().replaceLines(id, [{ description: 'Work\r\nmore work', quantity: 1, unit_price_cents: 1000 }]);
  documents().recalc(id);
  documents().markSent(id);
  documents().addPayment(id, { amount_cents: 1000, method: 'etransfer' });
  const doc = documents().getDocument(id);
  for (const buf of [await renderPdf(doc), await renderReceiptPdf(doc, doc.payments[0])]) {
    const bytes = drawnBytes(buf);
    assert.ok(bytes.length > 100, 'found drawn text');
    assert.ok(!bytes.some((b) => b < 0x20 || b === 0xd0), 'no control characters or stray Ð drawn');
  }
  const html = await (await req('GET', `/invoices/${id}`)).text();
  assert.match(html, /<div>rosser\.example<\/div>/);
  assert.doesNotMatch(html, /https:\/\/rosser\.example/);

  // New form input is normalised before it is saved.
  await req('POST', '/clients', { name: 'Typed', address: 'Line 1\r\nLine 2', currency: 'CAD' });
  assert.strictEqual(db.prepare("SELECT address FROM clients WHERE name = 'Typed'").get().address, 'Line 1\nLine 2');
});
