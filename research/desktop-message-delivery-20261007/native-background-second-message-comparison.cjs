'use strict';

// Reviewed opt-in native comparison driver. The default performs no I/O/launch.
// Root alone executes: NAMZU_NATIVE_MESSAGE_DELIVERY_PROOF=1 node <file> --execute.
// Private profiles and receipts contain only this fresh fixture's own conversations.
// Child launch arguments establish a request, not proof of child work or delivery.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pinnedHelper = {
  path: '../runtime-desktop-20260930/native-harness-isolated-real-20261006.cjs',
  sha256: 'ea0a2ebc3b18e69b2e396230a24976d3f78a3bf83041397cb1ef72bb7e70d6e7',
  reused: ['isolated app/bootstrap and native lineage checks', 'owner/newFixtureChat', 'selectEngine/selectModel', 'lowest offered effort', 'owned normal-close preconditions'],
};
const plan = {
  schema: 'namzu.native-second-message-comparison-plan.v1',
  actualEngines: ['claude-code', 'codex-cli'],
  uiBoundary: 'Namzu Desktop routes to the actual installed native engines. Desktop queue observations do not establish direct native CLI steering support.',
  isolation: 'Fresh second Electron userData and NAMZU_HOME; original app receives no actions.',
  modelAllowlist: { 'claude-code': 'Offered Haiku family only, child model haiku', 'codex-cli': ['gpt-6.1-luna', 'gpt-6-luna', 'gpt-5.6-luna'] },
  expensiveFallback: false,
  namzuProviderInference: false,
  maxRealUserUiSubmissions: 4,
  perEngine: ['Start exactly one native background child restricted to one sleep 30 and a completion marker.', 'Send one second user message only while an observed child launch and native wait call remain active.'],
  nativeChildWork: { allowedCommand: 'sleep 30', allowedWindowsAlternative: 'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"', forbidden: ['file reads/writes', 'network commands', 'parent shell fallback', 'extra children', 'model fallback'] },
  permissionMode: 'Ask first only. No automatic approval, decline or cancellation; private exact approval requests are reported for root review.',
  observationBoundMs: 180000,
  boundMeaning: 'Expiration is inconclusive external observation, never proof of slow/unsupported delivery or a successful comparison.',
  childEvidence: 'Strict scoped SDK journal launch/wait input/result receipts; assistant claims alone never prove actual child completion or sleep.',
  childModelBoundary: 'The child model is explicitly requested and verified from observed native launch arguments. This driver cannot intercept private native subagent inference or prove the requested sleep ran without child receipts.',
  pendingOrUnknown: 'Preserve owned fixture and driver. Never force-kill or close the primary/process tree.',
  cleanup: 'Only confirmed idle/known-terminal fixture: corrected Electron module callback; detach Inspector transport; exact CIM lineage normal window close.',
  executionRequires: ['--execute', 'NAMZU_NATIVE_MESSAGE_DELIVERY_PROOF=1', 'native Windows Node', 'reviewed pinned launcher and script'],
  pinnedHelper,
};
if (!process.argv.includes('--execute') || process.env.NAMZU_NATIVE_MESSAGE_DELIVERY_PROOF !== '1') {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}
assert.equal(process.platform, 'win32', 'Native Windows Node is required.');
assert.deepEqual(process.argv.slice(2), ['--execute'], 'Unexpected execution flag.');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, pinnedHelper.path))).digest('hex'), pinnedHelper.sha256, 'Pinned isolation helper changed; review again.');
const development = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const config = JSON.parse(fs.readFileSync(path.join(development, 'launch.json'), 'utf8'));
for (const file of [config.electron, config.cli, path.join(config.app, 'package.json')]) assert(fs.statSync(file).isFile());
const originalPid = Number(fs.readFileSync(path.join(development, 'desktop.pid'), 'utf8').trim());
assert(Number.isSafeInteger(originalPid) && originalPid > 0);
process.kill(originalPid, 0); // Observation only; never signal the primary process.
const suffix = crypto.randomUUID();
const userData = path.join(development, `message-delivery-userdata-${suffix}`);
const home = path.join(development, `message-delivery-home-${suffix}`);
const receiptPath = path.join(development, `message-delivery-private-${suffix}.json`);
fs.mkdirSync(userData); fs.mkdirSync(home);
const bootstrap = path.join(userData, 'bootstrap.cjs');
const appPackage = JSON.parse(fs.readFileSync(path.join(config.app, 'package.json'), 'utf8'));
assert(typeof appPackage.main === 'string' && appPackage.main.length);
fs.writeFileSync(bootstrap, [
  "const { app } = require('electron');",
  `app.setPath('userData', ${JSON.stringify(userData)});`,
  "const { pathToFileURL } = require('node:url');",
  "const { join } = require('node:path');",
  `void import(pathToFileURL(join(${JSON.stringify(config.app)}, 'dist/main/rpc-client.js')).href).then((runtime) => { globalThis.__namzuIsolatedRuntime = runtime; return import(pathToFileURL(join(${JSON.stringify(config.app)}, ${JSON.stringify(appPackage.main)})).href); });`,
].join('\n'), { flag: 'wx' });
const playwrightPath = path.join(development, 'runtime/packages/p39');
assert.equal(require(path.join(playwrightPath, 'package.json')).version, '1.63.0');
const { _electron } = require(playwrightPath);
const sdkPath = path.resolve(path.dirname(config.cli), '../node_modules/@namzu/sdk/dist/public-runtime.js');
const receipt = {
  schema: 'namzu.native-second-message-comparison.v1', passed: false,
  at: new Date().toISOString(), nativeWindows: true, isolationVerified: false,
  pinnedHelper, scriptSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  installedCliSha256: crypto.createHash('sha256').update(fs.readFileSync(config.cli)).digest('hex'),
  maxRealUserUiSubmissions: 4, realUserUiSubmissions: 0,
  engines: [], automaticApprovals: 0, guestActions: 0, primaryActions: 0,
  pageErrorCount: 0, limitations: [
    'Desktop queues are separate from direct native engine live-input capabilities.',
    'Native models/services can refuse or outlast the observation bound; no latency superiority is claimed.',
    'Child launch requests and parent replies do not prove child execution; raw child receipts may not be forwarded.',
    'Native engine subagent availability and explicit low-cost child model support can differ.',
    'Only offered parent models are selected; native child inference is not independently intercepted. Actual child launch arguments must match the requested model to qualify.',
    'A strict journal hash is a post-observation hash, not a pre/post unchanged-file claim.',
  ],
};
let phase = 'launch';
let desktop;
let page;
let sdk;
let preserveFixture = true;
const fixtureSessions = new Map();
const lunaIds = ['gpt-6.1-luna', 'gpt-6-luna', 'gpt-5.6-luna'];
const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const effortName = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
const bound = 180000;
const digest = value => crypto.createHash('sha256').update(
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
).digest('hex');
function observationBudget(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error('External observation budget exhausted; outcome is inconclusive.');
    error.name = 'ExternalObservationBudgetExhausted';
    throw error;
  }
  return remaining;
}
function contained(root, target) { const relative = path.relative(root, target); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); }
function currentEnv() {
  const env = { ...process.env, NAMZU_HOME: home, NAMZU_DESKTOP_CLI: config.cli };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const name of Object.keys(env)) if (name.startsWith('NAMZU_TEST_') || name.startsWith('NAMZU_REFERENCE_')) delete env[name];
  if (/^https?:\/\/127\.0\.0\.1(?::\d+)?\/?$/.test(config.url ?? '')) env.NAMZU_DESKTOP_DEV_URL = config.url;
  else delete env.NAMZU_DESKTOP_DEV_URL;
  return env;
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
async function installRpcObserver() {
  await desktop.evaluate(module => {
    const electron = module.default ?? module;
    if (!electron.app) throw new Error('Electron Inspector module has no app.');
    const { RuntimeClient } = globalThis.__namzuIsolatedRuntime;
    if (typeof RuntimeClient?.prototype?.request !== 'function') throw new Error('Fixture RPC module unavailable.');
    const original = RuntimeClient.prototype.request;
    const state = { allowed: [], requests: [], forbiddenRequests: 0 };
    RuntimeClient.prototype.request = function(method, params, timeout) {
      if (method === 'session/prompt') {
        const admitted = state.allowed.find(item => !item.consumed && item.prompt === params?.prompt);
        if (!admitted || state.requests.length >= 4) {
          state.forbiddenRequests += 1;
          return Promise.reject(new Error('Fixture forbids an unreviewed or extra prompt.'));
        }
        admitted.consumed = true;
        state.requests.push({ engine: admitted.engine, uiSessionId: admitted.sessionId, stage: admitted.stage, runtimeSessionId: params.sessionId, at: Date.now() });
      }
      if (method === 'namzu/sessions/retry' || /pal.*computer|computer.*pal/.test(method)) {
        state.forbiddenRequests += 1;
        return Promise.reject(new Error('Fixture forbids retry/computer actions.'));
      }
      return original.call(this, method, params, timeout);
    };
    globalThis.__namzuDeliveryRpc = state;
  });
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
        void window.__namzuDeliveryApprovalNotice({ request: event.request, index: trace.events.length - 1 });
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
  if (stage === 'second') {
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
async function main() {
  sdk = await import(pathToFileURL(sdkPath).href);
  assert.equal(typeof sdk.readSessionLog, 'function');
  desktop = await _electron.launch({ executablePath: config.electron, args: [bootstrap, `--user-data-dir=${userData}`, '--force-renderer-accessibility'], cwd: config.root, env: currentEnv(), timeout: 90000 });
  const identity = await desktop.evaluate(module => { const electron = module.default ?? module; return { pid: process.pid, userData: electron.app.getPath('userData') }; });
  assert.notEqual(identity.pid, originalPid);
  assert.equal(path.normalize(identity.userData).toLowerCase(), path.normalize(userData).toLowerCase());
  receipt.fixturePid = identity.pid; receipt.originalPid = originalPid;
  const launcherPid = desktop.process().pid;
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const inventory = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', `$ids=@(${launcherPid},${identity.pid}); $rows=@(Get-CimInstance Win32_Process | Where-Object {$ids -contains [int]$_.ProcessId} | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;executable=$_.ExecutablePath;createdAt=$_.CreationDate.ToUniversalTime().ToString('o');ownsFixture=[bool]($_.CommandLine -and $_.CommandLine.IndexOf(${quote(userData)},[System.StringComparison]::OrdinalIgnoreCase) -ge 0)}}); ConvertTo-Json -InputObject $rows -Depth 3 -Compress`], { encoding: 'utf8', windowsHide: true });
  assert.equal(inventory.status, 0);
  const owned = JSON.parse(inventory.stdout.trim());
  const actual = owned.find(row => row.pid === identity.pid);
  const launcher = owned.find(row => row.pid === launcherPid);
  assert(actual?.ownsFixture && launcher?.ownsFixture);
  assert.equal(path.normalize(actual.executable).toLowerCase(), path.normalize(config.electron).toLowerCase());
  if (launcherPid !== identity.pid) { assert.equal(actual.parent, launcherPid); assert.equal(launcher.name.toLowerCase(), 'cmd.exe'); assert(Date.parse(actual.createdAt) >= Date.parse(launcher.createdAt)); }
  receipt.fixtureCreatedAt = actual.createdAt; receipt.launchLineageVerified = true;
  page = await desktop.firstWindow(); page.on('pageerror', () => receipt.pageErrorCount++);
  await page.waitForFunction(() => typeof window.namzu?.openChat === 'function');
  assert.deepEqual(await page.evaluate(async () => ({ projects: (await window.namzu.projects()).length, pals: (await window.namzu.pals()).length })), { projects: 0, pals: 0 });
  receipt.isolationVerified = true;
  await desktop.evaluate(module => { const electron = module.default ?? module; const windows = electron.BrowserWindow.getAllWindows(); if (windows.length !== 1) throw new Error('Unexpected fixture window count.'); windows[0].setTitle('Namzu · Isolated message delivery test'); });
  await page.exposeBinding('__namzuDeliveryApprovalNotice', (_source, value) => {
    const file = path.join(development, `message-delivery-approval-private-${suffix}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), fixturePid: receipt.fixturePid, ...value }, null, 2)}\n`, { flag: 'wx' });
    receipt.approvalRequests = (receipt.approvalRequests ?? 0) + 1;
    process.stdout.write(`${JSON.stringify({ kind: 'manual-approval-review-required', automaticApproval: false, privateReceiptBasename: path.basename(file), receiptSha256: digest(fs.readFileSync(file)) })}\n`);
  });
  await installRpcObserver();
  for (const engine of ['claude-code', 'codex-cli']) {
    await runEngine(engine);
    const latest = receipt.engines.at(-1);
    if (!['observed-background-and-second-message-delivery', 'requested-low-cost-native-model-unavailable', 'native-background-agent-unavailable'].includes(latest.outcome)) break;
  }
  const rpc = await desktop.evaluate(() => globalThis.__namzuDeliveryRpc);
  receipt.nativePromptRequestsObserved = rpc.requests.length; receipt.forbiddenRequests = rpc.forbiddenRequests;
  assert.equal(rpc.forbiddenRequests, 0); assert(rpc.requests.length <= 4);
  receipt.passed = receipt.isolationVerified && receipt.pageErrorCount === 0 && receipt.engines.length === 2 && receipt.engines.every(entry => entry.outcome === 'observed-background-and-second-message-delivery') && receipt.realUserUiSubmissions === 4;
  preserveFixture = !receipt.engines.every(entry => ['observed-background-and-second-message-delivery', 'requested-low-cost-native-model-unavailable', 'native-background-agent-unavailable'].includes(entry.outcome));
}
async function closeIdleFixture() {
  const idle = await page.evaluate(async views => {
    const api = window.namzu;
    if ((await api.pals()).length) return false;
    for (const view of views) {
      const thread = (await api.openConversation(view.projectId, view.sessionId)).thread;
      const jobs = await api.jobs(view.sessionId);
      if (!thread || thread.running || thread.responding || thread.retry || thread.retryNotice || thread.permissions.length || thread.queued.length || thread.queuedItems.length || thread.activeToolIds.length || !Array.isArray(jobs) || jobs.some(job => job.status === 'running' || job.recoveryRequired)) return false;
    }
    return true;
  }, [...fixtureSessions.values()]);
  assert(idle, 'Preserve a fixture with unresolved work.');
  const identity = await desktop.evaluate(module => { const electron = module.default ?? module; return { pid: process.pid, userData: electron.app.getPath('userData'), windows: electron.BrowserWindow.getAllWindows().length }; });
  assert.equal(identity.pid, receipt.fixturePid); assert.equal(identity.userData, userData); assert.equal(identity.windows, 1);
  const launcher = desktop.process();
  const wrapperClosed = launcher.exitCode !== null ? Promise.resolve() : new Promise(resolve => launcher.once('close', resolve));
  const impl = desktop._connection?.toImpl?.(desktop);
  assert.equal(typeof impl?._nodeConnection?._transport?.closeAndWait, 'function');
  await impl._nodeConnection._transport.closeAndWait(); // Detach Inspector only; never ElectronApplication.close().
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const closed = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', `$row=Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}"; if (!$row -or $row.ExecutablePath -ne ${quote(config.electron)} -or $row.CreationDate.ToUniversalTime().ToString('o') -ne ${quote(receipt.fixtureCreatedAt)} -or !$row.CommandLine -or $row.CommandLine.IndexOf(${quote(userData)},[System.StringComparison]::OrdinalIgnoreCase) -lt 0 -or [int]$row.ParentProcessId -ne ${launcher.pid}) {throw 'Fixture identity changed'}; $owned=Get-Process -Id ${identity.pid}; if (!$owned.CloseMainWindow()) {throw 'Normal fixture close refused'}; if (!$owned.WaitForExit(60000)) {throw 'Fixture remains open'}; Write-Output '{"normalOwnedWindowClosed":true}'`], { encoding: 'utf8', windowsHide: true });
  assert.equal(closed.status, 0, 'Normal owned fixture window close did not complete.');
  await wrapperClosed;
  receipt.ownedFixtureClosed = true; receipt.cleanupLineageVerified = true;
  receipt.cleanupMethod = 'exact owned normal window close; Inspector detached; no process tree kill';
}
(async () => {
  try { await main(); }
  catch (error) { receipt.passed = false; receipt.failurePhase = phase; receipt.failureName = error.name; receipt.failureDiagnostic = error.message; preserveFixture = true; }
  finally {
    if (desktop && page && !preserveFixture) {
      try { await closeIdleFixture(); }
      catch (error) { receipt.passed = false; receipt.cleanupFailureName = error.name; receipt.cleanupDiagnostic = error.message; preserveFixture = true; }
    }
    receipt.preservedFixtureForReview = Boolean(desktop && preserveFixture);
    try { process.kill(originalPid, 0); receipt.originalProcessStillAliveObserved = true; } catch { receipt.originalProcessStillAliveObserved = false; receipt.passed = false; }
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ schema: receipt.schema, passed: receipt.passed, isolationVerified: receipt.isolationVerified, realUserUiSubmissions: receipt.realUserUiSubmissions, nativePromptRequestsObserved: receipt.nativePromptRequestsObserved, automaticApprovals: 0, fixturePreserved: receipt.preservedFixtureForReview, originalProcessStillAliveObserved: receipt.originalProcessStillAliveObserved, receiptSha256: digest(fs.readFileSync(receiptPath)), privateReceiptBasename: path.basename(receiptPath), engines: receipt.engines.map(entry => ({ engine: entry.engine, model: entry.model, outcome: entry.outcome, desktopQueuedSecond: entry.desktopQueuedSecond, secondAdmittedAfterFirstTerminal: entry.secondAdmittedAfterFirstTerminal, secondAcknowledgementObserved: entry.secondAcknowledgementObserved, childCompletionInNativeWaitReceipt: entry.childCompletionInNativeWaitReceipt, nativeToolStarts: entry.nativeToolStarts, externalLatency: entry.externalLatency })) })}\n`);
    if (!receipt.passed) process.exitCode = 1;
    // Preserve the driver with an unknown/pending fixture. No arbitrary timeout or kill.
    if (receipt.preservedFixtureForReview && desktop.process().exitCode === null) await new Promise(resolve => desktop.process().once('close', resolve));
  }
})();
