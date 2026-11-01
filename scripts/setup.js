#!/usr/bin/env node
'use strict';
// Interactive first-time setup: writes (or updates) the .env file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const envPath = path.join(__dirname, '..', '.env');
const examplePath = path.join(__dirname, '..', '.env.example');

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise((res) => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => res(a.trim() || def || '')));

function askHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return rl.question(`${q}: `, (a) => resolve(a));
    process.stdout.write(`${q}: `);
    stdin.setRawMode(true);
    let value = '';
    const onData = (buf) => {
      const ch = buf.toString('utf8');
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const existing = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  const env = { ...parseEnv(fs.readFileSync(examplePath, 'utf8')), ...existing };

  console.log('\nInvoices setup. Press Enter to keep the value in [brackets].\n');
  env.APP_URL = (await ask('Public URL of this app (e.g. https://invoices.example.com)', env.APP_URL)).replace(/\/$/, '');
  env.PORT = await ask('Port the app listens on', env.PORT || '3000');
  env.TZ = await ask('Your time zone (IANA name)', env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone);
  env.ADMIN_EMAIL = await ask('Admin login email', env.ADMIN_EMAIL);

  if (!env.ADMIN_PASSWORD_HASH || (await ask('Change the admin password? (y/N)', 'n')).toLowerCase().startsWith('y')) {
    let pw = '';
    for (;;) {
      pw = await askHidden('Admin password (12+ characters)');
      if (pw.length < 12) { console.log('Too short, try again.'); continue; }
      const again = await askHidden('Repeat password');
      if (pw === again) break;
      console.log('Passwords did not match, try again.');
    }
    env.ADMIN_PASSWORD_HASH = hashPassword(pw);
  }
  if (!env.SESSION_SECRET) env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');

  console.log('\nPostmark (for emailing invoices). Leave blank to set up later.');
  env.POSTMARK_SERVER_TOKEN = await ask('Postmark Server API token', env.POSTMARK_SERVER_TOKEN);

  console.log('\nStripe (for online card payments). Leave blank to set up later.');
  env.STRIPE_SECRET_KEY = await ask('Stripe secret key (sk_live_… or sk_test_…)', env.STRIPE_SECRET_KEY);
  env.STRIPE_WEBHOOK_SECRET = await ask('Stripe webhook signing secret (whsec_…)', env.STRIPE_WEBHOOK_SECRET);
  rl.close();

  // Rewrite the example file's layout with our values, keeping its comments.
  const lines = fs.readFileSync(examplePath, 'utf8').split('\n').map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    return m && m[1] in env ? `${m[1]}=${env[m[1]]}` : line;
  });
  for (const [k, v] of Object.entries(env)) {
    if (!lines.some((l) => l.startsWith(`${k}=`))) lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
  console.log(`\nSaved ${envPath}. Restart the app to apply changes, then log in at ${env.APP_URL}/login\n`);
})();
