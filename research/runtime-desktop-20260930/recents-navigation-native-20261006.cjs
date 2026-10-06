'use strict';

// Bounded Recents navigation in the already running native Windows desktop.
// No prompts, provider calls, computer input, renderer reload, or process restart.
// Usage: node.exe recents-navigation-native-20261006.cjs <private-receipt.json>
// The receipt contains identifiers, hashes, counts, and timings; never message text.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(process.platform, 'win32', 'Run with native Windows Node.');
const root = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const config = JSON.parse(fs.readFileSync(path.join(root, 'launch.json'), 'utf8'));
const receiptPath = path.resolve(process.argv[2] ?? '');
const selectionArg = process.argv[3] ?? '0';
const fixedIds = selectionArg.startsWith('--ids=') ? selectionArg.slice('--ids='.length).split(',') : null;
const candidateOffset = fixedIds ? 0 : Number(selectionArg);
const relativeReceipt = path.relative(root, receiptPath);
assert(
	process.argv[2] && relativeReceipt && !relativeReceipt.startsWith('..') && !path.isAbsolute(relativeReceipt),
	'Receipt must stay under the private Development directory.',
);
assert(Number.isInteger(candidateOffset) && candidateOffset >= 0 && candidateOffset <= 8,
	'Candidate offset must be an integer from 0 through 8.');
if (fixedIds) assert(fixedIds.length === 2 && new Set(fixedIds).size === 2 &&
	fixedIds.every((id) => /^[a-zA-Z0-9-]{1,100}$/.test(id)),
	'--ids requires two distinct comma-separated conversation IDs.');
const desktopPid = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim());
assert(Number.isInteger(desktopPid) && desktopPid > 0);
process.kill(desktopPid, 0);
const port = Number(
	fs.readFileSync(path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0],
);
assert(Number.isInteger(port) && port > 0);
const { chromium } = require(path.join(root, 'runtime', 'packages', 'p39'));
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const wire = (value) => JSON.parse(JSON.stringify(value));
const groupsOf = (node) =>
	!node ? [] : node.kind === 'group' ? [node] : [...groupsOf(node.first), ...groupsOf(node.second)];
const receipt = {
	version: 1,
	passed: false,
	at: new Date().toISOString(),
	nativeWindows: true,
	desktopPid,
	cdpPort: port,
	candidateOffset,
	candidateSelection: fixedIds ? 'fixed-ids' : 'visible-offset',
	samples: [],
	modelRequests: 0,
	computerActions: 0,
	guestActions: 0,
	reloads: 0,
	restarts: 0,
	measurement: 'Renderer click capture to visible phases and two animation frames; no latency pass threshold. Successful IPC durations are not emitted by desktop diagnostics.',
};
let browser;
let page;
let before;
let expectedTabs;
let added = [];

