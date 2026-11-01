'use strict';
// Exercises the in-app updater against throwaway git repositories.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'invoices-updater-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const origin = path.join(tmp, 'origin.git');
const dev = path.join(tmp, 'dev');
const server = path.join(tmp, 'server');

Object.assign(process.env, env);
process.env.ENV_FILE = path.join(tmp, 'none.env');
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPDATE_GIT_DIR = server;
process.env.UPDATE_BRANCH = 'main';
delete process.env.pm_id;
delete process.env.UPDATE_RESTART;

const updater = require('../src/updater');

async function waitForJob() {
  for (let i = 0; i < 100; i++) {
    const j = updater.jobStatus();
    if (j && !j.running) return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('update did not finish');
}

test.before(() => {
  git(tmp, 'init', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', origin, dev);
  fs.writeFileSync(path.join(dev, 'app.txt'), 'v1\n');
  git(dev, 'add', '.');
  git(dev, 'commit', '-m', 'v1');
  git(dev, 'push', 'origin', 'HEAD:main', 'HEAD:old-branch');
  // The "server" was installed from the old branch.
  git(tmp, 'clone', '-b', 'old-branch', origin, server);
  fs.writeFileSync(path.join(dev, 'app.txt'), 'v2\n');
  git(dev, 'commit', '-am', 'v2: new feature');
  git(dev, 'push', 'origin', 'HEAD:main');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('check finds new commits on main', async () => {
  const r = await updater.check();
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.branch, 'old-branch');
  assert.strictEqual(r.check.error, '');
  assert.strictEqual(r.check.behind, 1);
  assert.strictEqual(r.check.switchBranch, true);
  assert.strictEqual(r.check.commits[0].subject, 'v2: new feature');
});

test('refuses to update when tracked files were edited', async () => {
  fs.writeFileSync(path.join(server, 'app.txt'), 'hand edit\n');
  updater.startUpdate();
  const job = await waitForJob();
  assert.strictEqual(job.ok, false);
  assert.match(job.log, /changed by hand/);
  git(server, 'checkout', '--', '.');
});

test('update fast-forwards and switches to main', async () => {
  updater.startUpdate();
  const job = await waitForJob();
  assert.strictEqual(job.ok, true, job.log);
  assert.strictEqual(git(server, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.strictEqual(fs.readFileSync(path.join(server, 'app.txt'), 'utf8'), 'v2\n');
  assert.match(job.log, /Dependencies unchanged/);
  assert.match(job.log, /Restart the app/);
  const r = await updater.check();
  assert.strictEqual(r.check.behind, 0);
  assert.strictEqual(r.check.switchBranch, false);
});
