'use strict';

// Prepared native Windows deployment/proof. Do not run until the operator is
// idle and the root agent authorizes this renderer-only reload.
// Usage (native Windows Node):
//   node.exe windows-pal-context-tasks-renderer-proof-20261006.cjs <built-renderer-dir> <receipt.json>
// The built directory may be a Windows-accessible WSL share. This stages the
// complete renderer, retains the old renderer tree as a backup, and reloads
// only the existing Electron renderer page through its stable Development CDP.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(process.platform, 'win32', 'Run with native Windows Node.');
const devRoot = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const config = JSON.parse(fs.readFileSync(path.join(devRoot, 'launch.json'), 'utf8'));
const [sourceArg, receiptArg] = process.argv.slice(2);
assert(sourceArg && receiptArg, 'Arguments: final built renderer directory, receipt path.');
const source = path.resolve(sourceArg);
const output = path.resolve(receiptArg);
const appRoot = config.app;
const dist = path.join(appRoot, 'dist');
const renderer = path.join(dist, 'renderer');
assert(fs.existsSync(path.join(source, 'index.html')), 'Built source renderer is missing index.html.');
assert(fs.existsSync(renderer), 'Stable Development renderer is missing.');
assert.notEqual(path.resolve(source).toLowerCase(), path.resolve(renderer).toLowerCase());
const outputRelativeToDev = path.relative(devRoot, output);
assert(outputRelativeToDev && !outputRelativeToDev.startsWith('..') && !path.isAbsolute(outputRelativeToDev), 'Receipt must be written under the private Development directory.');
const captureDir = path.join(devRoot, 'proof-artifacts', 'pal-context-tasks-renderer-20261006');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function manifest(root) {
	const rows = [];
	const visit = relative => {
		for (const name of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
			const child = path.join(relative, name.name);
			if (name.isDirectory()) visit(child);
			else if (name.isFile()) rows.push({ file: child.replaceAll(path.sep, '/'), sha256: hash(fs.readFileSync(path.join(root, child))) });
			else throw new Error(`Unsupported renderer entry: ${child}`);
		}
	};
	visit('');
	return rows.sort((a, b) => a.file.localeCompare(b.file));
}
function bundleRefs(root) {
	const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
	const refs = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"?]+\.(?:js|css))"/g)].map(match => match[1]);
	assert(refs.some(file => file.endsWith('.js')), 'Built index does not reference its JavaScript entry.');
	assert(refs.some(file => file.endsWith('.css')), 'Built index does not reference its stylesheet.');
	for (const ref of refs) assert(fs.existsSync(path.join(root, ref)), `Built asset is missing: ${ref}`);
	return refs.sort();
}
const sourceManifest = manifest(source);
const sourceRefs = bundleRefs(source);
const { chromium } = require(path.join(devRoot, 'runtime', 'packages', 'p39'));
const cdpPortFile = path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort');
const port = Number(fs.readFileSync(cdpPortFile, 'utf8').split(/\r?\n/)[0]);
assert(Number.isInteger(port) && port > 0, 'Stable Development CDP port is invalid.');
const pidFile = path.join(devRoot, 'desktop.pid');
const desktopPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
assert(Number.isInteger(desktopPid) && desktopPid > 0);
process.kill(desktopPid, 0);

const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
const pending = path.join(dist, `renderer-pal-context-tasks-${stamp}`);
const backup = path.join(dist, `renderer-before-pal-context-tasks-${stamp}`);
assert(!fs.existsSync(pending) && !fs.existsSync(backup), 'Unique stage/backup path already exists.');

const groupsIn = node => !node ? [] : node.kind === 'group' ? [node] : [...groupsIn(node.first), ...groupsIn(node.second)];
let pageErrorCount = 0;
let browser;
let deployed = false;
let page;
const receipt = {
	version: 1,
	passed: false,
	platform: process.platform,
	rendererOnly: true,
	electronRestarted: false,
	cliRestarted: false,
	computerActions: 0,
	modelRequests: 0,
	guestExecutions: 0,
	cdpPort: port,
	desktopPid,
	checks: [],
	pageErrorCount,
	build: { sourceManifestSha256: hash(JSON.stringify(sourceManifest)), sourceAssetRefs: sourceRefs },
	backupDirectory: path.basename(backup),
};

