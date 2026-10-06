'use strict';

// Opt-in, real native Windows UI/inference proof in a second, empty Namzu profile.
// Requires explicit execution after the guarded desktop activation is reviewed.
// Native Windows Node: set NAMZU_REAL_HARNESS_PROOF=1, then pass --execute.
// Without both switches this file prints its plan and launches nothing.
// Public output contains no prompt, answer, account, path, or raw error text.
// Private fixture-only selector/notice diagnostics are retained on failure.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const plan = {
	schema: 'namzu.native-harness-isolated-plan.v1',
	isolation: 'second Electron process; fresh userData and NAMZU_HOME under private Development',
	actualEngines: ['namzu', 'codex-cli', 'claude-code'],
	uiModes: {
		namzu: ['Ask first', 'Allow tools', 'Plan'],
		'codex-cli': ['Ask first', 'Full access', 'Plan'],
		'claude-code': ['Ask first', 'Plan'],
	},
	maximumRealPrompts: 4,
	optionalFixtureRemoval: '--verify-removal deletes one isolated conversation with a verified settled reply through its confirmation UI after all turns, preferring Codex when available.',
	palOnlyRecheck: '--pal-only --verify-pal-removal opens one unsent ordinary tab, then creates and deletes one Pal with zero prompts.',
	optionalPalRemoval: '--verify-pal-removal creates one uniquely named, model-free fixture Pal through customization, verifies its computer is stopped, then deletes it through confirmation UI. Any attempted prompt/model selection/computer start aborts and preserves this second fixture.',
	modeBoundary: 'Full access is selected and confirmed only in the isolated draft, then reset before any prompt. Mode selection is not proof of tool review behavior.',
	modelBoundary: 'Only an actually listed Zen space-bunny-free model is attempted; native engines use their own offered catalogues. Claude local sign-in does not establish inference authorization.',
};
if (!process.argv.includes('--execute') || process.env.NAMZU_REAL_HARNESS_PROOF !== '1') {
	process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
	process.exit(0);
}

