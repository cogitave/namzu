'use strict';

// Native Windows renderer-only deployment and actual close/sidebar-reopen proof.
// Run with native Windows Node. All raw application state stays in Development.
// Usage: node.exe <helper> <built-renderer-dir> <private-receipt.json> <public-receipt.json>
// --preflight performs read-only inspection without deployment or navigation.
// --verify-current proves an already deployed, byte-identical renderer.
// --saved-history distinguishes pending saved history from authoritative history.
// --original-private <receipt> compares against an independent earlier before state.
// Timings are observations; Playwright's operation timeout detects a genuine hang.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(process.platform, 'win32', 'Use native Windows Node.');
const devRoot = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const config = JSON.parse(fs.readFileSync(path.join(devRoot, 'launch.json'), 'utf8'));
const [sourceArg, privateArg, publicArg] = process.argv.slice(2);
assert(sourceArg && privateArg && publicArg, 'Built renderer, private receipt and public receipt are required.');
const source = path.resolve(sourceArg);
const privateOutput = path.resolve(privateArg);
const publicOutput = path.resolve(publicArg);
const relativePrivate = path.relative(devRoot, privateOutput);
assert(relativePrivate && !relativePrivate.startsWith('..') && !path.isAbsolute(relativePrivate), 'Raw state must remain under private Development.');
assert.notEqual(privateOutput.toLowerCase(), publicOutput.toLowerCase());
const preflightOnly = process.argv.includes('--preflight');
const verifyCurrent = process.argv.includes('--verify-current');
const savedHistoryProof = process.argv.includes('--saved-history');
const originalIndex = process.argv.indexOf('--original-private');
const originalFile = originalIndex < 0 ? null : path.resolve(process.argv[originalIndex + 1]);
if (originalFile) {
	const relative = path.relative(devRoot, originalFile);
	assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Original state must come from private Development.');
	assert.notEqual(originalFile.toLowerCase(), privateOutput.toLowerCase(), 'Preserve the original private receipt independently.');
}
const renderer = path.join(config.app, 'dist', 'renderer');
assert(fs.existsSync(path.join(source, 'index.html')), 'Built renderer is missing.');
assert(fs.existsSync(renderer), 'Development renderer is missing.');
assert.notEqual(source.toLowerCase(), renderer.toLowerCase());
const { chromium } = require(path.join(devRoot, 'runtime', 'packages', 'p39'));
const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
assert(Number.isInteger(port) && port > 0, 'Development CDP port is invalid.');
const pidFile = path.join(devRoot, 'desktop.pid');
const desktopPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
assert(Number.isInteger(desktopPid) && desktopPid > 0);
process.kill(desktopPid, 0);

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
// JSON receipts omit undefined object properties. Compare the same persisted
// wire shape for live IPC objects and independently loaded private receipts.
const wire = value => JSON.parse(JSON.stringify(value));
function manifest(root) {
	const rows = [];
	const visit = relative => {
		for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
			const child = path.join(relative, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile()) rows.push({ file: child.replaceAll(path.sep, '/'), sha256: hash(fs.readFileSync(path.join(root, child))) });
			else throw new Error('Unsupported renderer filesystem entry.');
		}
	};
	visit('');
	return rows.sort((a, b) => a.file.localeCompare(b.file));
}
function bundleRefs(root) {
	const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
	const refs = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"?]+\.(?:js|css))"/g)].map(match => match[1]);
	assert(refs.some(file => file.endsWith('.js')) && refs.some(file => file.endsWith('.css')), 'Built index must reference JS and CSS.');
	for (const ref of refs) assert(fs.existsSync(path.join(root, ref)), 'A referenced built asset is missing.');
	return refs.sort();
}
const sourceManifest = manifest(source);
const sourceRefs = bundleRefs(source);
const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-');
const dist = path.dirname(renderer);
const pending = path.join(dist, `renderer-pal-reopen-${stamp}`);
const backup = path.join(dist, `renderer-before-pal-reopen-${stamp}`);
assert(!fs.existsSync(pending) && !fs.existsSync(backup), 'Renderer staging path exists.');

