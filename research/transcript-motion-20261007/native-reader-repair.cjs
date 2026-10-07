"use strict";
// Restore only the reviewed update's exact current reader position. No draft,
// message, preference, tab, focus, pointer, model or disclosure mutation.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const read = (file, limit) => { const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit); return fs.readFileSync(file); };

if (process.argv.length !== 3 || process.argv[2] !== "--restore-reviewed-reader") {
	console.log(JSON.stringify({ preparedOnly: true, requires: "--restore-reviewed-reader on the reviewed existing Windows process", actionsPerformed: 0 }));
} else (async () => {
	assert.equal(process.platform, "win32");
	const dev = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const pid = Number(read(path.join(dev, "desktop.pid"), 128).toString().trim());
	assert.equal(pid, 16492); process.kill(pid, 0);
	const config = JSON.parse(read(path.join(dev, "launch.json"), 1024 * 1024));
	const activationBytes = read(path.join(dev, "transcript-motion-alias-apply-private-20261007-v1.json"), 4 * 1024 * 1024);
	assert.equal(sha(activationBytes), "6b79f91a1a06d76b3b4bd8efd8e560556832de78a6e3e967a03ee0da29d60c28");
	const activation = JSON.parse(activationBytes);
	assert.equal(activation.passed, false); assert.equal(activation.phase, "verify");
	assert.equal(activation.beforePid, 35180); assert.equal(activation.ownedProcessesConfirmedClosed, true);
	assert.equal(activation.cliModuleCopies, 0); assert.equal(activation.sdkCopies, 0);
	assert(activation.error.message.startsWith("Public/runtime/project ownership changed across activation."));
	for (const name of Object.keys(activation.before)) if (name !== "presentation") assert.equal(activation.before[name], activation.after[name]);
	assert.equal(activation.privateSnapshot, "removal-before-private-20261007T100907852Z.json");
	const snapshotBytes = read(path.join(dev, activation.privateSnapshot), 48 * 1024 * 1024), snapshot = JSON.parse(snapshotBytes);
	assert.equal(sha(snapshotBytes), "1d6bde094241e23bfaf69109b787d6fce314c35bd96ee866987bb257ff4fac06");
	const active = snapshot.sessions.filter(session => session.id === snapshot.dom.activeTabId);
	assert.equal(active.length, 1);
	const { revision: priorRevision, ...priorLayout } = snapshot.workspace.layout;
	assert(Number.isSafeInteger(priorRevision));
	const expected = { groupId: snapshot.dom.focusedGroupId, sessionId: snapshot.dom.activeTabId, projectId: active[0].projectId, range: snapshot.dom.transcriptScrollRange, tail: snapshot.dom.transcriptScrollRange - snapshot.dom.transcriptScrollTop, layout: JSON.stringify(priorLayout) };
	assert.equal(expected.range, 1404); assert.equal(expected.tail, 16);
	// A new authored turn revokes this old update's repair ownership.
	const journalRoot = path.join(process.env.USERPROFILE, ".namzu/projects");
	const found = new Map(); let entries = 0;
	const walk = (directory, depth) => {
		assert(depth <= 2);
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			assert(++entries <= 50000);
			const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
			assert(!stat.isSymbolicLink());
			if (stat.isDirectory()) { if (depth < 2) walk(file, depth + 1); }
			else if (entry.name.endsWith(".jsonl") && Object.hasOwn(activation.durableJournals, entry.name.slice(0, -6))) {
				const id = entry.name.slice(0, -6); assert(!found.has(id)); found.set(id, sha(read(file, 128 * 1024 * 1024)));
			}
		}
	};
	walk(journalRoot, 0);
	assert.deepEqual(Object.fromEntries(found), activation.durableJournals);
	const port = Number(read(path.join(process.env.APPDATA, "Namzu/DevToolsActivePort"), 4096).toString().split(/\r?\n/)[0]);
	const { chromium } = require(path.join(dev, "runtime/packages/p39"));
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	try {
		const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === new URL(config.url).href); assert.equal(pages.length, 1);
		const result = await pages[0].evaluate(async expected => {
			const workspace = await window.namzu.workspace();
			const { revision, ...visibleLayout } = workspace.layout;
			const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
			if (JSON.stringify(canonical(visibleLayout)) !== JSON.stringify(canonical(JSON.parse(expected.layout)))) {
				const paths = [];
				const changes = (before, after, prefix) => {
					if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) return;
					if (before && after && typeof before === "object" && typeof after === "object") for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) changes(before[key], after[key], `${prefix}.${key}`);
					else paths.push({ path: prefix, before: typeof before === "number" ? before : typeof before, after: typeof after === "number" ? after : typeof after });
				};
				changes(JSON.parse(expected.layout), visibleLayout, "layout");
				throw new Error(`Workspace changed; repair no longer owns the reader: ${JSON.stringify(paths)}`);
			}
			// The restart can advance the layout revision. Fence every subsequent
			// await against this current exact revision, as well as all visible fields.
			const currentLayout = JSON.stringify(workspace.layout);
			const pane = [...document.querySelectorAll("[data-workspace-group]")].find(item => item.dataset.workspaceGroup === expected.groupId);
			const current = pane?.querySelector('.conversation-tab[data-active="true"]')?.dataset.tabId;
			const node = pane?.querySelector(".normal-transcript");
			const scroller = pane?.querySelector(".transcript");
			if (current !== expected.sessionId || !node || !scroller) throw new Error("The user selected another view.");
			if (pane.querySelector("output.working[data-transcript-phase]") || [...pane.querySelectorAll('textarea[aria-label="Message Namzu"]')].some(item => item.value.length)) throw new Error("The user has active work or a draft.");
			const range = scroller.scrollHeight - scroller.clientHeight;
			const before = { scrollTop: scroller.scrollTop, range, tail: range - scroller.scrollTop };
			if (range !== expected.range || before.tail !== 0) throw new Error("Reader changed independently of the reviewed restart.");
			let interactions = 0; const changed = () => { interactions++; };
			for (const type of ["pointermove", "pointerdown", "wheel", "keydown", "touchstart", "input"]) document.addEventListener(type, changed, true);
			try {
				const history = await window.namzu.openConversation(expected.projectId, expected.sessionId);
				const thread = history.thread;
				if (history.partial !== false || !thread || thread.running || thread.responding || thread.retry?.status === "running" || ["permissions", "queuedItems", "queued", "activeToolIds", "liveInputs"].some(field => !Array.isArray(thread[field]) || thread[field].length)) throw new Error("Authoritative conversation is not idle.");
				const jobs = await window.namzu.jobs(expected.sessionId);
				if (!Array.isArray(jobs) || jobs.some(job => job.status === "running" || job.recoveryRequired)) throw new Error("Authoritative jobs are not idle.");
				const currentWorkspace = await window.namzu.workspace();
				if (interactions || !pane.isConnected || JSON.stringify(currentWorkspace.layout) !== currentLayout || scroller.scrollTop !== before.scrollTop || scroller.scrollHeight - scroller.clientHeight !== before.range || [...pane.querySelectorAll('textarea[aria-label="Message Namzu"]')].some(item => item.value.length)) throw new Error("Reader changed during authoritative checks.");
				scroller.scrollTop = range - expected.tail;
				await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				const finalWorkspace = await window.namzu.workspace();
				if (interactions || !pane.isConnected || JSON.stringify(finalWorkspace.layout) !== currentLayout) throw new Error("Human input changed during reader restoration.");
				const after = { scrollTop: scroller.scrollTop, range: scroller.scrollHeight - scroller.clientHeight, tail: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop };
				if (after.range !== expected.range || after.tail !== expected.tail) throw new Error("Exact reader position did not restore.");
				return { before, after, interactions, assignments: 1, layoutUnchanged: true, authoritativeIdle: true, scope: "DOM-only tail restoration; no saved follow preference or long-term reader lock claim" };
			} finally { for (const type of ["pointermove", "pointerdown", "wheel", "keydown", "touchstart", "input"]) document.removeEventListener(type, changed, true); }
		}, expected);
		const receipt = { schema: "namzu.native-reader-repair.v1", at: new Date().toISOString(), helperSha256: sha(read(__filename, 1024 * 1024)), passed: true, nativePid: pid, activationReceiptSha256: sha(activationBytes), beforeSnapshotSha256: sha(snapshotBytes), authoredJournalsUnchanged: found.size, providerRequests: 0, inputActions: 0, ...result };
		const file = path.join(dev, `transcript-reader-repair-private-${crypto.randomUUID()}.json`);
		fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
		console.log(JSON.stringify({ passed: true, ...result, privateReceipt: file }));
	} finally { await browser.close(); }
})().catch(error => { console.error(JSON.stringify({ repairFailed: true, error: error.message })); process.exitCode = 1; });
