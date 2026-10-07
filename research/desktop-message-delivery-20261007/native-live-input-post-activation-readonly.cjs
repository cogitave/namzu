'use strict';
// Supplement the immutable failed activation receipt with bounded read-only checks.
// No restart, focus change, provider readiness, prompt, cancellation or queue action.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
if (process.env.NAMZU_LIVE_INPUT_POST_ACTIVATION_READONLY !== '1' || !process.argv.includes('--inspect-readonly')) {
  console.log(JSON.stringify({ enabled: false, defaultEffects: 0, applicationActions: 0 }));
  process.exit(0);
}
assert.equal(process.platform, 'win32');
assert.equal(process.argv.length, 5);
assert.equal(process.argv[4], '--inspect-readonly');
const root = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const snapshotOutput = path.resolve(process.argv[2]);
const receiptOutput = path.resolve(process.argv[3]);
for (const output of [snapshotOutput, receiptOutput]) {
  assert.equal(path.dirname(output).toLowerCase(), fs.realpathSync(root).toLowerCase());
  assert(!fs.existsSync(output), 'Retain every original receipt and snapshot.');
}
assert.notEqual(snapshotOutput.toLowerCase(), receiptOutput.toLowerCase());
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const pinnedJson = (name, sha256) => {
  const file = path.join(root, name);
  assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
  const bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), sha256, `Pinned private evidence changed: ${name}`);
  return JSON.parse(bytes);
};
const originalSha = '4489fbb03e8e0d328f8254859e1c7a7b9c83bc9ab316b22987329a6bd4e0efd6';
const backupSha = 'fd335c87a534f6b3c8fbd940bcb34e450f3fd6de593f4aa834a94af4f6d1c89d';
const original = pinnedJson('live-input-activation-private-20261007.json', originalSha);
assert(original.passed === false && original.phase === 'startup' && original.cliModuleCopies === 3 && original.sdkCopies === 0 && original.ownedProcessesConfirmedClosed === true);
assert.equal(original.modelRequests, 0);
const before = pinnedJson('removal-before-private-20261007T065353310Z.json', '119244c996967aa0bdf2f2c6b723d267577a4846244269daf5c062a816e59b7d');
assert.equal(original.privateSnapshot, 'removal-before-private-20261007T065353310Z.json');
const authoredBackup = pinnedJson('authored-queued-text-backup-private-20261007.json', backupSha);
assert.equal(authoredBackup.automaticReplayAuthorized, false);
assert.equal(authoredBackup.queuedItems.length, 2);
const targetBefore = before.sessions.find(item => item.id === authoredBackup.sessionId && item.projectId === authoredBackup.projectId);
assert(targetBefore && targetBefore.messages.length === 23 && targetBefore.draft === authoredBackup.draft);
assert.deepEqual(targetBefore.settings, authoredBackup.settings);
const changedCodex = before.sessions.find(item => item.id === '01a1088c-97e0-7663-b709-130e77fc16b5');
assert(changedCodex && changedCodex.messages.length === 0 && changedCodex.draft.length === 186);
const configBytes = fs.readFileSync(path.join(root, 'launch.json'));
assert.equal(hash(configBytes), original.launchConfigSha256);
const config = JSON.parse(configBytes);
const pid = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8'));
assert.equal(pid, 39636, 'Only the fresh primary application from this activation is in scope.');
assert.notEqual(pid, original.beforePid);
const receipt = { schema: 'namzu.desktop-live-input-post-activation-readonly.v1', at: new Date().toISOString(),
  limitedIntegrityChecksPassed: false, originalActivationPassed: false, originalActivationPhase: original.phase,
  originalActivationReceiptSha256: originalSha, originalBeforeSnapshotSha256: '119244c996967aa0bdf2f2c6b723d267577a4846244269daf5c062a816e59b7d',
  authoredQueueBackupSha256: backupSha, primaryPid: pid, applicationActions: 0, modelRequests: 0,
  automaticReplay: false, originalGuardReclassifiedAsPassed: false, completeProtectedStateUnchangedClaimed: false,
  nativeProviderChildOverlapClaimed: false, childCompletionClaimed: false, checks: [], phase: 'payload' };