let browser;
let page;
let before;
let closed = false;
let reopened = false;
let deployed = false;
const pageErrors = [];
const receipt = {
	version: 1, passed: false, nativeWindows: true, rendererOnly: true,
	preflightOnly, verifyCurrent, savedHistoryProof, electronRestarted: false, cliRestarted: false,
	modelRequests: 0, computerActions: 0, guestExecutions: 0,
	checks: [], observations: {}, preservation: {},
	build: { sourceManifestSha256: hash(JSON.stringify(sourceManifest)), sourceAssetRefs: sourceRefs },
};
const privateReceipt = { version: 1, cdpPort: port, desktopPid, backupDirectory: backup };

async function readState(target) {
	return target.evaluate(async () => {
		const api = window.namzu;
		if (!api) throw new Error('Native preload API is unavailable.');
		const workspace = await api.workspace();
		const windowState = workspace.layout.windows.find(item => item.id === workspace.windowId);
		if (!windowState) throw new Error('Workspace has no registered current window.');
		const visit = node => !node ? [] : node.kind === 'group' ? [node] : [...visit(node.first), ...visit(node.second)];
		const groups = visit(windowState.root);
		const projects = await api.projects();
		const conversations = (await Promise.all(projects.filter(project => project.status === 'ready').map(project => api.conversations(project.id)))).flat();
		const profiles = await api.pals();
		const sessions = [];
		for (const group of groups) for (const id of group.tabs) {
			const view = conversations.find(item => item.id === id);
			if (!view) throw new Error('An open tab has no conversation record.');
			const history = await api.openConversation(view.projectId, id);
			const thread = history.thread;
			if (thread?.running || thread?.responding || thread?.permissions?.length || thread?.queuedItems?.length || thread?.activeToolIds?.length)
				throw new Error('An open conversation is running or has queued/permission work.');
			const jobs = await api.jobs(id);
			if (jobs.some(job => job.status === 'running' || job.recoveryRequired)) throw new Error('An open conversation owns active/recovery work.');
			const draft = await api.draft(id);
			const editor = [...document.querySelectorAll('.composer-input textarea[aria-label="Message Namzu"]')]
				.find(input => input.closest('[data-workspace-group]')?.dataset.workspaceGroup === group.id);
			if (group.activeTabId === id && editor && editor.value !== draft) throw new Error('Visible composer differs from its saved draft.');
			sessions.push({ id, projectId: view.projectId, palId: projects.find(project => project.id === view.projectId)?.palId,
				messages: history.messages, partial: !!history.partial,
				thread: thread ? { running: !!thread.running, responding: !!thread.responding,
					permissions: thread.permissions ?? [], queuedItems: thread.queuedItems ?? [], activeToolIds: thread.activeToolIds ?? [],
					tasks: thread.tasks ?? [], tasksNotice: thread.tasksNotice, tools: thread.tools ?? {}, timeline: thread.timeline ?? [] } : null,
				draft, settings: await api.draftSettings(id), attachments: await api.attachments(id),
				selection: (await api.providers(view.projectId, id)).selected, jobs });
		}
		const computers = [];
		for (const profile of profiles) {
			const computer = await api.palComputer(profile.id);
			if (computer.control?.mode === 'transitioning') throw new Error('A computer control transition is active.');
			computers.push({ id: profile.id, status: computer.status, generation: computer.generation,
				environmentId: computer.environmentId, control: computer.control });
		}
		const activeGroup = groups.find(group => group.id === windowState.focusedGroupId);
		const activeSession = sessions.find(session => session.id === activeGroup?.activeTabId);
		const activeProject = projects.find(project => project.id === activeSession?.projectId);
		const activePal = profiles.find(profile => profile.id === activeProject?.palId);
		if (activePal?.name !== 'Sıtkı') throw new Error('The focused conversation must be Sıtkı.');
		const own = conversations.filter(view => view.projectId === activeSession.projectId).sort((left, right) =>
			Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id));
		if (own[0]?.id !== activeSession.id) throw new Error('Sıtkı must be showing its latest conversation.');
		if (activeGroup.tabs.at(-1) !== activeSession.id || activeGroup.tabs.length < 2)
			throw new Error('The target must be the last of at least two tabs, so normal reopening preserves exact order and group.');
		const pane = [...document.querySelectorAll('[data-workspace-group]')].find(element => element.dataset.workspaceGroup === activeGroup.id);
		const root = pane?.querySelector('.workspace');
		if (!root || root.dataset.page !== 'chat' || !pane.querySelector('.transcript')) throw new Error('Focused route is not a chat.');
		if (document.querySelector('.pal-computer-view canvas') || document.activeElement?.closest?.('.pal-computer-view')) throw new Error('Computer controls are active.');
		if ([...document.querySelectorAll('[role="dialog"], [role="alert"]')].some(element => element.getClientRects().length)) throw new Error('A dialog or visible alert is present.');
		if (document.activeElement?.matches('textarea,input,[contenteditable="true"]') && (document.activeElement.value?.length || document.activeElement.isContentEditable))
			throw new Error('A nonempty editor/control owns keyboard focus.');
		const transcript = pane.querySelector('.transcript');
		const card = pane.querySelector('.pal-context-card');
		const latestUser = [...activeSession.messages].reverse().find(message => message.role === 'user' && String(message.text ?? '').trim());
		if (!latestUser) throw new Error('Target history has no authored user message to verify.');
		return { workspace, groups, projects, profiles, sessions, computers,
			presentations: Object.keys(localStorage).filter(key => key.startsWith('namzu.workspace.presentation:')).sort().map(key => [key, localStorage.getItem(key)]),
			dom: { url: location.href, page: root.dataset.page, groupId: activeGroup.id, sessionId: activeSession.id,
				palId: activePal.id, palName: activePal.name, latestUserText: latestUser.text,
				transcriptScrollTop: transcript.scrollTop, cardScrollTop: card?.scrollTop ?? 0,
				cardVisible: !!card?.getClientRects().length,
				planExpanded: card?.querySelector('.pal-plan-toggle')?.getAttribute('aria-expanded') ?? null } };
	});
}

