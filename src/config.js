'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envFile = process.env.ENV_FILE || path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const dataDir = path.resolve(root, env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

const config = {
  root,
  dataDir,
  dbFile: path.join(dataDir, env.DB_FILE || 'invoices.db'),
  appUrl: (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  port: Number(env.PORT || 3000),
  // 127.0.0.1 behind a reverse proxy; set HOST=0.0.0.0 in Docker.
  host: env.HOST || '127.0.0.1',
  adminEmail: env.ADMIN_EMAIL || '',
  adminPasswordHash: env.ADMIN_PASSWORD_HASH || '',
  sessionSecret: env.SESSION_SECRET || '',
  postmarkToken: env.POSTMARK_SERVER_TOKEN || '',
  postmarkStream: env.POSTMARK_MESSAGE_STREAM || 'outbound',
  postmarkApiUrl: env.POSTMARK_API_URL || 'https://api.postmarkapp.com',
  stripeSecretKey: env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  isProduction: env.NODE_ENV === 'production',
  disableScheduler: env.DISABLE_SCHEDULER === '1',
};

config.secureCookies = config.appUrl.startsWith('https://');

module.exports = config;