async function readState() {
	return page.evaluate(async () => {
		const api = window.namzu;
		if (!api) throw new Error('Native preload API is missing.');
		const workspace = await api.workspace();
		const currentWindow = workspace.layout.windows.find((item) => item.id === workspace.windowId);
		if (!currentWindow) throw new Error('Current window has no workspace.');
		const visit = (node) =>
			!node ? [] : node.kind === 'group' ? [node] : [...visit(node.first), ...visit(node.second)];
		const groups = visit(currentWindow.root);
		const projects = await api.projects();
		const catalogues = await Promise.all(
			projects.filter((item) => item.status === 'ready').map(async (item) => ({
				projectId: item.id,
				rows: await api.conversations(item.id),
			})),
		);
		const conversations = catalogues.flatMap((item) => item.rows);
		const profiles = await api.pals();
		const computers = await Promise.all(
			profiles.map(async (profile) => {
				const computer = await api.palComputer(profile.id);
				if (computer.control?.mode === 'transitioning')
					throw new Error('Pal computer control is transitioning.');
				return {
					id: profile.id,
					status: computer.status,
					generation: computer.generation,
					environmentId: computer.environmentId,
					control: computer.control,
				};
			}),
		);
		const sessions = [];
		for (const group of groups) for (const id of group.tabs) {
			const view = conversations.find((item) => item.id === id);
			if (!view) throw new Error('Open tab is absent from its project catalogue.');
			const history = await api.openConversation(view.projectId, id);
			const thread = history.thread;
			if (
				thread?.running || thread?.responding || thread?.permissions?.length ||
				thread?.queuedItems?.length || thread?.queued?.length || thread?.activeToolIds?.length ||
				thread?.retry?.status === 'running'
			) throw new Error('An open conversation has active, queued, or permission work.');
			const jobs = await api.jobs(id);
			if (!Array.isArray(jobs) || jobs.some((job) => job.status === 'running' || job.recoveryRequired))
				throw new Error('An open conversation has active or recovery work.');
			const draft = await api.draft(id);
			const editor = [...document.querySelectorAll('.composer-input textarea[aria-label="Message Namzu"]')]
				.find((input) => input.closest('[data-workspace-group]')?.dataset.workspaceGroup === group.id);
			if (group.activeTabId === id && (!editor || editor.value !== draft))
				throw new Error('The visible composer is missing or differs from its saved draft.');
			sessions.push({
				id,
				projectId: view.projectId,
				messages: history.messages,
				partial: history.partial,
				thread,
				jobs,
				draft,
				settings: await api.draftSettings(id),
				attachments: await api.attachments(id),
				provider: (await api.providers(view.projectId, id)).selected,
			});
		}
		const sidebar = document.querySelector('#namzu-sidebar');
		const scroll = sidebar?.querySelector('.sidebar-scroll');
		const focusedGroup = groups.find((item) => item.id === currentWindow.focusedGroupId);
		const pane = [...document.querySelectorAll('[data-workspace-group]')]
			.find((item) => item.dataset.workspaceGroup === focusedGroup?.id);
		const transcript = pane?.querySelector('.transcript');
		const visible = (selector) => [...document.querySelectorAll(selector)]
			.some((item) => item.getClientRects().length > 0);
		if (
			visible('[role="dialog"], [role="alert"]') ||
			visible('.pal-computer-view canvas') ||
			document.activeElement?.closest?.('.pal-computer-view') ||
			(document.activeElement?.matches?.('textarea,input,[contenteditable="true"]') &&
				(document.activeElement.value?.length || document.activeElement.isContentEditable))
		) throw new Error('A dialog, alert, computer canvas, or focused editor is active.');
		if (!sidebar || sidebar.inert || !scroll || !focusedGroup || !transcript)
			throw new Error('Recents or the focused conversation is not available for navigation.');
		const presentations = Object.keys(localStorage)
			.filter((key) => key.startsWith('namzu.workspace.presentation:'))
			.sort().map((key) => [key, localStorage.getItem(key)]);
		const recents = [...document.querySelectorAll('.sidebar-recent-list [data-thread-item]')]
			.map((item) => ({ id: item.dataset.sessionId, rect: item.getBoundingClientRect() }))
			.filter((item) => item.rect.width > 0 && item.rect.y >= 0 && item.rect.bottom <= innerHeight)
			.map((item) => item.id);
		return {
			workspace, groups, projects, catalogues, profiles, computers, sessions, recents,
			dom: {
			page: document.querySelector('.workspace')?.dataset.page,
			focusedGroupId: focusedGroup.id,
			activeTabId: focusedGroup.activeTabId,
			sidebarScrollTop: scroll.scrollTop,
			sidebarCollapsed: document.querySelector('.workspace-host')?.dataset.sidebarCollapsed,
			projectDisclosure: [...sidebar.querySelectorAll('.sidebar-project-navigation [aria-expanded]')]
				.map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-expanded')]),
			recentDisclosure: [...sidebar.querySelectorAll('.sidebar-recent-list [aria-expanded]')]
				.map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-expanded')]),
			transcriptScrollTop: transcript.scrollTop,
			transcriptScrollRange: transcript.scrollHeight - transcript.clientHeight,
			selectedRecentId: sidebar.querySelector('.sidebar-recent-list [aria-current="page"]')
				?.closest('[data-thread-item]')?.dataset.sessionId ?? null,
			presentations,
			appearance: localStorage.getItem('namzu.appearance'),
			collapsedPreference: localStorage.getItem('namzu.sidebar-collapsed'),
			focusedElement: document.activeElement?.tagName ?? null,
		},
		};
	});
}

function protectedState(state, originalIds) {
	const originalSessions = state.sessions.filter((item) => originalIds.has(item.id));
	return {
		catalogues: state.catalogues,
		profiles: state.profiles,
		computers: state.computers,
		sessions: originalSessions.map((item) => ({
			id: item.id,
			projectId: item.projectId,
			messages: item.messages,
			partial: item.partial,
			jobs: item.jobs,
			draft: item.draft,
			settings: item.settings,
			attachments: item.attachments,
			provider: item.provider,
			tasks: item.thread?.tasks,
		})),
	};
}

