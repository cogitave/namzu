"use strict";

// PREPARED ONLY: the owner runs this after guarded native activation.
// Attach to the existing app; never launch, restart, install, change global
// policy, invoke an API send, approve tools, or remove a durable conversation.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROMPT =
	"Kısa bir salt okunur deneme yapalım. Yalnızca resmi OpenAI kaynaklarında web araması yaparak Codex'in ne olduğunu doğrula ve kaynak bağlantısını ver. Ardından bu sohbetin mevcut çalışma klasörünü değiştirmeden yalnızca konumunu oku ve klasörün adını söyle. Dosya oluşturma veya değiştirme, uygulama kurma, başka projelere ya da Pal'lere erişme. En fazla bir web araması ve bir salt okunur klasör-konumu okuması yap. Gerekli araç yoksa veya izin gerekiyorsa dürüstçe belirt; başka bir modele geçme. Sonucu Türkçe, en fazla üç kısa cümleyle yaz.";
const MAX_WAIT_MS = 180000;
const MAX_SESSIONS = 1000;
const MAX_EVENTS = 4096;
const MAX_DOM_STATES = 2048;
const flags = process.argv.slice(2);
assert(flags.every(flag => flag === "--execute" || flag.startsWith("--chat-project-id=")), "Unknown proof option.");
assert(flags.filter(flag => flag === "--execute").length <= 1);
assert(flags.filter(flag => flag.startsWith("--chat-project-id=")).length <= 1);
const expectedProjectId = flags.find(flag => flag.startsWith("--chat-project-id="))?.slice("--chat-project-id=".length);
assert(expectedProjectId === undefined || (expectedProjectId.length > 0 && expectedProjectId.length <= 256));

if (!flags.includes("--execute") || process.env.NAMZU_NATIVE_LIVE_PROOF !== "1") {
	console.log(JSON.stringify({ preparedOnly: true, requires: "NAMZU_NATIVE_LIVE_PROOF=1 and --execute after reviewed activation", prompts: 1, engine: "namzu", provider: "zen", model: "space-bunny-free", permissions: "Ask first", approvals: 0, existingAppOnly: true, paidFallbacks: 0, prompt: PROMPT }, null, 2));
} else {
	// Defer until all declarations below have initialized; this is not a retry.
	Promise.resolve().then(run).catch(error => {
		// Error payloads and private profile paths belong only in the private receipt.
		console.error(JSON.stringify({ passed: false, errorType: error.name, nativeProofFailed: true }));
		process.exitCode = 1;
	});
}

const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest("hex");
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	return value;
}
const byId = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const groups = node => !node ? [] : node.kind === "group" ? [node] : [...groups(node.first), ...groups(node.second)];
const selector = (attribute, value) => `[${attribute}=${JSON.stringify(value)}]`;
function boundedFile(file, maxBytes) {
	const stat = fs.lstatSync(file);
	assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, "A bounded input is redirected or oversized.");
	const bytes = fs.readFileSync(file);
	assert(bytes.length <= maxBytes);
	return bytes;
}
function voiceHashes() {
	const directory = path.join(process.env.APPDATA, "Namzu", "local-speech");
	return Object.fromEntries(["settings.json", "installation.json"].map(name => {
		const file = path.join(directory, name);
		return [name, fs.existsSync(file) ? hash(boundedFile(file, 1024 * 1024)) : null];
	}));
}
function journalHashes(sessions) {
	const ids = new Set(sessions.filter(row => row.harness === "namzu").map(row => row.id));
	const root = path.join(process.env.USERPROFILE, ".namzu", "projects");
	const found = {};
	if (!fs.existsSync(root)) {
		assert(sessions.every(row => row.harness !== "namzu" || row.palId || row.messageCount === 0), "The authored journal root is unavailable.");
		return found;
	}
	const rootStat = fs.lstatSync(root);
	assert(rootStat.isDirectory() && !rootStat.isSymbolicLink());
	let entries = 0;
	let bytesRead = 0;
	function visit(directory, depth) {
		assert(depth <= 2);
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			assert(++entries <= 50000, "Journal inventory exceeds the proof bound.");
			const file = path.join(directory, entry.name);
			const stat = fs.lstatSync(file);
			assert(!stat.isSymbolicLink(), "Journal inventory refuses redirected paths.");
			if (stat.isDirectory()) {
				if (depth < 2) visit(file, depth + 1);
			} else if (stat.isFile() && entry.name.endsWith(".jsonl")) {
				const id = entry.name.slice(0, -6);
				if (!ids.has(id)) continue;
				assert(!Object.hasOwn(found, id), "An authored journal has ambiguous ownership.");
				const bytes = boundedFile(file, 128 * 1024 * 1024);
				assert((bytesRead += bytes.length) <= 256 * 1024 * 1024, "Authored journal inventory exceeds the proof bound.");
				assert(bytes.toString("utf8").split(/\r?\n/).filter(Boolean).some(line => {
					const record = JSON.parse(line);
					return record.type === "session_started" && record.sessionId === id;
				}), "Journal identity differs from its filename.");
				found[id] = hash(bytes);
			}
		}
	}
	visit(root, 0);
	for (const row of sessions) if (row.harness === "namzu" && !row.palId && row.messageCount > 0)
		assert(Object.hasOwn(found, row.id), "A nonempty ordinary authored journal is missing.");
	return found;
}