const layoutPlacement = state => ({ version: state.workspace.layout.version, windows: state.workspace.layout.windows });
const closedGroups = state => state.groups.map(group => {
	const index = group.tabs.indexOf(state.dom.sessionId);
	if (index < 0) return { id: group.id, tabs: group.tabs, activeTabId: group.activeTabId };
	const tabs = group.tabs.filter(id => id !== state.dom.sessionId);
	return { id: group.id, tabs, activeTabId: group.activeTabId === state.dom.sessionId ? tabs[Math.min(index, tabs.length - 1)] ?? null : group.activeTabId };
});
async function currentGroups() {
	return page.evaluate(async () => {
		const workspace = await window.namzu.workspace();
		const win = workspace.layout.windows.find(item => item.id === workspace.windowId);
		const visit = node => !node ? [] : node.kind === 'group' ? [node] : [...visit(node.first), ...visit(node.second)];
		return visit(win.root).map(group => ({ id: group.id, tabs: group.tabs, activeTabId: group.activeTabId }));
	});
}
async function settle() {
	await page.evaluate(async () => {
		await document.fonts.ready;
		const finite = document.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
		await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
}
function compareState(after, original, phase) {
	assert.deepEqual(wire(layoutPlacement(after)), wire(layoutPlacement(original)), `${phase}: window layout/tabs/order/focus changed.`);
	assert.deepEqual(wire(after.sessions), wire(original.sessions), `${phase}: histories/drafts/settings/files/models/jobs changed.`);
	assert.deepEqual(wire(after.profiles), wire(original.profiles), `${phase}: Pal profiles changed.`);
	assert.deepEqual(wire(after.computers), wire(original.computers), `${phase}: computer status/generation/control changed.`);
	assert.equal(after.dom.groupId, original.dom.groupId, `${phase}: focused group changed.`);
	assert.equal(after.dom.sessionId, original.dom.sessionId, `${phase}: latest conversation changed.`);
	assert.equal(after.workspace.windowId, original.workspace.windowId, `${phase}: registered window changed.`);
	assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(desktopPid), `${phase}: Electron PID changed.`);
}
async function installObserver(target) {
	await page.evaluate(({ groupId, sessionId, palName, latestUserText, savedHistoryProof }) => {
		window.__palReopenProof?.cleanup?.();
		const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
		const expected = normalize(latestUserText);
		const data = { started: null, phases: [], seen: {}, done: false, failure: null,
			updatingStatusObserved: false, pendingSamples: 0, pendingControlsBlocked: true };
		let frame;
		const phase = name => {
			if (data.seen[name] || data.started === null) return;
			data.seen[name] = true;
			data.phases.push({ name, elapsedMs: performance.now() - data.started });
		};
		const sample = () => {
			if (data.started === null || data.done) return;
			if ([...document.querySelectorAll('[role="alert"]')].some(element => element.getClientRects().length)) {
				data.failure = 'A visible application alert appeared during reopen.';
				data.done = true;
				cleanup();
				return;
			}
			const pane = [...document.querySelectorAll('[data-workspace-group]')].find(element => element.dataset.workspaceGroup === groupId);
			const activeTab = pane?.querySelector('.conversation-tab[data-active="true"]');
			if (activeTab?.dataset.tabId !== sessionId) return;
			phase('targetTabActive');
			const transcript = [...(pane?.querySelectorAll('.transcript') ?? [])].find(element => element.getAttribute('aria-label') === `${palName} conversation`);
			const log = [...(transcript?.querySelectorAll('[role="log"]') ?? [])].find(element => element.getAttribute('aria-label') === `${palName} messages`);
			const identity = !!log && !!transcript?.getClientRects().length;
			if (identity) phase('palTranscriptVisible');
			const latestVisible = [...(log?.querySelectorAll('.pal-chat-message.user .pal-chat-bubble') ?? [])]
				.some(bubble => bubble.getClientRects().length && normalize(bubble.innerText) === expected);
			const editor = pane?.querySelector('textarea[aria-label="Message Namzu"]');
			const historyState = transcript?.getAttribute('data-history-state');
			if (savedHistoryProof && latestVisible && historyState === 'saved') {
				phase('savedUserMessageVisible');
				data.updatingStatusObserved ||= [...pane.querySelectorAll('[role="status"], output.conversation-refresh')]
					.some(element => element.getClientRects().length && normalize(element.textContent).replace(/[.…]+$/, '') === 'Updating conversation');
				data.pendingSamples++;
				const controls = [...pane.querySelectorAll('[aria-label="Send message"], [aria-label="Queue message"], [aria-label="Select model"], [aria-label="Action approval controls"], [aria-label^="Edit queued message"], [aria-label^="Remove queued message"]')];
				const blocked = !!editor && (editor.disabled || editor.readOnly) && controls.every(control => control.disabled || control.getAttribute('aria-disabled') === 'true');
				data.pendingControlsBlocked &&= blocked;
				if (!blocked) {
					data.failure = 'A saved-history pending sample admitted editable composer/action controls.';
					data.done = true;
					cleanup();
					return;
				}
			}
			const authoritative = latestVisible && (!savedHistoryProof || historyState === 'authoritative');
			if (authoritative) phase('latestAuthoritativeUserMessageVisible');
			if (identity && authoritative && editor?.getClientRects().length && !editor.disabled && !editor.readOnly) {
				phase('composerReady');
				data.done = true;
				cleanup();
			}
		};
		const observer = new MutationObserver(sample);
		const tick = () => { sample(); if (!data.done) frame = requestAnimationFrame(tick); };
		const start = event => {
			const row = event.target instanceof Element ? event.target.closest('.sidebar-pal-row') : null;
			if (!row || ![...row.children].some(child => child.tagName === 'SPAN' && normalize(child.textContent) === palName)) return;
			data.started = performance.now();
			data.phases = [];
			data.seen = {};
			observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
			frame = requestAnimationFrame(tick);
		};
		function cleanup() {
			observer.disconnect();
			if (frame !== undefined) cancelAnimationFrame(frame);
			document.removeEventListener('click', start, true);
		}
		window.__palReopenProof = { data, cleanup };
		document.addEventListener('click', start, true);
	}, { groupId: target.dom.groupId, sessionId: target.dom.sessionId, palName: target.dom.palName, latestUserText: target.dom.latestUserText, savedHistoryProof });
}
async function restorePresentation(original, pane) {
	const card = pane.locator('.pal-context-card');
	const cardVisible = await card.isVisible();
	if (cardVisible !== original.dom.cardVisible) {
		await pane.getByRole('button', { name: `${original.dom.cardVisible ? 'Show' : 'Hide'} ${original.dom.palName} profile`, exact: true }).click();
	}
	if (original.dom.cardVisible) {
		const toggle = card.locator('.pal-plan-toggle');
		if (original.dom.planExpanded !== null && await toggle.count() && await toggle.getAttribute('aria-expanded') !== original.dom.planExpanded) await toggle.click();
		await card.evaluate((element, top) => element.scrollTo({ top, behavior: 'instant' }), original.dom.cardScrollTop);
	}
	await pane.locator('.transcript').evaluate((element, top) => element.scrollTo({ top, behavior: 'instant' }), original.dom.transcriptScrollTop);
	await settle();
}

function comparePresentations(after, original) {
	const expected = new Map(original.presentations);
	const actual = new Map(after.presentations);
	assert.equal(actual.size, expected.size, 'Presentation key count changed.');
	const targetKey = `namzu.workspace.presentation:${original.dom.sessionId}`;
	for (const [key, value] of expected) {
		assert(actual.has(key), 'An original presentation was removed.');
		const previous = JSON.parse(value);
		const next = JSON.parse(actual.get(key));
		if (key === targetKey && next.scrollTop !== previous.scrollTop) {
			assert.equal(next.scrollTop, original.dom.transcriptScrollTop, 'Close persisted a viewport different from the unchanged visible scroll.');
			receipt.observations.presentationScrollRefresh = { storedBefore: previous.scrollTop, visibleBefore: original.dom.transcriptScrollTop, storedAfter: next.scrollTop };
			previous.scrollTop = original.dom.transcriptScrollTop;
		}
		assert.deepEqual(next, previous, 'A session preference changed beyond the target visible-scroll persistence.');
	}
}

async function main() {
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === new URL(config.url).href);
	assert(page, 'Stable Development renderer is not open.');
	page.setDefaultTimeout(60_000); // Native runtime reads perform real IPC and filesystem work.
	page.on('pageerror', error => pageErrors.push(String(error.stack ?? error)));
	before = await readState(page);
	privateReceipt.inspectedBefore = before;
	if (originalFile) {
		const independentReceipt = JSON.parse(fs.readFileSync(originalFile, 'utf8'));
		const original = independentReceipt.before;
		assert(original, 'Original receipt has no before state.');
		receipt.rendererDeploymentPreviouslyRecorded = independentReceipt.safeReceipt?.deployed === true &&
			independentReceipt.safeReceipt?.preservation.rendererReloadState === true &&
			independentReceipt.safeReceipt?.build.sourceManifestSha256 === receipt.build.sourceManifestSha256;
		compareState(before, original, 'Before resuming failed instrumentation');
		assert.equal(before.dom.transcriptScrollTop, original.dom.transcriptScrollTop, 'Original visible transcript scroll changed.');
		assert.equal(before.dom.cardScrollTop, original.dom.cardScrollTop, 'Original card scroll changed.');
		assert.equal(before.dom.cardVisible, original.dom.cardVisible, 'Original card visibility changed.');
		assert.equal(before.dom.planExpanded, original.dom.planExpanded, 'Original progress disclosure changed.');
		comparePresentations(before, original);
		privateReceipt.currentBeforeVerification = before;
		before = original;
		receipt.checks.push('The independent original pre-update receipt still matches all application state and visible scroll/disclosure; only normal persistence of its already visible target scroll is allowed.');
	}
	privateReceipt.before = before;
	receipt.idleOpenTabs = before.sessions.length;
	receipt.checks.push('All open conversations are idle; drafts match visible editors; no active/recovery job, queue, permission, dialog, alert or computer control transition is present.');
	receipt.checks.push('Focused Sıtkı conversation is its latest and the last tab in its unchanged owning group.');
	if (preflightOnly) {
		receipt.passed = true;
		return;
	}
	const paneSelector = `[data-workspace-group="${before.dom.groupId.replaceAll(/["\\]/g, '\\$&')}"]`;
	const pane = page.locator(paneSelector);
	assert.equal(await pane.count(), 1, 'Focused group is not unique.');
	if (verifyCurrent) {
		assert.deepEqual(manifest(renderer), sourceManifest, 'Current renderer differs from the verified built directory.');
		receipt.currentBuildVerified = true;
	} else {
		assert(sourceRefs.some(ref => !bundleRefs(renderer).includes(ref)), 'Built renderer assets do not differ from the deployed build.');
		fs.cpSync(source, pending, { recursive: true, errorOnExist: true, force: false });
		assert.deepEqual(manifest(pending), sourceManifest, 'Staged renderer differs from build.');
		try {
			fs.renameSync(renderer, backup);
			fs.renameSync(pending, renderer);
			deployed = true;
		} catch (error) {
			if (!fs.existsSync(renderer) && fs.existsSync(backup)) fs.renameSync(backup, renderer);
			throw error;
		}
		await page.reload({ waitUntil: 'domcontentloaded' });
	}
	await pane.getByRole('region', { name: `${before.dom.palName} conversation`, exact: true }).waitFor({ state: 'visible' });
	await pane.locator('textarea[aria-label="Message Namzu"]:not([disabled]):not([readonly])').waitFor({ state: 'visible' });
	await settle();
	const afterReload = await readState(page);
	privateReceipt.afterReload = afterReload;
	compareState(afterReload, before, 'Renderer reload');
	comparePresentations(afterReload, before);
	receipt.preservation.rendererReloadState = true;
	receipt.checks.push('Complete renderer-only update retains the Electron process, canonical tabs/layout/focus, exact histories/drafts/settings/files/model selections, Pal profiles and computer generations/control.');
	await installObserver(before);
	await pane.locator(`.conversation-tab[data-tab-id="${before.dom.sessionId.replaceAll(/["\\]/g, '\\$&')}"]`).getByRole('button', { name: `Close tab ${before.dom.palName}`, exact: true }).click();
	closed = true;
	await page.waitForFunction(({ groupId, sessionId }) => {
		const pane = [...document.querySelectorAll('[data-workspace-group]')].find(element => element.dataset.workspaceGroup === groupId);
		return !!pane && ![...pane.querySelectorAll('.conversation-tab')].some(tab => tab.dataset.tabId === sessionId);
	}, { groupId: before.dom.groupId, sessionId: before.dom.sessionId });
	assert.deepEqual(await currentGroups(), closedGroups(before), 'Closing the target changed unrelated group membership or selection.');
	const sidebarPal = page.locator('.sidebar-pal-row').filter({ has: page.locator('span', { hasText: new RegExp(`^${before.dom.palName}$`) }) });
	assert.equal(await sidebarPal.count(), 1, 'Sıtkı sidebar row is not unique.');
	await sidebarPal.click();
	// Readiness waits inspect shared DOM. Observer state is then read explicitly
	// through page.evaluate in the main world where it was installed, avoiding
	// assumptions about Playwright waitForFunction's execution world in Electron.
	await pane.locator(`.conversation-tab[data-active="true"][data-tab-id="${before.dom.sessionId.replaceAll(/["\\]/g, '\\$&')}"]`).waitFor({ state: 'visible' });
	await pane.getByRole('log', { name: `${before.dom.palName} messages`, exact: true })
		.getByText(normalize(before.dom.latestUserText), { exact: true }).waitFor({ state: 'visible' });
	await pane.locator('textarea[aria-label="Message Namzu"]:not([disabled]):not([readonly])').waitFor({ state: 'visible' });
	await settle();
	const result = await page.evaluate(() => {
		const data = window.__palReopenProof.data;
		return { started: data.started !== null, done: data.done, phases: data.phases, failure: data.failure,
			updatingStatusObserved: data.updatingStatusObserved, pendingSamples: data.pendingSamples,
			pendingControlsBlocked: data.pendingControlsBlocked };
	});
	privateReceipt.observer = result;
	assert(result.started, 'Real sidebar click was not observed in the page main world.');
	assert(result.done, 'Main-world observer did not confirm the same ready pane shown by DOM locators.');
	assert.equal(result.failure, null, 'A visible native metadata/error alert appeared.');
	assert.deepEqual(result.phases.map(phase => phase.name), savedHistoryProof
		? ['targetTabActive', 'palTranscriptVisible', 'savedUserMessageVisible', 'latestAuthoritativeUserMessageVisible', 'composerReady']
		: ['targetTabActive', 'palTranscriptVisible', 'latestAuthoritativeUserMessageVisible', 'composerReady']);
	if (savedHistoryProof) {
		assert(result.updatingStatusObserved, 'Saved visible history was not accompanied by Updating conversation status.');
		assert(result.pendingSamples > 0 && result.pendingControlsBlocked, 'Saved history was not verified as read-only before authoritative hydration.');
		receipt.savedHistoryAdmission = { updatingStatusObserved: true, pendingSamples: result.pendingSamples, pendingControlsBlocked: true };
	}
	reopened = true;
	receipt.observations.phases = result.phases.map(phase => ({ name: phase.name, elapsedMs: Math.round(phase.elapsedMs * 10) / 10 }));
	const authoritativePhase = result.phases.find(phase => phase.name === 'latestAuthoritativeUserMessageVisible');
	const composerPhase = result.phases.find(phase => phase.name === 'composerReady');
	receipt.observations.messageToComposerGapMs = Math.round((composerPhase.elapsedMs - authoritativePhase.elapsedMs) * 10) / 10;
	if (savedHistoryProof) receipt.observations.savedToAuthoritativeGapMs = Math.round((authoritativePhase.elapsedMs - result.phases.find(phase => phase.name === 'savedUserMessageVisible').elapsedMs) * 10) / 10;
	receipt.observations.timingInterpretation = 'One actual native close/sidebar-reopen observation. No speed threshold or before/after improvement claim is asserted.';
	await restorePresentation(before, pane);
	const after = await readState(page);
	privateReceipt.afterReopen = after;
	compareState(after, before, 'Actual close/reopen');
	comparePresentations(after, before);
	assert.equal(after.dom.cardVisible, before.dom.cardVisible, 'Pal card visibility was not restored.');
	assert.equal(after.dom.planExpanded, before.dom.planExpanded, 'Pal progress disclosure was not restored.');
	assert(Math.abs(after.dom.transcriptScrollTop - before.dom.transcriptScrollTop) <= 1, 'Transcript scroll was not restored.');
	assert(Math.abs(after.dom.cardScrollTop - before.dom.cardScrollTop) <= 1, 'Pal card scroll was not restored.');
	assert.deepEqual(manifest(renderer), sourceManifest, 'Deployed renderer changed after proof.');
	receipt.currentBuildVerified = true;
	assert.equal(pageErrors.length, 0, 'Native renderer raised page errors.');
	receipt.preservation = { rendererReloadState: true, canonicalLayoutAndTabOrder: true, focusedGroupAndConversation: true,
		exactHistories: true, draftsSettingsFilesAndModelSelections: true, palProfiles: true,
		computerStatusGenerationAndControl: true, nonScrollPresentationPreferencesAndVisibleScroll: true, electronPid: true };
	receipt.checks.push('Actual close/sidebar-reopen rendered the latest main-authoritative user message in the exact owning pane/target tab/Pal log and enabled the same pane composer.');
	receipt.checks.push('Final state matches the original canonical layout/order/focus, all observed histories, drafts/settings/files/models, Pal profiles and computer state; original visible presentation/scroll restored; normal persistence may refresh the target’s stale stored scroll to that unchanged viewport.');
	receipt.pageErrorCount = pageErrors.length;
	receipt.passed = true;
}