function protectedDigests(state, originalIds) {
	const value = protectedState(state, originalIds);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hash(item)]));
}

function threadFieldDigests(state, originalIds) {
	return state.sessions.filter((item) => originalIds.has(item.id)).map((item) => ({
		id: item.id,
		full: hash(item.thread),
		fields: Object.fromEntries(Object.entries(item.thread ?? {}).map(([key, value]) => [key, hash(value)])),
	}));
}

async function workspace() {
	return page.evaluate(() => window.namzu.workspace());
}

async function focusedGroup() {
	const view = await workspace();
	const win = view.layout.windows.find((item) => item.id === view.windowId);
	return groupsOf(win?.root).find((item) => item.id === win?.focusedGroupId);
}

async function observeClick(id, route) {
	const selector = `.sidebar-recent-list [data-thread-item][data-session-id="${id}"] button`;
	await page.locator(selector).scrollIntoViewIfNeeded();
	await page.evaluate(({ id, route }) => {
		const probe = { id, route, started: null, marks: {}, longTasks: [], done: false, error: null,
			visibilityAtClick: null, focusAtClick: null, visibilityAtPaint: null, focusAtPaint: null };
		let frame;
		const mark = (name) => {
			if (probe.started !== null && probe.marks[name] === undefined)
				probe.marks[name] = performance.now() - probe.started;
		};
		const clean = () => {
			document.removeEventListener('click', start, true);
			mutation.disconnect();
			longTasks?.disconnect();
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
		const sample = () => {
			if (probe.started === null || probe.done) return;
			if ([...document.querySelectorAll('[role="alert"]')].some((item) => item.getClientRects().length)) {
				probe.error = 'Visible application alert during navigation.';
				probe.done = true;
				clean();
				return;
			}
			const row = [...document.querySelectorAll('.sidebar-recent-list [data-thread-item]')]
				.find((item) => item.dataset.sessionId === id);
			if (!row?.querySelector('[aria-current="page"]')) return;
			mark('recentSelectedMs');
			const tab = [...document.querySelectorAll('.conversation-tab[data-tab-id]')]
				.find((item) => item.dataset.tabId === id && item.dataset.active === 'true');
			if (!tab) return;
			mark('tabActiveMs');
			const pane = tab.closest('[data-workspace-group]');
			const transcript = pane?.querySelector('.transcript');
			if (transcript?.getClientRects().length) mark('transcriptVisibleMs');
			if (transcript?.dataset.historyState === 'authoritative') mark('authoritativeMs');
			const editor = pane?.querySelector('.composer-input textarea[aria-label="Message Namzu"]');
			if (transcript?.dataset.historyState === 'authoritative' &&
				transcript.getClientRects().length && editor?.getClientRects().length &&
				!editor.disabled && !editor.readOnly) {
				mark('composerReadyMs');
				requestAnimationFrame(() => requestAnimationFrame(() => {
					mark('paintedMs');
					probe.visibilityAtPaint = document.visibilityState;
					probe.focusAtPaint = document.hasFocus();
					probe.done = true;
					clean();
				}));
			}
		};
		const mutation = new MutationObserver(sample);
		const longTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask')
			? new PerformanceObserver((list) => {
				for (const item of list.getEntries()) if (probe.started !== null && item.startTime >= probe.started)
					probe.longTasks.push({ startMs: item.startTime - probe.started, durationMs: item.duration });
			})
			: null;
		const start = (event) => {
			const row = event.target instanceof Element ? event.target.closest('.sidebar-recent-list [data-thread-item]') : null;
			if (row?.dataset.sessionId !== id) return;
			probe.started = performance.now();
			probe.visibilityAtClick = document.visibilityState;
			probe.focusAtClick = document.hasFocus();
			mutation.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
			longTasks?.observe({ type: 'longtask', buffered: false });
			frame = requestAnimationFrame(function tick() {
				sample();
				if (!probe.done) frame = requestAnimationFrame(tick);
			});
		};
		probe.cleanup = clean;
		window.__namzuRecentsNavigationProbe = probe;
		document.addEventListener('click', start, true);
	}, { id, route });
	const rect = await page.locator(selector).evaluate((item) => {
		const bounds = item.getBoundingClientRect();
		return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom,
			width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
	});
	assert(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 &&
		rect.right <= rect.viewportWidth && rect.bottom <= rect.viewportHeight,
		'Target Recents row is outside the desktop viewport.');
	await page.locator(selector).click();
	await page.waitForFunction(() => window.__namzuRecentsNavigationProbe?.done === true, { timeout: 60_000 });
	const result = await page.evaluate(() => {
		const data = window.__namzuRecentsNavigationProbe;
		data.cleanup();
		delete window.__namzuRecentsNavigationProbe;
		return {
			started: data.started !== null,
			marks: data.marks,
			longTasks: data.longTasks,
			visibilityAtClick: data.visibilityAtClick,
			focusAtClick: data.focusAtClick,
			visibilityAtPaint: data.visibilityAtPaint,
			focusAtPaint: data.focusAtPaint,
			error: data.error,
		};
	});
	assert(result.started && !result.error, result.error ?? 'Recents click was not observed.');
	assert(result.marks.composerReadyMs !== undefined && result.marks.paintedMs !== undefined);
	const group = await focusedGroup();
	assert.equal(group?.activeTabId, id, 'Clicked conversation did not become active.');
	receipt.samples.push({ route, id, ...result });
	return group;
}

async function restore() {
	if (!before || !expectedTabs) return;
	await page.evaluate(() => {
		window.__namzuRecentsNavigationProbe?.cleanup?.();
		delete window.__namzuRecentsNavigationProbe;
	});
	const originalGroup = before.groups[0];
	const current = await focusedGroup();
	assert(current && current.id === originalGroup.id, 'Owning group changed; refusing to restore over another actor.');
	assert.deepEqual(current.tabs.slice(0, originalGroup.tabs.length), originalGroup.tabs,
		'Original tab order changed; refusing to restore over another actor.');
	const extras = current.tabs.slice(originalGroup.tabs.length);
	assert.deepEqual(extras, receipt.candidates.slice(0, extras.length),
		'Tabs changed outside the benchmark; refusing to close another actor’s tab.');
	for (const id of [...extras].reverse()) {
		await page.evaluate(({ groupId, id }) => window.namzu.workspaceAction({
			kind: 'close', groupId, tabId: id,
		}), { groupId: originalGroup.id, id });
	}
	// Put the prior persisted presentation in place before the original tab is shown.
	await page.evaluate((entries) => {
		for (const [key, value] of entries) localStorage.setItem(key, value);
	}, before.dom.presentations);
	const afterClose = await focusedGroup();
	assert.deepEqual(afterClose?.tabs, originalGroup.tabs, 'Closing benchmark tabs did not restore tab order.');
	if (afterClose.activeTabId !== originalGroup.activeTabId)
		await page.evaluate(({ groupId, id }) => window.namzu.workspaceAction({
			kind: 'activate', groupId, tabId: id,
		}), { groupId: originalGroup.id, id: originalGroup.activeTabId });
	await page.waitForFunction((id) =>
		[...document.querySelectorAll('.conversation-tab[data-tab-id]')]
			.some((item) => item.dataset.tabId === id && item.dataset.active === 'true') &&
		[...document.querySelectorAll('[data-workspace-group]')]
			.some((pane) => pane.querySelector('.transcript[data-history-state="authoritative"]') &&
				pane.querySelector('.composer-input textarea[aria-label="Message Namzu"]:not([disabled]):not([readonly])')),
		originalGroup.activeTabId,
		{ timeout: 60_000 },
	);
	await page.evaluate((dom) => {
		const expected = new Map(dom.presentations);
		for (const key of Object.keys(localStorage).filter((key) => key.startsWith('namzu.workspace.presentation:')))
			if (!expected.has(key)) localStorage.removeItem(key);
		for (const [key, value] of expected) localStorage.setItem(key, value);
		const sidebar = document.querySelector('#namzu-sidebar .sidebar-scroll');
		if (sidebar) sidebar.scrollTop = dom.sidebarScrollTop;
		const pane = [...document.querySelectorAll('[data-workspace-group]')]
			.find((item) => item.dataset.workspaceGroup === dom.focusedGroupId);
		const transcript = pane?.querySelector('.transcript');
		if (transcript) transcript.scrollTop = dom.transcriptScrollTop;
		document.activeElement?.blur?.();
	}, before.dom);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function main() {
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap((context) => context.pages())
		.find((candidate) => candidate.url() === new URL(config.url).href);
	assert(page, 'No exact Development renderer page is open.');
	page.setDefaultTimeout(60_000);
	before = await readState();
	assert.equal(before.workspace.layout.windows.length, 1, 'More than one desktop window is open.');
	assert.equal(before.groups.length, 1, 'More than one owning pane is open.');
	assert(!before.workspace.pendingTransfer && !before.workspace.outgoingTransfer && !before.workspace.closingWindow,
		'A workspace transfer or close is pending.');
	assert.equal(before.dom.page, 'chat', 'The focused page is not a conversation.');
	const originalGroup = before.groups[0];
	assert(originalGroup.activeTabId && originalGroup.tabs.length >= 1);
	const originals = new Set(originalGroup.tabs);
	const catalogue = before.catalogues.flatMap((item) => item.rows);
	const candidatePool = (fixedIds ?? before.recents).filter((id) => {
		const view = catalogue.find((item) => item.id === id);
		return view && !view.palId && !originals.has(id);
	});
	const candidateIds = fixedIds ? candidatePool : candidatePool.slice(candidateOffset, candidateOffset + 2);
	assert.equal(candidateIds.length, 2, 'Two visible unopened ordinary Recents rows are required.');
	if (fixedIds) {
		const rendered = await page.locator('.sidebar-recent-list [data-thread-item]')
			.evaluateAll((items) => items.map((item) => item.dataset.sessionId));
		assert(candidateIds.every((id) => rendered.includes(id)), 'A fixed conversation is absent from Recents.');
	}
	receipt.original = {
		windowId: before.workspace.windowId,
		groupId: originalGroup.id,
		activeTabId: originalGroup.activeTabId,
		tabIds: originalGroup.tabs,
		projectCounts: before.catalogues.map((item) => ({ projectId: item.projectId, count: item.rows.length })),
		protectedStateSha256: hash(protectedState(before, originals)),
		protectedDigests: protectedDigests(before, originals),
		threadFieldDigests: threadFieldDigests(before, originals),
		presentationSha256: hash(before.dom.presentations),
		computerStates: before.computers.map((item) => ({ id: item.id, status: item.status, generation: item.generation })),
	};
	receipt.candidates = candidateIds;
	expectedTabs = [...originalGroup.tabs];
	for (const [index, id] of candidateIds.entries()) {
		const group = await observeClick(id, 'first-open');
		assert.deepEqual(group.tabs, [...expectedTabs, id], 'First-open tab placement differed.');
		expectedTabs.push(id);
		added.push(id);
	}
	for (const id of candidateIds) {
		const group = await observeClick(id, 'reopen');
		assert.deepEqual(group.tabs, expectedTabs, 'Reopening a Recents row changed tab order.');
	}
	await restore();
	const after = await readState();
	receipt.final = {
		protectedStateSha256: hash(protectedState(after, originals)),
		protectedDigests: protectedDigests(after, originals),
		threadFieldDigests: threadFieldDigests(after, originals),
		presentationSha256: hash(after.dom.presentations),
		layoutRestored: false,
		presentationsRestored: false,
		protectedStateUnchanged: false,
	};
	assert.deepEqual(wire(after.workspace.layout.windows), wire(before.workspace.layout.windows),
		'Window layout, tab order, focus, or bounds changed.');
	assert.equal(hash(protectedState(after, originals)), hash(protectedState(before, originals)),
		'Protected conversation, project, profile, or computer state changed.');
	assert.equal(hash(after.dom.presentations), hash(before.dom.presentations),
		'Persisted conversation presentations changed.');
	for (const key of ['sidebarScrollTop', 'sidebarCollapsed', 'projectDisclosure', 'recentDisclosure',
		'transcriptScrollTop', 'selectedRecentId', 'appearance', 'collapsedPreference'])
		assert.deepEqual(after.dom[key], before.dom[key], `Presentation changed: ${key}`);
	assert.equal(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim(), String(desktopPid),
		'Desktop PID changed.');
	receipt.final.layoutRestored = true;
	receipt.final.presentationsRestored = true;
	receipt.final.protectedStateUnchanged = true;
	receipt.passed = true;
}

main().catch(async (error) => {
	receipt.error = {
		name: error.name,
		message: error instanceof assert.AssertionError
			? error.message
			: 'Native baseline failed; no application content recorded.',
	};
	process.exitCode = 1;
	if (before && page) {
		try {
			await restore();
			receipt.restorationAfterFailure = 'attempted';
		} catch (restoreError) {
			receipt.restorationAfterFailure = 'failed';
			receipt.restorationError = { name: restoreError.name, message: restoreError.message };
		}
	}
}).finally(async () => {
	if (browser) await browser.close();
	fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
	fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	process.stdout.write(`${JSON.stringify({ passed: receipt.passed, receiptPath, samples: receipt.samples.length,
		error: receipt.error?.message, restorationAfterFailure: receipt.restorationAfterFailure })}\n`);
});
