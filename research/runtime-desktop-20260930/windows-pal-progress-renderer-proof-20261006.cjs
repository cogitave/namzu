'use strict';

// Native Windows deployment/proof with a strict idle-state preflight.
// Run only for an authorized renderer-only update.
// Usage (native Windows Node):
//   node.exe windows-pal-progress-renderer-proof-20261006.cjs <built-renderer-dir> <private-receipt.json>

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(process.platform, 'win32', 'Run with native Windows Node.');
const devRoot = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const config = JSON.parse(fs.readFileSync(path.join(devRoot, 'launch.json'), 'utf8'));
const [sourceArg, receiptArg] = process.argv.slice(2);
const verifyCurrent = process.argv[4] === '--verify-current';
assert(sourceArg && receiptArg, 'Arguments: built renderer directory and private receipt path.');
const source = path.resolve(sourceArg);
const output = path.resolve(receiptArg);
const renderer = path.join(config.app, 'dist', 'renderer');
assert(fs.existsSync(path.join(source, 'index.html')), 'Built renderer is missing index.html.');
assert(fs.existsSync(renderer), 'Stable Development renderer is missing.');
assert.notEqual(source.toLowerCase(), renderer.toLowerCase());
const outputRelativeToDev = path.relative(devRoot, output);
assert(outputRelativeToDev && !outputRelativeToDev.startsWith('..') && !path.isAbsolute(outputRelativeToDev), 'Receipt must stay under the private Development directory.');
const captureDir = path.join(devRoot, 'proof-artifacts', 'pal-progress-renderer-20261006');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function manifest(root) {
	const rows = [];
	const visit = relative => {
		for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
			const child = path.join(relative, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile()) rows.push({ file: child.replaceAll(path.sep, '/'), sha256: hash(fs.readFileSync(path.join(root, child))) });
			else throw new Error(`Unsupported renderer entry: ${child}`);
		}
	};
	visit('');
	return rows.sort((a, b) => a.file.localeCompare(b.file));
}
function bundleRefs(root) {
	const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
	const refs = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"?]+\.(?:js|css))"/g)].map(match => match[1]);
	assert(refs.some(file => file.endsWith('.js')) && refs.some(file => file.endsWith('.css')), 'Built index must reference JS and CSS assets.');
	for (const ref of refs) assert(fs.existsSync(path.join(root, ref)), `Built asset is missing: ${ref}`);
	return refs.sort();
}
const sourceManifest = manifest(source);
const sourceRefs = bundleRefs(source);
const { chromium } = require(path.join(devRoot, 'runtime', 'packages', 'p39'));
const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
assert(Number.isInteger(port) && port > 0, 'Stable Development CDP port is invalid.');
const pidFile = path.join(devRoot, 'desktop.pid');
const desktopPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
assert(Number.isInteger(desktopPid) && desktopPid > 0);
process.kill(desktopPid, 0);
const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
const dist = path.dirname(renderer);
const pending = path.join(dist, `renderer-pal-progress-${stamp}`);
const backup = path.join(dist, `renderer-before-pal-progress-${stamp}`);
assert(!fs.existsSync(pending) && !fs.existsSync(backup), 'Unique stage/backup path already exists.');

let browser;
let page;
let deployed = false;
let pageErrorCount = 0;
const receipt = {
	version: 1, passed: false, platform: process.platform, rendererOnly: true,
	electronRestarted: false, cliRestarted: false, computerActions: 0,
	modelRequests: 0, guestExecutions: 0, cdpPort: port, desktopPid,
	checks: [], build: { sourceManifestSha256: hash(JSON.stringify(sourceManifest)), sourceAssetRefs: sourceRefs },
	backupDirectory: path.basename(backup),
};

