#!/usr/bin/env node
'use strict';
// Interactive first-time setup: writes (or updates) the .env file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// One stdin reader handles both normal answers and hidden password entry, so typed
// or pasted input is never lost or sent to the wrong question.
const stdin = process.stdin;
const isTTY = Boolean(stdin.isTTY);
let buffer = '';
let closed = false;
let waiter = null; // { hidden, resolve }
let hiddenValue = '';

function pump() {
  while (waiter) {
    if (waiter.hidden) {
      if (!buffer.length) return;
      const ch = buffer[0];
      buffer = buffer.slice(1);
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        process.stdout.write('\n');
        const w = waiter;
        waiter = null;
        w.resolve(hiddenValue);
        // Drop the \n of a \r\n pair.
        if (ch === '\r' && buffer[0] === '\n') buffer = buffer.slice(1);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') {
        hiddenValue = hiddenValue.slice(0, -1);
      } else {
        hiddenValue += ch;
      }
    } else {
      const i = buffer.search(/\r?\n|\r/);
      if (i === -1) {
        if (!closed) return;
        if (!buffer) {
          const w = waiter;
          waiter = null;
          return w.resolve(null);
        }
        buffer += '\n';
        continue;
      }
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i).replace(/^(\r\n|\n|\r)/, '');
      const w = waiter;
      waiter = null;
      w.resolve(line);
    }
  }
}

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buffer += chunk;
  pump();
});
stdin.on('end', () => {
  closed = true;
  pump();
});

function readAnswer(hidden) {
  return new Promise((resolve) => {
    waiter = { hidden, resolve };
    if (hidden) {
      hiddenValue = '';
      stdin.setRawMode(true);
    }
    pump();
  });
}

function endOfInput() {
  console.error('\nSetup cancelled: no more input.');
  process.exit(1);
}

async function ask(q, def) {
  process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
  const a = await readAnswer(false);
  if (a === null) endOfInput();
  if (!isTTY) process.stdout.write('\n');
  return a.trim() || def || '';
}

async function askHidden(q) {
  if (!isTTY) return ask(q);
  process.stdout.write(`${q}: `);
  return readAnswer(true);
}

(async () => {
  const existing = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  const env = { ...parseEnv(fs.readFileSync(examplePath, 'utf8')), ...existing };

  console.log('\nInvoices setup. Press Enter to keep the value in [brackets].\n');
  // Suggestions come only from your existing .env, never from the example file.
  for (;;) {
    const url = (await ask('Public URL of this app (e.g. https://invoices.example.com)', existing.APP_URL)).replace(/\/+$/, '');
    if (/^https?:\/\/[^\s/]+\.[^\s/]+/.test(url) || /^http:\/\/localhost(:\d+)?$/.test(url)) {
      env.APP_URL = url;
      break;
    }
    console.log('Enter the full address starting with https://, for example https://invoices.example.com');
  }
  env.PORT = await ask('Port the app listens on', env.PORT || '3000');
  env.TZ = await ask('Your time zone (IANA name, e.g. America/New_York)', existing.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone);
  for (;;) {
    env.ADMIN_EMAIL = await ask('Admin login email', existing.ADMIN_EMAIL);
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.ADMIN_EMAIL)) break;
    console.log('Enter a valid email address.');
  }

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
  stdin.pause();

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
