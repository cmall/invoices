'use strict';
const db = require('./db');
const config = require('./config');
const settings = require('./settings');
const { renderPdf, pdfFilename, publicUrl } = require('./pdf');
const { formatMoney, formatDate, fillTemplate, escapeHtml, splitEmails } = require('./util');

function isConfigured() {
  return Boolean(config.postmarkToken && settings.get('from_email'));
}

function templateVars(doc, extra = {}) {
  const s = settings.getAll();
  const c = doc.client || {};
  return {
    business_name: s.business_name,
    client_name: c.name,
    contact_name: c.contact_name || c.name,
    number: doc.number,
    subject: doc.subject,
    total: formatMoney(doc.total_cents, doc.currency),
    amount_due: formatMoney(doc.total_cents - doc.paid_cents, doc.currency),
    due_date: formatDate(doc.due_date),
    issue_date: formatDate(doc.issue_date),
    link: publicUrl(doc),
    ...extra,
  };
}

function defaultsFor(purpose, doc, extra) {
  const s = settings.getAll();
  const vars = templateVars(doc, extra);
  const subject = s[`email_${purpose}_subject`];
  const body = s[`email_${purpose}_body`];
  return {
    to: doc.client.email,
    cc: doc.client.cc_emails,
    subject: fillTemplate(subject, vars),
    body: fillTemplate(body, vars),
  };
}

function textToHtml(text, buttonLabel, buttonUrl, accent, logoUrl, businessName) {
  const linked = escapeHtml(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    (u) => `<a href="${u}" style="color:${accent}">${u}</a>`,
  );
  const paragraphs = linked
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = buttonUrl
    ? `<p style="margin:24px 0"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">${escapeHtml(buttonLabel)}</a></p>`
    : '';
  const header = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" style="max-height:56px;max-width:220px;display:block;margin:0 0 24px">`
    : businessName
      ? `<div style="font-size:18px;font-weight:700;margin:0 0 24px">${escapeHtml(businessName)}</div>`
      : '';
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;font-size:15px;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border-top:4px solid ${accent};padding:32px">${header}${paragraphs}${button}</div>
</body></html>`;
}

async function postmarkSend(message) {
  if (!config.postmarkToken) throw new Error('POSTMARK_SERVER_TOKEN is not set');
  const res = await fetch(`${config.postmarkApiUrl}/email`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': config.postmarkToken,
    },
    body: JSON.stringify({ MessageStream: config.postmarkStream, ...message }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.ErrorCode && body.ErrorCode !== 0)) {
    throw new Error(`Postmark error ${body.ErrorCode ?? res.status}: ${body.Message || res.statusText}`);
  }
  return body;
}

function fromHeader() {
  const s = settings.getAll();
  const name = (s.from_name || s.business_name || '').replace(/["<>]/g, '');
  return name ? `"${name}" <${s.from_email}>` : s.from_email;
}

// Sends an email about a document (invoice, estimate, reminder, receipt), logging the result.
async function sendDocumentEmail(doc, { purpose, to, cc, subject, body, attachPdf = true }) {
  const s = settings.getAll();
  const toList = splitEmails(to);
  const ccList = splitEmails(cc);
  if (!toList.length) throw new Error('No valid recipient email address');
  if (!s.from_email) throw new Error('Set a "From" email address in Settings first');

  const accent = /^#[0-9a-f]{6}$/i.test(s.accent_color) ? s.accent_color : '#2f5d8a';
  let buttonLabel = 'View invoice';
  if (doc.kind === 'estimate') buttonLabel = 'View estimate';
  else if (doc.total_cents - doc.paid_cents > 0 && doc.status !== 'void' && config.stripeSecretKey && s.stripe_enabled === '1') {
    buttonLabel = 'View and pay invoice';
  }

  const message = {
    From: fromHeader(),
    To: toList.join(', '),
    Subject: subject,
    TextBody: body,
    HtmlBody: textToHtml(body, buttonLabel, publicUrl(doc), accent, s.logo_file ? `${config.appUrl}/logo?v=${encodeURIComponent(s.logo_file)}` : '', s.business_name),
    ReplyTo: s.business_email || s.from_email,
    Tag: purpose,
    TrackOpens: true,
    Metadata: { document_id: String(doc.id), purpose },
  };
  if (ccList.length) message.Cc = ccList.join(', ');
  if (s.bcc_self === '1' && (s.business_email || s.from_email)) message.Bcc = s.business_email || s.from_email;
  if (attachPdf) {
    const pdf = await renderPdf(doc);
    message.Attachments = [{ Name: pdfFilename(doc), Content: pdf.toString('base64'), ContentType: 'application/pdf' }];
  }

  const recipients = [...toList, ...ccList].join(', ');
  try {
    const result = await postmarkSend(message);
    db.prepare(
      'INSERT INTO email_log (document_id, purpose, recipients, subject, postmark_message_id) VALUES (?, ?, ?, ?, ?)',
    ).run(doc.id, purpose, recipients, subject, result.MessageID || null);
    return result;
  } catch (err) {
    db.prepare('INSERT INTO email_log (document_id, purpose, recipients, subject, error) VALUES (?, ?, ?, ?, ?)').run(
      doc.id,
      purpose,
      recipients,
      subject,
      err.message,
    );
    throw err;
  }
}

// Plain notification to the business owner (e.g. "payment received").
async function notifyOwner(subject, text) {
  const s = settings.getAll();
  const to = s.business_email || s.from_email;
  if (!config.postmarkToken || !s.from_email || !to) return;
  try {
    await postmarkSend({ From: fromHeader(), To: to, Subject: subject, TextBody: text, Tag: 'owner-notification' });
  } catch (err) {
    console.error('Owner notification failed:', err.message);
  }
}

module.exports = { isConfigured, templateVars, defaultsFor, sendDocumentEmail, notifyOwner, postmarkSend };
