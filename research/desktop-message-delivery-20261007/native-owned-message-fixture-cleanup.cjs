'use strict';

// New explicit cleanup authority for this single owned read-only test fixture.
// It does not change the older driver/receipts or claim child work completed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const fixture = '07639574-d16e-4b4b-81af-4309ab7ec1b0';
const plan = {
  schema: 'namzu.owned-message-fixture-cleanup-plan.v1',
  pinnedPid: 36540, pinnedCreation: '2026-10-07T06:17:37.6467550Z',
  modes: ['--preflight', '--normal-close-root-reviewed'],
  executeRequires: ['native Windows Node', '--resume=<exact private resume receipt>', 'NAMZU_OWNED_MESSAGE_CLEANUP=1'],
  authority: 'Root-reviewed intentional cleanup of our three isolated test inputs; unknown child termination is recorded, never reclassified as completion.',
  guards: ['Exact PID/creation/native executable/bootstrap/userData', 'Pinned completed resume receipt: three UI and native submissions',
    'One owned trusted chat project, zero Pals; all parent sessions idle, no queue/review/draft/attachment/jobs',
    'Strict two native journals: Claude two successful turns/one exact Haiku Agent launch, Codex one successful turn/zero tools',
    'Exact observed child instructions and output metadata: only two approved PowerShell sleep calls, one failed receipt/one background launch, no other tools/models',
    'Existing fixture RPC guard: exactly three consumed submissions, no retry/extra prompt'],
  cleanup: 'Close only the fixture Inspector server so preserved drivers cannot hold debugger shutdown; then exact owned CloseMainWindow. No app.quit, force kill, process-tree termination, primary action, approval or model request.',
  childLifetime: 'Unknown is permitted solely for the exact reviewed sleep fixture. Cleanup is intentional retirement, not proof of prior completion.',
  default: 'Print this plan; no I/O or native connection.',
};
const args = process.argv.slice(2);
const mode = args.includes('--normal-close-root-reviewed') ? 'close' : args.includes('--preflight') ? 'preflight' : null;
if (!mode || process.env.NAMZU_OWNED_MESSAGE_CLEANUP !== '1') {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); process.exit(0);
}
assert.equal(process.platform, 'win32');
assert.equal(args.length, 2);
assert.equal(args.filter(arg => arg.startsWith('--resume=')).length, 1);
const development = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const resumeFile = path.resolve(args.find(arg => arg.startsWith('--resume=')).slice('--resume='.length));
assert.equal(path.dirname(resumeFile).toLowerCase(), development.toLowerCase());
assert(/^message-delivery-resume-private-[0-9a-f-]{36}\.json$/.test(path.basename(resumeFile)));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const resumeBytes = fs.readFileSync(resumeFile);
assert(resumeBytes.length <= 8 * 1024 * 1024 && !fs.lstatSync(resumeFile).isSymbolicLink());
assert.equal(hash(resumeBytes), '8edd7a8749c72fdc14fd95397fae4ab78e8059dd8c55fb68396a06204e2ee9e9');
const previous = JSON.parse(resumeBytes);
assert(previous.completedObservation && previous.realUserUiSubmissions === 3 && previous.nativePromptRequestsObserved === 3 && previous.forbiddenRequests === 0);
assert.equal(previous.fixturePid, plan.pinnedPid); assert.equal(previous.fixtureCreatedAt, plan.pinnedCreation);
assert.equal(previous.engines[0].outcome, 'existing-claude-second-delivered-without-proven-background-overlap');
assert.equal(previous.engines[1].outcome, 'native-background-agent-unavailable');
const firstFile = path.join(development, `message-delivery-private-${fixture}.json`);
const firstBytes = fs.readFileSync(firstFile);
assert.equal(hash(firstBytes), previous.previousReceiptSha256);
const first = JSON.parse(firstBytes);
const config = JSON.parse(fs.readFileSync(path.join(development, 'launch.json')));
const userData = path.join(development, `message-delivery-userdata-${fixture}`);
const home = path.join(development, `message-delivery-home-${fixture}`);
const output = path.join(development, `message-fixture-cleanup-private-${crypto.randomUUID()}.json`);
const receipt = { schema: 'namzu.owned-message-fixture-cleanup.v1', at: new Date().toISOString(), mode,
  passed: false, preflightPassed: false, scriptSha256: hash(fs.readFileSync(__filename)),
  resumeReceiptSha256: hash(resumeBytes), firstReceiptSha256: hash(firstBytes),
  explicitOwnedTestRetirement: mode === 'close', childCompletionEstablished: false,
  childTerminationUnknownBeforeCleanup: true, primaryActions: 0, modelRequests: 0,
  userUiSubmissions: 0, automaticApprovals: 0, computerActions: 0, forceKills: 0,
  inspectorServerCloseRequests: 0, normalWindowCloseRequests: 0 };
