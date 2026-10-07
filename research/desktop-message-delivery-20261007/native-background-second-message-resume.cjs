'use strict';
// Root-only resume of one exact preserved fixture. No launch/reload/stop/close.
// The original first Claude turn has ended. Never retroclaim background overlap.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const suffix = '07639574-d16e-4b4b-81af-4309ab7ec1b0';
const plan = {
  schema: 'namzu.native-second-message-resume-plan.v1',
  previousReceiptBasename: `message-delivery-private-${suffix}.json`,
  pinnedFixturePid: 36540, pinnedCreation: '2026-10-07T06:17:37.6467550Z',
  additionalUserUiSubmissionsMax: 3, combinedUserUiSubmissionsMax: 4,
  actions: ['One Claude second-message acknowledgement in the existing Haiku chat.', 'One fresh Codex Luna background request plus one second message only if launch/wait overlap is observed.'],
  firstClaudeOverlap: 'Already missed by the first observation: report terminal/unknown child status at second submission, never claim an active overlap or respawn.',
  nativeChildContract: 'Claude completion can be an automatic task notification instead of TaskOutput. Evidence must match the exact child derived from its actual launch receipt.',
  noActions: ['primary app actions', 'app launch/reload/close', 'computer calls', 'automatic approvals', 'native retry', 'extra child', 'model fallback', 'Namzu provider inference'],
  permissions: 'Ask first; unique private exact-request receipts for root manual review.',
  parentModelAllowlist: { 'claude-code': 'Already selected offered Haiku only', 'codex-cli': ['gpt-6.1-luna', 'gpt-6-luna', 'gpt-5.6-luna'] },
  externalObservationBudgetMs: 180000, expiration: 'Inconclusive, never speed/unsupported proof.',
  preserveFixture: true,
  executionRequires: ['--execute', 'NAMZU_NATIVE_MESSAGE_DELIVERY_PROOF=1', 'native Windows Node', '--previous=<exact pinned receipt>'],
  optionalChildEvidence: '--child-evidence=<root-owned metadata-only helper receipt>',
};
if (!process.argv.includes('--execute') || process.env.NAMZU_NATIVE_MESSAGE_DELIVERY_PROOF !== '1') {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); process.exit(0);
}
assert.equal(process.platform, 'win32');
const options = process.argv.slice(2);
assert(options.every(item => item === '--execute' || item.startsWith('--previous=') || item.startsWith('--child-evidence=')));
assert.equal(options.filter(item => item === '--execute').length, 1);
assert.equal(options.filter(item => item.startsWith('--previous=')).length, 1);
assert(options.filter(item => item.startsWith('--child-evidence=')).length <= 1);
const development = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const previousFile = path.resolve(options.find(item => item.startsWith('--previous=')).slice('--previous='.length));
assert.equal(path.dirname(previousFile).toLowerCase(), development.toLowerCase());
assert.equal(path.basename(previousFile), plan.previousReceiptBasename);
const previousBytes = fs.readFileSync(previousFile);
assert(previousBytes.length <= 8 * 1024 * 1024 && fs.lstatSync(previousFile).isFile() && !fs.lstatSync(previousFile).isSymbolicLink());
const previous = JSON.parse(previousBytes);
assert.equal(previous.schema, 'namzu.native-second-message-comparison.v1');
assert.equal(previous.fixturePid, plan.pinnedFixturePid);
assert.equal(previous.fixtureCreatedAt, plan.pinnedCreation);
assert(previous.isolationVerified && previous.realUserUiSubmissions === 1 && previous.preservedFixtureForReview);
assert.equal(previous.scriptSha256, 'f1f2bec4b83f330c3c0f688d54e60287bf1577b546e7aac78d3b151f4e6deb09');
assert.equal(previous.engines.length, 1);
assert.equal(previous.engines[0].engine, 'claude-code');
assert(previous.engines[0].nativeEvidence?.available);
const config = JSON.parse(fs.readFileSync(path.join(development, 'launch.json'), 'utf8'));
const originalPid = previous.originalPid;
const userData = path.join(development, `message-delivery-userdata-${suffix}`);
const home = path.join(development, `message-delivery-home-${suffix}`);
const receiptPath = path.join(development, `message-delivery-resume-private-${crypto.randomUUID()}.json`);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => sha(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
const receipt = { schema: 'namzu.native-second-message-resume.v1', at: new Date().toISOString(), passed: false,
  completedObservation: false, previousReceiptSha256: sha(previousBytes), scriptSha256: sha(fs.readFileSync(__filename)),
  fixturePid: previous.fixturePid, fixtureCreatedAt: previous.fixtureCreatedAt, maxRealUserUiSubmissions: 4,
  initialUserUiSubmissions: 1, realUserUiSubmissions: 1, engines: [], automaticApprovals: 0,
  primaryActions: 0, computerActions: 0, appLaunches: 0, appReloads: 0, appCloses: 0,
  fixturePreserved: true, pageErrorCount: 0, firstClaudeOverlapVerified: false,
  limitations: ['First Claude parent ended before the second UI submission; this resume cannot recreate that overlap.',
    'Desktop queue/admission does not establish native turn/steer support.', 'Child launch arguments do not independently prove its work/model inference.',
    'External waiting may be inconclusive. No speed superiority is asserted.', 'Journal hashes are post-observation only.'] };
const childOption = options.find(item => item.startsWith('--child-evidence='));
let childEvidence;
if (childOption) {
  const file = path.resolve(childOption.slice('--child-evidence='.length));
  assert.equal(path.dirname(file).toLowerCase(), development.toLowerCase());
  const info = fs.lstatSync(file); assert(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024);
  const bytes = fs.readFileSync(file); childEvidence = JSON.parse(bytes);
  assert.equal(childEvidence.schema, 'namzu.owned-background-metadata.v1');
  assert.equal(childEvidence.fixtureReceiptSha256, receipt.previousReceiptSha256);
  assert(childEvidence.strictParentJournal && childEvidence.oneRequestedHaikuBackgroundLaunch && childEvidence.exactChildPathDerivedFromLaunch);
  assert.deepEqual(childEvidence.effects, { fileWrites: 0, nativeConnections: 0, modelRequests: 0, processActions: 0 });
  receipt.childEvidenceSha256 = sha(bytes);
  receipt.childMetadata = childEvidence.metadata;
}
let phase = 'owned-identity';
let page, browser, nodeSocket, sdk;
let nodeSequence = 0;
const pendingCalls = new Map();
const fixtureSessions = new Map();
const lunaIds = ['gpt-6.1-luna', 'gpt-6-luna', 'gpt-5.6-luna'];
const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const effortName = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
const bound = 180000;
function observationBudget(deadline) { const remaining = deadline - Date.now(); if (remaining <= 0) { const error = new Error('External observation exhausted.'); error.name = 'ExternalObservationBudgetExhausted'; throw error; } return remaining; }
function contained(root, target) { const relative = path.relative(root, target); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); }
function identity() {
  const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop';$r=Get-CimInstance Win32_Process -Filter "ProcessId = ${previous.fixturePid}";if(!$r){throw 'Owned fixture absent'};[pscustomobject]@{pid=[int]$r.ProcessId;parent=[int]$r.ParentProcessId;executable=$r.ExecutablePath;createdAt=$r.CreationDate.ToUniversalTime().ToString('o');command=$r.CommandLine}|ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  const row = JSON.parse(result.stdout);
  assert.equal(row.pid, previous.fixturePid); assert.equal(row.createdAt, previous.fixtureCreatedAt);
  assert.equal(path.normalize(row.executable).toLowerCase(), path.normalize(config.electron).toLowerCase());
  assert(row.command.toLowerCase().includes(userData.toLowerCase()) && row.command.toLowerCase().includes(path.join(userData, 'bootstrap.cjs').toLowerCase()));
  assert.notEqual(row.pid, originalPid); process.kill(originalPid, 0);
  return row;
}
async function nodeCall(method, params) {
  const id = ++nodeSequence;
  const result = new Promise((resolve, reject) => pendingCalls.set(id, { resolve, reject }));
  nodeSocket.send(JSON.stringify({ id, method, params })); return result;
}
async function nodeEval(expression) {
  const value = await nodeCall('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
  assert(!value.exceptionDetails, 'Owned Inspector evaluation failed.'); return value.result.value;
}
const desktop = { evaluate: async (callback, argument) => nodeEval(`(${callback.toString()})(require('electron'),${JSON.stringify(argument) ?? 'undefined'})`) };
async function attach() {
  identity();
  const ports = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop';ConvertTo-Json -InputObject @(Get-NetTCPConnection -State Listen -OwningProcess ${previous.fixturePid} | Select-Object -ExpandProperty LocalPort) -Compress`], { encoding: 'utf8', windowsHide: true });
  assert.equal(ports.status, 0);
  let target;
  for (const port of JSON.parse(ports.stdout)) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    if (!response?.ok) continue;
    const node = (await response.json()).find(row => row.type === 'node');
    if (node) { assert(!target); target = node; }
  }
  assert(target?.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:'));
  nodeSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { nodeSocket.addEventListener('open', resolve, { once: true }); nodeSocket.addEventListener('error', reject, { once: true }); });
  nodeSocket.addEventListener('message', event => { const value = JSON.parse(event.data); const request = pendingCalls.get(value.id); if (!request) return; pendingCalls.delete(value.id); value.error ? request.reject(new Error('Owned Inspector protocol failed.')) : request.resolve(value.result); });
  const actual = await desktop.evaluate(module => { const electron = module.default ?? module; return { pid: process.pid, userData: electron.app.getPath('userData') }; });
  assert.equal(actual.pid, previous.fixturePid); assert.equal(actual.userData, userData);
  const { chromium } = require(path.join(development, 'runtime/packages/p39'));
  const port = Number(fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
  assert.equal(port, 59660);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === new URL(config.url).href);
  assert(page); page.on('pageerror', () => receipt.pageErrorCount++);
  sdk = await import(pathToFileURL(path.resolve(path.dirname(config.cli), '../node_modules/@namzu/sdk/dist/public-runtime.js')).href);
  assert.equal(typeof sdk.readSessionLog, 'function');
  const rpc = await desktop.evaluate(() => globalThis.__namzuDeliveryRpc);
  assert(rpc && rpc.requests.length === 1 && rpc.forbiddenRequests === 0 && rpc.allowed.length === 1 && rpc.allowed[0].consumed === true);
  await page.exposeBinding('__namzuDeliveryResumeApprovalNotice', (_source, value) => {
    const file = path.join(development, `message-delivery-resume-approval-private-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), fixturePid: receipt.fixturePid, ...value }, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ kind: 'manual-approval-review-required', automaticApproval: false, privateReceiptBasename: path.basename(file), receiptSha256: sha(fs.readFileSync(file)) })}\n`);
  });
  receipt.isolationVerified = true;
}
async function owner() {
	return page.evaluate(async () => {
		const api = window.namzu;
		const workspace = await api.workspace();
		const windowView = workspace.layout.windows.find((entry) => entry.id === workspace.windowId);
		const descend = (node) => !node ? [] : node.kind === 'group'
			? [node] : [...descend(node.first), ...descend(node.second)];
		const group = descend(windowView?.root).find((entry) => entry.id === windowView?.focusedGroupId);
		const projects = await api.projects();
		const pals = await api.pals();
		const project = projects.find((entry) => entry.isChat && entry.trusted && entry.status === 'ready');
		const sessionId = group?.activeTabId;
		const rows = project ? await api.conversations(project.id) : [];
		return {
			projectId: project?.id, sessionId,
			isolated: projects.length === 1 && pals.length === 0 &&
				Boolean(project && sessionId && rows.some((row) => row.id === sessionId && !row.palId)),
		};
	});
}