async function readState(target) {
	return target.evaluate(async () => {
		const api = window.namzu;
		if (!api) throw new Error('Native preload API is unavailable.');
		const workspace = await api.workspace();
		const windowState = workspace.layout.windows.find(item => item.id === workspace.windowId);
		if (!windowState) throw new Error('Workspace has no active window.');
		const groups = (() => {
			const visit = node => !node ? [] : node.kind === 'group' ? [node] : [...visit(node.first), ...visit(node.second)];
			return visit(windowState.root);
		})();
		const projects = await api.projects();
		const conversations = (await Promise.all(projects.filter(p => p.status === 'ready').map(p => api.conversations(p.id)))).flat();
		const profiles = await api.pals();
		const sessions = [];
		for (const group of groups) {
			for (const id of group.tabs) {
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
				if (group.activeTabId === id && editor && editor.value !== draft)
					throw new Error(`Open tab ${id} has unsaved composer text.`);
				sessions.push({
					id, projectId: row.projectId, palId: projects.find(project => project.id === row.projectId)?.palId,
					active: group.activeTabId === id,
					messages: history.messages,
					thread: thread ? {
						running: !!thread.running, responding: !!thread.responding,
						permissions: thread.permissions ?? [], queuedItems: thread.queuedItems ?? [],
						activeToolIds: thread.activeToolIds ?? [], tasks: thread.tasks ?? [], tasksNotice: thread.tasksNotice,
					} : null,
					draft, settings: await api.draftSettings(id), attachments: await api.attachments(id),
					provider: (await api.providers(row.projectId, id)).selected,
					jobs,
				});
			}
		}
		const computers = [];
		for (const profile of profiles) {
			const computer = await api.palComputer(profile.id);
			if (computer.control?.mode === 'transitioning')
				throw new Error('A Pal computer control transition is active.');
			computers.push({ id: profile.id, status: computer.status, generation: computer.generation, environmentId: computer.environmentId, control: computer.control });
		}
		const activeGroup = groups.find(group => group.id === windowState.focusedGroupId);
		const activeSessionId = activeGroup?.activeTabId;
		const activeSession = sessions.find(session => session.id === activeSessionId);
		const activeProject = activeSession && projects.find(project => project.id === activeSession.projectId);
		if (!activeSession || !activeProject?.palId) throw new Error('Focused tab must be an existing Pal conversation.');
		if (!activeSession.thread?.tasks?.length && !activeSession.thread?.tasksNotice)
			throw new Error('Focused Pal conversation has no real projected task summary to verify.');
		const root = document.querySelector('.workspace');
		const transcript = root?.querySelector('.transcript');
		if (!transcript || transcript.scrollHeight <= transcript.clientHeight)
			throw new Error('Focused Pal transcript must have real scrollable history before deployment.');
		if (!root || root.dataset.page !== 'chat') throw new Error('Focused renderer route is not chat.');
		if (root.querySelector('.pal-computer-view canvas') || document.activeElement?.closest?.('.pal-computer-view')) throw new Error('A computer canvas or focused computer control is currently mounted.');
		if ([...document.querySelectorAll('[role="dialog"]')].some(element => element.getClientRects().length)) throw new Error('A dialog is already open.');
		if ([...document.querySelectorAll('[role="alert"]')].some(element => element.getClientRects().length)) throw new Error('A visible alert is present.');
		if (document.activeElement?.matches('textarea,input,[contenteditable="true"]') &&
			(document.activeElement.value?.length || document.activeElement.isContentEditable))
			throw new Error('A text editor/control currently owns keyboard focus.');
		const presentations = Object.keys(localStorage).filter(key => key.startsWith('namzu.workspace.presentation:')).sort()
			.map(key => [key, localStorage.getItem(key)]);
		const dom = {
			url: location.href,
			page: root.dataset.page,
			computerChat: root.dataset.computerChat ?? null,
			activePalName: profiles.find(profile => profile.id === activeProject.palId)?.name,
			activeGroupId: activeGroup.id,
			activeSessionId,
			visibleTabs: [...document.querySelectorAll('.conversation-tabs [role="tab"][aria-selected="true"]')].map(tab => tab.textContent?.trim()),
			viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
			activeJobsPanel: !!document.querySelector('.jobs-panel[data-open="true"]'),
			activeComputerCanvas: !!document.querySelector('.pal-computer-view canvas'),
			transcriptScrollTop: transcript.scrollTop,
			transcriptScrollRange: transcript.scrollHeight - transcript.clientHeight,
		};
		return {
			workspace: { windowId: workspace.windowId, homeGroupId: workspace.homeGroupId, sequence: workspace.sequence, layout: workspace.layout },
			groups, sessions, profiles, computers, presentations, dom,
		};
	});
}

