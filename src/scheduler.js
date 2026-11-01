'use strict';
// Hourly background jobs: stage/send recurring invoices, then overdue reminders.
const recurring = require('./recurring');
const reminders = require('./reminders');

async function tick() {
  try {
    await recurring.runOnce();
  } catch (err) {
    console.error('Recurring invoices job failed:', err);
  }
  try {
    await reminders.runOnce();
  } catch (err) {
    console.error('Reminders job failed:', err);
  }
}

function start() {
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}

module.exports = { start, tick };
