'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
require('./db');
const auth = require('./auth');
const settings = require('./settings');
const util = require('./util');
const stripe = require('./stripe');
const reminders = require('./reminders');
const updater = require('./updater');

// Fingerprint of the CSS/JS so browsers fetch fresh copies after every update.
function assetVersion() {
  const hash = require('crypto').createHash('sha1');
  for (const f of ['app.css', 'app.js']) {
    try {
      hash.update(require('fs').readFileSync(path.join(config.root, 'public', f)));
    } catch {
      /* missing file: ignore */
    }
  }
  return hash.digest('hex').slice(0, 10);
}

function createApp() {
  const assetV = assetVersion();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Stripe needs the raw body to verify the signature, so this comes before the form parser.
  app.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    try {
      await stripe.handleWebhook(req.body, req.get('stripe-signature'));
      res.json({ received: true });
    } catch (err) {
      console.error('Stripe webhook error:', err.message);
      res.status(400).send(`Webhook error: ${err.message}`);
    }
  });

  app.use(express.urlencoded({ extended: false, limit: '2mb', parameterLimit: 5000 }));
  app.use(
    '/static/fonts',
    express.static(path.join(config.root, 'node_modules/@fontsource-variable/inter/files'), { maxAge: '30d', immutable: true }),
  );
  app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: config.isProduction ? '7d' : 0 }));
  app.use(auth.loadSession);

  app.use((req, res, next) => {
    res.locals.s = settings.getAll();
    res.locals.u = util;
    res.locals.v = assetV;
    res.locals.path = req.path;
    const uc = updater.cachedCheck();
    res.locals.updateAvailable = Boolean(uc && uc.behind > 0);
    res.locals.flash = req.query.msg ? String(req.query.msg).slice(0, 300) : '';
    res.locals.flashError = req.query.err ? String(req.query.err).slice(0, 300) : '';
    res.locals.config = { postmark: Boolean(config.postmarkToken), stripe: Boolean(config.stripeSecretKey), stripeWebhook: Boolean(config.stripeWebhookSecret), appUrl: config.appUrl };
    next();
  });

  app.use(require('./routes/public'));
  app.use(require('./routes/admin'));

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: config.isProduction ? 'An unexpected error occurred.' : err.message });
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(config.port, config.host, () => {
    console.log(`Invoices running on http://${config.host}:${config.port} (public URL ${config.appUrl})`);
    if (!config.adminPasswordHash) console.warn('ADMIN_PASSWORD_HASH is not set. Run "npm run setup" to create one.');
  });
  if (!config.disableScheduler) {
    reminders.start();
    updater.startBackgroundChecks();
  }
}

module.exports = { createApp };