async function newFixtureChat() {
	phase = 'new-fixture-chat';
	const previous = await owner();
	await page.locator('.sidebar-new-conversation').click();
	await page.waitForFunction(async (previousId) => {
		const workspace = await window.namzu.workspace();
		const current = workspace.layout.windows.find((entry) => entry.id === workspace.windowId);
		const groups = (node) => !node ? [] : node.kind === 'group'
			? [node] : [...groups(node.first), ...groups(node.second)];
		const selected = groups(current?.root).find((entry) => entry.id === current?.focusedGroupId)?.activeTabId;
		return Boolean(selected && selected !== previousId);
	}, previous.sessionId ?? null);
	await page.getByRole('textbox', { name: 'Message Namzu', exact: true }).waitFor({ state: 'visible' });
	await page.waitForFunction(() => {
		const input = document.querySelector('.composer-input textarea[aria-label="Message Namzu"]');
		const engine = document.querySelector('button[aria-label="Execution engine"]');
		return Boolean(input && !input.disabled && !input.readOnly && engine && !engine.disabled);
	});
	await page.waitForFunction(async () => {
		const api = window.namzu;
		const projects = await api.projects();
		const project = projects.find((item) => item.isChat && item.trusted && item.status === 'ready');
		if (projects.length !== 1 || !project || (await api.pals()).length !== 0) return false;
		const workspace = await api.workspace();
		const current = workspace.layout.windows.find((entry) => entry.id === workspace.windowId);
		const groups = (node) => !node ? [] : node.kind === 'group' ? [node] : [...groups(node.first), ...groups(node.second)];
		const selected = groups(current?.root).find((entry) => entry.id === current?.focusedGroupId)?.activeTabId;
		return Boolean(selected && (await api.conversations(project.id)).some((row) => row.id === selected && !row.palId));
	});
	const view = await owner();
	assert(view.isolated, 'A fixture chat was not isolated from projects or Pals.');
	return view;
}

