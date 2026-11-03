'use strict';
// Payment receipts: a PDF per payment, emailed to the client on demand or automatically.
const db = require('./db');
const documents = require('./documents');
const email = require('./email');
const { renderReceiptPdf, receiptFilename, receiptNumber } = require('./pdf');
const { formatMoney, formatDate, splitEmails } = require('./util');

const METHOD_LABELS = { stripe: 'card', etransfer: 'e-transfer', bank: 'bank transfer', cheque: 'cheque', cash: 'cash', other: 'payment' };

function findPayment(doc, paymentId) {
  return (doc.payments || []).find((p) => p.id === Number(paymentId)) || null;
}

// Email fields pre-filled from the receipt template in Settings.
function defaults(doc, payment) {
  return email.defaultsFor('receipt', doc, {
    payment_amount: formatMoney(payment.amount_cents, doc.currency),
    payment_date: formatDate(payment.paid_date),
    payment_method: METHOD_LABELS[payment.method] || 'payment',
    receipt_number: receiptNumber(doc, payment),
  });
}

async function send(doc, payment, fields = {}) {
  const d = defaults(doc, payment);
  const to = fields.to !== undefined ? fields.to : d.to;
  const cc = fields.cc !== undefined ? fields.cc : d.cc;
  const attach = fields.attachPdf !== false;
  const attachments = attach ? [{ name: receiptFilename(doc, payment), content: await renderReceiptPdf(doc, payment) }] : null;
  await email.sendDocumentEmail(doc, {
    purpose: 'receipt',
    to,
    cc,
    subject: fields.subject || d.subject,
    body: fields.body !== undefined ? fields.body : d.body,
    attachPdf: false,
    attachments,
  });
  db.prepare("UPDATE payments SET receipt_sent_at = datetime('now') WHERE id = ?").run(payment.id);
  documents.logActivity(
    doc.id,
    `Receipt ${receiptNumber(doc, payment)} for ${formatMoney(payment.amount_cents, doc.currency)} emailed to ${splitEmails(to).concat(splitEmails(cc)).join(', ')}`,
  );
}

module.exports = { findPayment, defaults, send };
