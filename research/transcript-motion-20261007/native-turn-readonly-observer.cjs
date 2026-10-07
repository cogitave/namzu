"use strict";

// Attach to the already running native renderer. Read only: never launch,
// focus, click, navigate, send, approve, hydrate a conversation, or read bodies.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const OBSERVE_MS = 10000;
const MAX_STATES = 512;
const MAX_EVENTS = 2048;
assert.equal(process.argv.length, 2, "This observer has no mutation or provider options.");
assert.equal(process.platform, "win32");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const bounded = (file, maximum) => {
	const stat = fs.lstatSync(file);
	assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum);
	return fs.readFileSync(file);
};

(async () => {
	const dev = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const config = JSON.parse(bounded(path.join(dev, "launch.json"), 1024 * 1024));
	const pid = Number(bounded(path.join(dev, "desktop.pid"), 128).toString().trim());
	assert(Number.isSafeInteger(pid) && pid > 0);
	process.kill(pid, 0);
	const port = Number(bounded(path.join(process.env.APPDATA, "Namzu", "DevToolsActivePort"), 4096).toString().split(/\r?\n/)[0]);
	assert(Number.isInteger(port) && port > 0 && port < 65536);
	const { chromium } = require(path.join(dev, "runtime/packages/p39"));
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
	let page;
	try {
		const pages = browser.contexts().flatMap(context => context.pages()).filter(candidate => candidate.url() === new URL(config.url).href);
		assert.equal(pages.length, 1, "Existing native renderer is ambiguous or unavailable.");
		page = pages[0];
		const result = await page.evaluate(async ({ observeMs, maxStates, maxEvents }) => {
			const api = window.namzu;
			if (!api?.workspace || !api.onEvent) throw new Error("Existing native observer bridge is missing.");
			const workspace = await api.workspace();
			const visit = node => !node ? [] : node.kind === "group" ? [node] : [...visit(node.first), ...visit(node.second)];
			const win = workspace.layout.windows.find(item => item.id === workspace.windowId);
			const owner = visit(win?.root).find(group => group.id === win.focusedGroupId);
			if (!owner?.activeTabId) throw new Error("There is no focused existing conversation.");
			const pane = [...document.querySelectorAll("[data-workspace-group]")].find(item => item.dataset.workspaceGroup === owner.id);
			if (!pane?.querySelector(".normal-transcript")) throw new Error("The focused pane is not an ordinary transcript.");
			const origin = performance.now();
			const state = { navigationChanged: false, domTruncated: false, eventsTruncated: false };
			const dom = [], events = [];
			let last = "", stopped = false;
			const observedClock = () => ({ observedAt: Date.now(), elapsedMs: performance.now() - origin });
			const visible = item => Boolean(item?.getClientRects().length && getComputedStyle(item).visibility !== "hidden" && !item.closest('[aria-hidden="true"], [inert]'));
			const recordClock = item => {
				const clock = item?.querySelector("time");
				return { datetime: clock?.dateTime ?? null, source: clock?.title ?? null, visible: visible(clock), opacity: clock ? getComputedStyle(clock).opacity : null };
			};
			const capture = reason => {
				if (stopped || state.navigationChanged) return;
				const current = pane.querySelector(".conversation-tab[data-active='true']")?.dataset.tabId;
				if (!pane.isConnected || current !== owner.activeTabId) { state.navigationChanged = true; return; }
				const transcript = pane.querySelector(".normal-transcript");
				const output = transcript?.querySelector("output.working");
				const activity = [...(transcript?.querySelectorAll("[data-activity-turn]") ?? [])].slice(-32).map(item => {
					const header = item.querySelector(":scope > .activity-trigger");
					return { turn: item.dataset.activityTurn, label: header?.getAttribute("aria-label") ?? null, expanded: header?.getAttribute("aria-expanded") ?? null, visible: visible(header), clock: recordClock(header) };
				});
				const tools = [...(transcript?.querySelectorAll("[data-tool-call-id]") ?? [])].slice(-128).map(item => ({ id: item.dataset.toolCallId, state: item.dataset.toolState ?? null, label: item.querySelector(".tool-label")?.textContent?.trim().slice(0, 128) ?? null, visible: visible(item), clock: recordClock(item), duration: item.querySelector(".tool-duration")?.getAttribute("aria-label") ?? null }));
				const nested = [...(transcript?.querySelectorAll(".tool-label") ?? [])].filter(item => item.textContent?.trim() === "Actions completed");
				const snapshot = {
					activity, tools,
					phase: output?.dataset.transcriptPhase ?? null,
					phaseLabel: output?.getAttribute("aria-label") ?? null,
					phaseVisible: visible(output) && !output?.classList.contains("transcript-status-only"),
					duplicateNestedHeaders: { total: nested.length, visible: nested.filter(visible).length },
					commentaryCount: transcript?.querySelectorAll('.message[data-message-phase="commentary"]').length ?? 0,
					reasoningCount: transcript?.querySelectorAll("[data-reasoning-id]").length ?? 0,
					visibleFinalAnswersOutsideDisclosure: [...(transcript?.querySelectorAll(".message.assistant:not(.commentary)") ?? [])].filter(item => !item.closest("[data-activity-turn]") && visible(item)).length,
					historyState: pane.querySelector(".transcript")?.dataset.historyState ?? null
				};
				const encoded = JSON.stringify(snapshot);
				if (encoded === last && reason !== "initial" && reason !== "final") return;
				last = encoded;
				if (dom.length === maxStates) { state.domTruncated = true; return; }
				dom.push({ ...observedClock(), reason, ...snapshot });
			};
			const unsubscribe = api.onEvent(event => {
				const sessionId = event.kind === "permission" ? event.request?.sessionId : event.sessionId;
				if (stopped || sessionId !== owner.activeTabId) return;
				const row = { ...observedClock(), kind: event.kind, hostAt: event.at ?? null, revision: event.revision ?? null };
				if (event.kind === "state") Object.assign(row, { running: event.running, error: Boolean(event.error), queuedCount: event.queued?.length ?? 0 });
				if (event.kind === "update") Object.assign(row, { updateKind: event.update.kind, status: event.update.status, phase: event.update.phase, toolCallId: event.update.toolCallId, durationMs: event.update.durationMs, viewKind: event.update.view?.kind });
				if (events.length === maxEvents) state.eventsTruncated = true;
				else events.push(row);
				capture("native-event");
			});
			const mutation = new MutationObserver(() => capture("dom-mutation"));
			mutation.observe(pane, { subtree: true, childList: true, attributes: true, characterData: true });
			capture("initial");
			// Observation duration only; elapsed wall time never decides a pass/fail.
			await new Promise(resolve => setTimeout(resolve, observeMs));
			capture("final");
			stopped = true; mutation.disconnect(); unsubscribe();
			const finalWorkspace = await api.workspace();
			const finalWin = finalWorkspace.layout.windows.find(item => item.id === finalWorkspace.windowId);
			const finalOwner = visit(finalWin?.root).find(group => group.id === finalWin.focusedGroupId);
			return { owner: { groupId: owner.id, sessionId: owner.activeTabId }, finalOwner: { groupId: finalOwner?.id ?? null, sessionId: finalOwner?.activeTabId ?? null }, elapsedMs: performance.now() - origin, state, events, dom };
		}, { observeMs: OBSERVE_MS, maxStates: MAX_STATES, maxEvents: MAX_EVENTS });
		const receipt = { schema: "namzu.native-readonly-turn-observation.v1", at: new Date().toISOString(), nativePid: pid, observerSha256: sha(fs.readFileSync(__filename)), readOnly: true, uiActions: 0, providerRequests: 0, bodyReads: 0, observationMs: OBSERVE_MS, limits: ["Only the originally focused conversation DOM and its own events are observed.", "No Thinking phase or clock precision is inferred if it was not actually observed.", "Tool labels and clocks are private; message, reasoning, input and result bodies are not captured.", "Ten-second observation can start after a turn settled; absence of a phase is inconclusive."], ...result };
		const directory = path.join(dev, `transcript-observer-private-${crypto.randomUUID()}`);
		fs.mkdirSync(directory);
		const file = path.join(directory, "receipt.json");
		fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
		console.log(JSON.stringify({ readOnly: true, uiActions: 0, providerRequests: 0, bodyReads: 0, domStates: result.dom.length, nativeEvents: result.events.length, navigationChanged: result.state.navigationChanged || result.owner.sessionId !== result.finalOwner.sessionId || result.owner.groupId !== result.finalOwner.groupId, phasesObserved: [...new Set(result.dom.map(row => row.phase).filter(Boolean))], workLabelsObserved: [...new Set(result.dom.flatMap(row => row.activity.map(item => item.label).filter(label => /^(Worked|Working) for/.test(label ?? ""))))], duplicateNestedHeadersObserved: result.dom.some(row => row.duplicateNestedHeaders.visible > 0), privateReceipt: file }));
	} finally { if (page) await page.evaluate(() => undefined).catch(() => {}); await browser.close(); }
})().catch(error => { console.error(JSON.stringify({ readOnly: true, observerFailed: true, errorType: error.name })); process.exitCode = 1; });