async function selectEngine(engine) {
	phase = `select-${engine}`;
	if (engine === 'namzu') return;
	await page.getByRole('button', { name: 'Execution engine', exact: true }).click();
	await page.locator('.harness-picker-popup').getByRole('radio', {
		name: engine === 'codex-cli' ? 'Codex CLI' : 'Claude Code', exact: true,
	}).click();
	// Metadata reads are deliberately fenced while the UI's write is pending.
	// Observe its enabled settled control before making one authoritative read.
	await page.waitForFunction((label) => {
		const trigger = document.querySelector('button[aria-label="Execution engine"]');
		return trigger?.title === label && !trigger.disabled;
	}, engine === 'codex-cli' ? 'Codex CLI' : 'Claude Code');
	const view = await owner();
	assert(view.isolated);
	const selected = await page.evaluate(({ projectId, sessionId }) =>
		window.namzu.harnesses(projectId, sessionId), view);
	assert.equal(selected.selected, engine);
	return view;
}

async function selectModel(view, provider, model) {
	phase = 'select-model';
	await page.getByRole('button', { name: 'Select model', exact: true }).click();
	const popup = page.locator('.model-picker-popup');
	const providerTab = popup.getByRole('tab', { name: provider.label, exact: true });
	if (await providerTab.count()) await providerTab.click();
	else {
		assert.equal(await popup.getByRole('tab').count(), 0,
			'A multi-provider picker omitted the target provider tab.');
		await popup.locator('.model-provider-single').waitFor({ state: 'visible' });
	}
	await popup.getByRole('radio', { name: `${provider.label} ${model.label}`, exact: true }).click();
	await page.waitForFunction(async ({ sessionId, providerId, modelId }) => {
		const saved = await window.namzu.draftSettings(sessionId);
		return saved.choice?.provider === providerId && saved.choice?.model === modelId;
	}, { sessionId: view.sessionId, providerId: provider.id, modelId: model.id });
	if (await popup.isVisible()) await page.keyboard.press('Escape');
	const route = await page.evaluate((id) => window.namzu.draftSettings(id), view.sessionId);
	assert.equal(route.choice?.provider, provider.id);
	assert.equal(route.choice?.model, model.id);
}

