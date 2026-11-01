'use strict';
const Stripe = require('stripe');
const db = require('./db');
const config = require('./config');
const settings = require('./settings');
const documents = require('./documents');
const email = require('./email');
const { publicUrl } = require('./pdf');
const { formatMoney, today } = require('./util');

let client = null;
function stripe() {
  if (!config.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not set');
  if (!client) client = Stripe(config.stripeSecretKey);
  return client;
}

function isEnabled() {
  return Boolean(config.stripeSecretKey) && settings.get('stripe_enabled') === '1';
}

async function createCheckoutSession(doc) {
  const balance = doc.total_cents - doc.paid_cents;
  if (balance <= 0) throw new Error('Nothing to pay');
  const s = require('./businesses').effective(doc.business_id);
  const url = publicUrl(doc);
  const description = `${s.business_name ? `${s.business_name} ` : ''}invoice ${doc.number}`;
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: doc.currency.toLowerCase(),
          unit_amount: balance,
          product_data: { name: `Invoice ${doc.number}`, description: doc.subject || undefined },
        },
      },
    ],
    customer_email: (doc.client.email || '').split(/[,;\s]/)[0] || undefined,
    client_reference_id: String(doc.id),
    metadata: { document_id: String(doc.id), invoice_number: doc.number },
    payment_intent_data: {
      description,
      metadata: { document_id: String(doc.id), invoice_number: doc.number },
    },
    success_url: `${url}/paid?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: url,
  });
  return session;
}

// Records a completed Checkout Session as a payment. Safe to call more than once per session.
async function recordSession(session) {
  if (!session || session.payment_status !== 'paid') return false;
  const documentId = Number(session.metadata?.document_id || session.client_reference_id);
  const doc = documentId && documents.getDocument(documentId);
  if (!doc) return false;
  if (db.prepare('SELECT 1 FROM payments WHERE stripe_session_id = ?').get(session.id)) return false;
  if (String(session.currency).toUpperCase() !== doc.currency) {
    console.warn(`Stripe session ${session.id} currency ${session.currency} does not match invoice ${doc.number}`);
  }

  try {
    documents.addPayment(doc.id, {
      amount_cents: session.amount_total,
      paid_date: today(),
      method: 'stripe',
      reference: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || session.id,
      stripe_session_id: session.id,
    });
  } catch (err) {
    // Unique constraint: the webhook and the success page raced; the other one recorded it.
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return false;
    throw err;
  }
  const amount = formatMoney(session.amount_total, doc.currency);
  documents.logActivity(doc.id, `Paid ${amount} online by card`);

  // Emails are best effort and must not fail the webhook.
  const updated = documents.getDocument(doc.id);
  const s = settings.getAll();
  if (email.isConfigured() && updated.client.email) {
    const d = email.defaultsFor('receipt', updated, { payment_amount: amount });
    email
      .sendDocumentEmail(updated, { purpose: 'receipt', ...d, attachPdf: false })
      .then(() => documents.logActivity(doc.id, 'Payment receipt emailed'))
      .catch((err) => console.error('Receipt email failed:', err.message));
  }
  if (s.notify_on_payment === '1') {
    email.notifyOwner(
      `Payment received: ${amount} for invoice ${doc.number}`,
      `${doc.client.name} paid ${amount} on invoice ${doc.number}.\n\nBalance remaining: ${formatMoney(
        updated.balance_cents,
        doc.currency,
      )}\n\n${config.appUrl}/invoices/${doc.id}`,
    );
  }
  return true;
}

async function retrieveAndRecord(sessionId) {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  await recordSession(session);
  return session;
}

async function handleWebhook(rawBody, signature) {
  if (!config.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  const event = stripe().webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await recordSession(event.data.object);
  }
  return event;
}

module.exports = { isEnabled, createCheckoutSession, recordSession, retrieveAndRecord, handleWebhook };
