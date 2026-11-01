'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../settings');
const documents = require('../documents');
const stripe = require('../stripe');
const email = require('../email');
const { renderPdf, pdfFilename } = require('../pdf');
const { formatMoney } = require('../util');

const router = express.Router();

// The main business logo, or another business's logo with ?b=<id>.
router.get('/logo', (req, res) => {
  const b = Number(req.query.b) ? require('../businesses').get(Number(req.query.b)) : null;
  const file = b ? b.logo_file : settings.get('logo_file');
  const full = file && path.join(config.dataDir, file);
  if (!full || !fs.existsSync(full)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(full);
});

function loadPublic(kind) {
  return (req, res, next) => {
    const doc = documents.getByToken(req.params.token);
    // Drafts are never visible to clients.
    if (!doc || doc.kind !== kind || doc.status === 'draft') {
      return res.status(404).render('error', { title: 'Not found', message: 'This link is not valid.' });
    }
    req.doc = doc;
    // Client pages show the branding of the business the document is from.
    res.locals.s = require('../businesses').effective(doc.business_id);
    next();
  };
}

function recordView(req) {
  const doc = req.doc;
  if (req.sessionId) return; // the owner previewing their own link
  if (!doc.viewed_at) {
    db.prepare("UPDATE documents SET viewed_at = datetime('now') WHERE id = ?").run(doc.id);
    documents.logActivity(doc.id, 'First viewed by client');
  }
}

function sendPdf(req, res) {
  return renderPdf(req.doc).then((buf) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${req.query.download ? 'attachment' : 'inline'}; filename="${pdfFilename(req.doc)}"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });
}

// Invoices
router.get('/i/:token', loadPublic('invoice'), (req, res) => {
  recordView(req);
  res.render('public/document', {
    title: `Invoice ${req.doc.number}`,
    doc: req.doc,
    canPay: stripe.isEnabled() && req.doc.balance_cents > 0 && req.doc.status !== 'void',
    cancelled: false,
  });
});

router.get('/i/:token/pdf', loadPublic('invoice'), sendPdf);

router.post('/i/:token/pay', loadPublic('invoice'), async (req, res) => {
  if (!stripe.isEnabled() || req.doc.balance_cents <= 0 || req.doc.status === 'void') {
    return res.redirect(`/i/${req.doc.public_token}`);
  }
  try {
    const session = await stripe.createCheckoutSession(req.doc);
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe checkout failed:', err.message);
    res.status(502).render('error', {
      title: 'Payment unavailable',
      message: 'Online payment is temporarily unavailable. Please try again later or use another payment method.',
    });
  }
});

router.get('/i/:token/paid', loadPublic('invoice'), async (req, res) => {
  let session = null;
  if (req.query.session_id && stripe.isEnabled()) {
    try {
      session = await stripe.retrieveAndRecord(String(req.query.session_id));
      if (Number(session.metadata?.document_id) !== req.doc.id) session = null;
    } catch (err) {
      console.error('Could not confirm Stripe session:', err.message);
    }
  }
  const doc = documents.getDocument(req.doc.id);
  res.render('public/paid', {
    title: 'Thank you',
    doc,
    amount: session && session.payment_status === 'paid' ? formatMoney(session.amount_total, doc.currency) : null,
    pending: session && session.payment_status !== 'paid',
  });
});

// Estimates
router.get('/e/:token', loadPublic('estimate'), (req, res) => {
  recordView(req);
  res.render('public/document', { title: `Estimate ${req.doc.number}`, doc: req.doc, canPay: false });
});

router.get('/e/:token/pdf', loadPublic('estimate'), sendPdf);

function respond(accepted) {
  return (req, res) => {
    const doc = req.doc;
    if (doc.status === 'sent') {
      documents.setEstimateResponse(doc.id, accepted);
      const who = String((req.body && req.body.name) || '')
        .trim()
        .slice(0, 100);
      documents.logActivity(doc.id, `${accepted ? 'Accepted' : 'Declined'} by client${who ? ` (${who})` : ''}`);
      email.notifyOwner(
        `Estimate ${doc.number} ${accepted ? 'accepted' : 'declined'} by ${doc.client.name}`,
        `${doc.client.name} ${accepted ? 'accepted' : 'declined'} estimate ${doc.number} (${formatMoney(doc.total_cents, doc.currency)})${who ? ` - signed by ${who}` : ''}.\n\n${config.appUrl}/estimates/${doc.id}`,
      );
    }
    res.redirect(303, `/e/${doc.public_token}`);
  };
}
router.post('/e/:token/accept', loadPublic('estimate'), respond(true));
router.post('/e/:token/decline', loadPublic('estimate'), respond(false));

module.exports = router;