async function setLowestOfferedEffort(view, provider, model) {
	phase = 'effort';
	const settings = await page.evaluate(({ projectId, sessionId, providerId, modelId }) =>
		window.namzu.modelSettings(projectId, providerId, modelId, sessionId),
		{ projectId: view.projectId, sessionId: view.sessionId, providerId: provider.id, modelId: model.id });
	const levels = [...new Set(settings.effortLevels ?? [])].sort((a, b) =>
		effortOrder.indexOf(a) - effortOrder.indexOf(b));
	assert(levels.every((level) => effortOrder.includes(level)),
		'The native catalogue has an unknown effort level.');
	if (!levels.length) return { offered: false };
	if (levels.length === 1 && settings.effortDefault === levels[0])
		return { offered: true, defaultOnly: true, levels: 1 };
	const desired = levels[0];
	if (desired === settings.effortDefault) return { offered: true, defaultOnly: true, selected: desired, levels: levels.length };
	assert(effortName[desired], 'Unknown effort level from native catalogue.');
	await page.getByRole('button', { name: 'Select model', exact: true }).click();
	const popup = page.locator('.model-picker-popup');
	await popup.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
	const slider = page.getByRole('slider', { name: 'Reasoning effort', exact: true });
	if (await slider.count()) {
		await slider.press('Home');
		for (let index = 0; index < levels.indexOf(desired); index++) await slider.press('ArrowRight');
	}
	else await page.getByRole('button', { name: effortName[desired], exact: true }).click();
	await page.waitForFunction(async ({ id, value }) =>
		(await window.namzu.draftSettings(id)).options?.effort === value,
		{ id: view.sessionId, value: desired });
	await page.keyboard.press('Escape');
	if (await popup.isVisible()) await page.keyboard.press('Escape');
	return { offered: true, selected: desired, levels: levels.length };
}


