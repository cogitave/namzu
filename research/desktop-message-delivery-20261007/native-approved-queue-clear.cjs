'use strict';
// The user explicitly approved removing these two backed-up queue entries only.
// No default action and no model request or automatic replay.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (!process.argv.includes('--apply-user-approved') || process.env.NAMZU_APPROVED_QUEUE_CLEAR !== '1') {
  console.log(JSON.stringify({ defaultEffects: 0, action: 'Remove only the two exact backed-up queue items after fresh validation.' }));
  process.exit(0);
}
assert.equal(process.platform, 'win32');
assert.deepEqual(process.argv.slice(2), ['--apply-user-approved']);
const root = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const backupPath = path.join(root, 'authored-queued-text-backup-private-20261007.json');
const backupBytes = fs.readFileSync(backupPath);
assert.equal(hash(backupBytes), 'fd335c87a534f6b3c8fbd940bcb34e450f3fd6de593f4aa834a94af4f6d1c89d');
const backup = JSON.parse(backupBytes);
assert.equal(backup.automaticReplayAuthorized, false);
assert.equal(backup.queuedItems.length, 2);
assert.equal(hash(backup.sessionId), '3d2315978779fa49db3d2d9fe0d097d945ccec316f63ba6d241344fdd291c771');
const pid = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8'));
assert.equal(pid, backup.observedAppPid);
process.kill(pid, 0);
const config = JSON.parse(fs.readFileSync(path.join(root, 'launch.json')));
const { chromium } = require(path.join(root, 'runtime/packages/p39'));
(async () => {
  const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let result;
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === new URL(config.url).href);
    assert(page);
    result = await page.evaluate(async backup => {
      const api = window.namzu;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const fail = () => { throw new Error('Authored input or owner changed; no queue removal is allowed.'); };
      const views = await api.conversations(backup.projectId);
      const owner = views.find(view => view.id === backup.sessionId);
      if (!owner || owner.palId) fail();
      const before = await api.openConversation(backup.projectId, backup.sessionId);
      const thread = before.thread;
      const draft = await api.draft(backup.sessionId);
      const settings = await api.draftSettings(backup.sessionId);
      const attachments = await api.attachments(backup.sessionId);
      const jobs = await api.jobs(backup.sessionId);
      if (!thread || thread.running || thread.responding || thread.permissions.length || thread.activeToolIds.length ||
        thread.retry?.status === 'running' || jobs.some(job => job.status === 'running' || job.recoveryRequired) ||
        attachments.length || draft !== backup.draft || !same(settings, backup.settings) ||
        !same(thread.queuedItems, backup.queuedItems) || !same(thread.queued, backup.queuedItems.map(item => item.prompt))) fail();
      const editor = document.querySelector('textarea[aria-label="Message Namzu"]');
      if (!editor || editor.value !== draft) fail();
      for (const item of backup.queuedItems) await api.removeQueued(backup.sessionId, item.id);
      const after = await api.openConversation(backup.projectId, backup.sessionId);
      if (after.thread.queued.length || after.thread.queuedItems.length ||
        !same(before.messages, after.messages) || !same(before.partial, after.partial) ||
        await api.draft(backup.sessionId) !== draft || !same(await api.draftSettings(backup.sessionId), settings)) {
        throw new Error('Queue removal did not preserve authored history/draft/settings.');
      }
      return { removedQueueItems: 2, remainingQueueItems: 0, messages: after.messages.length,
        historyPreserved: true, draftPreserved: true, settingsPreserved: true };
    }, backup);
  } finally { await browser.close(); }
  assert.equal(hash(fs.readFileSync(backupPath)), hash(backupBytes));
  process.kill(pid, 0);
  console.log(JSON.stringify({ schema: 'namzu.user-approved-queue-clear.v1', at: new Date().toISOString(),
    userApproved: true, backupPreserved: true, backupSha256: hash(backupBytes),
    ...result, automaticReplay: false, modelRequests: 0 }));
})().catch(error => { console.error(error.name); process.exitCode = 1; });
