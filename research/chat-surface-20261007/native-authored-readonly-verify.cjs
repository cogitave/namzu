"use strict";

// Additive evidence for the failed activation. This only reads the current
// Desktop, its durable SDK journals, and pinned private receipts; it never
// reclassifies the original failure or restores any presentation.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "../..");
const expected = {
	pid: 25184,
	prepareSha: "ef0638562ea3b1ab03589cce4da7e71448452e0c96853cf15175a2082f598263",
	snapshotSha: "0e400d1082948ee6a0916fad70c11924b11f9893c953427906aac5bd686cdaa7",
	failedSha: "b81249199dae85b53cc74649fd6aa0a7c607d111c823453efb4594b0385ce7fe",
	sourceManifestSha: "5df55b80b2fea1d83874cd0e7fa1f0a33879707819bf1e08cdff30407c0a51d3",
};
const names = {
	prepare: "chat-surface-prepare-private-20261007-b5eee10c-3b2a-41ab-aaae-7f8b1ee84250.json",
	snapshot: "chat-surface-before-private-20261007T105804748Z.json",
	failed: "chat-surface-apply-private-20261007-56e534ff-95b7-4529-a567-4632923164b0.json",
};
const sha = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const read = (file, maximum) => {
	const stat = fs.lstatSync(file);
	assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, "A proof input is redirected or oversized.");
	const bytes = fs.readFileSync(file);
	assert(bytes.length <= maximum);
	return bytes;
};
const readPinned = (directory, name, expectedSha, maximum) => {
	const bytes = read(path.join(directory, name), maximum);
	assert.equal(sha(bytes), expectedSha, `Pinned private evidence changed: ${name}`);
	return JSON.parse(bytes);
};
const manifest = directory => {
	const rows = [];
	let entries = 0, totalBytes = 0;
	const visit = relative => {
		for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
			assert(++entries <= 50000, "Payload inventory exceeds its bound.");
			const file = path.join(relative, entry.name), absolute = path.join(directory, file), stat = fs.lstatSync(absolute);
			assert(!stat.isSymbolicLink(), "Payload inventory refuses redirected paths.");
			if (stat.isDirectory()) visit(file);
			else {
				assert(stat.isFile() && stat.size <= 128 * 1024 * 1024);
				totalBytes += stat.size; assert(totalBytes <= 2 * 1024 * 1024 * 1024);
				rows.push({ file: file.replaceAll(path.sep, "/"), hash: sha(read(absolute, 128 * 1024 * 1024)) });
			}
		}
	};
	visit("");
	return rows.sort((a, b) => a.file.localeCompare(b.file));
};
const journalFiles = (directory, runtimeIds) => {
	const found = new Map();
	let entries = 0;
	const visit = (folder, depth) => {
		assert(depth <= 2);
		for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
			assert(++entries <= 50000, "Journal inventory exceeds its bound.");
			const file = path.join(folder, entry.name), stat = fs.lstatSync(file);
			assert(!stat.isSymbolicLink(), "Journal inventory refuses redirected paths.");
			if (stat.isDirectory() && depth < 2) visit(file, depth + 1);
			else if (stat.isFile() && entry.name.endsWith(".jsonl")) {
				const id = entry.name.slice(0, -6);
				if (runtimeIds.has(id)) {
					assert(!found.has(id), "Duplicate SDK journal identity.");
					found.set(id, file);
				}
			}
		}
	};
	visit(directory, 0);
	assert.equal(found.size, runtimeIds.size, "An authored SDK journal is missing.");
	return found;
};
// Match the pinned activation guard's exact digest shapes to bind its private
// after snapshot to the failed receipt without accepting the differing values.
const sessionsDigest = state => sha(state.sessions.map(item => ({
	id: item.id,
	messages: item.messages.map(({ messageId, status, stopReason, time, ...body }) => body),
	partial: item.partial, jobs: item.jobs, draft: item.draft, settings: item.settings,
	attachments: item.attachments,
	provider: { id: item.settings?.choice?.provider ?? item.provider?.id,
		model: item.settings?.choice?.model ?? item.provider?.model },
	tasks: item.thread?.tasks ?? [], tasksNotice: item.thread?.tasksNotice,
	retry: item.thread?.retry, retryNotice: item.thread?.retryNotice,
})));
const presentationDigest = state => sha({
	entries: state.dom.presentations.filter(([key]) => key !== `namzu.workspace.presentation:${state.dom.activeTabId}`),
	appearance: state.dom.appearance, sidebar: state.dom.collapsedPreference, page: state.dom.page,
	sidebarCollapsed: state.dom.sidebarCollapsed,
	transcriptTailDistance: Math.max(0, state.dom.transcriptScrollRange - state.dom.transcriptScrollTop),
});
const journalClock = (records, message) => {
	if (!message.messageId) return undefined;
	let start, final;
	for (const record of records) {
		if (record.messageId !== message.messageId || (record.type !== "message_started" && record.type !== "message")) continue;
		const at = Date.parse(record.ts);
		if (!Number.isFinite(at) || at < 0) continue;
		if (record.type === "message_started") {
			start = { turnId: record.turnId, seq: start?.seq ?? record.seq, at: start?.at ?? at,
				ambiguous: Boolean(start && (start.ambiguous || start.turnId !== record.turnId)) };
		} else if (record.role === "user" || record.role === "assistant") {
			final = { turnId: record.turnId, role: record.role, seq: final?.seq ?? record.seq,
				at: final?.at ?? at, ambiguous: Boolean(final) };
		}
	}
	if (!final || final.ambiguous || final.role !== message.role) return undefined;
	const at = start && !start.ambiguous && start.turnId === final.turnId && start.seq <= final.seq ? start.at : final.at;
	return { at, source: "journal" };
};