main().catch(error => {
	privateReceipt.failure = String(error.stack ?? error);
	receipt.error = { name: error.name, message: 'Native proof failed; inspect its private Development receipt.' };
	process.exitCode = 1;
}).finally(async () => {
	try {
		if (page) {
			privateReceipt.finalObserver = await page.evaluate(() => {
				const data = window.__palReopenProof?.data;
				const result = data ? { started: data.started !== null, done: data.done, phases: data.phases, failure: data.failure,
					updatingStatusObserved: data.updatingStatusObserved, pendingSamples: data.pendingSamples,
					pendingControlsBlocked: data.pendingControlsBlocked } : null;
				window.__palReopenProof?.cleanup?.();
				delete window.__palReopenProof;
				return result;
			}).catch(() => null);
			if (closed && !reopened && before) {
				const current = await currentGroups();
				if (JSON.stringify(current) === JSON.stringify(closedGroups(before))) {
					receipt.recoveryAttempted = true;
					await page.locator('.sidebar-pal-row').filter({ hasText: before.dom.palName }).click();
					await page.waitForFunction(id => [...document.querySelectorAll('.conversation-tab[data-active="true"]')].some(tab => tab.dataset.tabId === id), before.dom.sessionId);
				} else receipt.recoverySkippedBecauseLayoutChanged = true;
			}
		}
	} catch (error) { privateReceipt.recoveryFailure = String(error.stack ?? error); }
	if (browser) await browser.close().catch(() => {});
	receipt.deployed = deployed;
	receipt.failurePolicy = deployed ? 'Prior renderer retained as a timestamped backup. No app/CLI/computer rollback or restart attempted.' : 'No deployment occurred before idle preflight passed.';
	privateReceipt.pageErrors = pageErrors;
	privateReceipt.safeReceipt = receipt;
	fs.mkdirSync(path.dirname(privateOutput), { recursive: true });
	fs.writeFileSync(privateOutput, `${JSON.stringify(privateReceipt, null, 2)}\n`, { mode: 0o600 });
	fs.mkdirSync(path.dirname(publicOutput), { recursive: true });
	fs.writeFileSync(publicOutput, `${JSON.stringify(receipt, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ passed: receipt.passed, preflightOnly, deployed, checks: receipt.checks.length, observations: receipt.observations, error: receipt.error?.message })}\n`);
});
