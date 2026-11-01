#!/usr/bin/env node
'use strict';
// Command-line version of Updates -> Update now. Uses the same source (repository/branch)
// as the app. Exit code 0 = updated or already current, 1 = failed; prints "RESTART" when a
// restart is needed.
delete process.env.pm_id; // never let this short-lived process exit early to "restart"
const updater = require('../src/updater');

(async () => {
  const v = await updater.currentVersion();
  if (!v.enabled) {
    console.error(v.reason);
    process.exit(1);
  }
  console.log(`Installed ${v.sha} on ${v.branch}; updates come from ${v.source.url || 'origin'} (${v.source.branch}).`);
  updater.startUpdate();
  for (;;) {
    const j = updater.jobStatus();
    if (j && !j.running) {
      process.stdout.write(j.log.trim() + '\n');
      if (!j.ok) process.exit(1);
      if (!/Already up to date/.test(j.log)) console.log('RESTART');
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
})();