assert.equal(process.platform, 'win32', 'This proof requires native Windows Node.');
const development = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const config = JSON.parse(fs.readFileSync(path.join(development, 'launch.json'), 'utf8'));
const requiredFiles = [config.electron, config.cli, path.join(config.app, 'package.json')];
for (const file of requiredFiles) assert(fs.statSync(file).isFile(), 'Installed desktop/CLI input is missing.');
const originalPid = Number(fs.readFileSync(path.join(development, 'desktop.pid'), 'utf8').trim());
assert(Number.isInteger(originalPid) && originalPid > 0, 'The original owned desktop PID is absent.');
process.kill(originalPid, 0);
const palOnly = process.argv.includes('--pal-only');
assert(!palOnly || (!process.argv.includes('--verify-removal') && process.argv.includes('--verify-pal-removal')));
const reuseOptions = process.argv.filter((arg) => arg.startsWith('--reuse-owned-fixture='));
assert(reuseOptions.length <= 1 && (!palOnly || reuseOptions.length === 0));
let reuse;
if (reuseOptions.length) {
	const file = path.resolve(reuseOptions[0].slice('--reuse-owned-fixture='.length));
	assert.equal(path.dirname(file).toLowerCase(), development.toLowerCase());
	const match = path.basename(file).match(/^harness-fixture-private-([0-9a-f-]{36})\.json$/);
	assert(match);
	const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert(previous.isolationVerified && previous.nativeWindows && previous.realPromptsSent === 4);
	assert.equal(previous.failurePhase, 'fixture-removal-ui');
	assert(previous.engines.length === 3 && previous.engines.every((entry) => entry.outcome === 'all-attempted-live-answers-observed'));
	let previousAlive = false;
	try { process.kill(previous.fixturePid, 0); previousAlive = true; } catch { /* Closed exact fixture. */ }
	assert(!previousAlive, 'Close the retained fixture normally before its targeted recheck.');
	reuse = { suffix: match[1], proofHash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
const suffix = reuse?.suffix ?? crypto.randomUUID();
const invocation = crypto.randomUUID();
const userData = path.join(development, `harness-fixture-userdata-${suffix}`);
const home = path.join(development, `harness-fixture-home-${suffix}`);
const receiptPath = path.join(development, `harness-fixture-private-${reuse ? invocation : suffix}.json`);
if (reuse) { assert(fs.statSync(userData).isDirectory()); assert(fs.statSync(home).isDirectory()); }
else { fs.mkdirSync(userData); fs.mkdirSync(home); }
// Set Electron's app path before the production main module is imported. A
// Chromium --user-data-dir switch alone is not proof that app.getPath('userData')
// was private when requestSingleInstanceLock and Operator were constructed.
const appPackage = JSON.parse(fs.readFileSync(path.join(config.app, 'package.json'), 'utf8'));
assert(typeof appPackage.main === 'string' && appPackage.main.length > 0);
const bootstrap = path.join(userData, reuse ? `bootstrap-removal-recheck-${invocation}.cjs` : 'bootstrap.cjs');
fs.writeFileSync(bootstrap, [
	"const { app } = require('electron');",
	`app.setPath('userData', ${JSON.stringify(userData)});`,
	"const { pathToFileURL } = require('node:url');",
	"const { join } = require('node:path');",
	`void import(pathToFileURL(join(${JSON.stringify(config.app)}, 'dist/main/rpc-client.js')).href).then((runtime) => { globalThis.__namzuIsolatedRuntime = runtime; return import(pathToFileURL(join(${JSON.stringify(config.app)}, ${JSON.stringify(appPackage.main)})).href); });`,
].join('\n'), { flag: 'wx' });
const playwright = require(path.join(development, 'runtime', 'packages', 'p39'));
const { _electron } = playwright;
assert(_electron && typeof _electron.launch === 'function', 'Native Playwright Electron launcher is unavailable.');
const removalRequested = process.argv.includes('--verify-removal');
const palRemovalRequested = process.argv.includes('--verify-pal-removal');

const receipt = {
	schema: 'namzu.native-harness-isolated-real.v1',
	passed: false,
	nativeWindows: true,
	isolationVerified: false,
	installedCliSha256: crypto.createHash('sha256').update(fs.readFileSync(config.cli)).digest('hex'),
	maxRealPrompts: palOnly ? 0 : reuse ? 1 : 4,
	palOnly,
	retainedFixtureRecheck: Boolean(reuse),
	priorEngineProofHash: reuse?.proofHash,
	realPromptsSent: 0,
	removalRequested,
	palRemovalRequested,
	engines: [],
	pageErrorCount: 0,
	limitations: [
		'An offered catalogue and local sign-in do not establish inference authorization.',
		'Tool-free prompts do not prove Ask first approval or Full access enforcement.',
		'Live model completion can be inconclusive because of external service latency.',
	],
};
let phase = 'launch';
let desktop;
let page;
let activeTurn = false;
let preserveFixture = false;
const preference = ['gpt-6.1-luna', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-sol'];
const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const fixtureSessions = new Map();
const effortName = {
	none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
	xhigh: 'Extra high', max: 'Max', ultra: 'Ultra',
};
const modeName = {
	namzu: { prompt: 'Ask first', auto: 'Allow tools', plan: 'Plan' },
	'codex-cli': { prompt: 'Ask first', auto: 'Full access', plan: 'Plan' },
	'claude-code': { prompt: 'Ask first', plan: 'Plan' },
};

function currentEnv() {
	const env = { ...process.env, NAMZU_HOME: home, NAMZU_DESKTOP_CLI: config.cli };
	// Reuse the installed launcher's engine coordinates for read-only status;
	// this proof forbids computer start, execution and machine provisioning.
	if (config.podman && fs.statSync(config.podman).isFile()) Object.assign(env, {
		NAMZU_PAL_COMPUTER_ENGINE: 'podman', NAMZU_PAL_PODMAN_BINARY: config.podman,
		NAMZU_PAL_PODMAN_MACHINE: 'podman-machine-default',
		NAMZU_PAL_PODMAN_CONNECTION: 'podman-machine-default-root',
	});
	delete env.ELECTRON_RUN_AS_NODE;
	for (const name of Object.keys(env))
		if (name.startsWith('NAMZU_TEST_') || name.startsWith('NAMZU_REFERENCE_')) delete env[name];
	if (/^https?:\/\/127\.0\.0\.1(?::\d+)?\/?$/.test(config.url ?? ''))
		env.NAMZU_DESKTOP_DEV_URL = config.url;
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

async function catalogue(projectId, sessionId, engine) {
	phase = `catalogue-${engine}`;
	const data = await page.evaluate(async ({ projectId, sessionId, engine }) => {
		const api = window.namzu;
		const available = await api.providers(projectId, sessionId);
		const provider = available.available.find((item) => item.id === (engine === 'namzu' ? 'zen' : engine));
		if (!provider) return { provider: null, models: [], notice: false };
		const catalogue = await api.models(projectId, provider.id, sessionId);
		return { provider, models: catalogue.models, notice: Boolean(catalogue.notice) };
	}, { projectId, sessionId, engine });
	const models = data.models;
	const preferred = engine === 'namzu'
		? models.find((item) => item.id === 'space-bunny-free')
		: engine === 'claude-code'
			? models.find((item) => /haiku/i.test(item.id)) ??
				models.find((item) => /sonnet/i.test(item.id)) ?? models[0]
		: preference.map((id) => models.find((item) => item.id === id)).find(Boolean) ?? models[0];
	return { ...data, choice: preferred ?? null };
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

async function verifyWarmCatalogue() {
	phase = 'warm-model-catalogue';
	await page.waitForFunction(() => {
		const trigger = document.querySelector('button[aria-label="Select model"]');
		return trigger && !trigger.disabled;
	});
	const before = await desktop.evaluate(() => globalThis.__namzuIsolatedCatalogueReads.count);
	let rows = 0;
	for (let reopen = 0; reopen < 2; reopen++) {
		await page.getByRole('button', { name: 'Select model', exact: true }).click();
		const popup = page.locator('.model-picker-popup');
		await popup.getByRole('radio').first().waitFor({ state: 'visible' });
		assert.equal(await popup.getByText('Loading models', { exact: true }).count(), 0);
		rows = await popup.getByRole('radio').count();
		await page.keyboard.press('Escape');
		await popup.waitFor({ state: 'hidden' });
	}
	const after = await desktop.evaluate(() => globalThis.__namzuIsolatedCatalogueReads.count);
	assert.equal(after, before, 'Reopening the admitted catalogue issued a duplicate read.');
	return { reopens: 2, repeatedCatalogueRequests: after - before, rows };
}

async function setMode(view, engine, mode) {
	phase = `mode-${engine}-${mode}`;
	const label = modeName[engine][mode];
	assert(label, 'The requested engine does not expose this mode in the fixture UI.');
	const trigger = page.getByRole('combobox', { name: 'Tool permissions', exact: true });
	const changed = !(await trigger.textContent()).includes(label);
	if (changed) {
		await trigger.click();
		await page.getByRole('option', { name: label, exact: false }).click();
		if (engine === 'codex-cli' && mode === 'auto') {
			await page.getByRole('alertdialog', { name: 'Allow Codex full access?' }).waitFor({ state: 'visible' });
			await page.getByRole('button', { name: 'Enable full access', exact: true }).click();
		}
	}
	if (changed)
		await page.waitForFunction(async ({ id, wanted }) =>
			(await window.namzu.draftSettings(id)).options?.permissionMode === wanted,
			{ id: view.sessionId, wanted: mode });
	assert((await trigger.textContent()).includes(label));
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
	const desired = levels.find((level) => level !== settings.effortDefault) ?? levels[0];
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

async function sendOne(view, engine, mode, providerId, modelId) {
	phase = `send-${engine}-${mode}`;
	assert(receipt.realPromptsSent < receipt.maxRealPrompts, 'Real prompt cap exceeded.');
	const prompt = `Reply with exactly OK. Do not call tools, run commands, open files, browse, or make changes. Proof ${crypto.randomUUID()}.`;
	const before = await page.evaluate(async ({ projectId, sessionId }) => {
		const value = await window.namzu.openConversation(projectId, sessionId);
		return { count: value.messages.length, turn: value.thread?.turn ?? 0 };
	}, view);
	await page.evaluate(({ sessionId }) => {
		window.__namzuHarnessProbe?.dispose();
		const state = { prompted: false, ended: false, idle: false, permission: false };
		const dispose = window.namzu.onEvent((event) => {
			const ownerId = event.kind === 'permission' ? event.request.sessionId : event.sessionId;
			if (ownerId !== sessionId) return;
			if (event.kind === 'prompt') { state.prompted = true; state.idle = false; }
			if (event.kind === 'update' && event.update.kind === 'turn_ended') state.ended = true;
			if (event.kind === 'state' && state.prompted && !event.running) state.idle = true;
			if (event.kind === 'permission') state.permission = true;
		});
		window.__namzuHarnessProbe = { state, dispose };
	}, view);
	const input = page.getByRole('textbox', { name: 'Message Namzu', exact: true });
	await input.fill(prompt);
	activeTurn = true;
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	receipt.realPromptsSent += 1;
	let terminal;
	try {
		await page.waitForFunction(() => {
			const state = window.__namzuHarnessProbe?.state;
			return Boolean(state?.permission || (state?.prompted && state?.ended && state?.idle));
		}, undefined, { timeout: 180000 });
		const observed = await page.evaluate(() => window.__namzuHarnessProbe?.state);
		if (observed?.permission) {
			terminal = { inconclusive: true, reason: 'Unexpected tool approval requires manual review.' };
			return { mode, ...terminal };
		}
		terminal = await page.evaluate(async ({ projectId, sessionId, count }) => {
			const value = await window.namzu.openConversation(projectId, sessionId);
			const appended = value.messages.slice(count);
			const route = (await window.namzu.providers(projectId, sessionId)).selected;
			return {
				stopReason: value.thread?.stopReason ?? null,
				error: Boolean(value.thread?.error),
				privateErrorDiagnostic: value.thread?.error ?? null,
				userRows: appended.filter((row) => row.role === 'user').length,
				assistantRows: appended.filter((row) => row.role === 'assistant' && row.text.trim()).length,
				selectedRoute: { provider: route?.id ?? null, model: route?.model ?? null },
			};
		}, { ...view, count: before.count });
		const after = await page.evaluate(async ({ projectId, sessionId }) => {
			const value = await window.namzu.openConversation(projectId, sessionId);
			return { count: value.messages.length, turn: value.thread?.turn ?? 0, running: value.thread?.running };
		}, view);
		assert(after.count > before.count && after.turn > before.turn && after.running === false,
			'The observed terminal does not belong to a new settled turn.');
		terminal.routeMatches = terminal.selectedRoute.provider === providerId &&
			terminal.selectedRoute.model === modelId;
		delete terminal.selectedRoute;
		await page.evaluate(() => { window.__namzuHarnessProbe?.dispose(); window.__namzuHarnessProbe = undefined; });
		activeTurn = false;
	} catch {
		terminal = { inconclusive: true, reason: 'No terminal state observed within proof bound.' };
	}
	return { mode, ...terminal };
}

async function runEngine(engine) {
	const result = { engine, offered: false, modes: [], turns: [] };
	receipt.engines.push(result);
	let view = await newFixtureChat();
	view = (await selectEngine(engine)) ?? view;
	fixtureSessions.set(engine, view);
	const data = await catalogue(view.projectId, view.sessionId, engine);
	result.offered = Boolean(data.provider && data.choice);
	result.catalogueRows = data.models.length;
	result.catalogueNotice = data.notice;
	if (!data.provider || !data.choice) {
		result.outcome = engine === 'namzu' ? 'known-free-model-unavailable' : 'native-model-unavailable';
		return;
	}
	await selectModel(view, data.provider, data.choice);
	result.initialModel = data.choice.id;
	result.warmCatalogue = await verifyWarmCatalogue();
	for (const mode of Object.keys(modeName[engine])) {
		await setMode(view, engine, mode);
		result.modes.push(mode);
	}
	await setMode(view, engine, 'prompt');
	result.effort = engine === 'claude-code'
		? { offered: false }
		: await setLowestOfferedEffort(view, data.provider, data.choice);
	result.turns.push(await sendOne(view, engine, 'prompt', data.provider.id, data.choice.id));
	if (activeTurn) return;
	if (engine === 'codex-cli') {
		const alternative = preference.map((id) => data.models.find((item) => item.id === id && id !== data.choice.id))
			.find(Boolean) ?? data.models.find((item) => item.id !== data.choice.id);
		if (alternative) {
			await selectModel(view, data.provider, alternative);
			result.switchedModel = alternative.id;
			result.warmCatalogueAfterModelChange = await verifyWarmCatalogue();
			await setMode(view, engine, 'plan');
			result.turns.push(await sendOne(view, engine, 'plan', data.provider.id, alternative.id));
		} else result.modelSwitch = 'not-available';
	}
	result.outcome = result.turns.every((item) =>
		item.stopReason === 'end_turn' && item.assistantRows > 0 && item.routeMatches)
		? 'all-attempted-live-answers-observed'
		: result.turns.some((item) => item.inconclusive) ? 'inconclusive' : 'no-successful-answer';
}

async function verifyFixtureRemoval() {
	phase = 'fixture-removal-preflight';
	receipt.removal = { requested: true, passed: false };
	const engine = ['codex-cli', 'namzu', 'claude-code'].find((id) =>
		receipt.engines.some((entry) => entry.engine === id && entry.outcome === 'all-attempted-live-answers-observed' && entry.turns.length > 0));
	const view = fixtureSessions.get(engine);
	assert(view, 'No isolated conversation has a successful settled turn for removal.');
	assert(/^[a-zA-Z0-9-]{1,100}$/.test(view.sessionId), 'Fixture session ID is unsafe for a selector.');
	const safe = await page.evaluate(async ({ projectId, sessionId }) => {
		const api = window.namzu;
		const projects = await api.projects();
		const history = await api.openConversation(projectId, sessionId);
		const jobs = await api.jobs(sessionId);
		const rows = await api.conversations(projectId);
		const thread = history.thread;
		return projects.length === 1 && projects[0]?.isChat &&
			(await api.pals()).length === 0 &&
			rows.some((row) => row.id === sessionId && !row.palId) &&
			Boolean(thread && !thread.running && !thread.responding && !thread.permissions.length &&
				!thread.queued.length && !thread.queuedItems.length && !thread.activeToolIds.length) &&
			jobs.every((job) => job.status !== 'running' && !job.recoveryRequired);
	}, view);
	assert(safe, 'The isolated fixture is not idle for conversation removal.');
	phase = 'fixture-removal-ui';
	const row = page.locator(`.sidebar-recent-list [data-thread-item][data-session-id="${view.sessionId}"]`);
	await row.waitFor({ state: 'visible' });
	await row.hover();
	await row.locator('.sidebar-thread-menu').click();
	await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
	const dialog = page.getByRole('alertdialog', { name: 'Delete conversation?', exact: true });
	await dialog.waitFor({ state: 'visible' });
	await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click();
	await dialog.waitFor({ state: 'hidden' });
	await row.waitFor({ state: 'detached' });
	const gone = await page.evaluate(async ({ projectId, sessionId }) => {
		const api = window.namzu;
		const listed = (await api.conversations(projectId)).some((item) => item.id === sessionId);
		const workspace = await api.workspace();
		const windowView = workspace.layout.windows.find((entry) => entry.id === workspace.windowId);
		const groups = (node) => !node ? [] : node.kind === 'group'
			? [node] : [...groups(node.first), ...groups(node.second)];
		const tabOpen = groups(windowView?.root).some((group) => group.tabs.includes(sessionId));
		return !listed && !tabOpen;
	}, view);
	assert(gone, 'The isolated conversation remains listed or open after confirmation.');
	const archiveAcknowledgements = await desktop.evaluate(() => globalThis.__namzuIsolatedCatalogueReads.archiveAcknowledgements);
	assert(archiveAcknowledgements.length > 0 && archiveAcknowledgements.some((entry) => entry.archived && !entry.missing),
		'The completed native conversation was removed without a durable archive acknowledgement.');
	receipt.removal = { requested: true, passed: true, engine, uiConfirmed: true,
		durableArchiveAcknowledged: true, archiveAcknowledgements, catalogueAbsent: true, tabAbsent: true };
}

async function verifyPalFixtureRemoval() {
	phase = 'pal-fixture-preflight';
	receipt.palRemoval = { requested: true, passed: false };
	assert(!activeTurn && receipt.engines.length === (palOnly ? 0 : reuse ? 1 : 3) && receipt.engines.every((entry) =>
		entry.turns.length > 0 && entry.turns.every((turn) => turn.stopReason && !turn.inconclusive)),
		'All requested fixture engines must have observed terminal attempts before creating a Pal.');
	const before = await page.evaluate(async (views) => {
		const api = window.namzu;
		const pals = await api.pals();
		const projects = await api.projects();
		const workspace = await api.workspace();
		const groups = (node) => !node ? [] : node.kind === 'group'
			? [node] : [...groups(node.first), ...groups(node.second)];
		const tabs = workspace.layout.windows.flatMap((window) => groups(window.root).flatMap((group) => group.tabs));
		let idle = true;
		for (const view of views) {
			const rows = await api.conversations(view.projectId);
			if (!rows.some((row) => row.id === view.sessionId)) { idle = false; continue; }
			const history = await api.openConversation(view.projectId, view.sessionId);
			const thread = history.thread;
			const jobs = await api.jobs(view.sessionId);
			if (!thread || thread.running || thread.responding || thread.permissions.length ||
				thread.queued.length || thread.queuedItems.length || thread.activeToolIds.length ||
				thread.retry || thread.retryNotice || !Array.isArray(jobs) ||
				jobs.some((job) => job.status === 'running' || job.recoveryRequired)) idle = false;
		}
		return { profiles: pals.length, projectIds: projects.map((project) => project.id),
			ordinaryOnly: projects.length === 1 && projects[0].isChat && !projects[0].palId,
			tabs, idle, supportsDelete: typeof api.deletePal === 'function' };
	}, [...fixtureSessions.entries()].filter(([engine]) =>
		engine !== receipt.removal?.engine || receipt.removal?.passed !== true).map(([, view]) => view));
	assert.equal(before.profiles, 0, 'The isolated profile must have no pre-existing Pal.');
	assert(before.ordinaryOnly && before.idle && before.supportsDelete,
		'The isolated conversations are not idle or Pal deletion is unavailable.');
	// This guard is installed only inside the second Electron's existing main
	// module. It refuses unexpected side effects before RPC dispatch; it never
	// wraps or changes the original user's desktop or account configuration.
	await desktop.evaluate(async (_electron, appDirectory) => {
		const { RuntimeClient } = globalThis.__namzuIsolatedRuntime;
		if (typeof RuntimeClient?.prototype?.request !== 'function') throw new Error('Fixture RPC module is unavailable.');
		const original = RuntimeClient.prototype.request;
		const state = { forbiddenRequests: 0, createRequests: 0, deleteRequests: 0 };
		RuntimeClient.prototype.request = function (method, params, timeout) {
			if (method === 'session/prompt' || method === 'namzu/sessions/retry' ||
				method === 'namzu/providers/select' || method === 'namzu/harnesses/select' ||
				(method.startsWith('namzu/pals/computer/') &&
					method !== 'namzu/pals/computer/status' && method !== 'namzu/pals/computer/stop')) {
				state.forbiddenRequests += 1;
				return Promise.reject(new Error('Fixture Pal removal refused unexpected execution or setup.'));
			}
			if (method === 'namzu/pals/create') state.createRequests += 1;
			if (method === 'namzu/pals/delete') state.deleteRequests += 1;
			return original.call(this, method, params, timeout);
		};
		globalThis.__namzuIsolatedPalRemovalGuard = { state, restore: () => { RuntimeClient.prototype.request = original; } };
	}, config.app);
	preserveFixture = true;
	const name = `Removal fixture ${suffix.slice(0, 12)}`;
	phase = 'pal-fixture-create-ui';
	await page.getByRole('button', { name: 'Create your first Pal', exact: true }).click();
	await page.locator('.pal-onboarding-footer').getByRole('button', { name: 'Customize your Pal', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'Customize your Pal', exact: true });
	await editor.waitFor({ state: 'visible' });
	await editor.getByRole('textbox', { name: 'Pal name', exact: true }).fill(name);
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await page.waitForFunction(async () => {
		const pals = await window.namzu.pals();
		return pals.length === 1 || [...document.querySelectorAll('[role="alert"]')]
			.some((item) => item.getClientRects().length > 0);
	});
	const creationGuard = await desktop.evaluate(() => globalThis.__namzuIsolatedPalRemovalGuard.state);
	assert.equal(creationGuard.forbiddenRequests, 0, 'Pal save attempted inference, model setup or computer execution.');
	assert.equal(creationGuard.createRequests, 1, 'Pal save must issue exactly one profile creation.');
	const pal = await page.evaluate(async () => {
		const pals = await window.namzu.pals();
		return pals.length === 1 ? pals[0] : null;
	});
	assert(pal && pal.name === name && pal.model === null, 'The unique model-free fixture Pal was not saved.');
	assert(/^[0-9a-f-]{36}$/.test(pal.id), 'The fixture Pal identity is malformed.');
	assert.equal(path.normalize(pal.workspace).toLowerCase(),
		path.normalize(path.join(path.dirname(home), `${path.basename(home)}-workspaces`, 'pals', pal.id)).toLowerCase(),
		'The created Pal workspace is outside its fresh fixture home.');
	assert(fs.statSync(pal.workspace).isDirectory(), 'The fixture Pal has no owned workspace.');
	await editor.waitFor({ state: 'hidden' });
	await page.getByRole('button', { name: `Customize ${name}`, exact: true }).waitFor({ state: 'visible' });
	const created = await page.evaluate(async (palId) => {
		const api = window.namzu;
		const projects = (await api.projects()).filter((project) => project.palId === palId);
		const computer = await api.palComputer(palId);
		const sessions = (await Promise.all(projects.map((project) => api.conversations(project.id))))
			.flat().filter((row) => row.palId === palId);
		const visibleAlert = [...document.querySelectorAll('[role="alert"]')]
			.some((item) => item.getClientRects().length > 0);
		return { projectIds: projects.map((project) => project.id), sessionIds: sessions.map((row) => row.id),
			stopped: computer.status === 'stopped' && !computer.requiresStop && computer.control?.mode !== 'transitioning',
			visibleAlert };
	}, pal.id);
	assert(created.stopped && !created.visibleAlert && created.projectIds.length === 1 && created.sessionIds.length === 1,
		'Pal save requires computer execution or unresolved model setup; preserve this fixture for review.');
	phase = 'pal-fixture-delete-ui';
	await page.getByRole('button', { name: `Customize ${name}`, exact: true }).click();
	await editor.waitFor({ state: 'visible' });
	await editor.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
	const confirmation = page.getByRole('alertdialog', { name: `Delete ${name}?`, exact: true });
	await confirmation.waitFor({ state: 'visible' });
	await confirmation.getByRole('button', { name: 'Delete Pal', exact: true }).click();
	await confirmation.waitFor({ state: 'hidden' });
	await page.waitForFunction(async () => (await window.namzu.pals()).length === 0);
	const after = await page.evaluate(async () => {
		const api = window.namzu;
		const projects = await api.projects();
		const workspace = await api.workspace();
		const groups = (node) => !node ? [] : node.kind === 'group'
			? [node] : [...groups(node.first), ...groups(node.second)];
		const tabs = workspace.layout.windows.flatMap((window) => groups(window.root).flatMap((group) => group.tabs));
		const rows = (await Promise.all(projects.map((project) => api.conversations(project.id)))).flat();
		return { profiles: (await api.pals()).length, projectIds: projects.map((project) => project.id),
			tabs, catalogueSessionIds: rows.map((row) => row.id), hasPalProject: projects.some((project) => project.palId) };
	});
	assert.equal(after.profiles, 0);
	assert(!after.hasPalProject && created.projectIds.every((id) => !after.projectIds.includes(id)) &&
		created.sessionIds.every((id) => !after.tabs.includes(id) && !after.catalogueSessionIds.includes(id)),
		'The fixture Pal remains in projects, conversation catalogues or canonical tabs.');
	assert.deepEqual([...after.projectIds].sort(), [...before.projectIds].sort(), 'Existing fixture projects changed.');
	assert.deepEqual([...after.tabs].sort(), [...before.tabs].sort(), 'Existing fixture conversation tabs changed.');
	assert(fs.statSync(pal.workspace).isDirectory(), 'Logical Pal deletion removed its saved workspace.');
	const finalGuard = await desktop.evaluate(() => {
		const guard = globalThis.__namzuIsolatedPalRemovalGuard;
		const state = { ...guard.state };
		guard.restore(); delete globalThis.__namzuIsolatedPalRemovalGuard;
		return state;
	});
	assert.equal(finalGuard.forbiddenRequests, 0, 'The Pal removal attempted a forbidden side effect.');
	assert.equal(finalGuard.deleteRequests, 1, 'The Pal removal must issue exactly one tombstone request.');
	receipt.palRemoval = { requested: true, passed: true, uiCreated: true, uiConfirmed: true,
		profilesBefore: 0, profilesCreated: 1, profilesAfter: 0, computerStopped: true,
		palProjectsAbsent: true, palConversationsAbsent: true, palTabsAbsent: true,
		ordinaryProjectsAndTabsPreserved: true, workspaceDirectoryPreserved: true,
		additionalPrompts: 0, forbiddenExecutionOrSetupRequests: 0 };
	preserveFixture = false;
}

async function main() {
	phase = 'launch';
	desktop = await _electron.launch({
		executablePath: config.electron,
		args: [bootstrap, `--user-data-dir=${userData}`, '--force-renderer-accessibility'],
		cwd: config.root,
		env: currentEnv(),
		timeout: 90000,
	});
	const identity = await desktop.evaluate(({ app }) => ({
		pid: process.pid, userData: app.getPath('userData'),
	}));
	assert.notEqual(identity.pid, originalPid, 'The original desktop was selected.');
	assert.equal(path.normalize(identity.userData).toLowerCase(), path.normalize(userData).toLowerCase(),
		'The second Electron did not use its private userData.');
	receipt.fixturePid = identity.pid;
	receipt.originalPid = originalPid;
	const launcherPid = desktop.process().pid;
	const quotedUserData = `'${userData.replaceAll("'", "''")}'`;
	const inventory = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command',
		`$taskIds = @(${launcherPid}, ${identity.pid}); $taskRows = @(Get-CimInstance Win32_Process | ` +
		`Where-Object { $taskIds -contains [int]$_.ProcessId } | ForEach-Object { ` +
		`[pscustomobject]@{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; name=$_.Name; ` +
		`executable=$_.ExecutablePath; createdAt=$_.CreationDate.ToUniversalTime().ToString('o'); ` +
		`ownsFixture=[bool]($_.CommandLine -and $_.CommandLine.IndexOf(${quotedUserData}, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } }); ` +
		`ConvertTo-Json -InputObject $taskRows -Depth 3 -Compress`,
	], { encoding: 'utf8', windowsHide: true });
	assert.equal(inventory.status, 0, 'Cannot verify the fixture launch lineage.');
	const owned = JSON.parse(inventory.stdout.trim());
	const main = owned.find((item) => item.pid === identity.pid);
	const launcher = owned.find((item) => item.pid === launcherPid);
	assert(main?.ownsFixture && launcher?.ownsFixture);
	assert.equal(path.normalize(main.executable).toLowerCase(), path.normalize(config.electron).toLowerCase());
	if (launcherPid !== identity.pid) {
		// Native Playwright uses a cmd.exe launcher on Windows. Check the actual
		// child and creation times; the launcher's PID is not the Electron PID.
		assert.equal(main.parent, launcherPid);
		assert.equal(launcher.name.toLowerCase(), 'cmd.exe');
		assert(Date.parse(main.createdAt) >= Date.parse(launcher.createdAt));
	}
	receipt.fixtureCreatedAt = main.createdAt;
	receipt.launchLineageVerified = true;
	page = await desktop.firstWindow();
	page.on('pageerror', () => { receipt.pageErrorCount += 1; });
	await page.waitForFunction(() => typeof window.namzu?.openChat === 'function');
	const initial = await page.evaluate(async () => ({
		projects: (await window.namzu.projects()).length,
		pals: (await window.namzu.pals()).length,
	}));
	assert.deepEqual(initial, reuse ? { projects: 1, pals: 0 } : { projects: 0, pals: 0 }, 'The fixture profile has an unexpected ownership count.');
	receipt.isolationVerified = true;
	await desktop.evaluate(({ BrowserWindow }) => {
		const windows = BrowserWindow.getAllWindows();
		if (windows.length !== 1) throw new Error('The isolated fixture has an unexpected native window.');
		windows[0].setTitle('Namzu · Isolated harness test');
	});
	receipt.fixtureWindowTitleSet = true;
	await desktop.evaluate(async (_electron, appDirectory) => {
		const { RuntimeClient } = globalThis.__namzuIsolatedRuntime;
		if (typeof RuntimeClient?.prototype?.request !== 'function') throw new Error('Fixture RPC module is unavailable.');
		const original = RuntimeClient.prototype.request;
		const state = { count: 0, archiveAcknowledgements: [] };
		RuntimeClient.prototype.request = function (method, params, timeout) {
			if (method === 'namzu/providers/models') state.count += 1;
			const pending = original.call(this, method, params, timeout);
			if (method === 'namzu/conversations/archive') return pending.then((answer) => {
				state.archiveAcknowledgements.push({ archived: answer?.archived === true, missing: answer?.missing === true });
				return answer;
			});
			return pending;
		};
		globalThis.__namzuIsolatedCatalogueReads = state;
	}, config.app);
	if (palOnly) {
		const view = await newFixtureChat();
		fixtureSessions.set('namzu', view);
	} else if (reuse) {
		phase = 'retained-fixture-ownership';
		await page.waitForFunction(async () => (await window.namzu.projects()).some((project) => project.isChat && project.trusted && project.status === 'ready'));
		const projects = await page.evaluate(() => window.namzu.projects());
		assert.equal(projects.length, 1); assert(projects[0].isChat && projects[0].trusted && !projects[0].palId);
		const rows = await page.evaluate((id) => window.namzu.conversations(id), projects[0].id);
		const codex = rows.filter((row) => row.harness === 'codex-cli' && !row.palId);
		assert.equal(codex.length, 1, 'The retained fixture must have exactly one owned Codex conversation.');
		assert(rows.every((row) => !row.palId) && rows.length === 3);
		const view = { projectId: projects[0].id, sessionId: codex[0].id };
		await page.locator(`.sidebar-recent-list [data-session-id="${view.sessionId}"] .sidebar-conversation-button`).click();
		await page.waitForFunction(() => {
			const trigger = document.querySelector('button[aria-label="Execution engine"]');
			return trigger?.title === 'Codex CLI' && !trigger.disabled;
		});
		assert.deepEqual(await owner(), { ...view, isolated: true });
		fixtureSessions.set('codex-cli', view);
		const data = await catalogue(view.projectId, view.sessionId, 'codex-cli');
		assert(data.provider && data.choice && /luna|sol|mini/i.test(data.choice.id), 'The targeted recheck must select an offered inexpensive native model.');
		await selectModel(view, data.provider, data.choice);
		const result = { engine: 'codex-cli', offered: true, catalogueRows: data.models.length, initialModel: data.choice.id, modes: [], turns: [] };
		receipt.engines.push(result);
		result.warmCatalogue = await verifyWarmCatalogue();
		await setMode(view, 'codex-cli', 'prompt'); result.modes.push('prompt');
		result.effort = await setLowestOfferedEffort(view, data.provider, data.choice);
		result.turns.push(await sendOne(view, 'codex-cli', 'prompt', data.provider.id, data.choice.id));
		result.outcome = !activeTurn && result.turns.every((turn) => turn.stopReason === 'end_turn' && turn.assistantRows > 0 && turn.routeMatches)
			? 'all-attempted-live-answers-observed' : 'inconclusive';
		// Remove the Codex conversation while another retained ordinary tab is active.
		const other = rows.find((row) => row.harness === 'claude-code'); assert(other);
		fixtureSessions.set('claude-code', { projectId: projects[0].id, sessionId: other.id });
		const namzu = rows.find((row) => row.harness === 'namzu' || !row.harness); assert(namzu);
		fixtureSessions.set('namzu', { projectId: projects[0].id, sessionId: namzu.id });
		await page.locator(`.sidebar-recent-list [data-session-id="${other.id}"] .sidebar-conversation-button`).click();
		await page.waitForFunction(() => {
			const trigger = document.querySelector('button[aria-label="Execution engine"]');
			return trigger?.title === 'Claude Code' && !trigger.disabled;
		});
	} else for (const engine of ['namzu', 'codex-cli', 'claude-code']) {
		await runEngine(engine);
		if (activeTurn) break;
	}
	if (removalRequested && !activeTurn) await verifyFixtureRemoval();
	if (palRemovalRequested && !activeTurn) await verifyPalFixtureRemoval();
	receipt.passed = receipt.isolationVerified && !activeTurn && receipt.pageErrorCount === 0 &&
		(palOnly ? receipt.engines.length === 0 : reuse ? receipt.engines.length === 1 : receipt.engines.length === 3) &&
		receipt.engines.every((entry) =>
			entry.outcome === 'all-attempted-live-answers-observed' &&
			entry.modes.length === (reuse ? 1 : Object.keys(modeName[entry.engine]).length)) &&
		(palOnly || Boolean(reuse) || Boolean(receipt.engines.find((entry) => entry.engine === 'codex-cli')?.switchedModel)) &&
		(!removalRequested || receipt.removal?.passed === true) &&
		(!palRemovalRequested || receipt.palRemoval?.passed === true);
}

async function execute() {
	try {
		await main();
	} catch (error) {
		receipt.failurePhase = phase;
		receipt.failureName = error.name;
		// Private fixture diagnostics contain only its public notices/selectors,
		// never account files, model text or native stderr.
		receipt.failureDiagnostic = String(error.message);
		if (page) receipt.visibleFailureNotices = await page.locator('[role="alert"]').allTextContents().catch(() => []);
		receipt.passed = false;
	} finally {
		receipt.ownedFixtureStillRunning = activeTurn;
		receipt.preservedFixtureForReview = preserveFixture;
		if (desktop && !activeTurn && !preserveFixture) {
			try {
				const identity = await desktop.evaluate(({ app }) => ({ pid: process.pid, userData: app.getPath('userData') }));
				assert.equal(identity.pid, receipt.fixturePid);
				assert.equal(identity.userData, userData);
				// p39 is pinned to Playwright 1.63. Detach only its Node Inspector
				// transport, then ask the exact owned native window to close normally.
				// ElectronApplication.close/app.quit bypasses Namzu's renderer flush;
				// process-tree cleanup can include stale Windows parent PID links.
				assert.equal(require(path.join(development, 'runtime/packages/p39/package.json')).version, '1.63.0');
				const idle = await page.evaluate(async () => {
					const api = window.namzu;
					const projects = await api.projects();
					for (const project of projects) for (const row of await api.conversations(project.id)) {
						const thread = (await api.openConversation(project.id, row.id)).thread;
						const jobs = await api.jobs(row.id);
						if (!thread || thread.running || thread.responding || thread.retry || thread.retryNotice ||
							!Array.isArray(thread.permissions) || thread.permissions.length ||
							!Array.isArray(thread.queued) || thread.queued.length ||
							!Array.isArray(thread.queuedItems) || thread.queuedItems.length ||
							!Array.isArray(thread.activeToolIds) || thread.activeToolIds.length ||
							!Array.isArray(jobs) || jobs.some((job) => job.status === 'running' || job.recoveryRequired)) return false;
					}
					for (const pal of await api.pals()) {
						const computer = await api.palComputer(pal.id);
						if (computer.status !== 'stopped' || computer.requiresStop) return false;
					}
					return true;
				});
				assert(idle, 'Preserve a fixture with unresolved work.');
				assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
				const launcher = desktop.process();
				const wrapperClosed = launcher.exitCode !== null ? Promise.resolve() : new Promise((resolve) => launcher.once('close', resolve));
				const impl = desktop._connection?.toImpl?.(desktop);
				assert.equal(typeof impl?._nodeConnection?._transport?.closeAndWait, 'function');
				await impl._nodeConnection._transport.closeAndWait();
				const escapedExecutable = `'${config.electron.replaceAll("'", "''")}'`;
				const escapedProfile = `'${userData.replaceAll("'", "''")}'`;
				const escapedCreation = `'${receipt.fixtureCreatedAt.replaceAll("'", "''")}'`;
				const closed = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command',
					`$taskRow = Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}"; ` +
					`if (!$taskRow -or $taskRow.ExecutablePath -ne ${escapedExecutable} -or ` +
					`$taskRow.CreationDate.ToUniversalTime().ToString('o') -ne ${escapedCreation} -or ` +
					`!$taskRow.CommandLine -or $taskRow.CommandLine.IndexOf(${escapedProfile}, [System.StringComparison]::OrdinalIgnoreCase) -lt 0 ` +
					`-or [int]$taskRow.ParentProcessId -ne ${launcher.pid}) { throw 'Fixture process identity changed' }; ` +
					`$taskProcess = Get-Process -Id ${identity.pid}; if (!$taskProcess.CloseMainWindow()) { throw 'Fixture normal window close was refused' }; ` +
					`if (!$taskProcess.WaitForExit(60000)) { throw 'Fixture remains open; preserve its driver' }; ` +
					`Write-Output '{"normalOwnedWindowClosed":true}'`,
				], { encoding: 'utf8', windowsHide: true });
				assert.equal(closed.status, 0, 'Normal owned fixture window close did not complete.');
				await wrapperClosed;
				receipt.cleanupLineageVerified = true;
				receipt.cleanupMethod = 'exact owned window normal close; Inspector detached; launcher close observed';
				receipt.ownedFixtureClosed = true;
			}
			catch (error) {
				receipt.ownedFixtureClosed = false;
				receipt.cleanupDiagnostic = String(error.message);
				receipt.passed = false;
			}
		}
		try { process.kill(originalPid, 0); receipt.originalProcessStillAlive = true; }
		catch { receipt.originalProcessStillAlive = false; }
		fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
		process.stdout.write(`${JSON.stringify({
			passed: receipt.passed,
			isolationVerified: receipt.isolationVerified,
			realPromptsSent: receipt.realPromptsSent,
			engines: receipt.engines.map(({ engine, offered, catalogueRows, initialModel, switchedModel, modes, turns, outcome }) =>
				({ engine, offered, catalogueRows, initialModel, switchedModel, modes,
					turns: turns.map(({ mode, stopReason, assistantRows, routeMatches, error, inconclusive }) =>
						({ mode, stopReason, assistantRows, routeMatches, error, inconclusive })), outcome })),
			pageErrorCount: receipt.pageErrorCount,
			failurePhase: receipt.failurePhase,
			ownedFixtureClosed: receipt.ownedFixtureClosed,
			ownedFixtureStillRunning: receipt.ownedFixtureStillRunning,
			fixtureRemoval: receipt.removal,
			palFixtureRemoval: receipt.palRemoval,
			preservedFixtureForReview: receipt.preservedFixtureForReview,
		})}\n`);
		if (!receipt.passed) process.exitCode = 1;
	}
}
void execute();