let phase = 'exact-owned-identity';
let browser, socket, page;
let sequence = 0;
const pending = new Map();
const quote = value => `'${value.replaceAll("'", "''")}'`;
function ps(code) {
  const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop';${code}`], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'Owned native identity/normal-close probe refused.'); return result.stdout.trim();
}
function identity() {
  const value = JSON.parse(ps(`$r=Get-CimInstance Win32_Process -Filter "ProcessId = ${plan.pinnedPid}";if(!$r){throw 'Fixture absent'};[pscustomobject]@{pid=[int]$r.ProcessId;parent=[int]$r.ParentProcessId;created=$r.CreationDate.ToUniversalTime().ToString('o');exe=$r.ExecutablePath;command=$r.CommandLine}|ConvertTo-Json -Compress`));
  assert.equal(value.pid, plan.pinnedPid); assert.equal(value.created, plan.pinnedCreation);
  assert.equal(path.normalize(value.exe).toLowerCase(), path.normalize(config.electron).toLowerCase());
  assert(value.command.toLowerCase().includes(userData.toLowerCase()) && value.command.toLowerCase().includes(path.join(userData, 'bootstrap.cjs').toLowerCase()));
  assert.notEqual(value.pid, first.originalPid); return value;
}
function regular(file, root) {
  const relative = path.relative(root, file);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  let cursor = root; assert(fs.lstatSync(cursor).isDirectory() && !fs.lstatSync(cursor).isSymbolicLink());
  for (const [index, piece] of relative.split(path.sep).entries()) {
    cursor = path.join(cursor, piece); const info = fs.lstatSync(cursor); assert(!info.isSymbolicLink());
    assert(index === relative.split(path.sep).length - 1 ? info.isFile() && info.size <= 16 * 1024 * 1024 : info.isDirectory());
  }
}
async function evaluate(expression) {
  const id = ++sequence; const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }));
  const response = await result; assert(!response.exceptionDetails); return response.result.value;
}
async function attach() {
  identity();
  const ports = JSON.parse(ps(`ConvertTo-Json -InputObject @(Get-NetTCPConnection -State Listen -OwningProcess ${plan.pinnedPid} | Select-Object -ExpandProperty LocalPort) -Compress`));
  let target;
  for (const port of ports) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    if (!response?.ok) continue;
    const node = (await response.json()).find(item => item.type === 'node');
    if (node) { assert(!target); target = node; }
  }
  assert(target?.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:'));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => { const row = JSON.parse(event.data); const request = pending.get(row.id); if (!request) return; pending.delete(row.id); row.error ? request.reject(new Error('Fixture Inspector refused.')) : request.resolve(row.result); });
  socket.addEventListener('close', () => { for (const request of pending.values()) request.reject(new Error('Fixture Inspector disconnected.')); pending.clear(); });
  const main = JSON.parse(await evaluate("JSON.stringify({pid:process.pid,userData:require('electron').app.getPath('userData'),windows:require('electron').BrowserWindow.getAllWindows().length})"));
  assert.equal(main.pid, plan.pinnedPid); assert.equal(main.userData, userData); assert.equal(main.windows, 1);
  const rpc = JSON.parse(await evaluate('JSON.stringify(globalThis.__namzuDeliveryRpc)'));
  assert.equal(rpc.requests.length, 3); assert.equal(rpc.allowed.length, 3); assert.equal(rpc.forbiddenRequests, 0);
  assert(rpc.allowed.every(item => item.consumed === true));
  assert.equal(rpc.requests.filter(item => item.engine === 'claude-code').length, 2);
  assert.equal(rpc.requests.filter(item => item.engine === 'codex-cli').length, 1);
  const { chromium } = require(path.join(development, 'runtime/packages/p39'));
  const port = Number(fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); assert.equal(port, 59660);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === new URL(config.url).href); assert(page);
}
async function readState() {
  return page.evaluate(async () => {
    const api = window.namzu; const projects = await api.projects();
    if (projects.length !== 1 || !projects[0].isChat || !projects[0].trusted || projects[0].status !== 'ready' || (await api.pals()).length) throw new Error('Fixture project scope changed.');
    const rows = await api.conversations(projects[0].id);
    if (rows.length !== 2 || rows.some(row => row.palId)) throw new Error('Fixture conversation scope changed.');
    const sessions = [];
    for (const row of rows) sessions.push({ id: row.id, projectId: row.projectId, history: await api.openConversation(row.projectId, row.id), draft: await api.draft(row.id), attachments: await api.attachments(row.id), jobs: await api.jobs(row.id) });
    return { workspace: await api.workspace(), sessions, dialog: Boolean(document.querySelector('[role="dialog"],[role="alertdialog"]')), inputValue: document.querySelector('textarea[aria-label="Message Namzu"]')?.value ?? '' };
  });
}
async function preflight() {
  await attach(); phase = 'strict-owned-journals';
  const sdk = await import(pathToFileURL(path.resolve(path.dirname(config.cli), '../node_modules/@namzu/sdk/dist/public-runtime.js')).href);
  const journalHashes = [];
  for (const engine of previous.engines) {
    const file = engine.nativeEvidence.file; regular(file, home);
    const strict = await sdk.readSessionLog(file, { sessionId: engine.nativeEvidence.runtimeId });
    const records = strict.entries.map(entry => entry.record);
    const starts = records.filter(row => row.type === 'turn_started'); const ends = records.filter(row => row.type === 'turn_completed');
    assert.equal(starts.length, engine.engine === 'claude-code' ? 2 : 1);
    assert.equal(ends.length, starts.length); assert(ends.every(row => row.stopReason === 'end_turn'));
    const tools = records.filter(row => row.type === 'tool_executing');
    assert.equal(tools.length, engine.engine === 'claude-code' ? 1 : 0);
    if (tools.length) {
      const call = tools[0]; assert(/(?:^|:)Agent$/.test(call.toolName)); assert.equal(call.input.model, 'haiku'); assert.equal(call.input.run_in_background, true);
      assert.equal(hash(call.input.prompt), '7b67ab57292b1b093e98d05a60016aa23973b5fde0c077f8b40f0f0edd556700');
      assert(records.some(row => row.type === 'tool_completed' && row.turnId === call.turnId && row.toolUseId === call.toolUseId && row.isError === false));
    }
    journalHashes.push({ engine: engine.engine, postObservationSha256: hash(fs.readFileSync(file)), recordCount: records.length });
  }
  const reader = path.join(__dirname, 'native-owned-background-metadata.cjs');
  assert.equal(hash(fs.readFileSync(reader)), '03e07e3b0db3b4ff5b04251a1c61fca50e6e56f8de266ccf65a834a1713b50ed');
  const diagnostic = cp.spawnSync(process.execPath, [reader, `--inspect-receipt=${firstFile}`], { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true });
  assert.equal(diagnostic.status, 0); const child = JSON.parse(diagnostic.stdout);
  assert(child.strictParentJournal && child.oneRequestedHaikuBackgroundLaunch && child.exactChildPathDerivedFromLaunch);
  assert.equal(child.childPostObservationSha256, 'a17cdaa774a732bba5df8b8af2a66338c19dd240aa91569aa90bc35076452f9d');
  assert.equal(child.metadata.toolStarts, 2); assert.equal(child.metadata.otherToolCalls, 0);
  assert.equal(child.metadata.allowedSleepCalls, 2); assert.equal(child.metadata.toolErrors, 1);
  assert.equal(child.metadata.allowedSleepToolSuccessReceipts, 1); assert.equal(child.metadata.allowedBackgroundSleepLaunchReceipts, 1);
  assert.equal(child.metadata.otherModelFrames, 0); assert(!child.metadata.incompleteTrailingRow);
  receipt.childMetadata = child.metadata; receipt.childPostObservationSha256 = child.childPostObservationSha256;
  receipt.childCompletionEstablished = child.terminalStatusObserved; receipt.childTerminationUnknownBeforeCleanup = !child.terminalStatusObserved;
  phase = 'idle-parent-state'; const state = await readState();
  assert(!state.dialog && !state.inputValue);
  const expectedIds = new Set(previous.engines.map(engine => engine.after.trace.sessionId));
  assert.equal(state.sessions.length, expectedIds.size);
  for (const row of state.sessions) {
    assert(expectedIds.has(row.id)); const thread = row.history.thread;
    assert(thread && !thread.running && !thread.responding && !thread.retry && !thread.retryNotice && !thread.permissions.length && !thread.activeToolIds.length && !thread.queued.length && !thread.queuedItems.length);
    assert(!row.draft && !row.attachments.length && Array.isArray(row.jobs) && !row.jobs.some(job => job.status === 'running' || job.recoveryRequired));
  }
  receipt.stateSha256 = hash(JSON.stringify(state)); receipt.strictJournalSummaries = journalHashes;
  receipt.parentSessionsIdle = true; receipt.currentSessionCount = state.sessions.length;
  receipt.preflightPassed = true; identity();
  return state;
}
(async () => {
  try {
    const state = await preflight();
    if (mode === 'close') {
      phase = 'final-read-only-fence'; assert.equal(hash(JSON.stringify(await readState())), hash(JSON.stringify(state))); identity();
      phase = 'detach-owned-inspector-server';
      // Close diagnostics only after all ownership/scope guards. Other preserved
      // fixture drivers attached to this server otherwise hold debugger shutdown.
      receipt.inspectorServerCloseRequests = 1;
      assert.equal(await evaluate("setImmediate(() => require('node:inspector').close()); true"), true);
      socket.close(); socket = null;
      phase = 'normal-owned-window-close';
      receipt.normalWindowCloseRequests = 1;
      const closed = JSON.parse(ps(`$r=Get-CimInstance Win32_Process -Filter "ProcessId = ${plan.pinnedPid}";if(!$r -or $r.ExecutablePath -ne ${quote(config.electron)} -or $r.CreationDate.ToUniversalTime().ToString('o') -ne ${quote(plan.pinnedCreation)} -or !$r.CommandLine -or $r.CommandLine.IndexOf(${quote(userData)},[System.StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'Fixture changed'};$p=Get-Process -Id ${plan.pinnedPid};if(!$p.CloseMainWindow()){throw 'Normal close refused'};if(!$p.WaitForExit(60000)){throw 'Fixture closure still unknown'};Write-Output '{"normalOwnedWindowClosed":true}'`));
      assert(closed.normalOwnedWindowClosed); receipt.normalOwnedWindowClosed = true;
    }
    receipt.passed = true;
  } catch (error) { receipt.failurePhase = phase; receipt.failureName = error.name; }
  finally {
    if (socket) socket.close();
    if (browser) { assert.equal(typeof browser._connection?.close, 'function'); browser._connection.close(); }
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ schema: receipt.schema, passed: receipt.passed, mode,
      preflightPassed: receipt.preflightPassed, parentSessionsIdle: receipt.parentSessionsIdle,
      childCompletionEstablished: receipt.childCompletionEstablished,
      childTerminationUnknownBeforeCleanup: receipt.childTerminationUnknownBeforeCleanup,
      explicitOwnedTestRetirement: receipt.explicitOwnedTestRetirement,
      normalOwnedWindowClosed: receipt.normalOwnedWindowClosed ?? false,
      primaryActions: 0, modelRequests: 0, userUiSubmissions: 0, forceKills: 0,
      inspectorServerCloseRequests: receipt.inspectorServerCloseRequests, normalWindowCloseRequests: receipt.normalWindowCloseRequests,
      failurePhase: receipt.failurePhase, failureName: receipt.failureName,
      privateReceiptBasename: path.basename(output), receiptSha256: hash(fs.readFileSync(output)) })}\n`);
    if (!receipt.passed) process.exitCode = 1;
  }
})();
