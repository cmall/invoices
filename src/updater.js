'use strict';
// In-app updates: fetches the checked-out branch from git, fast-forwards, reinstalls
// dependencies when they changed, then restarts (when running under PM2 or another
// process manager that restarts the app when it exits).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');

// UPDATE_GIT_DIR exists for tests; normally the app updates its own folder.
const root = process.env.UPDATE_GIT_DIR || config.root;
const LOG_LIMIT = 20000;
// The GitHub branch updates come from. Override with UPDATE_BRANCH in .env.
const TARGET = process.env.UPDATE_BRANCH || 'main';
const UPSTREAM = `origin/${TARGET}`;

async function fetchTarget() {
  // Explicit refspec so this works even in single-branch clones.
  await git('fetch', '--quiet', 'origin', `+refs/heads/${TARGET}:refs/remotes/origin/${TARGET}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: root, timeout: opts.timeout || 120000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), err }),
    );
  });
}

async function git(...args) {
  const r = await run('git', args);
  if (!r.ok) throw new Error((r.stderr || r.stdout || (r.err && r.err.message) || 'git failed').trim());
  return r.stdout.trim();
}

function canRestartItself() {
  return process.env.pm_id !== undefined || process.env.UPDATE_RESTART === 'exit';
}

function disabledReason() {
  if (process.env.UPDATES_ENABLED === '0') return 'Updates are turned off (UPDATES_ENABLED=0).';
  if (!fs.existsSync(path.join(root, '.git'))) return 'This copy was not installed with git clone, so it cannot update itself.';
  return '';
}

let lastCheck = null; // { at, behind, commits, error }

async function currentVersion() {
  const reason = disabledReason();
  if (reason) return { enabled: false, reason };
  try {
    const [sha, branch, info] = await Promise.all([
      git('rev-parse', '--short', 'HEAD'),
      git('rev-parse', '--abbrev-ref', 'HEAD'),
      git('log', '-1', '--format=%s%x09%cI'),
    ]);
    const [subject, date] = info.split('\t');
    return { enabled: true, sha, branch, target: TARGET, subject, date, canRestart: canRestartItself() };
  } catch (err) {
    return { enabled: false, reason: `git is not available: ${err.message}` };
  }
}

async function check() {
  const v = await currentVersion();
  if (!v.enabled) return { ...v, check: null };
  try {
    await fetchTarget();
    const behind = Number(await git('rev-list', '--count', `HEAD..${UPSTREAM}`));
    const ahead = Number(await git('rev-list', '--count', `${UPSTREAM}..HEAD`));
    const log = behind ? await git('log', '--format=%h%x09%s%x09%cI', '-n', '30', `HEAD..${UPSTREAM}`) : '';
    const commits = log
      ? log.split('\n').map((l) => {
          const [sha, subject, date] = l.split('\t');
          return { sha, subject, date };
        })
      : [];
    const dirty = (await git('status', '--porcelain', '--untracked-files=no')).split('\n').filter(Boolean);
    const switchBranch = v.branch !== TARGET;
    let error = '';
    if (ahead > 0) error = `This copy has ${ahead} commit(s) that are not on ${TARGET}, so it can't be updated automatically.`;
    lastCheck = { at: new Date().toISOString(), behind, ahead, commits, dirty, switchBranch, error };
  } catch (err) {
    lastCheck = { at: new Date().toISOString(), behind: 0, ahead: 0, commits: [], dirty: [], switchBranch: false, error: err.message };
  }
  return { ...v, check: lastCheck };
}

function cachedCheck() {
  return lastCheck;
}

// ----- Running an update -----

let job = null; // { id, running, ok, log, restarting, startedAt }

function append(text) {
  job.log = (job.log + text).slice(-LOG_LIMIT);
}

async function step(label, cmd, args, opts) {
  append(`\n$ ${[cmd, ...args].join(' ')}\n`);
  const r = await run(cmd, args, opts);
  append(r.stdout + r.stderr);
  if (!r.ok) throw new Error(`${label} failed`);
  return r.stdout;
}

function startUpdate() {
  if (job && job.running) return job;
  const reason = disabledReason();
  if (reason) throw new Error(reason);
  job = { id: Date.now(), running: true, ok: false, log: '', restarting: false, startedAt: new Date().toISOString() };
  (async () => {
    try {
      const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
      const dirty = (await git('status', '--porcelain', '--untracked-files=no')).trim();
      if (dirty) {
        append(`Local changes found:\n${dirty}\n`);
        throw new Error('Files in the app folder were changed by hand. Undo them (git checkout -- .) and try again.');
      }
      const before = await git('rev-parse', 'HEAD');
      await step('git fetch', 'git', ['fetch', 'origin', `+refs/heads/${TARGET}:refs/remotes/origin/${TARGET}`]);
      const isAncestor = await run('git', ['merge-base', '--is-ancestor', 'HEAD', UPSTREAM]);
      if (!isAncestor.ok) throw new Error(`The installed version is not part of ${TARGET}'s history, so it can't be fast-forwarded.`);
      if (branch === TARGET) {
        await step('git merge', 'git', ['merge', '--ff-only', UPSTREAM]);
      } else {
        append(`\nSwitching from ${branch} to ${TARGET}.\n`);
        await step('git checkout', 'git', ['checkout', '-B', TARGET, UPSTREAM]);
        await step('git branch', 'git', ['branch', `--set-upstream-to=${UPSTREAM}`, TARGET]);
      }
      const after = await git('rev-parse', 'HEAD');
      if (before === after) {
        append('\nAlready up to date.\n');
        job.ok = true;
        return;
      }
      const changed = (await git('diff', '--name-only', before, after)).split('\n');
      if (changed.some((f) => f === 'package.json' || f === 'package-lock.json')) {
        await step('npm ci', 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { timeout: 600000, env: { NODE_ENV: 'production' } });
      } else {
        append('\nDependencies unchanged; skipping npm ci.\n');
      }
      job.ok = true;
      lastCheck = null;
      if (canRestartItself()) {
        append('\nUpdate installed. Restarting…\n');
        job.restarting = true;
        setTimeout(() => process.exit(0), 1500);
      } else {
        append('\nUpdate installed. Restart the app to finish (for example: pm2 restart invoices).\n');
      }
    } catch (err) {
      append(`\nError: ${err.message}\n`);
      job.ok = false;
    } finally {
      job.running = false;
    }
  })();
  return job;
}

function jobStatus() {
  return job;
}

// Check quietly in the background a minute after start and then twice a day.
function startBackgroundChecks() {
  if (disabledReason()) return;
  const tick = () => check().catch(() => {});
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 12 * 60 * 60 * 1000).unref();
}

module.exports = { currentVersion, check, cachedCheck, startUpdate, jobStatus, startBackgroundChecks, canRestartItself };