async function settle(target) {
	await target.evaluate(async () => {
		await document.fonts.ready;
		const finite = document.getAnimations({ subtree: true }).filter(animation => {
			const endTime = animation.effect?.getComputedTiming().endTime;
			return animation.playState === 'running' && typeof endTime === 'number' && Number.isFinite(endTime);
		});
		await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
}

async function main() {
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === new URL(config.url).href);
	assert(page, 'No window is open on the stable Development renderer URL.');
	page.on('pageerror', () => { pageErrorCount += 1; });
	const pidBefore = fs.readFileSync(pidFile, 'utf8').trim();
	const before = await readState(page);
	const activePalName = before.dom.activePalName;
	assert(activePalName, 'Focused Pal profile could not be identified.');
	const activePalSession = before.sessions.find(session => session.id === before.dom.activeSessionId);
	assert(activePalSession?.thread?.tasks?.length, 'Real focused Pal task rows are required for the UI proof.');
	assert.equal(before.dom.activeComputerCanvas, false);
	const paneSelector = `[data-workspace-group="${before.dom.activeGroupId.replaceAll(/["\\]/g, '\\$&')}"]`;
	const pane = page.locator(paneSelector);
	assert.equal(await pane.count(), 1, 'Focused conversation group could not be uniquely scoped.');
	receipt.beforeStateSha256 = hash(JSON.stringify(before));
	receipt.originalLayoutSha256 = hash(JSON.stringify(before.groups.map(group => ({ id: group.id, tabs: group.tabs, activeTabId: group.activeTabId }))));
	receipt.originalPage = before.dom.page;
	receipt.originalPal = activePalName;
	receipt.originalTaskCount = activePalSession.thread.tasks.length;
	receipt.checks.push('All open tabs idle; no unsaved editor, pending permission, queued item, active/recovery job, dialog, alert, computer canvas, focused computer control or control transition.');

	const oldRefs = bundleRefs(renderer);
	const oldEntryRefs = oldRefs.filter(ref => /(?:^|\/)(?:index|main)-.*\.(?:js|css)$/.test(ref));
	assert(oldEntryRefs.length >= 2, 'Current renderer entry assets are not discoverable.');
	assert(sourceRefs.some(ref => ref.endsWith('.js') && !oldEntryRefs.includes(ref)), 'Source JS entry must differ from the currently deployed old renderer.');

	fs.cpSync(source, pending, { recursive: true, errorOnExist: true, force: false });
	assert.deepEqual(manifest(pending), sourceManifest, 'Staged renderer differs from the verified build directory.');
	try {
		fs.renameSync(renderer, backup);
		fs.renameSync(pending, renderer);
		deployed = true;
	} catch (error) {
		if (!fs.existsSync(renderer) && fs.existsSync(backup)) fs.renameSync(backup, renderer);
		throw error;
	}
	receipt.checks.push('Entire final renderer staged; old JavaScript, CSS and runtime assets retained in a timestamped backup.');

	await page.reload({ waitUntil: 'domcontentloaded' });
	await pane.getByRole('region', { name: `${activePalName} conversation`, exact: true }).waitFor({ state: 'visible' });
	await settle(page);
	assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), pidBefore, 'Electron process PID changed unexpectedly.');
	const afterReload = await readState(page);
	const persistentView = state => {
		const { presentations: _presentations, ...rest } = state;
		const { activeJobsPanel: _activeJobsPanel, transcriptScrollTop: _transcriptScrollTop, transcriptScrollRange: _transcriptScrollRange, ...dom } = rest.dom;
		return { ...rest, dom };
	};
	assert.equal(hash(JSON.stringify(persistentView(afterReload))), hash(JSON.stringify(persistentView(before))), 'Persistent user state, route, tabs, drafts, profiles, selected models or computer allocations changed on renderer reload.');
	receipt.checks.push('Guarded page reload retained route, layout/tab identities, profiles, messages, drafts/settings/attachments/models, tasks and computer generations/control.');

	const transcript = pane.getByRole('region', { name: `${activePalName} conversation`, exact: true });
	await transcript.waitFor({ state: 'visible' });
	const transcriptStyle = await transcript.evaluate(element => ({
		overflowY: getComputedStyle(element).overflowY,
		scrollbarWidth: getComputedStyle(element).scrollbarWidth,
		scrollbarGutter: getComputedStyle(element).scrollbarGutter,
		webkitScrollbar: getComputedStyle(element, '::-webkit-scrollbar').display,
		scrollHeight: element.scrollHeight,
		clientHeight: element.clientHeight,
		scrollTop: element.scrollTop,
		outer: { x: scrollX, y: scrollY, width: document.documentElement.scrollWidth, clientWidth: innerWidth },
	}));
	assert.equal(transcriptStyle.overflowY, 'auto');
	assert.equal(transcriptStyle.scrollbarWidth, 'none');
	assert.equal(transcriptStyle.scrollbarGutter, 'auto');
	assert.equal(transcriptStyle.webkitScrollbar, 'none');
	assert(transcriptStyle.scrollHeight > transcriptStyle.clientHeight, 'Native Pal transcript must retain a nonzero scroll range.');
	assert(transcriptStyle.outer.width <= transcriptStyle.outer.clientWidth, 'Native Pal transcript must not create horizontal overflow.');
	const transcriptScrollTop = transcriptStyle.scrollTop;
	await transcript.evaluate(element => { element.scrollTo({ top: 0, behavior: 'instant' }); });
	await transcript.hover();
	const wheelWait = transcript.evaluate(element => new Promise(resolve => {
		element.addEventListener('scroll', () => resolve(element.scrollTop), { once: true, passive: true });
	}));
	await page.mouse.wheel(0, 420);
	const wheelScrollTop = await wheelWait;
	assert(wheelScrollTop > 0, 'Native wheel event did not scroll the Pal transcript.');
	await transcript.evaluate(element => { element.scrollTo({ top: 0, behavior: 'instant' }); });
	await transcript.focus();
	const pageDownWait = transcript.evaluate(element => new Promise(resolve => {
		element.addEventListener('scrollend', () => resolve(element.scrollTop), { once: true, passive: true });
	}));
	await page.keyboard.press('PageDown');
	const pageDownScrollTop = await pageDownWait;
	assert(pageDownScrollTop >= Math.min(100, transcriptStyle.clientHeight * 0.25), 'PageDown did not meaningfully scroll the keyboard-focused Pal transcript.');
	const lastMessage = transcript.locator('.pal-chat-message').last();
	await lastMessage.scrollIntoViewIfNeeded();
	assert(await lastMessage.isVisible(), 'Last Pal message must remain reachable with the scrollbar hidden.');
	const finalTranscriptScrollTop = await transcript.evaluate(element => element.scrollTop);
	const outerAfterScroll = await transcript.evaluate(() => ({ x: scrollX, y: scrollY, width: document.documentElement.scrollWidth, clientWidth: innerWidth }));
	assert.deepEqual(outerAfterScroll, transcriptStyle.outer, 'Wheel/keyboard transcript scrolling moved or widened the outer workspace.');
	await transcript.evaluate((element, value) => { element.scrollTo({ top: value, behavior: 'instant' }); }, transcriptScrollTop);
	assert.equal(await transcript.evaluate(element => element.scrollTop), transcriptScrollTop, 'Original transcript scroll position was not restored.');
	receipt.transcript = { overflowY: transcriptStyle.overflowY, scrollbarWidth: transcriptStyle.scrollbarWidth, scrollbarGutter: transcriptStyle.scrollbarGutter, webkitScrollbar: transcriptStyle.webkitScrollbar, scrollRange: transcriptStyle.scrollHeight - transcriptStyle.clientHeight, wheelScrollTop, pageDownScrollTop, lastMessageScrollTop: finalTranscriptScrollTop, originalScrollRestored: true, outerUnchanged: true };
	receipt.checks.push('Pal transcript scrollbar hidden while overflow stays scrollable; real wheel and PageDown reached the last message without outer scrolling, then restored the original scroll position.');

	const card = pane.getByRole('complementary', { name: 'Pal context', exact: true });
	const profileToggle = pane.getByRole('button', { name: `Show ${activePalName} profile`, exact: true });
	if (await profileToggle.count()) await profileToggle.click();
	await card.waitFor({ state: 'visible' });
	const gear = card.getByRole('button', { name: `${activePalName} settings`, exact: true });
	await gear.click();
	const dialog = page.getByRole('dialog', { name: `${activePalName} settings`, exact: true });
	await dialog.waitFor({ state: 'visible' });
	fs.mkdirSync(captureDir, { recursive: true });
	await dialog.screenshot({ path: path.join(captureDir, 'pal-settings-dialog.png') });
	assert.equal((await dialog.getByText('Communication', { exact: true }).count()), 1);
	const inbox = dialog.getByRole('tab', { name: 'Inbox', exact: true });
	await inbox.focus();
	await page.keyboard.press('ArrowRight');
	const subscriptions = dialog.getByRole('tab', { name: 'Activity subscriptions', exact: true });
	await subscriptions.waitFor({ state: 'visible' });
	assert.equal(await subscriptions.evaluate(element => document.activeElement === element), true);
	await page.keyboard.press('Enter');
	assert.equal(await subscriptions.getAttribute('aria-selected'), 'true');
	await page.keyboard.press('Escape');
	await dialog.waitFor({ state: 'detached' });
	assert.equal(await gear.evaluate(element => document.activeElement === element), true, 'Escape must restore focus to the gear.');
	receipt.checks.push('Native Pal settings gear opens the accessible Communication dialog; keyboard tab activation and Escape focus restoration pass.');

	await gear.click();
	await dialog.waitFor({ state: 'visible' });
	await dialog.getByRole('button', { name: 'Close Pal settings', exact: true }).click();
	await dialog.waitFor({ state: 'detached' });
	assert.equal(await gear.evaluate(element => document.activeElement === element), true, 'X must restore focus to the gear.');
	const panel = page.locator('.pal-context-card');
	const taskRegion = panel.getByRole('region', { name: `${activePalName} tasks`, exact: true });
	await taskRegion.waitFor({ state: 'visible' });
	const summary = pane.locator('.conversation-body').getByRole('button', { name: /^Tasks(?: · |$)/ });
	assert.equal(await summary.count(), 1, 'Focused Pal turn should have one task summary.');
	await summary.click();
	await taskRegion.waitFor({ state: 'visible' });
	await page.waitForFunction(element => document.activeElement === element, await taskRegion.elementHandle());
	assert.equal(await pane.locator('.jobs-panel[data-open="true"]').count(), 0, 'Pal task summary must not open the third Activity column.');
	await settle(page);
	const cardGeometry = () => panel.boundingBox();
	const cardBefore = await cardGeometry();
	const laneBefore = await pane.locator('.conversation-lane').boundingBox();
	const hide = pane.getByRole('button', { name: `Hide ${activePalName} profile`, exact: true });
	await hide.click();
	await card.waitFor({ state: 'detached' });
	await summary.click();
	await card.waitFor({ state: 'visible' });
	await taskRegion.waitFor({ state: 'visible' });
	await page.waitForFunction(element => document.activeElement === element, await taskRegion.elementHandle());
	await settle(page);
	assert.equal(await pane.locator('.jobs-panel[data-open="true"]').count(), 0);
	const cardAfter = await cardGeometry();
	const laneAfter = await pane.locator('.conversation-lane').boundingBox();
	for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(cardAfter[key] - cardBefore[key]) <= 1, `Pal card ${key} shifted after reopening task details.`);
	for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(laneAfter[key] - laneBefore[key]) <= 1, `Conversation lane ${key} shifted after reopening task details.`);
	receipt.taskGeometry = { card: cardAfter, lane: laneAfter, openJobsPanels: 0 };
	await panel.screenshot({ path: path.join(captureDir, 'pal-context-tasks-card.png') });
	await pane.locator('.workspace-conversation-header').screenshot({ path: path.join(captureDir, 'conversation-header.png') });
	receipt.checks.push('Task summary keeps details in the same Pal card, leaves Activity closed, and reopens/focuses the card after its profile toggle hides it.');

	const postTest = await readState(page);
	assert.equal(hash(JSON.stringify(persistentView(postTest))), hash(JSON.stringify(persistentView(before))), 'Non-presentation state changed during proof.');
	const originalPresentationKeys = new Set(before.presentations.map(([key]) => key));
	const currentPresentationKeys = new Set(postTest.presentations.map(([key]) => key));
	const activePresentationKey = `namzu.workspace.presentation:${before.dom.activeSessionId}`;
	const otherBefore = before.presentations.filter(([key]) => key !== activePresentationKey);
	const otherAfter = postTest.presentations.filter(([key]) => key !== activePresentationKey);
	assert.equal(hash(JSON.stringify(otherAfter)), hash(JSON.stringify(otherBefore)), 'Another session presentation changed during proof.');
	assert.equal(hash(JSON.stringify([...currentPresentationKeys].filter(key => key !== activePresentationKey).sort())), hash(JSON.stringify([...originalPresentationKeys].filter(key => key !== activePresentationKey).sort())), 'Another session presentation key changed.');
	const presentationRow = postTest.presentations.find(([key]) => key === activePresentationKey)?.[1];
	const activePresentation = presentationRow ? JSON.parse(presentationRow) : {};
	assert.equal(activePresentation.palProfileOpen, true, 'Requested Pal context card should remain visible.');
	assert.equal(activePresentation.jobsOpen, false, 'Activity/jobs column should remain closed.');
	assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), pidBefore, 'Electron process PID changed during proof.');
	assert.deepEqual(manifest(renderer), sourceManifest, 'Deployed renderer no longer matches the staged build.');
	assert.equal(pageErrorCount, 0, 'Native renderer raised page errors.');
	receipt.afterStateSha256 = hash(JSON.stringify(persistentView(postTest)));
	receipt.stagedRendererManifestSha256 = hash(JSON.stringify(manifest(renderer)));
	receipt.nativePidUnchanged = true;
	receipt.persistentStatePreserved = true;
	receipt.otherSessionPresentationPreserved = true;
	receipt.requestedPalPresentationRetained = true;
	receipt.pageErrorCount = pageErrorCount;
	receipt.checks.push('All non-presentation state and other session presentation fields remain unchanged; the requested Pal card stays visible and Activity stays closed without a second reload or storage overwrite.');
	receipt.passed = true;
}

main().catch(error => {
	fs.writeFileSync(output.replace(/\.json$/i, '-failure-private.txt'), `${String(error.stack ?? error)}\n`, { mode: 0o600 });
	receipt.error = { name: error.name, message: 'Native renderer proof failed; inspect the private Development logs without exporting raw application state.' };
	process.exitCode = 1;
}).finally(async () => {
	if (browser) await browser.close();
	receipt.deployed = deployed;
	receipt.failurePolicy = deployed ? 'Old renderer retained in backup; no app/CLI/computer rollback or restart attempted.' : 'No renderer deployment occurred before native idle/state preflight passed.';
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ passed: receipt.passed, deployed: receipt.deployed, checks: receipt.checks.length, error: receipt.error?.message })}\n`);
});