async function selectCheapModel(view, engine) {
  const data = await page.evaluate(async ({ projectId, sessionId, engine }) => {
    const providers = await window.namzu.providers(projectId, sessionId);
    const provider = providers.available.find(item => item.id === engine);
    if (!provider) return { provider: null, models: [] };
    return { provider, models: (await window.namzu.models(projectId, provider.id, sessionId)).models };
  }, { ...view, engine });
  const choice = engine === 'claude-code'
    ? data.models.find(model => /(^|[-_.])haiku($|[-_.])/i.test(model.id))
    : lunaIds.map(id => data.models.find(model => model.id === id)).find(Boolean);
  if (!choice || !data.provider) return { available: false, catalogueRows: data.models.length };
  assert(engine === 'claude-code' ? /(^|[-_.])haiku($|[-_.])/i.test(choice.id) : lunaIds.includes(choice.id));
  await selectModel(view, data.provider, choice);
  const permissions = page.getByRole('combobox', { name: 'Tool permissions', exact: true });
  if (!(await permissions.textContent()).includes('Ask first')) {
    await permissions.click();
    await page.getByRole('option', { name: 'Ask first', exact: false }).click();
    await page.waitForFunction(async id => (await window.namzu.draftSettings(id)).options?.permissionMode === 'prompt', view.sessionId);
  }
  assert((await permissions.textContent()).includes('Ask first'));
  const effort = engine === 'codex-cli' ? await setLowestOfferedEffort(view, data.provider, choice) : { offered: false };
  return { available: true, provider: data.provider.id, model: choice.id, effort, catalogueRows: data.models.length };
}
function prompts(engine, model) {
  const tag = `${engine.replaceAll('-', '_')}_${suffix}`;
  const childModel = engine === 'claude-code' ? 'haiku' : model;
  const child = `Run only sleep 30 once, or the exact Windows equivalent powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30", then reply BG_DONE_${tag}. Do not read/write files, use network tools/commands, spawn another agent, or perform other work.`;
  return {
    tag, done: `BG_DONE_${tag}`, unavailable: `BG_UNAVAILABLE_${tag}`, secondAck: `SECOND_ACK_${tag}`,
    first: `This is a bounded native background-agent/message-delivery check. Start exactly one background subagent with explicit model ${childModel}. Its complete instruction is: ${child} Use your actual native background agent primitive (Agent/Task with run_in_background=true, or spawn_agent). Do not run the sleep in the parent and do not emulate an agent with a shell job. If the native primitive or explicit ${childModel} child model is unavailable, reply BG_UNAVAILABLE_${tag} with a brief honest reason and stop; no model fallback. After the child launch, use the native wait/task-output primitive to await its completion. A second user message will arrive while the child is active; preserve the child and report actual results. No file writes/reads or network commands. Keep your reply brief.`,
    second: `Second user message during the background child: acknowledge SECOND_ACK_${tag}. Preserve the original child and its completion receipt. Do not spawn another child, run a command, browse, read/write files, cancel or restart work. This is only a message-delivery check; reply briefly.`,
  };
}
async function watch(view, expected) {
  await page.evaluate(({ sessionId, expected }) => {
    window.__namzuDeliveryTrace?.dispose();
    const trace = { sessionId, events: [], overflow: false, running: false, promptCount: 0, endedCount: 0, queuedSecond: false, firstEndedBeforeSecond: false, permissions: [], expected };
    const dispose = window.namzu.onEvent(event => {
      const id = event.kind === 'permission' ? event.request.sessionId : event.sessionId;
      if (id !== sessionId) return;
      if (trace.events.length >= 2000) { trace.overflow = true; return; }
      trace.events.push({ index: trace.events.length, observedAt: Date.now(), event });
      if (event.kind === 'prompt') { trace.promptCount++; trace.running = true; }
      if (event.kind === 'state') { trace.running = event.running; if (event.queued?.includes(expected.second)) trace.queuedSecond = true; }
      if (event.kind === 'update' && event.update.kind === 'turn_ended') trace.endedCount++;
      if (event.kind === 'permission') {
        trace.permissions.push(event.request);
        void window.__namzuDeliveryResumeApprovalNotice({ request: event.request, index: trace.events.length - 1 });
      }
    });
    // Keep one reference so subscription writes and read-only observations agree.
    window.__namzuDeliveryTrace = trace;
    trace.dispose = dispose;
  }, { ...view, expected });
}
async function snapshot(view) {
  const value = await page.evaluate(async ({ projectId, sessionId }) => {
    const history = await window.namzu.openConversation(projectId, sessionId);
    return { history, trace: window.__namzuDeliveryTrace ? { ...window.__namzuDeliveryTrace, dispose: undefined } : null,
      draft: await window.namzu.draft(sessionId), settings: await window.namzu.draftSettings(sessionId), jobs: await window.namzu.jobs(sessionId) };
  }, view);
  assert(value.trace && !value.trace.overflow, 'Fixture event trace exceeded its bound.');
  return value;
}
async function journal(engine) {
  const runtimeId = await desktop.evaluate((module, wanted) => {
    const rows = globalThis.__namzuDeliveryRpc.requests.filter(item => item.engine === wanted);
    return rows.at(-1)?.runtimeSessionId ?? null;
  }, engine);
  if (!runtimeId) return { available: false, tools: [], records: [] };
  assert(/^[0-9a-f-]{36}$/i.test(runtimeId), 'Native runtime journal ID malformed.');
  const matches = [];
  let entries = 0;
  const walk = directory => {
    const info = fs.lstatSync(directory);
    assert(info.isDirectory() && !info.isSymbolicLink() && contained(home, directory));
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      assert(++entries <= 5000, 'Fixture filesystem inventory exceeded its bound.');
      const file = path.join(directory, item.name);
      const stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'Fixture journal inventory refuses links.');
      if (stat.isDirectory()) walk(file);
      else if (item.name === `${runtimeId}.jsonl`) { assert(stat.isFile() && stat.size <= 16 * 1024 * 1024); matches.push(file); }
    }
  };
  const projects = path.join(home, 'projects');
  if (!fs.existsSync(projects)) return { available: false, tools: [], records: [] };
  walk(projects);
  assert.equal(matches.length, 1, 'Exact scoped runtime journal was not unique.');
  const file = matches[0];
  const read = await sdk.readSessionLog(file, { sessionId: runtimeId }); // strict default; never repair a live log
  const records = read.entries.map(entry => entry.record);
  const latest = new Map();
  // Reused tool IDs or resumed attempts cannot attach a completion that predates
  // the latest start. Match the durable native turn as well as the tool ID.
  for (const record of records) {
    const key = `${record.turnId}:${record.toolUseId}`;
    if (record.type === 'tool_executing') latest.set(key, { ...record });
    else if (record.type === 'tool_completed' && latest.has(key)) latest.get(key).completed = record;
  }
  return { available: true, file, postOnlySha256: digest(fs.readFileSync(file)), runtimeId, recordCount: records.length, tools: [...latest.values()], records };
}
function nativeToolName(tool) { return String(tool.toolName ?? '').split(':').at(-1).replaceAll('_', '').replaceAll('-', '').toLowerCase(); }
function agentCandidate(tool) { return ['agent', 'task', 'spawnagent'].includes(nativeToolName(tool)); }
function waitCandidate(tool) { return ['wait', 'waitagent', 'taskoutput'].includes(nativeToolName(tool)); }
function checkedLaunch(tool, engine, model) {
  if (!agentCandidate(tool) || !tool.completed || tool.completed.isError !== false) return false;
  const input = tool.input;
  return input && typeof input === 'object' && !Array.isArray(input) &&
    (engine === 'claude-code' ? input.model === 'haiku' && input.run_in_background === true : input.model === model);
}
async function submit(view, engine, stage, prompt) {
  assert(receipt.realUserUiSubmissions < 4, 'User UI submission cap exceeded.');
  const settings = await page.evaluate(id => window.namzu.draftSettings(id), view.sessionId);
  assert.equal(settings.choice?.provider, engine, 'Fixture refuses Namzu provider inference.');
  assert(settings.options?.permissionMode === undefined || settings.options.permissionMode === 'prompt');
  await desktop.evaluate((module, item) => globalThis.__namzuDeliveryRpc.allowed.push(item), { engine, stage, sessionId: view.sessionId, prompt });
  const input = page.getByRole('textbox', { name: 'Message Namzu', exact: true });
  await input.fill(prompt);
  const button = page.getByRole('button', { name: stage === 'second' ? 'Queue message' : 'Send message', exact: true });
  if (stage === 'second' && engine !== 'claude-code') {
    const pending = await snapshot(view);
    const native = await journal(engine);
    assert(pending.history.thread?.running && native.tools.some(tool => waitCandidate(tool) && !tool.completed),
      'The native wait finished before the second UI submission; comparison is inconclusive.');
  }
  await button.click();
  receipt.realUserUiSubmissions++;
}
async function runEngine(engine) {
  phase = `new-${engine}`;
  const result = { engine, outcome: 'not-attempted', realUserUiSubmissions: 0, externalLatency: {}, limitations: [] };
  receipt.engines.push(result);
  let view = await newFixtureChat();
  view = (await selectEngine(engine)) ?? view;
  fixtureSessions.set(engine, view);
  const choice = await selectCheapModel(view, engine);
  result.catalogueRows = choice.catalogueRows;
  if (!choice.available) { result.outcome = 'requested-low-cost-native-model-unavailable'; return; }
  result.model = choice.model; result.effort = choice.effort;
  const expected = prompts(engine, choice.model);
  await watch(view, expected);
  const before = await snapshot(view);
  const firstStarted = Date.now();
  const backgroundDeadline = firstStarted + bound;
  await submit(view, engine, 'first', expected.first); result.realUserUiSubmissions++;
  let observed;
  phase = `observe-background-${engine}`;
  // External observation budget: timeout is INCONCLUSIVE, never a speed assertion.
  try {
    await page.waitForFunction(() => {
      const trace = window.__namzuDeliveryTrace;
      return trace?.events.some(item => item.event.kind === 'update' && item.event.update.kind === 'tool_call' && /(?:agent|task|spawn|wait)/i.test(item.event.update.title ?? '')) || (trace?.endedCount > 0 && !trace.running);
    }, undefined, { timeout: observationBudget(backgroundDeadline) });
    observed = await snapshot(view);
    let durable = await journal(engine);
    // Wait on real tool events until both successful launch and pending native wait exist.
    for (;;) {
      const launched = durable.tools.find(tool => checkedLaunch(tool, engine, choice.model));
      const waiting = durable.tools.find(tool => waitCandidate(tool) && !tool.completed);
      if (launched && waiting && observed.history.thread?.running) {
        result.launchRequestVerified = true; result.nativeWaitPendingVerified = true;
        result.launchInputSha256 = digest(launched.input);
        result.firstObservedAt = Date.now();
        break;
      }
      if (observed.trace.endedCount && !observed.history.thread?.running) {
        const assistant = observed.history.messages.filter(row => row.role === 'assistant').map(row => row.text).join('\n');
        result.outcome = !durable.tools.some(agentCandidate) && assistant.includes(expected.unavailable)
          ? 'native-background-agent-unavailable' : 'no-confirmed-background-overlap';
        result.nativeEvidence = durable; result.before = before; result.after = observed;
        return;
      }
      const revision = observed.history.thread?.revision ?? 0;
      await page.waitForFunction(prior => window.__namzuDeliveryTrace?.events.length > prior, observed.trace.events.length, { timeout: observationBudget(backgroundDeadline) });
      observed = await snapshot(view); durable = await journal(engine);
      result.lastObservedRevision = revision;
    }
  } catch (error) {
    result.outcome = 'inconclusive-before-second-message'; result.observationFailureName = error.name;
    result.after = observed ?? await snapshot(view); return;
  }
  result.externalLatency.backgroundReadyMs = Date.now() - firstStarted;
  const secondStarted = Date.now();
  phase = `second-message-${engine}`;
  // Recheck actual state immediately before UI submission; a missed overlap is not a pass.
  const preSecond = await snapshot(view);
  if (!preSecond.history.thread?.running) { result.outcome = 'background-ended-before-second-message'; result.after = preSecond; return; }
  result.preSecond = preSecond;
  await submit(view, engine, 'second', expected.second); result.realUserUiSubmissions++;
  phase = `observe-second-${engine}`;
  try {
    await page.waitForFunction(() => {
      const trace = window.__namzuDeliveryTrace;
      return trace?.promptCount >= 2 && trace.endedCount >= 2 && !trace.running;
    }, undefined, { timeout: bound });
  } catch (error) {
    result.outcome = 'inconclusive-after-second-message'; result.observationFailureName = error.name;
    result.after = await snapshot(view); result.nativeEvidence = await journal(engine); return;
  }
  const after = await snapshot(view);
  const durable = await journal(engine);
  const waits = durable.tools.filter(waitCandidate);
  const confirmedChild = waits.some(tool => tool.completed?.isError === false && typeof tool.completed.result === 'string' && tool.completed.result.includes(expected.done));
  const secondAdmitted = after.trace.events.find(item => item.event.kind === 'prompt' && item.event.prompt === expected.second);
  const firstEnded = after.trace.events.find(item => item.event.kind === 'update' && item.event.update.kind === 'turn_ended');
  const terminalEvents = after.trace.events.filter(item => item.event.kind === 'update' && item.event.update.kind === 'turn_ended');
  const successfulTerminalTurns = terminalEvents.length === 2 && terminalEvents.every(item =>
    item.event.update.stopReason === 'end_turn' && !item.event.update.error);
  const acknowledgement = after.history.messages.some(row => row.role === 'assistant' && row.stopReason !== 'cancelled' && row.text.includes(expected.secondAck));
  result.externalLatency.secondSubmitToObservedTerminalMs = Date.now() - secondStarted;
  result.desktopQueuedSecond = after.trace.queuedSecond;
  result.secondAdmittedAfterFirstTerminal = Boolean(secondAdmitted && firstEnded && secondAdmitted.index > firstEnded.index);
  result.secondAcknowledgementObserved = acknowledgement;
  result.childCompletionInNativeWaitReceipt = confirmedChild;
  result.successfulTerminalTurns = successfulTerminalTurns;
  result.toolEventCount = after.trace.events.filter(item => item.event.kind === 'update' && item.event.update.kind === 'tool_call').length;
  result.nativeToolStarts = durable.tools.length;
  result.outcome = confirmedChild && acknowledgement && secondAdmitted && successfulTerminalTurns
    ? 'observed-background-and-second-message-delivery' : 'inconclusive-child-or-acknowledgement';
  result.before = before; result.after = after; result.nativeEvidence = durable;
  if (!confirmedChild) result.limitations.push('No successful actual native wait receipt confirms the child marker; preserve fixture.');
}

