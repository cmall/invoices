#!/usr/bin/env node
'use strict';
// Writes a consistent copy of the database to data/backups and keeps the newest 30.
// Run it from cron, e.g.:  15 3 * * *  cd /path/to/app && npm run backup --silent
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');

(async () => {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `invoices-${stamp}.db`);
  await db.backup(file);
  const keep = Number(process.env.BACKUP_KEEP || 30);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('invoices-') && f.endsWith('.db')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, old));
  console.log(`Backup written to ${file}`);
})();
