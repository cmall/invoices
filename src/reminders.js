'use strict';
const db = require('./db');
const settings = require('./settings');
const documents = require('./documents');
const email = require('./email');
const { today, daysBetween } = require('./util');

function reminderSchedule() {
  return String(settings.get('reminder_days') || '')
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
}

// Returns invoices that should get a reminder today, with the reminder index due.
function dueReminders() {
  const schedule = reminderSchedule();
  if (!schedule.length) return [];
  const t = today();
  const rows = db
    .prepare(
      `SELECT id, due_date, reminder_count, last_reminder_at FROM documents
       WHERE kind = 'invoice' AND status IN ('sent','partial') AND due_date IS NOT NULL AND due_date < ?
         AND total_cents > paid_cents`,
    )
    .all(t);
  return rows.filter((r) => {
    if (r.reminder_count >= schedule.length) return false;
    const overdueDays = daysBetween(r.due_date, t);
    if (overdueDays < schedule[r.reminder_count]) return false;
    // Never more than one reminder per day, even if several thresholds have passed.
    if (r.last_reminder_at && r.last_reminder_at.slice(0, 10) === t) return false;
    return true;
  });
}

async function sendReminder(id) {
  const doc = documents.getDocument(id);
  if (!doc || !doc.client.email) return false;
  const d = email.defaultsFor('reminder', doc);
  await email.sendDocumentEmail(doc, { purpose: 'reminder', ...d, attachPdf: true });
  db.prepare('UPDATE documents SET reminder_count = reminder_count + 1, last_reminder_at = ? WHERE id = ?').run(today(), id);
  documents.logActivity(id, `Overdue reminder #${doc.reminder_count + 1} emailed to ${d.to}`);
  return true;
}

let running = false;
async function runOnce() {
  if (running) return;
  running = true;
  try {
    if (settings.get('reminders_enabled') !== '1' || !email.isConfigured()) return;
    for (const r of dueReminders()) {
      try {
        await sendReminder(r.id);
      } catch (err) {
        console.error(`Reminder for document ${r.id} failed:`, err.message);
        // Record the attempt so a broken address does not retry every hour.
        db.prepare('UPDATE documents SET last_reminder_at = ? WHERE id = ?').run(today(), r.id);
        documents.logActivity(r.id, `Overdue reminder failed: ${err.message}`);
      }
    }
  } finally {
    running = false;
  }
}

function start() {
  setTimeout(runOnce, 30 * 1000).unref();
  setInterval(runOnce, 60 * 60 * 1000).unref();
}

module.exports = { start, runOnce, dueReminders, sendReminder, reminderSchedule };