async function readState(target) {
	return target.evaluate(async () => {
		const api = window.namzu;
		if (!api) throw new Error('Native preload API is unavailable.');
		const workspace = await api.workspace();
		const windowState = workspace.layout.windows.find(item => item.id === workspace.windowId);
		if (!windowState) throw new Error('Workspace has no active window.');
		const visit = node => !node ? [] : node.kind === 'group' ? [node] : [...visit(node.first), ...visit(node.second)];
		const groups = visit(windowState.root);
		const projects = await api.projects();
		const conversations = (await Promise.all(projects.filter(p => p.status === 'ready').map(p => api.conversations(p.id)))).flat();
		const profiles = await api.pals();
		const sessions = [];
		for (const group of groups) for (const id of group.tabs) {
			const row = conversations.find(item => item.id === id);
			if (!row) throw new Error(`Open tab ${id} has no conversation record.`);
			const history = await api.openConversation(row.projectId, id);
			const thread = history.thread;
			if (thread?.running || thread?.responding || thread?.permissions?.length || thread?.queuedItems?.length || thread?.activeToolIds?.length)
				throw new Error(`Open tab ${id} is not idle.`);
			const jobs = await api.jobs(id);
			if (jobs.some(job => job.status === 'running' || job.recoveryRequired)) throw new Error(`Open tab ${id} owns an active/recovery job.`);
			const draft = await api.draft(id);
			const editor = [...document.querySelectorAll('.composer-input textarea[aria-label="Message Namzu"]')]
				.find(input => input.closest('[data-workspace-group]')?.dataset.workspaceGroup === group.id);
			if (group.activeTabId === id && editor && editor.value !== draft) throw new Error(`Open tab ${id} has unsaved composer text.`);
			sessions.push({ id, projectId: row.projectId, palId: projects.find(project => project.id === row.projectId)?.palId,
				active: group.activeTabId === id, messages: history.messages,
				thread: thread ? { running: !!thread.running, responding: !!thread.responding,
					permissions: thread.permissions ?? [], queuedItems: thread.queuedItems ?? [], activeToolIds: thread.activeToolIds ?? [],
					tasks: thread.tasks ?? [], tasksNotice: thread.tasksNotice, tools: thread.tools ?? {}, timeline: thread.timeline ?? [] } : null,
				draft, settings: await api.draftSettings(id), attachments: await api.attachments(id),
				provider: (await api.providers(row.projectId, id)).selected, jobs });
		}
		const computers = [];
		for (const profile of profiles) {
			const computer = await api.palComputer(profile.id);
			if (computer.control?.mode === 'transitioning') throw new Error('A Pal computer control transition is active.');
			computers.push({ id: profile.id, status: computer.status, generation: computer.generation, environmentId: computer.environmentId, control: computer.control });
		}
		const activeGroup = groups.find(group => group.id === windowState.focusedGroupId);
		const activeSession = sessions.find(session => session.id === activeGroup?.activeTabId);
		const activeProject = activeSession && projects.find(project => project.id === activeSession.projectId);
		if (!activeSession || !activeProject?.palId) throw new Error('Focused tab must be an existing Pal conversation.');
		if (!activeSession.thread?.tasks?.length && !activeSession.thread?.tasksNotice) throw new Error('Focused Pal conversation has no projected plan to inspect.');
		const root = document.querySelector('.workspace');
		const transcript = root?.querySelector('.transcript');
		if (!root || root.dataset.page !== 'chat' || !transcript) throw new Error('Focused renderer route is not a chat.');
		if (root.querySelector('.pal-computer-view canvas') || document.activeElement?.closest?.('.pal-computer-view')) throw new Error('Computer canvas/control is active.');
		if ([...document.querySelectorAll('[role="dialog"], [role="alert"]')].some(element => element.getClientRects().length)) throw new Error('A dialog or visible alert is present.');
		if (document.activeElement?.matches('textarea,input,[contenteditable="true"]') && (document.activeElement.value?.length || document.activeElement.isContentEditable)) throw new Error('A text editor/control owns keyboard focus.');
		const presentations = Object.keys(localStorage).filter(key => key.startsWith('namzu.workspace.presentation:')).sort().map(key => [key, localStorage.getItem(key)]);
		const activePane = [...document.querySelectorAll('[data-workspace-group]')].find(element => element.dataset.workspaceGroup === activeGroup.id);
		const card = activePane?.querySelector('.pal-context-card');
		const planToggle = card?.querySelector('.pal-plan-toggle');
		return { workspace: { windowId: workspace.windowId, homeGroupId: workspace.homeGroupId, sequence: workspace.sequence, layout: workspace.layout },
			groups, sessions, profiles, computers, presentations,
			dom: { url: location.href, page: root.dataset.page, activePalName: profiles.find(profile => profile.id === activeProject.palId)?.name,
				activeGroupId: activeGroup.id, activeSessionId: activeSession.id,
				visibleTabs: [...document.querySelectorAll('.conversation-tabs [role="tab"][aria-selected="true"]')].map(tab => tab.textContent?.trim()),
				viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
				activeJobsPanel: !!document.querySelector('.jobs-panel[data-open="true"]'),
				transcriptScrollTop: transcript.scrollTop, transcriptScrollRange: transcript.scrollHeight - transcript.clientHeight,
				cardVisible: !!card && !!card.getClientRects().length, cardScrollTop: card?.scrollTop ?? 0,
				planExpanded: planToggle?.getAttribute('aria-expanded') ?? null } };
	});
}

