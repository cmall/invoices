'use strict';
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const COOKIE = 'inv_session';
const SESSION_DAYS = 30;

let secret = config.sessionSecret;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set: using a temporary one (you will be logged out on restart).');
}

// Password hashes look like: scrypt$<salt hex>$<hash hex>
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(value, maxAgeSeconds) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

function createSession(res) {
  const id = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)').run(sha256(id), Date.now() + SESSION_DAYS * 86400000);
  res.setHeader('Set-Cookie', cookieString(id, SESSION_DAYS * 86400));
}

function destroySession(req, res) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(id));
  res.setHeader('Set-Cookie', cookieString('', 0));
}

// Populates req.sessionId (raw cookie value) and res.locals.loggedIn.
function loadSession(req, res, next) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (id) {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(id));
    if (row && row.expires_at > Date.now()) {
      req.sessionId = id;
      res.locals.csrfToken = csrfToken(id);
    }
  }
  res.locals.loggedIn = Boolean(req.sessionId);
  if (!res.locals.csrfToken) res.locals.csrfToken = '';
  next();
}

function requireAuth(req, res, next) {
  if (req.sessionId) return next();
  if (req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.status(401).send('Not logged in');
}

function csrfToken(sessionId) {
  return crypto.createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

function checkCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const expected = req.sessionId ? csrfToken(req.sessionId) : '';
  if (expected && sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
    return next();
  }
  return res.status(403).send('Invalid form token. Go back, reload the page and try again.');
}

// Simple in-memory login throttle: 10 failures per 15 minutes per IP.
const failures = new Map();
function loginAllowed(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) return true;
  return f.count < 10;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60000 });
  else f.count++;
}
function clearFailures(ip) {
  failures.delete(ip);
}

function checkLogin(email, password) {
  if (!config.adminPasswordHash) return false;
  const emailOk = !config.adminEmail || String(email).trim().toLowerCase() === config.adminEmail.trim().toLowerCase();
  const passOk = verifyPassword(password, config.adminPasswordHash);
  return emailOk && passOk;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadSession,
  requireAuth,
  checkCsrf,
  loginAllowed,
  recordFailure,
  clearFailures,
  checkLogin,
};