if (process.argv.length !== 3 || process.argv[2] !== "--verify-reviewed" ||
	process.env.NAMZU_CHAT_SURFACE_READONLY !== "1") {
	console.log(JSON.stringify({ preparedOnly: true, readOnly: true, expectedPid: expected.pid,
		requires: "NAMZU_CHAT_SURFACE_READONLY=1 and --verify-reviewed on the reviewed native Windows host",
		originalApplyPassed: false, appRestarts: 0, uiActions: 0, modelRequests: 0 }));
} else {
	assert.equal(process.platform, "win32");
	(async () => {
		const dev = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
		const output = path.join(dev, `chat-surface-authored-readonly-private-20261007-${crypto.randomUUID()}.json`);
		const proof = { passed: false, readOnly: true, originalApplyPassed: false, uiActions: 0,
			modelRequests: 0, appRestarts: 0, originalApplyReceipt: names.failed };
		let browser;
		try {
			const pid = () => Number(read(path.join(dev, "desktop.pid"), 128).toString().trim());
			assert.equal(pid(), expected.pid); process.kill(expected.pid, 0);
			const prepared = readPinned(dev, names.prepare, expected.prepareSha, 8 * 1024 * 1024);
			const before = readPinned(dev, names.snapshot, expected.snapshotSha, 32 * 1024 * 1024);
			const failed = readPinned(dev, names.failed, expected.failedSha, 8 * 1024 * 1024);
			assert(prepared.passed && prepared.phase === "prepared");
			assert(!failed.passed && failed.phase === "verify" && failed.journalClocksValidated === true);
			assert.equal(failed.error?.message?.split(/\r?\n/, 1)[0], "Protected presentation changed across activation");
			assert.notEqual(failed.before.presentation, failed.after.presentation);
			assert.notEqual(failed.before.sessions, failed.after.sessions);
			assert.equal(failed.beforePid, prepared.beforePid);
			assert.deepEqual(failed.runtimeAliases, prepared.runtimeAliases);
			assert.deepEqual(failed.aliasMessageProofs, prepared.aliasMessageProofs);
			assert.deepEqual(failed.durableJournals, prepared.durableJournals);
			assert.equal(failed.sourceManifestSha256, expected.sourceManifestSha);
			assert.equal(prepared.sourceManifestSha256, expected.sourceManifestSha);
			assert.equal(failed.cliModuleCopies, 0); assert.equal(failed.sdkCopies, 0);
			assert.equal(failed.before.sessions, prepared.before.sessions);
			assert.equal(before.sessions.length, 4);
			assert.equal(before.sessions.reduce((count, session) => count + session.messages.length, 0), 20);
			const aliasIds = Object.keys(prepared.runtimeAliases), runtimeIds = new Set(aliasIds.map(id => prepared.runtimeAliases[id].runtimeId));
			assert.equal(aliasIds.length, 4); assert.equal(runtimeIds.size, 4);
			assert.equal(Object.keys(prepared.durableJournals).length, 4);
			const stamp = /^dist-before-removal-([0-9TZ]+)$/.exec(failed.backupDirectory)?.[1];
			assert(stamp, "Failed receipt does not identify its private after snapshot.");
			const after = JSON.parse(read(path.join(dev, `removal-after-private-${stamp}.json`), 32 * 1024 * 1024));
			assert.equal(after.sessions.length, 4);
			assert.equal(after.sessions.reduce((count, session) => count + session.messages.length, 0), 20);
			assert.equal(sessionsDigest(before), prepared.before.sessions, "Fresh private before snapshot differs from its receipt.");
			assert.equal(presentationDigest(before), prepared.before.presentation);
			assert.equal(sessionsDigest(after), failed.after.sessions, "Failed private after snapshot differs from its receipt.");
			assert.equal(presentationDigest(after), failed.after.presentation);
			const byId = list => new Map(list.map(session => [session.id, session]));
			const beforeSessions = byId(before.sessions), afterSessions = byId(after.sessions);
			assert.equal(beforeSessions.size, 4); assert.equal(afterSessions.size, 4);
			const devConfig = JSON.parse(read(path.join(dev, "launch.json"), 1024 * 1024));
			assert.equal(sha(read(path.join(dev, "launch.json"), 1024 * 1024)), failed.launchConfigSha256);
			const sourceRows = manifest(path.join(repo, "packages/desktop/dist"));
			const installedRows = manifest(path.join(devConfig.app, "dist"));
			assert.equal(sourceRows.length, 742); assert.deepEqual(installedRows, sourceRows);
			assert.equal(sha(sourceRows), expected.sourceManifestSha);
			assert.equal(sha(read(path.join(devConfig.app, "package.json"), 1024 * 1024)), failed.desktopPackageSha256);
			const cliRoot = path.dirname(devConfig.cli);
			const cliPackage = path.join(path.dirname(cliRoot), "package.json");
			const sdkPackage = fs.realpathSync(path.join(path.dirname(cliRoot), "node_modules", "@namzu", "sdk", "package.json"));
			const sdkRoot = path.join(path.dirname(sdkPackage), "dist");
			assert.equal(sha(manifest(cliRoot)), failed.cliManifestBeforeSha256);
			assert.equal(sha(manifest(sdkRoot)), failed.sdkManifestBeforeSha256);
			assert.equal(sha(read(cliPackage, 1024 * 1024)), failed.cliPackageSha256);
			assert.equal(sha(read(sdkPackage, 1024 * 1024)), failed.sdkPackageSha256);
			const registryFile = path.join(process.env.APPDATA, "Namzu", "desktop-conversations.json");
			const registryBytes = read(registryFile, 48 * 1024 * 1024);
			const registry = JSON.parse(registryBytes);
			assert.equal(registry.version, 1);
			const journalRoot = path.join(process.env.USERPROFILE, ".namzu", "projects");
			assert(fs.lstatSync(journalRoot).isDirectory() && !fs.lstatSync(journalRoot).isSymbolicLink());
			const files = journalFiles(journalRoot, runtimeIds), journals = new Map();
			for (const publicId of aliasIds) {
				const alias = prepared.runtimeAliases[publicId];
				assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(alias.runtimeId));
				const owners = registry.conversations.filter(row => row.view.id === publicId);
				assert.equal(owners.length, 1); assert.equal(owners[0].runtimeSessionId, alias.runtimeId);
				assert.equal(owners[0].view.projectId, alias.projectId);
				assert.equal(owners[0].view.harness ?? "namzu", "namzu");
				assert.equal(owners[0].hasPrompted, true);
				assert.equal(registry.conversations.filter(row => row.runtimeSessionId === alias.runtimeId).length, 1);
				const projects = registry.projects.filter(project => project.id === alias.projectId);
				assert.equal(projects.length, 1); assert.equal(fs.realpathSync(projects[0].path), alias.projectCwd);
				const file = files.get(alias.runtimeId), bytes = read(file, 128 * 1024 * 1024);
				assert.equal(sha(bytes), prepared.durableJournals[alias.runtimeId]);
				const records = bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
				assert(records.every(record => record.sessionId === alias.runtimeId));
				const parent = path.dirname(file), project = JSON.parse(read(path.join(parent, "project.json"), 1024 * 1024));
				assert.equal(fs.realpathSync(project.cwd), alias.projectRoot);
				assert.equal(project.slug, path.basename(parent));
				assert.equal(path.resolve(parent), path.resolve(journalRoot, project.slug));
				const starts = records.filter(record => record.type === "session_started"); assert.equal(starts.length, 1);
				assert.equal(starts[0].projectId, project.projectId); assert.equal(fs.realpathSync(starts[0].cwd), alias.projectCwd);
				journals.set(alias.runtimeId, { bytes, records });
			}
			const portFile = path.join(process.env.APPDATA, "Namzu", "DevToolsActivePort");
			const port = Number(read(portFile, 4096).toString().split(/\r?\n/)[0]);
			assert(Number.isInteger(port) && port > 0 && port < 65536);
			const { chromium } = require(path.join(dev, "runtime/packages/p39"));
			browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
			const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === new URL(devConfig.url).href);
			assert.equal(pages.length, 1);
			const observation = await pages[0].evaluate(async owners => {
				const digest = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, "0")).join("");
				const api = window.namzu; if (!api) throw new Error("Native preload API absent.");
				const initial = await api.workspace();
				const views = [];
				for (const owner of owners) {
					const history = await api.openConversation(owner.projectId, owner.publicId);
					if (history.partial || history.thread?.running || history.thread?.responding || history.thread?.queued?.length ||
						history.thread?.queuedItems?.length || history.thread?.permissions?.length || history.thread?.activeToolIds?.length ||
						history.thread?.retry?.status === "running")
						throw new Error("Current owned conversation is not idle.");
					const jobs = await api.jobs(owner.publicId);
					if (!Array.isArray(jobs) || jobs.some(job => job.status === "running" || job.recoveryRequired))
						throw new Error("Current owned background work is not idle.");
					const messages = [];
					for (const message of history.messages) messages.push({ messageId: message.messageId ?? null,
						role: message.role, bodySha256: await digest(message.text), time: message.time ?? null,
						textPartIdPresent: message.textPartId !== undefined });
					views.push({ publicId: owner.publicId, projectId: owner.projectId, messages });
				}
				const final = await api.workspace();
				const layoutBefore = await digest(JSON.stringify({ windowId: initial.windowId, layout: initial.layout }));
				const layoutAfter = await digest(JSON.stringify({ windowId: final.windowId, layout: final.layout }));
				return { layoutBefore, layoutAfter, views };
			}, aliasIds.map(publicId => ({ publicId, projectId: prepared.runtimeAliases[publicId].projectId })));
			assert.equal(observation.layoutBefore, observation.layoutAfter, "Current workspace changed during read-only observation.");
			const current = new Map(observation.views.map(view => [view.publicId, view]));
			assert.equal(current.size, 4);
			let messages = 0, verifiedClocks = 0, absentClocks = 0, liveToJournal = 0, durableIdsAdded = 0, textPartIdsDropped = 0;
			for (const publicId of aliasIds) {
				const prior = beforeSessions.get(publicId), settled = afterSessions.get(publicId), observed = current.get(publicId), alias = prepared.runtimeAliases[publicId];
				assert(prior && settled && observed);
				assert.equal(prior.projectId, alias.projectId); assert.equal(settled.projectId, alias.projectId); assert.equal(observed.projectId, alias.projectId);
				assert.equal(prior.messages.length, settled.messages.length); assert.equal(settled.messages.length, observed.messages.length);
				for (let index = 0; index < observed.messages.length; index++) {
					const old = prior.messages[index], saved = settled.messages[index], actual = observed.messages[index];
					assert.equal(old.role, saved.role); assert.equal(saved.role, actual.role);
					assert.equal(sha(old.text), sha(saved.text)); assert.equal(sha(saved.text), actual.bodySha256);
					if (old.messageId) assert.equal(saved.messageId, old.messageId);
					if (saved.messageId) assert.equal(actual.messageId, saved.messageId);
					if (!old.messageId && actual.messageId) durableIdsAdded++;
					if (old.textPartId !== undefined && saved.textPartId === undefined) textPartIdsDropped++;
					const knownClock = journalClock(journals.get(alias.runtimeId).records, actual);
					assert.deepEqual(actual.time, saved.time ?? null, "Current public clock changed since the failed receipt snapshot.");
					if (knownClock) { assert.deepEqual(actual.time, knownClock); verifiedClocks++; }
					else { assert.equal(actual.time, null, "Unknown journal identity acquired an unsupported clock."); absentClocks++; }
					if (old.time?.source === "host" && actual.time?.source === "journal") liveToJournal++;
					messages++;
				}
			}
			assert.equal(messages, 20);
			assert.equal(sha(read(registryFile, 48 * 1024 * 1024)), sha(registryBytes), "Runtime ownership changed during observation.");
			for (const publicId of aliasIds) {
				const alias = prepared.runtimeAliases[publicId], journal = journals.get(alias.runtimeId);
				assert.equal(sha(read(files.get(alias.runtimeId), 128 * 1024 * 1024)), sha(journal.bytes));
			}
			assert.equal(pid(), expected.pid);
			proof.passed = true;
			proof.authoredOwners = aliasIds.length; proof.authoredMessages = messages; proof.authoredJournals = journals.size;
			proof.verifiedJournalClocks = verifiedClocks; proof.honestlyAbsentClocks = absentClocks;
			proof.liveToJournalClocks = liveToJournal; proof.durableIdsAdded = durableIdsAdded; proof.textPartIdsDropped = textPartIdsDropped;
			proof.currentLayoutUnchangedDuringRead = true; proof.desktopFiles = sourceRows.length;
			proof.installedDesktopByteExact = true; proof.installedCliSdkPayloadByteExact = true;
			proof.originalApplyFailedAtProtectedPresentation = failed.error?.message?.split(/\r?\n/, 1)[0] === "Protected presentation changed across activation";
			proof.originalPresentationDigestsDiffer = failed.before.presentation !== failed.after.presentation;
			proof.originalSessionsDigestsDiffer = failed.before.sessions !== failed.after.sessions;
			proof.failedReceiptSha256 = expected.failedSha; proof.prepareReceiptSha256 = expected.prepareSha;
			proof.beforeSnapshotSha256 = expected.snapshotSha; proof.helperSha256 = sha(read(__filename, 128 * 1024));
			proof.scope = "Additive authored content/journal/clock/payload proof only. The original activation remains failed; presentation drift is not accepted or restored.";
		} catch (error) {
			proof.error = { name: error.name, message: error.message };
			process.exitCode = 1;
		} finally {
			if (browser) await browser.close();
			fs.writeFileSync(output, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600, flag: "wx" });
			console.log(JSON.stringify({ passed: proof.passed, readOnly: true, originalApplyPassed: false,
				authoredOwners: proof.authoredOwners ?? null, authoredMessages: proof.authoredMessages ?? null,
				authoredJournals: proof.authoredJournals ?? null, verifiedJournalClocks: proof.verifiedJournalClocks ?? null,
				installedDesktopByteExact: proof.installedDesktopByteExact ?? false,
				installedCliSdkPayloadByteExact: proof.installedCliSdkPayloadByteExact ?? false,
				currentLayoutUnchangedDuringRead: proof.currentLayoutUnchangedDuringRead ?? false,
				privateReceipt: path.basename(output), errorType: proof.error?.name }));
		}
	})().catch(error => { console.error(JSON.stringify({ passed: false, readOnly: true, errorType: error.name })); process.exitCode = 1; });
}