async function run() {
	assert.equal(process.platform, "win32", "This proof attaches only to the existing Windows app.");
	const development = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const config = JSON.parse(boundedFile(path.join(development, "launch.json"), 1024 * 1024));
	const pid = Number(boundedFile(path.join(development, "desktop.pid"), 128).toString("utf8").trim());
	assert(Number.isSafeInteger(pid) && pid > 0);
	process.kill(pid, 0);
	const port = Number(boundedFile(path.join(process.env.APPDATA, "Namzu", "DevToolsActivePort"), 4096).toString("utf8").split(/\r?\n/)[0]);
	assert(Number.isInteger(port) && port > 0 && port < 65536);
	const { chromium } = require(path.join(development, "runtime", "packages", "p39"));
	const receiptId = crypto.randomUUID();
	const receiptDirectory = path.join(development, `transcript-live-private-${receiptId}`);
	fs.mkdirSync(receiptDirectory);
	const receiptFile = path.join(receiptDirectory, "receipt.json");
	const receipt = {
		schema: "namzu.native-live-transcript-proof.v1", receiptId, at: new Date().toISOString(),
		platform: "win32", nativePid: pid, maxPrompts: 1, attemptedPrompts: 0, admittedPrompts: 0,
		provider: "zen", model: "space-bunny-free", harness: "namzu", permissionMode: "prompt",
		approvals: 0, apiSends: 0, appLaunches: 0, appRestarts: 0, installations: 0, paidFallbacks: 0,
		promptSha256: hash(PROMPT), prompt: PROMPT, outcome: "preflight", passed: false,
		limits: ["One task-owned live provider turn only; no automatic permission approval.", "Recorded clocks are actual host/event/DOM observations; a model need not report Thinking.", "Existing UI message/draft/settings/attachment/task/job projections and catalogues are preserved by hashes.", "Available host SDK journals are preserved byte exactly; CLI authentication profiles and Pal guest filesystem journals are never read.", "Motion screenshots may miss a fast phase; DOM observations are reported without inventing a phase."]
	};
	let browser;
	let page;
	let before;
	let own;
	let phase = "connect";
	let thrown;
	function checkpoint() { fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n"); }
	checkpoint();
	try {
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
		const matches = browser.contexts().flatMap(context => context.pages()).filter(candidate => candidate.url() === new URL(config.url).href);
		assert.equal(matches.length, 1, "The existing native renderer is ambiguous or unavailable.");
		page = matches[0];
		page.setDefaultTimeout(15000);
		phase = "protect-existing";
		before = await readProtected(page);
		receipt.privateExpectedWorkspace = structuredClone(before.workspace);
		receipt.protectedBefore = before.digests;
		receipt.protectedSessionCount = before.sessions.length;
		receipt.protectedJournalCount = Object.keys(before.journals).length;
		receipt.privateOriginalWorkspace = before.workspace;
		assert(!before.workspace.pendingTransfer && !before.workspace.outgoingTransfer && !before.workspace.closingWindow);
		const currentWindow = before.workspace.layout.windows.find(row => row.id === before.workspace.windowId);
		assert(currentWindow);
		const originalGroups = groups(currentWindow.root);
		const focused = originalGroups.find(row => row.id === currentWindow.focusedGroupId);
		assert(focused && focused.activeTabId, "A populated focused conversation pane is required.");
		const chatProjects = before.projects.filter(row => row.isChat && row.trusted && row.status === "ready" && !row.palId && (!expectedProjectId || row.id === expectedProjectId));
		assert.equal(chatProjects.length, 1, "A unique ready trusted ordinary chat context is required.");
		const chatProject = chatProjects[0];
		const current = before.sessions.find(row => row.id === focused.activeTabId);
		const anchor = current?.projectId === chatProject.id ? { group: focused, session: current } : originalGroups.flatMap(group => group.tabs.map(id => ({ group, session: before.sessions.find(row => row.id === id) }))).find(row => row.session?.projectId === chatProject.id && !row.session.palId);
		assert(anchor, "Open an existing ordinary chat tab before running this proof; no other project context will be used.");
		await assertExpectedUi(page, receipt.privateExpectedWorkspace, { rejectFocusedDraft: true, sequence: true });
		if (anchor.group.activeTabId !== anchor.session.id || focused.id !== anchor.group.id) {
			receipt.privateExpectedWorkspace = activatedWorkspace(receipt.privateExpectedWorkspace, anchor.group.id, anchor.session.id);
			await tab(page, anchor.group.id, anchor.session.id).click();
			await waitActive(page, anchor.group.id, anchor.session.id);
			await assertExpectedUi(page, receipt.privateExpectedWorkspace, { rejectFocusedDraft: true });
		}
		const pane = page.locator(selector("data-workspace-group", anchor.group.id));
		phase = "new-conversation-ui";
		await pane.getByRole("button", { name: "New conversation tab", exact: true }).click();
		await page.waitForFunction(async ({ groupId, previousIds }) => {
			const view = await window.namzu.workspace();
			const visit = node => !node ? [] : node.kind === "group" ? [node] : [...visit(node.first), ...visit(node.second)];
			const windowView = view.layout.windows.find(item => item.id === view.windowId);
			const group = visit(windowView?.root).find(item => item.id === groupId);
			return group && group.activeTabId && !previousIds.includes(group.activeTabId);
		}, { groupId: anchor.group.id, previousIds: before.sessions.map(row => row.id) });
		const created = await page.evaluate(async projectId => ({ workspace: await window.namzu.workspace(), rows: await window.namzu.conversations(projectId) }), chatProject.id);
		const newRows = created.rows.filter(row => !before.sessions.some(previous => previous.id === row.id));
		assert.equal(newRows.length, 1, "The UI must create exactly one owned ordinary conversation.");
		own = { projectId: chatProject.id, sessionId: newRows[0].id, groupId: anchor.group.id };
		receipt.privateExpectedWorkspace = activatedWorkspace(receipt.privateExpectedWorkspace, own.groupId, own.sessionId, true);
		own.expectedWorkspace = receipt.privateExpectedWorkspace;
		await assertExpectedUi(page, own.expectedWorkspace, { rejectFocusedDraft: true });
		receipt.privateOwnedConversation = own;
		assert(!newRows[0].palId && newRows[0].projectId === chatProject.id);
		await waitActive(page, own.groupId, own.sessionId);
		await pane.getByRole("textbox", { name: "Message Namzu", exact: true }).waitFor({ state: "visible" });
		await page.waitForFunction(groupId => {
			const pane = [...document.querySelectorAll("[data-workspace-group]")].find(item => item.dataset.workspaceGroup === groupId);
			const input = pane?.querySelector('textarea[aria-label="Message Namzu"]');
			const engine = pane?.querySelector('button[aria-label="Execution engine"]');
			return input && !input.disabled && engine && !engine.disabled;
		}, own.groupId);
		const empty = await ownHistory(page, own);
		assert.equal(empty.messages.length, 0);
		assert.equal(await page.evaluate(id => window.namzu.draft(id), own.sessionId), "");
		phase = "select-own-engine-ui";
		await assertOwner(page, own);
		const engine = pane.getByRole("button", { name: "Execution engine", exact: true });
		await engine.click();
		const harnessPopup = page.locator(".harness-picker-popup");
		await harnessPopup.getByRole("radio", { name: "Namzu", exact: true }).click();
		if (await harnessPopup.isVisible()) await page.keyboard.press("Escape");
		const selected = await page.evaluate(({ projectId, sessionId }) => window.namzu.harnesses(projectId, sessionId), own);
		assert.equal(selected.selected, "namzu");
		assert(!selected.locked, "The task-owned empty conversation should not be engine locked.");
		await assertOwner(page, own);
		phase = "select-own-free-model-ui";
		const providers = await page.evaluate(({ projectId, sessionId }) => window.namzu.providers(projectId, sessionId), own);
		const provider = providers.available.find(row => row.id === "zen");
		assert(provider, "Zen is unavailable; no paid provider fallback is allowed.");
		const catalogue = await page.evaluate(({ projectId, sessionId }) => window.namzu.models(projectId, "zen", sessionId), own);
		assert.equal(catalogue.notice, null, "The free model catalogue has an admission notice.");
		const model = catalogue.models.find(row => row.id === "space-bunny-free");
		assert(model && model.label === "Space Bunny Free", "The exact authorized free model is unavailable.");
		await pane.getByRole("button", { name: "Select model", exact: true }).click();
		const picker = page.locator(".model-picker-popup");
		const providerTab = picker.getByRole("tab", { name: provider.label, exact: true });
		if (await providerTab.count()) await providerTab.click();
		else { assert.equal(await picker.getByRole("tab").count(), 0); await picker.locator(".model-provider-single").waitFor({ state: "visible" }); }
		await picker.getByRole("radio", { name: `${provider.label} ${model.label}`, exact: true }).click();
		await page.waitForFunction(async id => { const saved = await window.namzu.draftSettings(id); return saved.choice?.provider === "zen" && saved.choice?.model === "space-bunny-free"; }, own.sessionId);
		if (await picker.isVisible()) await page.keyboard.press("Escape");
		const permissions = pane.getByRole("combobox", { name: "Tool permissions", exact: true });
		assert.equal(await permissions.getAttribute("data-composer-permission"), "prompt", "Keep the default Ask first policy; do not broaden permissions.");
		assert((await permissions.innerText()).includes("Ask first"));
		const draftSettings = await page.evaluate(id => window.namzu.draftSettings(id), own.sessionId);
		assert.equal(draftSettings.choice?.provider, "zen"); assert.equal(draftSettings.choice?.model, "space-bunny-free");
		assert.equal(draftSettings.options?.permissionMode ?? "prompt", "prompt");
		await assertOwner(page, own);
		receipt.freeRouteVerified = true; receipt.askFirstVerified = true;
		phase = "attach-observers";
		await attachProbe(page, own, { maxEvents: MAX_EVENTS, maxDomStates: MAX_DOM_STATES });
		phase = "send-one-human-prompt";
		await pane.getByRole("textbox", { name: "Message Namzu", exact: true }).fill(PROMPT);
		await page.waitForFunction(async ({ sessionId, text }) => await window.namzu.draft(sessionId) === text, { sessionId: own.sessionId, text: PROMPT });
		await assertOwner(page, own);
		const immediatelyBefore = await ownHistory(page, own);
		assert.equal(immediatelyBefore.messages.length, 0);
		await page.evaluate(() => { window.__namzuLiveTranscriptProof.state.sendAttempted = true; window.__namzuLiveTranscriptProof.capture("before-send"); });
		receipt.attemptedPrompts = 1; checkpoint();
		await pane.getByRole("button", { name: "Send message", exact: true }).click();
		await page.waitForFunction(() => { const state = window.__namzuLiveTranscriptProof?.state; return state?.promptCount > 0 || state?.permission || (state?.error && state.running === false); }, undefined, { timeout: MAX_WAIT_MS });
		await capturePane(page, own, receiptDirectory, "after-admission", receipt);
		phase = "await-real-provider-terminal-or-permission";
		try {
			// This is a bounded external provider/UI driver wait, not a test outcome
			// racing machine speed. A timeout is explicitly inconclusive; no retry.
			await page.waitForFunction(() => { const state = window.__namzuLiveTranscriptProof?.state; return state?.permission || (state?.error && state.running === false) || (state?.promptCount === 1 && state.turnEnded && state.running === false); }, undefined, { timeout: MAX_WAIT_MS });
		} catch (error) { if (error.name !== "TimeoutError") throw error; receipt.outcome = "inconclusive-provider-wait"; }
		const probe = await page.evaluate(() => { window.__namzuLiveTranscriptProof.capture("terminal-inspection"); return { state: window.__namzuLiveTranscriptProof.state, events: window.__namzuLiveTranscriptProof.events, dom: window.__namzuLiveTranscriptProof.dom }; });
		receipt.observations = probe; receipt.admittedPrompts = probe.state.promptCount;
		assert(probe.state.promptCount <= 1, "More than one prompt was admitted.");
		const history = await ownHistory(page, own);
		receipt.privateOwnedHistory = history;
		const completedTools = Object.values(history.thread?.tools ?? {}).filter(tool => tool.status === "completed");
		receipt.readOnlyCapabilityEvidence = {
			completedTools: completedTools.map(tool => ({ id: tool.toolCallId, title: tool.title, callView: tool.callView ?? null, resultView: tool.view })),
			webSearchCompleted: completedTools.some(tool => ["Web search", "web_search", "search_web"].includes(tool.title)),
			cwdReadCompleted: completedTools.some(tool => {
				const call = tool.callView ?? tool.view;
				return call.kind === "terminal" && ["pwd", "Get-Location", "cd"].includes(call.command?.trim());
			}),
			classification: "Conservative exact admitted tool title/command matches; inspect task-owned result views for actual findings."
		};
		const actualRoute = await page.evaluate(async ({ projectId, sessionId }) => ({ provider: (await window.namzu.providers(projectId, sessionId)).selected, harness: (await window.namzu.harnesses(projectId, sessionId)).selected, settings: await window.namzu.draftSettings(sessionId) }), own);
		assert.equal(actualRoute.provider?.id, "zen"); assert.equal(actualRoute.provider?.model, "space-bunny-free");
		assert.equal(actualRoute.harness, "namzu");
		assert.equal(actualRoute.settings.choice?.provider, "zen"); assert.equal(actualRoute.settings.choice?.model, "space-bunny-free");
		assert.equal(actualRoute.settings.options?.permissionMode ?? "prompt", "prompt");
		receipt.actualRouteAfter = actualRoute;
		if (probe.state.permission || history.thread?.permissions?.length) receipt.outcome = "manual-readonly-permission-review";
		else if (probe.state.error || history.thread?.error) receipt.outcome = "provider-or-runtime-error";
		else if (probe.state.turnEnded && probe.state.running === false) receipt.outcome = "settled";
		else if (receipt.outcome !== "inconclusive-provider-wait") receipt.outcome = "inconclusive-no-terminal";
		if (receipt.outcome === "settled") {
			assert.equal(history.messages.filter(row => row.role === "user").length, 1);
			assert.equal(history.messages.find(row => row.role === "user")?.text, PROMPT);
			assert(history.messages.some(row => row.role === "assistant" && row.text.trim()), "A settled turn has no assistant answer.");
			await inspectSettled(page, own, receiptDirectory, receipt);
		} else await capturePane(page, own, receiptDirectory, "pending-or-failed", receipt);
		// Stop observing before any existing conversation is made active again.
		await page.evaluate(() => { window.__namzuLiveTranscriptProof.capture("terminal-inspection"); window.__namzuLiveTranscriptProof.dispose(); });
		phase = "restore-original-ui";
		await restoreOriginal(page, before, own, receipt);
		phase = "verify-existing-preserved";
		const after = await readProtected(page, before.sessions.map(row => row.id));
		assert.deepEqual(after.digests, before.digests, "Existing authored data, drafts, model/engine settings or preferences changed.");
		receipt.protectedAfter = after.digests; receipt.existingDataPreserved = true;
		assert.equal(Number(boundedFile(path.join(development, "desktop.pid"), 128).toString("utf8").trim()), pid);
		process.kill(pid, 0);
		receipt.transcriptVerified = receipt.outcome === "settled" && receipt.existingDataPreserved && receipt.originalLayoutRestored;
		receipt.requestedToolsVerified = receipt.readOnlyCapabilityEvidence.webSearchCompleted && receipt.readOnlyCapabilityEvidence.cwdReadCompleted;
		receipt.passed = receipt.transcriptVerified && receipt.requestedToolsVerified;
	} catch (error) {
		thrown = error;
		receipt.failure = { phase, type: error.name, message: error.message };
		if (receipt.outcome === "preflight") receipt.outcome = "preflight-refused";
		else if (receipt.outcome === "settled") receipt.outcome = "verification-failed";
		else receipt.outcome = "inconclusive-driver-failure";
		if (page && before) {
			try { await restoreOriginal(page, before, own, receipt); }
			catch (restoreError) { receipt.restoreFailure = { type: restoreError.name, message: restoreError.message }; }
			try { const after = await readProtected(page, before.sessions.map(row => row.id)); receipt.protectedAfter = after.digests; receipt.existingDataPreserved = hash(after.digests) === hash(before.digests); }
			catch (protectError) { receipt.protectionFailure = { type: protectError.name, message: protectError.message }; }
		}
	} finally {
		if (page) {
			try { const finalProbe = await page.evaluate(() => { const probe = window.__namzuLiveTranscriptProof; if (!probe) return null; probe.capture("dispose"); probe.dispose(); return { state: probe.state, events: probe.events, dom: probe.dom }; }); if (finalProbe) receipt.observations = finalProbe; }
			catch { receipt.observerUnavailableAtDispose = true; }
		}
		receipt.finishedAt = new Date().toISOString(); checkpoint();
		if (browser) await browser.close(); // CDP disconnect; the owned Electron app stays alive.
	}
	console.log(JSON.stringify({ passed: receipt.passed, outcome: receipt.outcome, attemptedPrompts: receipt.attemptedPrompts, admittedPrompts: receipt.admittedPrompts, approvals: 0, apiSends: 0, existingDataPreserved: receipt.existingDataPreserved ?? false, originalLayoutRestored: receipt.originalLayoutRestored ?? false, privateReceipt: receiptFile }));
	if (thrown) throw thrown;
}

function tab(page, groupId, sessionId) { return page.locator(selector("data-workspace-group", groupId)).locator(`${selector("data-tab-id", sessionId)} .conversation-tab-label`); }
async function waitActive(page, groupId, sessionId) {
	await page.waitForFunction(async ({ groupId, sessionId }) => { const view = await window.namzu.workspace(); const visit = node => !node ? [] : node.kind === "group" ? [node] : [...visit(node.first), ...visit(node.second)]; const win = view.layout.windows.find(row => row.id === view.windowId); return win?.focusedGroupId === groupId && visit(win?.root).find(row => row.id === groupId)?.activeTabId === sessionId; }, { groupId, sessionId });
}
async function assertOwner(page, own) {
	// User navigation is a reason to stop, never something this driver waits out.
	await assertExpectedUi(page, own.expectedWorkspace);
	const rows = await page.evaluate(({ projectId }) => window.namzu.conversations(projectId), own);
	const row = rows.find(candidate => candidate.id === own.sessionId);
	assert(row && row.projectId === own.projectId && !row.palId && (row.harness ?? "namzu") === "namzu");
}
async function ownHistory(page, own) { return page.evaluate(({ projectId, sessionId }) => window.namzu.openConversation(projectId, sessionId), own); }

async function readProtected(page, expectedIds) {
	const state = await page.evaluate(async ({ expectedIds, maxSessions }) => {
		const api = window.namzu;
		if (!api?.workspace || !api.onEvent) throw new Error("The required native read/event bridge is missing.");
		const workspace = await api.workspace();
		const focusedDraft = () => {
			const active = document.activeElement;
			return Boolean((active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement && /^(text|search|url|email|number|password|tel)$/.test(active.type)) && active.value.length || active instanceof HTMLElement && active.isContentEditable && active.textContent?.length);
		};
		if (!expectedIds && focusedDraft()) throw new Error("The focused editor contains a user-owned draft; do not take its UI.");
		const visit = node => !node ? [] : node.kind === "group" ? [node] : [...visit(node.first), ...visit(node.second)];
		const openedIds = new Set(workspace.layout.windows.flatMap(win => visit(win.root).flatMap(group => group.tabs)));
		const projects = await api.projects();
		if (projects.length > 128) throw new Error("Project inventory exceeds the proof bound.");
		const catalogues = [];
		for (const project of projects) catalogues.push({ projectId: project.id, rows: await api.conversations(project.id) });
		const rows = catalogues.flatMap(item => item.rows).filter(row => !expectedIds || expectedIds.includes(row.id));
		if (rows.length > maxSessions || (expectedIds && rows.length !== expectedIds.length)) throw new Error("Protected conversation inventory differs or exceeds its bound.");
		const sessions = [];
		let characters = 0;
		for (const row of rows) {
			const history = await api.openConversation(row.projectId, row.id);
			const thread = history.thread;
			if (history.partial) throw new Error("A partial message projection cannot establish exact existing bodies.");
			if (thread?.running || thread?.responding || thread?.permissions?.length || thread?.queued?.length || thread?.queuedItems?.length || thread?.activeToolIds?.length) throw new Error("An existing conversation has active or queued work.");
			// Closed histories can be read without reattaching their execution
			// engines. Do not hydrate a CLI/provider context just to query jobs.
			const jobs = openedIds.has(row.id) ? await api.jobs(row.id) : null;
			if (jobs && (!Array.isArray(jobs) || jobs.some(job => job.status === "running" || job.recoveryRequired))) throw new Error("An existing conversation owns active background work.");
			const draft = await api.draft(row.id);
			if ((characters += draft.length + history.messages.reduce((sum, message) => sum + message.text.length, 0)) > 32 * 1024 * 1024) throw new Error("Protected conversation bodies exceed the proof bound.");
			const editor = [...document.querySelectorAll('textarea[aria-label="Message Namzu"]')].find(input => input.closest("[data-workspace-group]")?.querySelector(`[data-tab-id="${CSS.escape(row.id)}"][data-active="true"]`));
			if (editor && editor.value !== draft) throw new Error("A visible existing draft has not drained to saved state.");
			sessions.push({ id: row.id, projectId: row.projectId, palId: row.palId, harness: row.harness ?? "namzu", messageCount: history.messages.length, messages: history.messages, draft, settings: await api.draftSettings(row.id), attachments: await api.attachments(row.id), jobs, tasks: thread?.tasks, tasksNotice: thread?.tasksNotice, retry: thread?.retry, retryNotice: thread?.retryNotice });
		}
		const speech = api.localSpeechState ? await api.localSpeechState() : null;
		if (speech?.installation === "installing" || ["loading", "speaking"].includes(speech?.worker)) throw new Error("Local speech has active work.");
		const preferences = Object.keys(localStorage).filter(key => key.startsWith("namzu.") && !key.startsWith("namzu.workspace.presentation:")).sort().map(key => [key, localStorage.getItem(key)]);
		const visible = selector => [...document.querySelectorAll(selector)].some(item => item.getClientRects().length > 0);
		if (visible('[role="dialog"], [role="alertdialog"]')) throw new Error("A modal requires its human owner.");
		if (!expectedIds && visible('.pal-computer-view canvas')) throw new Error("The initial computer view is outside this ordinary chat proof.");
		const profiles = await api.pals();
		const finalWorkspace = await api.workspace();
		if (workspace.sequence !== finalWorkspace.sequence || JSON.stringify(workspace.layout.windows) !== JSON.stringify(finalWorkspace.layout.windows) || workspace.windowId !== finalWorkspace.windowId || finalWorkspace.pendingTransfer || finalWorkspace.outgoingTransfer || finalWorkspace.closingWindow) throw new Error("The workspace changed during the protected snapshot; preserve the user's UI.");
		if (!expectedIds && focusedDraft()) throw new Error("The focused editor acquired a user-owned draft during preflight.");
		return { workspace, projects, catalogues: catalogues.map(item => ({ ...item, rows: item.rows.filter(row => !expectedIds || expectedIds.includes(row.id)) })), sessions, profiles, speechSettings: speech?.settings ?? null, preferences };
	}, { expectedIds: expectedIds ?? null, maxSessions: MAX_SESSIONS });
	state.journals = journalHashes(state.sessions);
	state.voiceFiles = voiceHashes();
	state.digests = {
		projects: hash(byId(state.projects)), catalogues: hash([...state.catalogues].sort((a, b) => a.projectId.localeCompare(b.projectId)).map(row => ({ projectId: row.projectId, rows: byId(row.rows) }))),
		sessions: hash(byId(state.sessions)), profiles: hash(byId(state.profiles)), preferences: hash(state.preferences), speechSettings: hash(state.speechSettings), voiceFiles: hash(state.voiceFiles), journals: hash(state.journals)
	};
	return state;
}

async function attachProbe(page, own, bounds) {
	await page.evaluate(({ own, bounds }) => {
		if (window.__namzuLiveTranscriptProof) throw new Error("Another live transcript proof owns this renderer.");
		const pane = [...document.querySelectorAll("[data-workspace-group]")].find(item => item.dataset.workspaceGroup === own.groupId);
		if (!pane) throw new Error("The task-owned pane is missing.");
		const origin = performance.now();
		const state = { sendAttempted: false, promptCount: 0, turnEnded: false, running: null, permission: false, error: false, eventsTruncated: false, domTruncated: false };
		const events = [], dom = [];
		let last = "", disposed = false;
		const visible = item => Boolean(item?.getClientRects().length && getComputedStyle(item).visibility !== "hidden" && !item.closest('[aria-hidden="true"], [inert]'));
		const clock = () => ({ observedAt: Date.now(), elapsedMs: performance.now() - origin });
		const capture = reason => {
			if (disposed) return;
			if (pane.querySelector(".conversation-tab[data-active='true']")?.dataset.tabId !== own.sessionId) return;
			const transcript = pane.querySelector(".normal-transcript");
			const status = transcript?.querySelector("output.working");
			const snapshot = {
				activity: [...(transcript?.querySelectorAll("[data-activity-turn]") ?? [])].map(item => {
					const header = item.querySelector(":scope > .activity-trigger");
					const rect = header?.getBoundingClientRect();
					return { turn: item.dataset.activityTurn, label: header?.getAttribute("aria-label"), expanded: header?.getAttribute("aria-expanded"), visible: visible(header), rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null, clock: header?.querySelector("time")?.dateTime ?? null, clockSource: header?.querySelector("time")?.title ?? null };
				}),
				phase: status?.dataset.transcriptPhase ?? null, phaseLabel: status?.getAttribute("aria-label") ?? null, phaseVisible: visible(status) && !status?.classList.contains("transcript-status-only"),
				tools: [...(transcript?.querySelectorAll("[data-tool-call-id]") ?? [])].map(item => ({ id: item.dataset.toolCallId, state: item.dataset.toolState, label: item.querySelector(".tool-label")?.textContent?.trim(), visible: visible(item), clock: item.querySelector("time")?.dateTime ?? null, clockSource: item.querySelector("time")?.title ?? null, duration: item.querySelector(".tool-duration")?.getAttribute("aria-label") ?? null })),
				commentary: [...(transcript?.querySelectorAll('.message[data-message-phase="commentary"]') ?? [])].map(item => ({ characters: item.textContent?.length ?? 0, visible: visible(item), insideActivity: Boolean(item.closest("[data-activity-turn]")) })),
				answers: [...(transcript?.querySelectorAll(".message.assistant:not(.commentary)") ?? [])].map(item => ({ characters: item.textContent?.length ?? 0, visible: visible(item), outsideActivity: !item.closest("[data-activity-turn]"), clock: item.querySelector("time")?.dateTime ?? null, clockSource: item.querySelector("time")?.title ?? null })),
				reasoningCount: transcript?.querySelectorAll("[data-reasoning-id]").length ?? 0
			};
			const encoded = JSON.stringify(snapshot);
			if (encoded === last && !["before-send", "terminal-inspection", "dispose"].includes(reason)) return;
			last = encoded;
			if (dom.length >= bounds.maxDomStates) { state.domTruncated = true; return; }
			dom.push({ ...clock(), reason, ...snapshot });
		};
		const unsubscribe = window.namzu.onEvent(event => {
			const sessionId = event.kind === "permission" ? event.request.sessionId : event.sessionId;
			if (sessionId !== own.sessionId || disposed) return;
			if (event.kind === "prompt") state.promptCount += 1;
			if (event.kind === "permission") state.permission = true;
			if (event.kind === "state") { state.running = event.running; if (event.error) state.error = true; }
			if (event.kind === "update" && event.update.kind === "turn_ended") state.turnEnded = true;
			const row = { ...clock(), kind: event.kind, hostAt: event.at ?? null, revision: event.revision ?? null };
			if (event.kind === "state") Object.assign(row, { running: event.running, queuedCount: event.queued?.length ?? 0, error: Boolean(event.error) });
			if (event.kind === "permission") row.privatePermission = event.request;
			if (event.kind === "update") { const update = event.update; Object.assign(row, { updateKind: update.kind, status: update.status, phase: update.phase, toolCallId: update.toolCallId, title: update.title, viewKind: update.view?.kind, durationMs: update.durationMs, stopReason: update.stopReason, reason: update.reason, textCharacters: typeof update.text === "string" ? update.text.length : undefined }); }
			if (events.length < bounds.maxEvents) events.push(row); else state.eventsTruncated = true;
			capture("native-event");
		});
		const observer = new MutationObserver(() => capture("dom-mutation"));
		observer.observe(pane, { subtree: true, childList: true, attributes: true, characterData: true });
		window.__namzuLiveTranscriptProof = { state, events, dom, capture, dispose: () => { disposed = true; observer.disconnect(); unsubscribe(); } };
		capture("attached-before-send");
	}, { own, bounds });
}

async function capturePane(page, own, directory, label, receipt) {
	const pane = page.locator(selector("data-workspace-group", own.groupId));
	await pane.screenshot({ path: path.join(directory, `${label}.png`), animations: "allow" });
	const measured = await pane.evaluate(item => {
		const transcript = item.querySelector(".normal-transcript");
		const rect = transcript?.getBoundingClientRect();
		return { capturedAt: Date.now(), transcript: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null, phase: transcript?.querySelector("output.working")?.dataset.transcriptPhase ?? null, activityLabels: [...(transcript?.querySelectorAll(".activity-trigger") ?? [])].map(item => item.getAttribute("aria-label")), motion: (transcript?.getAnimations({ subtree: true }) ?? []).map(animation => { const timing = animation.effect?.getComputedTiming(); return { playState: animation.playState, duration: typeof timing?.duration === "number" ? timing.duration : null, iterations: Number.isFinite(timing?.iterations) ? timing.iterations : "infinite", easing: timing?.easing ?? null }; }).slice(0, 128) };
	});
	(receipt.screenshots ??= []).push({ label, ...measured });
}

async function inspectSettled(page, own, directory, receipt) {
	const pane = page.locator(selector("data-workspace-group", own.groupId));
	const disclosures = pane.locator("[data-activity-turn] > .activity-trigger");
	if (!await disclosures.count()) { receipt.settledActivity = { present: false, reason: "The actual model emitted no public work group." }; await capturePane(page, own, directory, "settled-answer", receipt); return; }
	const last = disclosures.last();
	await assertOwner(page, own);
	assert((await last.getAttribute("aria-label")).startsWith("Worked for"), "The settled real work header does not show Worked for.");
	if (await last.getAttribute("aria-expanded") !== "true") await last.click();
	await finiteMotion(page, own.groupId);
	await capturePane(page, own, directory, "settled-expanded", receipt);
	const expanded = await pane.evaluate(item => ({ answerCount: [...item.querySelectorAll(".normal-transcript .message.assistant:not(.commentary)")].filter(answer => !answer.closest("[data-activity-turn]") && answer.getClientRects().length).length, commentaryCount: item.querySelectorAll('[data-activity-turn] .message[data-message-phase="commentary"]').length, toolCount: item.querySelectorAll("[data-activity-turn] [data-tool-call-id]").length, duplicateNestedHeaders: [...item.querySelectorAll(".tool-label")].filter(label => label.textContent?.trim() === "Actions completed").length }));
	assert(expanded.answerCount > 0, "The final answer is not outside the work disclosure.");
	assert.equal(expanded.duplicateNestedHeaders, 0);
	await assertOwner(page, own);
	await last.click();
	await finiteMotion(page, own.groupId);
	await capturePane(page, own, directory, "settled-collapsed", receipt);
	const collapsed = await pane.evaluate(item => ({ answerCount: [...item.querySelectorAll(".normal-transcript .message.assistant:not(.commentary)")].filter(answer => !answer.closest("[data-activity-turn]") && answer.getClientRects().length).length, visibleHistoricalEntries: [...item.querySelectorAll("[data-activity-turn] .activity-entries")].filter(entries => entries.getClientRects().length && !entries.closest('[aria-hidden="true"], [inert]') && getComputedStyle(entries).visibility !== "hidden").length }));
	assert.equal(collapsed.answerCount, expanded.answerCount, "Closing work hides the final answer.");
	assert.equal(collapsed.visibleHistoricalEntries, 0, "Closed work still displays historical commentary or tools.");
	const probe = await page.evaluate(() => ({ state: window.__namzuLiveTranscriptProof.state, events: window.__namzuLiveTranscriptProof.events, dom: window.__namzuLiveTranscriptProof.dom }));
	assert(!probe.state.eventsTruncated && !probe.state.domTruncated, "The real observation trace exceeded its bound.");
	const nativeStart = probe.events.find(row => row.kind === "prompt");
	const nativeEnd = probe.events.find(row => row.updateKind === "turn_ended");
	const history = await ownHistory(page, own);
	const turn = history.thread?.turns?.[history.thread?.turn];
	receipt.settledActivity = { present: true, header: await last.getAttribute("aria-label"), expanded, collapsed, emittedThinking: probe.events.some(row => ["agent_thought", "agent_thought_chunk"].includes(row.updateKind)), visibleThinking: probe.dom.some(row => row.phase === "thinking" && row.phaseVisible), visibleWorkingHeaders: [...new Set(probe.dom.flatMap(row => row.activity.filter(activity => activity.visible && activity.label?.startsWith("Working for")).map(activity => activity.label)))], nativeObservedDurationMs: nativeStart && nativeEnd ? nativeEnd.observedAt - nativeStart.observedAt : null, hostDurationMs: Number.isFinite(nativeStart?.hostAt) && Number.isFinite(nativeEnd?.hostAt) ? nativeEnd.hostAt - nativeStart.hostAt : null, projectedStartedAt: turn?.startedAt ?? null, projectedEndedAt: turn?.endedAt ?? null, recordedDurationMs: turn?.recordedDurationMs ?? null, tools: Object.values(history.thread?.tools ?? {}).map(tool => ({ id: tool.toolCallId, title: tool.title, status: tool.status, durationMs: tool.durationMs ?? null, startedTime: tool.startedTime ?? null, endedTime: tool.endedTime ?? null })) };
}
async function finiteMotion(page, groupId) {
	await page.evaluate(groupId => { const pane = [...document.querySelectorAll("[data-workspace-group]")].find(item => item.dataset.workspaceGroup === groupId); return Promise.all((pane?.getAnimations({ subtree: true }) ?? []).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); }, groupId);
}
function activatedWorkspace(workspace, groupId, sessionId, append = false) {
	const expected = structuredClone(workspace);
	const win = expected.layout.windows.find(row => row.id === expected.windowId);
	const group = groups(win?.root).find(row => row.id === groupId);
	assert(group, "The planned pane is missing from the driver's expected layout.");
	if (append) { assert(!group.tabs.includes(sessionId)); group.tabs.push(sessionId); }
	else assert(group.tabs.includes(sessionId));
	group.activeTabId = sessionId;
	win.focusedGroupId = groupId;
	return expected;
}
async function assertExpectedUi(page, expected, options = {}) {
	assert(expected, "There is no owned expected UI state.");
	const actual = await page.evaluate(async () => {
		const active = document.activeElement;
		const focusedNonemptyEditor = Boolean((active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement && /^(text|search|url|email|number|password|tel)$/.test(active.type)) && active.value.length || active instanceof HTMLElement && active.isContentEditable && active.textContent?.length);
		return { workspace: await window.namzu.workspace(), focusedNonemptyEditor };
	});
	assert.equal(actual.workspace.windowId, expected.windowId, "The user changed the owning window.");
	assert(!actual.workspace.pendingTransfer && !actual.workspace.outgoingTransfer && !actual.workspace.closingWindow, "The user's workspace has a transfer or close in progress.");
	assert.deepEqual(actual.workspace.layout.windows, expected.layout.windows, "The user navigated or changed tab placement; preserve the actual UI.");
	if (options.sequence) assert.equal(actual.workspace.sequence, expected.sequence, "The workspace changed after the protected snapshot.");
	if (options.rejectFocusedDraft) assert(!actual.focusedNonemptyEditor, "The focused editor contains user-owned input; preserve it.");
}
async function restoreOriginal(page, before, own, receipt) {
	let expected = receipt.privateExpectedWorkspace;
	const retainUserUi = error => {
		receipt.restorationSkippedUnexpectedNavigation = true;
		receipt.restorationSkipReason = error.message;
		receipt.originalLayoutRestored = false;
		if (own && !receipt.ownedTabClosed) receipt.ownedTabRetainedForManualReview = true;
	};
	// A human can navigate/type while the external provider is running. Neither
	// cleanup nor a caught error grants authority to take their UI back.
	try { await assertExpectedUi(page, expected, { rejectFocusedDraft: true }); }
	catch (error) { retainUserUi(error); return; }
	if (own) {
		const history = await ownHistory(page, own);
		const thread = history.thread;
		const idle = !thread?.running && !thread?.responding && !thread?.permissions?.length && !thread?.queued?.length && !thread?.queuedItems?.length && !thread?.activeToolIds?.length;
		if (idle) {
			try { await assertExpectedUi(page, expected, { rejectFocusedDraft: true }); }
			catch (error) { retainUserUi(error); return; }
			const win = expected.layout.windows.find(row => row.id === expected.windowId);
			const location = groups(win?.root).find(group => group.tabs.includes(own.sessionId));
			assert(location && location.id === own.groupId && location.activeTabId === own.sessionId);
			const closed = structuredClone(expected);
			const closedWin = closed.layout.windows.find(row => row.id === closed.windowId);
			const closedGroup = groups(closedWin?.root).find(group => group.id === location.id);
			const index = closedGroup.tabs.indexOf(own.sessionId);
			closedGroup.tabs.splice(index, 1);
			assert(closedGroup.tabs.length, "The owned tab must have an original pane sibling.");
			closedGroup.activeTabId = closedGroup.tabs[Math.min(index, closedGroup.tabs.length - 1)];
			await page.locator(selector("data-workspace-group", location.id)).locator(selector("data-tab-id", own.sessionId)).getByRole("button", { name: /^Close tab / }).click();
			receipt.ownedTabClosed = true;
			expected = closed;
			receipt.privateExpectedWorkspace = expected;
		} else receipt.ownedTabRetainedForManualReview = true;
	}
	const originalWindow = before.workspace.layout.windows.find(row => row.id === before.workspace.windowId);
	for (const group of groups(originalWindow.root)) {
		try { await assertExpectedUi(page, expected, { rejectFocusedDraft: true }); }
		catch (error) { retainUserUi(error); return; }
		const win = expected.layout.windows.find(row => row.id === expected.windowId);
		const actual = groups(win?.root).find(row => row.id === group.id);
		assert(actual && actual.tabs.includes(group.activeTabId), "An existing active tab moved or closed; do not mutate its layout.");
		if (actual.activeTabId !== group.activeTabId) {
			expected = activatedWorkspace(expected, group.id, group.activeTabId);
			receipt.privateExpectedWorkspace = expected;
			await tab(page, group.id, group.activeTabId).click(); await waitActive(page, group.id, group.activeTabId);
		}
	}
	const focused = groups(originalWindow.root).find(row => row.id === originalWindow.focusedGroupId);
	try { await assertExpectedUi(page, expected, { rejectFocusedDraft: true }); }
	catch (error) { retainUserUi(error); return; }
	const expectedWin = expected.layout.windows.find(row => row.id === expected.windowId);
	if (focused && expectedWin.focusedGroupId !== focused.id) {
		expected = activatedWorkspace(expected, focused.id, focused.activeTabId);
		receipt.privateExpectedWorkspace = expected;
		await tab(page, focused.id, focused.activeTabId).click(); await waitActive(page, focused.id, focused.activeTabId);
	}
	try { await assertExpectedUi(page, expected, { rejectFocusedDraft: true }); }
	catch (error) { retainUserUi(error); return; }
	const restored = await page.evaluate(() => window.namzu.workspace());
	const layout = value => value.layout.windows.map(win => ({ ...win, root: prune(win.root) }));
	function prune(node) { if (!node) return node; if (node.kind === "group") return { ...node, tabs: node.tabs.filter(id => id !== own?.sessionId) }; return { ...node, first: prune(node.first), second: prune(node.second) }; }
	assert.deepEqual(layout(restored), layout(before.workspace), "Existing tab placement, order, focus or layout changed.");
	receipt.originalLayoutRestored = !receipt.ownedTabRetainedForManualReview;
	receipt.existingTabOrderAndFocusRestored = true;
}