async function resumeClaude() {
  phase = 'existing-claude-owner';
  const prior = previous.engines[0];
  const view = await owner();
  const rpcOwner = await desktop.evaluate(() => ({ grant: globalThis.__namzuDeliveryRpc.allowed[0], request: globalThis.__namzuDeliveryRpc.requests[0] }));
  assert(view.isolated && view.sessionId === prior.after.trace.sessionId && view.sessionId === rpcOwner.grant.sessionId);
  assert.equal(rpcOwner.grant.engine, 'claude-code');
  assert.equal(rpcOwner.request.engine, 'claude-code');
  assert.equal(rpcOwner.request.uiSessionId, view.sessionId);
  assert.equal(rpcOwner.request.runtimeSessionId, prior.nativeEvidence.runtimeId);
  fixtureSessions.set('claude-code', view);
  const route = await page.evaluate(async view => ({ settings: await window.namzu.draftSettings(view.sessionId), engine: await window.namzu.harnesses(view.projectId, view.sessionId) }), view);
  assert.equal(route.engine.selected, 'claude-code'); assert.equal(route.settings.choice?.provider, 'claude-code'); assert.equal(route.settings.choice?.model, prior.model);
  assert(!route.settings.options?.permissionMode || route.settings.options.permissionMode === 'prompt');
  const expected = prior.after.trace.expected;
  assert(expected && typeof expected.second === 'string' && typeof expected.secondAck === 'string');
  await watch(view, expected);
  const before = await snapshot(view);
  assert(!before.history.thread?.running && before.history.thread.permissions.length === 0 && before.history.thread.queued.length === 0 && before.history.thread.activeToolIds.length === 0);
  const result = { engine: 'claude-code', model: prior.model, outcome: 'not-attempted', realUserUiSubmissions: 1,
    parentAlreadyTerminalBeforeSecond: true, backgroundOverlapAtSecondVerified: false,
    childStatusBeforeSecond: childEvidence?.terminalStatusObserved ? 'terminal-observed-before-second' : 'unknown',
    before, limitations: ['This second message follows the parent terminal event; actual child active overlap was not established.'] };
  receipt.engines.push(result);
  phase = 'existing-claude-second-ui';
  // Existing parent is idle: use normal UI submission, not a fake Queue click.
  await submit(view, 'claude-code', 'first', expected.second); result.realUserUiSubmissions++;
  try {
    await page.waitForFunction(() => { const trace = window.__namzuDeliveryTrace; return trace?.endedCount >= 1 && !trace.running; }, undefined, { timeout: bound });
  } catch (error) { result.outcome = 'inconclusive-existing-claude-second'; result.observationFailureName = error.name; result.after = await snapshot(view); return false; }
  const after = await snapshot(view);
  const terminal = after.trace.events.find(row => row.event.kind === 'update' && row.event.update.kind === 'turn_ended');
  const admitted = after.trace.events.some(row => row.event.kind === 'prompt' && row.event.prompt === expected.second);
  const ack = after.history.messages.some(row => row.role === 'assistant' && row.stopReason !== 'cancelled' && row.text.includes(expected.secondAck));
  result.secondAdmissionObserved = admitted; result.secondAcknowledgementObserved = ack;
  result.terminalStopReason = terminal?.event.update.stopReason;
  result.outcome = admitted && ack && terminal?.event.update.stopReason === 'end_turn'
    ? 'existing-claude-second-delivered-without-proven-background-overlap' : 'existing-claude-second-terminal-refusal-or-no-ack';
  result.after = after; result.nativeEvidence = await journal('claude-code');
  return true;
}
(async () => {
  try {
    await attach();
    const terminal = await resumeClaude();
    if (terminal) await runEngine('codex-cli');
    const rpc = await desktop.evaluate(() => globalThis.__namzuDeliveryRpc);
    receipt.nativePromptRequestsObserved = rpc.requests.length; receipt.forbiddenRequests = rpc.forbiddenRequests;
    assert.equal(rpc.forbiddenRequests, 0); assert(rpc.requests.length <= 4); assert(receipt.realUserUiSubmissions <= 4);
    receipt.completedObservation = terminal && receipt.engines.length === 2 && !receipt.engines.some(row => row.outcome.startsWith('inconclusive'));
    // First Claude overlap was missed and is immutable. Do not relabel as a full pass.
    receipt.passed = false;
  } catch (error) { receipt.failurePhase = phase; receipt.failureName = error.name; receipt.failureDiagnostic = error.message; }
  finally {
    if (nodeSocket) nodeSocket.close();
    if (browser) {
      // Disconnect only our CDP transport: never Browser.close or app/process close.
      assert.equal(typeof browser._connection?.close, 'function'); browser._connection.close();
    }
    try { identity(); receipt.exactFixtureProcessStillAliveObserved = true; } catch { receipt.exactFixtureProcessStillAliveObserved = false; }
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ schema: receipt.schema, passed: false, completedObservation: receipt.completedObservation,
      totalUserUiSubmissions: receipt.realUserUiSubmissions, nativePromptRequestsObserved: receipt.nativePromptRequestsObserved,
      automaticApprovals: 0, primaryActions: 0, computerActions: 0, fixturePreserved: true,
      firstClaudeOverlapVerified: false, exactFixtureProcessStillAliveObserved: receipt.exactFixtureProcessStillAliveObserved,
      privateReceiptBasename: path.basename(receiptPath), receiptSha256: sha(fs.readFileSync(receiptPath)),
      engines: receipt.engines.map(row => ({ engine: row.engine, model: row.model, outcome: row.outcome,
        childStatusBeforeSecond: row.childStatusBeforeSecond, secondAcknowledgementObserved: row.secondAcknowledgementObserved,
        desktopQueuedSecond: row.desktopQueuedSecond, secondAdmittedAfterFirstTerminal: row.secondAdmittedAfterFirstTerminal,
        childCompletionInNativeWaitReceipt: row.childCompletionInNativeWaitReceipt })) })}\n`);
    if (!receipt.completedObservation) process.exitCode = 1;
  }
})();