function manifest(directory) {
  const rows = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(file);
      else { assert(entry.isFile()); rows.push({ file: file.replaceAll(path.sep, '/'), hash: hash(fs.readFileSync(path.join(directory, file))) }); }
    }
  }
  visit(''); return rows.sort((a, b) => a.file.localeCompare(b.file));
}
function dependencyGraph(packagePath) {
  const directory = path.dirname(packagePath);
  const dependencies = JSON.parse(fs.readFileSync(packagePath)).dependencies ?? {};
  return Object.keys(dependencies).sort().map(name => {
    const dependencyPackage = fs.realpathSync(path.join(directory, 'node_modules', name, 'package.json'));
    return { name, requested: dependencies[name], packagePath: dependencyPackage, packageSha256: hash(fs.readFileSync(dependencyPackage)) };
  });
}
function inspectPayload() {
  assert.equal(hash(fs.readFileSync(path.join(root, 'launch.cjs'))), original.launcherSha256);
  assert.equal(hash(fs.readFileSync(path.join(config.app, 'package.json'))), original.desktopPackageSha256);
  const desktop = manifest(path.join(config.app, 'dist'));
  assert.equal(hash(desktop), original.sourceManifestSha256);
  const cliRoot = path.dirname(config.cli);
  const cliPackagePath = path.join(path.dirname(cliRoot), 'package.json');
  const sdkPackagePath = fs.realpathSync(path.join(path.dirname(cliRoot), 'node_modules', '@namzu', 'sdk', 'package.json'));
  const sdkRoot = path.join(path.dirname(sdkPackagePath), 'dist');
  const cli = manifest(cliRoot);
  const changed = original.cliReviewedModules.filter(item => item.beforeSha256 !== item.afterSha256);
  assert.deepEqual(changed.map(item => item.file).sort(), ['commands/acp-harness.js', 'commands/acp.js', 'commands/desktop-host.js']);
  for (const item of original.cliReviewedModules) assert.equal(cli.find(row => row.file === item.file)?.hash, item.afterSha256);
  const reconstructedBefore = cli.map(row => { const item = changed.find(item => item.file === row.file); return item ? { ...row, hash: item.beforeSha256 } : row; });
  assert.equal(hash(reconstructedBefore), original.cliManifestBeforeSha256, 'Unrelated CLI payload changed.');
  assert.equal(hash(manifest(sdkRoot)), original.sdkManifestBeforeSha256);
  assert.equal(hash(fs.readFileSync(cliPackagePath)), original.cliPackageSha256);
  assert.equal(hash(fs.readFileSync(sdkPackagePath)), original.sdkPackageSha256);
  assert.equal(hash(dependencyGraph(cliPackagePath)), original.cliDependencyGraphSha256);
  assert.equal(hash(dependencyGraph(sdkPackagePath)), original.sdkDependencyGraphSha256);
  const runtimeRoot = path.join(root, 'runtime');
  const graphBytes = fs.readFileSync(path.join(runtimeRoot, 'manifest.json'));
  assert.equal(hash(graphBytes), original.packageGraphManifestSha256);
  const graph = JSON.parse(graphBytes);
  assert.equal(fs.realpathSync(path.join(runtimeRoot, graph.cli)).toLowerCase(), fs.realpathSync(config.cli).toLowerCase());
  let links = 0, sdkUsers = 0; const sdkRoots = new Set();
  const packages = graph.packages.map(item => {
    const directory = path.join(runtimeRoot, item.relative), packagePath = path.join(directory, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(packagePath));
    assert.equal(metadata.name, item.name); assert.equal(metadata.version, item.version);
    const rows = Object.entries(item.links ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, relative]) => {
      const actual = fs.realpathSync(path.join(directory, 'node_modules', name));
      assert.equal(actual.toLowerCase(), fs.realpathSync(path.join(runtimeRoot, relative)).toLowerCase());
      const linkedPackage = path.join(actual, 'package.json');
      assert.equal(JSON.parse(fs.readFileSync(linkedPackage)).name, name); links++;
      if (name === '@namzu/sdk') { sdkUsers++; sdkRoots.add(actual.toLowerCase()); }
      return { name, directory: actual, packageSha256: hash(fs.readFileSync(linkedPackage)) };
    });
    return { directory: fs.realpathSync(directory), name: metadata.name, packageSha256: hash(fs.readFileSync(packagePath)), links: rows };
  });
  assert.equal(links, 225); assert.equal(sdkUsers, 11); assert.equal(sdkRoots.size, 1);
  assert.equal([...sdkRoots][0], fs.realpathSync(path.dirname(sdkPackagePath)).toLowerCase());
  assert.equal(hash({ packages, links, sdkUsers, singleSdkRoot: true }), original.packageGraphSha256);
  return { changedCliModules: changed.map(item => item.file), sdkCopies: 0, dependencyLinks: links, sdkUsers };
}
const messageBodies = messages => messages.map(({ messageId, status, stopReason, ...body }) => body);
const authoredState = session => ({ messages: messageBodies(session.messages), partial: session.partial,
  draft: session.draft, settings: session.settings, attachments: session.attachments, jobs: session.jobs,
  tasks: session.thread?.tasks ?? [], tasksNotice: session.thread?.tasksNotice, retry: session.thread?.retry, retryNotice: session.thread?.retryNotice });
