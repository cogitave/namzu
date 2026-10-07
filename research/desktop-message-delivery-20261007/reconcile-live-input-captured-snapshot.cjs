'use strict';
// Offline reconciliation of already captured immutable evidence. No CDP, app,
// provider, process, queue or computer APIs; only a fresh summary file is written.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
if (process.env.NAMZU_LIVE_INPUT_CAPTURE_RECONCILE !== '1') {
  console.log(JSON.stringify({ enabled: false, defaultEffects: 0, applicationActions: 0 }));
  process.exit(0);
}
assert.equal(process.argv.length, 4, 'Supply the private Development directory and a fresh output JSON file.');
const root = fs.realpathSync(process.argv[2]), output = path.resolve(process.argv[3]);
assert(!fs.existsSync(output), 'Every original receipt must remain intact.');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const evidence = {
  activation: ['live-input-activation-private-20261007.json', '4489fbb03e8e0d328f8254859e1c7a7b9c83bc9ab316b22987329a6bd4e0efd6'],
  before: ['removal-before-private-20261007T065353310Z.json', '119244c996967aa0bdf2f2c6b723d267577a4846244269daf5c062a816e59b7d'],
  readonlyReceipt: ['live-input-post-activation-receipt-private-20261007.json', 'cb0372a67a9b6e32f5153c1a64e24e36884654fc08f52cc0d648332fc5544e4c'],
  snapshot: ['live-input-post-activation-snapshot-private-20261007.json', 'bea0f3929d6e1183e88d8985298748ec1ac7fdbaa11d67ecb6e9ed80ee23ece6'],
  backup: ['authored-queued-text-backup-private-20261007.json', 'fd335c87a534f6b3c8fbd940bcb34e450f3fd6de593f4aa834a94af4f6d1c89d'],
};
function readPinned([name, expected]) {
  const file = path.join(root, name), stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink()); const bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), expected, `Immutable evidence changed: ${name}`); return JSON.parse(bytes);
}
const inputs = Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, readPinned(value)]));
const { activation, before, readonlyReceipt, snapshot, backup } = inputs, current = snapshot.current;
assert.equal(activation.passed, false); assert.equal(activation.phase, 'startup');
assert.equal(readonlyReceipt.limitedIntegrityChecksPassed, false); assert.equal(readonlyReceipt.phase, 'integrity');
assert.equal(readonlyReceipt.originalActivationReceiptSha256, evidence.activation[1]);
assert.equal(readonlyReceipt.privateSnapshotSha256, evidence.snapshot[1]);
assert.equal(snapshot.originalActivationReceiptSha256, evidence.activation[1]); assert.equal(snapshot.pid, 39636);
assert.equal(readonlyReceipt.primaryPid, snapshot.pid);
assert.equal(activation.cliModuleCopies, 3); assert.equal(activation.sdkCopies, 0);
assert.deepEqual(readonlyReceipt.payload.changedCliModules.slice().sort(), ['commands/acp-harness.js', 'commands/acp.js', 'commands/desktop-host.js']);
assert.equal(readonlyReceipt.payload.sdkCopies, 0); assert.equal(readonlyReceipt.payload.dependencyLinks, 225); assert.equal(readonlyReceipt.payload.sdkUsers, 11);
assert(readonlyReceipt.checks.includes('Exact applied Desktop and three CLI modules; SDK and unrelated CLI byte unchanged; complete dependency graph unchanged'));
assert.equal(backup.automaticReplayAuthorized, false); assert.equal(backup.queuedItems.length, 2);
const messageBodies = messages => messages.map(({ messageId, status, stopReason, ...body }) => body);
const nonMessageState = session => ({ partial: session.partial, draft: session.draft, settings: session.settings,
  attachments: session.attachments, jobs: session.jobs, tasks: session.thread?.tasks ?? [], tasksNotice: session.thread?.tasksNotice,
  retry: session.thread?.retry, retryNotice: session.thread?.retryNotice });
