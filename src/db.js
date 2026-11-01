'use strict';
const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Each migration runs once, in order. Never edit a shipped migration; append a new one.
const migrations = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE tax_rates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    rate REAL NOT NULL,
    reg_number TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE clients (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    contact_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    cc_emails TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'CAD',
    payment_terms_days INTEGER,
    default_tax_ids TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    harvest_id INTEGER UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    hourly_rate_cents INTEGER,
    archived INTEGER NOT NULL DEFAULT 0,
    harvest_id INTEGER UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Invoices and estimates share one table; kind tells them apart.
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('invoice','estimate')),
    number TEXT NOT NULL,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    status TEXT NOT NULL DEFAULT 'draft',
    subject TEXT NOT NULL DEFAULT '',
    po_number TEXT NOT NULL DEFAULT '',
    issue_date TEXT NOT NULL,
    due_date TEXT,
    currency TEXT NOT NULL,
    discount_percent REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    terms TEXT NOT NULL DEFAULT '',
    public_token TEXT NOT NULL UNIQUE,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    paid_cents INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    viewed_at TEXT,
    paid_at TEXT,
    accepted_at TEXT,
    declined_at TEXT,
    voided_at TEXT,
    last_reminder_at TEXT,
    reminder_count INTEGER NOT NULL DEFAULT 0,
    source_estimate_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    converted_invoice_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    harvest_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, number),
    UNIQUE (kind, harvest_id)
  );
  CREATE INDEX documents_client ON documents(client_id);
  CREATE INDEX documents_kind_status ON documents(kind, status);

  CREATE TABLE line_items (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    item_date TEXT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'Service',
    description TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 1,
    unit_price_cents INTEGER NOT NULL DEFAULT 0,
    taxable INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX line_items_document ON line_items(document_id);

  -- Taxes are copied onto each document so later rate changes never alter old invoices.
  CREATE TABLE document_taxes (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    tax_rate_id INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    rate REAL NOT NULL,
    reg_number TEXT NOT NULL DEFAULT '',
    -- Set only for imported documents, so totals match the source system exactly.
    fixed_amount_cents INTEGER
  );

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL,
    paid_date TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'other',
    reference TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    stripe_session_id TEXT UNIQUE,
    harvest_id INTEGER UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX payments_document ON payments(document_id);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX activity_document ON activity(document_id);

  CREATE TABLE email_log (
    id INTEGER PRIMARY KEY,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    purpose TEXT NOT NULL,
    recipients TEXT NOT NULL,
    subject TEXT NOT NULL,
    postmark_message_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  -- Recurring invoice profiles: a template plus a schedule.
  CREATE TABLE recurring (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    po_number TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL,
    discount_percent REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    terms TEXT NOT NULL DEFAULT '',
    lines_json TEXT NOT NULL DEFAULT '[]',
    taxes_json TEXT NOT NULL DEFAULT '[]',
    frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
    interval_count INTEGER NOT NULL DEFAULT 1,
    start_date TEXT NOT NULL,
    end_date TEXT,
    max_count INTEGER,
    generated_count INTEGER NOT NULL DEFAULT 0,
    next_date TEXT,
    -- 'review': staged as a draft for you to send; 'auto': sent automatically on the invoice date.
    send_mode TEXT NOT NULL DEFAULT 'review' CHECK (send_mode IN ('review','auto')),
    stage_days INTEGER NOT NULL DEFAULT 3,
    notify_owner INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    last_generated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE documents ADD COLUMN recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL;
  -- When set on a draft invoice, it is emailed automatically on this date.
  ALTER TABLE documents ADD COLUMN auto_send_on TEXT;
  `,
];

function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (let i = current; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

migrate();

module.exports = db;