async function settle(target) {
	await target.evaluate(async () => {
		await document.fonts.ready;
		const finite = document.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
		await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
}

async function main() {
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === new URL(config.url).href);
	assert(page, 'No window is open on the stable Development renderer URL.');
	page.on('pageerror', () => { pageErrorCount++; });
	const pidBefore = fs.readFileSync(pidFile, 'utf8').trim();
	const before = await readState(page);
	const activeName = before.dom.activePalName;
	const activeSession = before.sessions.find(session => session.id === before.dom.activeSessionId);
	assert(activeSession?.thread?.tasks?.length, 'Focused Pal must contain real plan steps.');
	assert(activeSession.thread.tasks.every(task => task.status === 'completed'), 'Focused native plan must already be all-completed before deployment.');
	assert.equal(before.dom.activeJobsPanel, false, 'Close Activity before proof so the narrow card capture is unambiguous.');
	const groupSelector = `[data-workspace-group="${before.dom.activeGroupId.replaceAll(/["\\]/g, '\\$&')}"]`;
	const pane = page.locator(groupSelector);
	assert.equal(await pane.count(), 1, 'Focused conversation group is not unique.');
	receipt.beforeStateSha256 = hash(JSON.stringify(before));
	receipt.originalLayoutSha256 = hash(JSON.stringify(before.groups.map(group => ({ id: group.id, tabs: group.tabs, activeTabId: group.activeTabId }))));
	receipt.originalPage = before.dom.page;
	receipt.originalPal = activeName;
	receipt.originalTaskCount = activeSession.thread.tasks.length;
	receipt.originalCardVisible = before.dom.cardVisible;
	receipt.originalCardScrollTop = before.dom.cardScrollTop;
	receipt.originalPlanDisclosure = before.dom.planExpanded;
	receipt.checks.push('Idle preflight passed for every open tab: no unsaved editor, permissions, queued work, active/recovery job, dialog, alert, focused computer control or control transition.');

	// This is an observed sample of open conversation projections, not a claim
	// about every historical conversation or every retained event.
	const observed = before.sessions.filter(session => session.palId && session.thread);
	const observedNames = new Set();
	for (const session of observed) {
		const tools = session.thread.tools;
		for (const entry of session.thread.timeline) {
			if (entry.kind !== 'tool') continue;
			const tool = tools[entry.id];
			if (tool?.status === 'completed' && ['send_pal_message', 'list_pals'].includes(tool.title)) observedNames.add(tool.title);
		}
	}
	assert(observedNames.has('send_pal_message'), 'No completed send_pal_message receipt was observed in the open Pal conversations.');
	assert(observedNames.has('list_pals'), 'No completed list_pals receipt was observed in the open Pal conversations.');
	receipt.observedConversationCount = observed.length;
	receipt.observedPlacedConversationNames = ['Message to another Pal', 'Available Pals'];
	receipt.checks.push('Two friendly activity labels are backed by completed send/list receipts in the observed open Pal conversation projections; scope is limited to those observed conversations.');

	if (verifyCurrent) {
		assert.deepEqual(manifest(renderer), sourceManifest, 'Current renderer is not the verified build.');
		receipt.checks.push('Read-only verification uses the already deployed complete renderer, without another reload.');
	} else {
		const oldRefs = bundleRefs(renderer);
		const oldEntries = oldRefs.filter(ref => /(?:^|\/)(?:index|main)-.*\.(?:js|css)$/.test(ref));
		assert(oldEntries.length >= 2 && sourceRefs.some(ref => ref.endsWith('.js') && !oldEntries.includes(ref)), 'Built renderer entry must differ from the deployed entry.');
		fs.cpSync(source, pending, { recursive: true, errorOnExist: true, force: false });
		assert.deepEqual(manifest(pending), sourceManifest, 'Staged renderer differs from the build directory.');
		try {
			fs.renameSync(renderer, backup);
			fs.renameSync(pending, renderer);
			deployed = true;
		} catch (error) {
			if (!fs.existsSync(renderer) && fs.existsSync(backup)) fs.renameSync(backup, renderer);
			throw error;
		}
		receipt.checks.push('Complete built renderer staged with the prior renderer retained as a timestamped backup.');
		await page.reload({ waitUntil: 'domcontentloaded' });
	}
	await pane.getByRole('region', { name: `${activeName} conversation`, exact: true }).waitFor({ state: 'visible' });
	await settle(page);
	assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), pidBefore, 'Electron PID changed on renderer reload.');
	const afterReload = await readState(page);
	const persistent = state => {
		const { presentations: _presentations, ...rest } = state;
		const { activeJobsPanel: _jobs, transcriptScrollTop: _scroll, transcriptScrollRange: _range,
			cardVisible: _cardVisible, cardScrollTop: _cardScrollTop, planExpanded: _planExpanded, ...dom } = rest.dom;
		return { ...rest, dom };
	};
	assert.equal(hash(JSON.stringify(persistent(afterReload))), hash(JSON.stringify(persistent(before))), 'Persistent application state changed on reload.');
	receipt.checks.push(verifyCurrent ? 'Read-only current-renderer inspection retained workspace, tabs, messages, drafts/settings/attachments/models, plan state and computer generations/control.' : 'Renderer-only reload retained workspace, tabs, messages, drafts/settings/attachments/models, plan state and computer generations/control.');

	const card = pane.getByRole('complementary', { name: 'Pal context', exact: true });
	const profileToggle = pane.getByRole('button', { name: `Show ${activeName} profile`, exact: true });
	const cardWasVisible = before.dom.cardVisible;
	if (!cardWasVisible && await profileToggle.count()) await profileToggle.click();
	await card.waitFor({ state: 'visible' });
	fs.mkdirSync(captureDir, { recursive: true });
	const taskRegion = card.getByRole('region', { name: `${activeName} tasks`, exact: true });
	await taskRegion.waitFor({ state: 'visible' });
	assert.equal(await taskRegion.getByRole('heading', { name: 'Progress', exact: true }).count(), 1);
	const toggle = taskRegion.locator('.pal-plan-toggle');
	await toggle.waitFor({ state: 'visible' });
	const baselineExpanded = before.dom.planExpanded ?? await toggle.getAttribute('aria-expanded');
	const baselineCardScroll = before.dom.cardScrollTop;
	await toggle.evaluate(element => element.scrollIntoView({ block: 'nearest' }));
	await settle(page);
	assert.match((await toggle.innerText()).trim(), /^\d+ of \d+ steps done(?:\s|$)/);
	assert.equal(await taskRegion.locator('progress').count(), 0, 'Progress display must not imply measured percentage.');
	assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'All-completed plan must be collapsed by default after reload.');
	assert.equal(await taskRegion.locator('.pal-plan-steps').count(), 0, 'Collapsed plan exposes no detailed rows.');
	await card.screenshot({ path: path.join(captureDir, 'pal-progress-completed-collapsed.png') });
	await toggle.click();
	await settle(page);
	assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
	const actualRows = await taskRegion.locator('.pal-plan-steps li').evaluateAll(rows => rows.map(row => ({ status: row.dataset.status, subject: row.querySelector('.pal-step-copy > span')?.innerText.trim(), label: row.querySelector('.pal-step-copy')?.innerText.trim() })));
	assert(actualRows.length > 0 && actualRows.every(row => row.label), 'Expanded progress must show actual source plan rows.');
	assert(actualRows.every(row => row.status === 'completed'), 'Focused native source plan is expected to be all-completed.');
	assert.deepEqual(actualRows.map(({ subject, status }) => ({ subject, status })), activeSession.thread.tasks.map(({ subject, status }) => ({ subject, status })), 'Disclosed plan does not match the actual source rows.');
	await card.screenshot({ path: path.join(captureDir, 'pal-progress-completed-disclosed.png') });
	const activity = card.getByRole('region', { name: 'Recent activity', exact: true });
	await activity.waitFor({ state: 'visible' });
	assert(await activity.getByRole('button', { name: /^Message to another Pal\. Sent to inbox\. View details$/ }).count() > 0, 'Friendly sent-message summary is missing.');
	assert(await activity.getByRole('button', { name: /^Available Pals\. Checked\. View details$/ }).count() > 0, 'Friendly Pal-list summary is missing.');
	for (const technical of ['send_pal_message', 'list_pals']) assert.equal(await activity.getByText(technical, { exact: true }).count(), 0, `Recent activity exposes ${technical}.`);
	await card.screenshot({ path: path.join(captureDir, 'pal-progress-recent-activity.png') });
	receipt.actualPlanRows = actualRows.length;
	receipt.actualPlanStatuses = [...new Set(actualRows.map(row => row.status))];
	receipt.checks.push('Native card shows Progress, a collapsed all-completed summary, then actual detailed source rows when disclosed; no percentage widget is present.');
	receipt.checks.push('Recent activity uses friendly titles/details for the two observed placed conversations and does not display raw tool names.');

	// Restore disclosure, card scroll, and the active session presentation to the
	// exact pre-proof values. Activity remains closed, as established by preflight.
	const currentExpanded = await toggle.getAttribute('aria-expanded');
	if (currentExpanded !== baselineExpanded) await toggle.click();
	await settle(page);
	await card.evaluate((element, scrollTop) => { element.scrollTo({ top: scrollTop, behavior: 'instant' }); }, baselineCardScroll);
	await pane.locator('.transcript').evaluate((element, scrollTop) => { element.scrollTo({ top: scrollTop, behavior: 'instant' }); }, before.dom.transcriptScrollTop);
	if (!cardWasVisible) {
		const hide = pane.getByRole('button', { name: `Hide ${activeName} profile`, exact: true });
		if (await hide.count()) await hide.click();
	}
	const postTest = await readState(page);
	assert.equal(hash(JSON.stringify(persistent(postTest))), hash(JSON.stringify(persistent(before))), 'Non-presentation state changed during proof.');
	const presentationKey = `namzu.workspace.presentation:${before.dom.activeSessionId}`;
	const decodedPresentations = state => state.presentations.map(([key, value]) => [key, JSON.parse(value)]);
	assert.deepEqual(decodedPresentations(postTest), decodedPresentations(before), 'Session presentation preferences changed during proof.');
	const presentation = JSON.parse(postTest.presentations.find(([key]) => key === presentationKey)?.[1] ?? '{}');
	assert.equal(presentation.palProfileOpen, JSON.parse(before.presentations.find(([key]) => key === presentationKey)?.[1] ?? '{}').palProfileOpen, 'Pal card visibility preference was not restored.');
	assert.equal(presentation.jobsOpen, false, 'Activity must remain closed.');
	assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), pidBefore, 'Electron PID changed during proof.');
	assert.deepEqual(manifest(renderer), sourceManifest, 'Deployed renderer differs from the staged build.');
	assert.equal(pageErrorCount, 0, 'Native renderer raised page errors.');
	receipt.afterStateSha256 = hash(JSON.stringify(persistent(postTest)));
	receipt.stagedRendererManifestSha256 = hash(JSON.stringify(manifest(renderer)));
	receipt.nativePidUnchanged = true;
	receipt.persistentStatePreserved = true;
	receipt.presentationRestored = true;
	receipt.pageErrorCount = pageErrorCount;
	receipt.checks.push('Original disclosure, card scroll and session presentation restored; Activity remains closed and all other user state is unchanged.');
	receipt.passed = true;
}

main().catch(error => {
	fs.writeFileSync(output.replace(/\.json$/i, '-failure-private.txt'), `${String(error.stack ?? error)}\n`, { mode: 0o600 });
	receipt.error = { name: error.name, message: 'Native renderer proof failed; inspect private Development logs without exporting raw application state.' };
	process.exitCode = 1;
}).finally(async () => {
	if (browser) await browser.close();
	receipt.deployed = deployed;
	receipt.failurePolicy = deployed ? 'Prior renderer retained in backup; no app/CLI/computer rollback or restart attempted.' : 'No renderer deployment occurred before idle/state preflight passed.';
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	process.stdout.write(`${JSON.stringify({ passed: receipt.passed, deployed: receipt.deployed, checks: receipt.checks.length, error: receipt.error?.message })}\n`);
});