const targetBefore = before.sessions.find(item => item.id === backup.sessionId && item.projectId === backup.projectId);
const target = current.sessions.find(item => item.id === backup.sessionId && item.projectId === backup.projectId);
assert(targetBefore && target && targetBefore.messages.length === 23 && target.messages.length === 24);
assert.deepEqual(messageBodies(target.messages.slice(0, 23)), messageBodies(targetBefore.messages));
assert.deepEqual(nonMessageState(target), nonMessageState(targetBefore));
assert.deepEqual(target.settings, backup.settings); assert.equal(target.draft, backup.draft);
assert(target.thread && Array.isArray(target.thread.queued) && Array.isArray(target.thread.queuedItems));
assert.equal(target.thread.queued.length, 0); assert.equal(target.thread.queuedItems.length, 0);
const appended = target.messages[23]; assert.equal(appended.role, 'assistant'); assert.equal(appended.text.length, 376);
assert(!backup.queuedItems.some(item => item.prompt === appended.text));
const codexBefore = before.sessions.find(item => item.id === '01a1088c-97e0-7663-b709-130e77fc16b5');
const codex = current.sessions.find(item => item.id === codexBefore?.id && item.projectId === codexBefore?.projectId);
assert(codexBefore && codex && codexBefore.messages.length === 0 && codexBefore.draft.length === 186 && codex.messages.length === 3);
assert.equal(codex.messages[0].role, 'user'); assert.equal(codex.messages[0].text, codexBefore.draft);
assert(codex.messages.slice(1).every(item => item.role === 'assistant')); assert.equal(codex.draft, '');
assert.deepEqual(codex.settings, codexBefore.settings); assert.deepEqual(codex.attachments, codexBefore.attachments);
const unchangedOthers = before.sessions.filter(item => item.id !== targetBefore.id && item.id !== codexBefore.id);
assert.equal(unchangedOthers.length, 4);
assert(unchangedOthers.some(item => item.draft.length === 49));
for (const previous of unchangedOthers) {
  const now = current.sessions.find(item => item.id === previous.id && item.projectId === previous.projectId); assert(now);
  assert.deepEqual(messageBodies(now.messages), messageBodies(previous.messages)); assert.deepEqual(nonMessageState(now), nonMessageState(previous));
}
const oldTabs = before.groups.flatMap(item => item.tabs), tabs = current.groups.flatMap(item => item.tabs);
assert.equal(oldTabs.length, 6); assert.equal(tabs.length, 10); assert(oldTabs.every(id => tabs.includes(id)));
assert(current.ui.sendCurrentAvailable && current.ui.focusedEditorPresent);
assert.equal(current.ui.focusedEditorValue, current.ui.latestFocusedDraft);
assert.equal(current.ui.visibleDialogs.length, 0); assert.equal(current.ui.alerts.length, 0);
for (const value of Object.values(evidence)) readPinned(value);
const result = {
  schema: 'namzu.desktop-live-input-captured-snapshot-reconciliation.v1', at: new Date().toISOString(),
  scope: 'Offline reconciliation of the exact captured snapshot; no new native inspection or application actions.',
  limitedChecksPassed: true, originalActivationPassed: false, originalReadonlyVerifierPassed: false,
  originalGuardReclassifiedAsPassed: false, completeProtectedStateUnchangedClaimed: false,
  evidenceSha256: Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, value[1]])),
  payload: { evidence: 'Previously completed read-only payload checks before snapshot capture', changedCliModules: 3, changedSdkModules: 0, dependencyLinks: 225, sdkUsers: 11 },
  preservedAuthoredState: { originalTargetMessageBodiesPreservedAsExactPrefix: 23, targetDraftSettingsAttachmentsJobsTasksPreserved: true,
    otherOriginalConversationsUnchanged: 4, separateUnsentDraftCharactersPreserved: 49, targetQueueEmpty: true, exactTwoMessageBackupPreserved: true },
  observedCodexActivity: { exactPreexistingDraftMatchesFirstUserMessage: true, preexistingDraftCharacters: 186, newUserMessages: 1, assistantMessages: 2, currentDraftEmpty: true },
  unattributedTargetActivity: { appendedAssistantMessages: 1, appendedAssistantCharacters: appended.text.length,
    newUserMessages: 0, appendedTextEqualsEitherBackedUpPrompt: false, cause: 'Unknown from this captured snapshot; neither generation nor delivery source is attributed.' },
  observedTabActivity: { originalTabsStillPresent: 6, capturedOpenTabs: 10, additionalOpenTabs: 4,
    originalOrderChanged: JSON.stringify(tabs.filter(id => oldTabs.includes(id))) !== JSON.stringify(oldTabs), focusChanged: current.ui.focusedSessionId !== before.dom.activeTabId },
  capturedUi: { sendCurrentAvailable: true, focusedEditorMatchesLatestSavedDraft: true, visibleDialogs: 0, visibleAlerts: 0 },
  diagnosticOperationCounters: { originalActivationModelRequests: activation.modelRequests, readonlyVerifierModelRequests: readonlyReceipt.modelRequests,
    readonlyVerifierApplicationActions: readonlyReceipt.applicationActions, reconciliationApplicationActions: 0, reconciliationNativeRequests: 0 },
  automaticReplayRequestedByTheseOperations: false, applicationModelRequestsDuringIntervalAttributed: false,
  childCompletionClaimed: false, nativeProviderChildOverlapClaimed: false, messageNormalization: ['messageId', 'status', 'stopReason'],
};
assert.equal(result.diagnosticOperationCounters.originalActivationModelRequests, 0);
assert.equal(result.diagnosticOperationCounters.readonlyVerifierModelRequests, 0);
assert.equal(result.diagnosticOperationCounters.readonlyVerifierApplicationActions, 0);
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ limitedChecksPassed: true, originalActivationPassed: false, originalReadonlyVerifierPassed: false,
  originalTargetPrefixMessages: 23, unchangedOtherConversations: 4, unattributedAppendedAssistantMessages: 1, applicationActions: 0, nativeRequests: 0 }));
