'use strict';
const crypto = require('crypto');

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CHF'];

const formatters = new Map();
function formatMoney(cents, currency = 'CAD') {
  const key = currency;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat('en-CA', { style: 'currency', currency }));
  }
  return formatters.get(key).format((cents || 0) / 100);
}

// "1,234.50" / "$1234.5" / "" -> integer cents. Returns null for blank input.
function parseMoney(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

function parseNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(value ?? '').trim() !== '' ? n : fallback;
}

// Today's date (YYYY-MM-DD) in the configured time zone (process.env.TZ).
function today() {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T12:00:00Z`);
  const b = Date.parse(`${toIso}T12:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function formatShortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// SQLite datetime('now') strings are UTC without a zone marker.
function formatDateTime(sqliteUtc) {
  if (!sqliteUtc) return '';
  const d = new Date(`${String(sqliteUtc).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return sqliteUtc;
  return d.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function formatQuantity(q) {
  const n = Number(q) || 0;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

function formatRate(rate) {
  return `${Math.round(Number(rate) * 1000) / 1000}%`;
}

// Simple {{placeholder}} substitution for email templates.
function fillTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : m,
  );
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function splitEmails(s) {
  return String(s || '')
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

module.exports = {
  CURRENCIES,
  formatMoney,
  parseMoney,
  centsToInput,
  parseNumber,
  today,
  addDays,
  daysBetween,
  isIsoDate,
  formatDate,
  formatShortDate,
  formatDateTime,
  randomToken,
  formatQuantity,
  formatRate,
  fillTemplate,
  escapeHtml,
  splitEmails,
};
