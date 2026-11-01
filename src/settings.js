'use strict';
const db = require('./db');

const DEFAULTS = {
  business_name: '',
  business_email: '',
  business_phone: '',
  business_address: '',
  business_website: '',
  // Email address Postmark sends from. Must be a verified Sender Signature or domain in Postmark.
  from_email: '',
  from_name: '',
  bcc_self: '1',
  default_currency: 'USD',
  payment_terms_days: '30',
  invoice_prefix: 'INV-',
  invoice_next_number: '1001',
  estimate_prefix: 'EST-',
  estimate_next_number: '1001',
  number_padding: '0',
  estimate_valid_days: '30',
  default_invoice_notes: 'Thank you for your business!',
  default_invoice_terms: '',
  default_estimate_notes: '',
  payment_instructions: '',
  accent_color: '#2f5d8a',
  // Colour of the big INVOICE/ESTIMATE title and headings on documents.
  heading_color: '#1e3a5f',
  // 'modern' (sans-serif) or 'classic' (serif) typeface on invoices.
  invoice_font: 'modern',
  logo_size: 'medium',
  paper_size: 'LETTER',
  logo_file: '',
  stripe_enabled: '1',
  reminders_enabled: '0',
  // Days after the due date to send each reminder.
  reminder_days: '3, 14, 30',
  notify_on_payment: '1',
  // In-app updates: repository (blank = the one this copy was cloned from) and branch.
  update_repo: '',
  update_branch: '',

  email_invoice_subject: 'Invoice {{number}} from {{business_name}}',
  email_invoice_body:
    'Hi {{contact_name}},\n\n' +
    'Here is invoice {{number}} for {{amount_due}}, due {{due_date}}.\n\n' +
    'You can view and pay it online here:\n{{link}}\n\n' +
    'A PDF copy is attached.\n\n' +
    'Thank you,\n{{business_name}}',

  email_estimate_subject: 'Estimate {{number}} from {{business_name}}',
  email_estimate_body:
    'Hi {{contact_name}},\n\n' +
    'Here is estimate {{number}} for {{total}}.\n\n' +
    'You can review and accept it online here:\n{{link}}\n\n' +
    'A PDF copy is attached.\n\n' +
    'Thank you,\n{{business_name}}',

  email_reminder_subject: 'Reminder: invoice {{number}} is overdue',
  email_reminder_body:
    'Hi {{contact_name}},\n\n' +
    'This is a friendly reminder that invoice {{number}} for {{amount_due}} was due on {{due_date}}.\n\n' +
    'You can view and pay it online here:\n{{link}}\n\n' +
    'If you have already sent payment, please disregard this message.\n\n' +
    'Thank you,\n{{business_name}}',

  email_receipt_subject: 'Payment received for invoice {{number}}',
  email_receipt_body:
    'Hi {{contact_name}},\n\n' +
    'We received your payment of {{payment_amount}} for invoice {{number}}. ' +
    'The remaining balance is {{amount_due}}.\n\n' +
    'You can view the invoice here:\n{{link}}\n\n' +
    'Thank you,\n{{business_name}}',
};

function getAll() {
  const out = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function get(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key];
}

function set(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value ?? ''));
}

function setMany(obj) {
  db.transaction(() => {
    for (const [k, v] of Object.entries(obj)) if (k in DEFAULTS) set(k, v);
  })();
}

module.exports = { DEFAULTS, getAll, get, set, setMany };