let browser;
(async () => {
  try {
    receipt.payload = inspectPayload(); receipt.checks.push('Exact applied Desktop and three CLI modules; SDK and unrelated CLI byte unchanged; complete dependency graph unchanged');
    receipt.phase = 'capture';
    const portBytes = fs.readFileSync(path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort'));
    const port = Number(portBytes.toString('utf8').split(/\r?\n/)[0]);
    assert(Number.isInteger(port) && port > 0);
    const { chromium } = require(path.join(root, 'runtime/packages/p39'));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const connection = await browser.newBrowserCDPSession();
    try { const processes = await connection.send('SystemInfo.getProcessInfo'); assert(processes.processInfo.some(item => item.type === 'browser' && Number(item.id) === pid)); }
    finally { await connection.detach(); }
    const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === new URL(config.url).href);
    assert(page, 'Exact primary renderer missing.');
    const current = await page.evaluate(async () => {
      const api = window.namzu; if (!api) throw Error('Native preload API missing.');
      const workspace = await api.workspace(), currentWindow = workspace.layout.windows.find(item => item.id === workspace.windowId);
      if (!currentWindow) throw Error('Current workspace missing.');
      const visit = node => !node ? [] : node.kind === 'group' ? [node] : [...visit(node.first), ...visit(node.second)];
      const groups = visit(currentWindow.root), projects = await api.projects();
      const catalogues = await Promise.all(projects.filter(item => item.status === 'ready').map(async item => ({ projectId: item.id, rows: await api.conversations(item.id) })));
      const views = catalogues.flatMap(item => item.rows), sessions = [];
      for (const group of groups) for (const id of group.tabs) {
        const view = views.find(item => item.id === id); if (!view) throw Error('Open conversation owner missing.');
        const history = await api.openConversation(view.projectId, id);
        sessions.push({ id, projectId: view.projectId, ...history, draft: await api.draft(id), settings: await api.draftSettings(id), jobs: await api.jobs(id), attachments: await api.attachments(id) });
      }
      const focused = groups.find(item => item.id === currentWindow.focusedGroupId);
      const latestFocusedDraft = focused ? await api.draft(focused.activeTabId) : null;
      const editor = [...document.querySelectorAll('.composer-input textarea[aria-label="Message Namzu"]')].find(input => input.closest('[data-workspace-group]')?.dataset.workspaceGroup === focused?.id);
      const workspaceAfter = await api.workspace();
      const visible = selector => [...document.querySelectorAll(selector)].filter(item => item.getClientRects().length > 0);
      const alerts = visible('[role="alert"], [role="alertdialog"]').map(item => {
        const group = groups.find(group => group.id === item.closest('[data-workspace-group]')?.dataset.workspaceGroup);
        const session = sessions.find(session => session.id === group?.activeTabId), text = item.textContent?.trim() ?? '';
        return { text, capturedTerminalError: !!session && item.matches('.inline-error') && !!item.closest('.transcript .conversation-body') && session.thread?.stopReason === 'error' && session.thread.error === text && !!text };
      });
      return { workspace, workspaceAfter, groups, projects, catalogues, sessions,
        diagnostics: typeof api.diagnostics === 'function' ? await api.diagnostics() : null,
        ui: { sendCurrentAvailable: typeof api.sendCurrent === 'function', focusedSessionId: focused?.activeTabId,
          focusedEditorPresent: !!editor, focusedEditorValue: editor?.value, latestFocusedDraft,
          visibleDialogs: visible('[role="dialog"], [role="alertdialog"]').map(item => item.getAttribute('aria-label')), alerts } };
    });
    fs.writeFileSync(snapshotOutput, JSON.stringify({ at: new Date().toISOString(), pid, originalActivationReceiptSha256: originalSha, current }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    receipt.privateSnapshot = path.basename(snapshotOutput); receipt.privateSnapshotSha256 = hash(fs.readFileSync(snapshotOutput));
    receipt.phase = 'integrity';
    assert.deepEqual(current.workspaceAfter, current.workspace, 'User activity changed workspace during capture.');
    assert.equal(current.groups.length, before.groups.length);
    assert.deepEqual(current.groups.map(item => item.tabs), before.groups.map(item => item.tabs));
    assert.equal(current.sessions.length, before.sessions.length);
    assert(current.ui.sendCurrentAvailable && current.ui.focusedEditorPresent);
    assert.equal(current.ui.focusedEditorValue, current.ui.latestFocusedDraft, 'Focused editor changed during capture.');
    assert.equal(current.sessions.find(item => item.id === current.ui.focusedSessionId)?.draft, current.ui.latestFocusedDraft, 'Focused saved draft changed during capture.');
    const target = current.sessions.find(item => item.id === targetBefore.id && item.projectId === targetBefore.projectId);
    assert(target); assert.deepEqual(authoredState(target), authoredState(targetBefore));
    assert.equal(target.messages.length, 23); assert(target.thread && Array.isArray(target.thread.queued) && Array.isArray(target.thread.queuedItems));
    assert.equal(target.thread.queued.length, 0); assert.equal(target.thread.queuedItems.length, 0);
    for (const previous of before.sessions.filter(item => item.id !== changedCodex.id)) {
      const now = current.sessions.find(item => item.id === previous.id && item.projectId === previous.projectId);
      assert(now); assert.deepEqual(authoredState(now), authoredState(previous), 'Another authored conversation changed.');
    }
    const codex = current.sessions.find(item => item.id === changedCodex.id && item.projectId === changedCodex.projectId);
    assert(codex); assert.equal(codex.draft, ''); assert.deepEqual(codex.settings, changedCodex.settings); assert.deepEqual(codex.attachments, changedCodex.attachments);
    const messages = messageBodies(codex.messages);
    assert(messages.length >= 2 && messages[0].role === 'user' && messages[0].text === changedCodex.draft);
    assert(messages.slice(1).every(item => item.role === 'assistant'), 'Additional authored messages are outside the classified activity.');
    receipt.observedUserActivity = { changedAuthoredConversationCount: 1, preexistingDraftCharacters: changedCodex.draft.length,
      exactPreexistingDraftMatchesFirstUserMessage: true, newUserMessages: 1, observedAssistantMessages: messages.length - 1,
      observedJobs: codex.jobs.length, observedToolReceipts: Object.keys(codex.thread?.tools ?? {}).length,
      observedProgressSteps: (codex.thread?.tasks ?? []).length, currentRunning: !!codex.thread?.running,
      currentResponding: !!codex.thread?.responding, focusChanged: current.ui.focusedSessionId !== before.dom.activeTabId,
      classification: 'Observed Codex activity consumed exactly its preexisting draft; assistant messages and work receipts are preserved as observed activity, not an unchanged-state claim.' };
    receipt.ui = { sendCurrentAvailable: true, originalTabOrderPreserved: true, focusedEditorMatchesLatestSavedDraft: true,
      visibleDialogs: current.ui.visibleDialogs.length, visibleAlerts: current.ui.alerts.length,
      capturedTerminalAlerts: current.ui.alerts.filter(item => item.capturedTerminalError).length,
      unclassifiedAlerts: current.ui.alerts.filter(item => !item.capturedTerminalError).length };
    receipt.checks.push('All 23 original target message bodies, draft, settings, attachments and jobs preserved; authorized queue remains empty and its backup is byte exact',
      'Every other original authored conversation preserved except the one strictly classified Codex draft submission',
      'Original tab order and current focused editor preserved without restoring old focus; sendCurrent preload API present');
    receipt.messageNormalization = ['messageId', 'status', 'stopReason'];
    receipt.diagnostics = { available: current.diagnostics?.available ?? null, noticePresent: !!current.diagnostics?.notice, eventCounts: null };
    if (current.diagnostics?.available) {
      const diagnosticPath = path.resolve(current.diagnostics.path), expected = path.join(process.env.APPDATA, 'Namzu', 'logs', 'desktop.ndjson');
      if (diagnosticPath.toLowerCase() === expected.toLowerCase() && fs.existsSync(diagnosticPath)) {
        const stat = fs.lstatSync(diagnosticPath); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 524288);
        const rows = fs.readFileSync(diagnosticPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        const counts = {}; for (const row of rows.filter(row => row.timestamp >= Date.parse(original.at))) if (/^namzu\.desktop\.[a-z_]+$/.test(row.eventName)) counts[row.eventName] = (counts[row.eventName] ?? 0) + 1;
        receipt.diagnostics.eventCounts = counts; receipt.diagnostics.metadataOnly = true;
      }
    }
    assert.equal(hash(fs.readFileSync(path.join(root, 'launch.json'))), original.launchConfigSha256);
    assert.equal(Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8')), pid);
    assert.equal(hash(fs.readFileSync(path.join(root, 'authored-queued-text-backup-private-20261007.json'))), backupSha);
    assert.equal(hash(fs.readFileSync(path.join(root, 'live-input-activation-private-20261007.json'))), originalSha);
    inspectPayload(); receipt.phase = 'complete'; receipt.limitedIntegrityChecksPassed = true;
  } catch (error) { receipt.error = { name: error.name, message: error.message }; process.exitCode = 1; }
  finally {
    if (browser) { try { await browser.close(); } catch (error) { receipt.disconnectError = error.name; receipt.limitedIntegrityChecksPassed = false; process.exitCode = 1; } }
    fs.writeFileSync(receiptOutput, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ limitedIntegrityChecksPassed: receipt.limitedIntegrityChecksPassed, originalActivationPassed: false,
      completeProtectedStateUnchangedClaimed: false, observedUserActivityChanges: receipt.observedUserActivity?.changedAuthoredConversationCount,
      applicationActions: 0, modelRequests: 0, phase: receipt.phase, privateReceipt: path.basename(receiptOutput), error: receipt.error ? 'See private receipt' : undefined }));
  }
})();
