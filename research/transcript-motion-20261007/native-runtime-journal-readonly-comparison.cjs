"use strict";
// Exact current Desktop view/runtime journal ownership; never sends or mutates.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const PUBLIC_ID = "01a10870-3735-712c-b746-01bad4c61c55";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const read = (file, bound) => { const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= bound); return fs.readFileSync(file); };
assert.equal(process.platform, "win32");
(async () => {
	const dev = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const config = JSON.parse(read(path.join(dev, "launch.json"), 1024 * 1024));
	const pid = Number(read(path.join(dev, "desktop.pid"), 128).toString().trim()); assert.equal(pid, 35180); process.kill(pid, 0);
	const registryPath = path.join(process.env.APPDATA, "Namzu", "desktop-conversations.json"), registryBytes = read(registryPath, 48 * 1024 * 1024), registry = JSON.parse(registryBytes);
	const aliases = registry.conversations.filter(row => row.view.id === PUBLIC_ID); assert.equal(aliases.length, 1);
	const alias = aliases[0]; assert.equal(alias.view.harness ?? "namzu", "namzu"); assert(alias.hasPrompted);
	assert.equal(registry.conversations.filter(row => row.runtimeSessionId === alias.runtimeSessionId).length, 1);
	const projects = registry.projects.filter(row => row.id === alias.view.projectId); assert.equal(projects.length, 1);
	const home = path.join(process.env.USERPROFILE, ".namzu"), slug = projects[0].path.replace(/[^A-Za-z0-9]/g, "-");
	const projectDir = path.join(home, "projects", slug);
	for (const folder of [home, path.join(home, "projects"), projectDir]) { const stat = fs.lstatSync(folder); assert(stat.isDirectory() && !stat.isSymbolicLink()); }
	const projectBytes = read(path.join(projectDir, "project.json"), 1024 * 1024), project = JSON.parse(projectBytes);
	assert.equal(project.cwd, projects[0].path); assert.equal(project.slug, slug);
	const journalFile = path.join(projectDir, `${alias.runtimeSessionId}.jsonl`), journalBytes = read(journalFile, 128 * 1024 * 1024);
	const records = journalBytes.toString().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
	assert(records.every(row => row.sessionId === alias.runtimeSessionId));
	assert.equal(records.filter(row => row.type === "session_started" && row.sessionId === alias.runtimeSessionId).length, 1);
	const text = content => typeof content === "string" ? content : Array.isArray(content) ? content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
	const publicMessages = records.filter(row => row.type === "message" && ["user", "assistant"].includes(row.role)).map(row => ({ id: row.messageId, role: row.role, textSha256: sha(text(row.content?.content)), textCharacters: text(row.content?.content).length, recordedAt: row.ts, startedAt: records.find(start => start.type === "message_started" && start.messageId === row.messageId)?.ts ?? null }));
	const port = Number(read(path.join(process.env.APPDATA, "Namzu", "DevToolsActivePort"), 4096).toString().split(/\r?\n/)[0]);
	assert(Number.isInteger(port) && port > 0 && port < 65536);
	const { chromium } = require(path.join(dev, "runtime/packages/p39")); const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
	try {
		const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === new URL(config.url).href); assert.equal(pages.length, 1);
		const history = await pages[0].evaluate(async ({ projectId, publicId }) => {
			const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(number => number.toString(16).padStart(2, "0")).join("");
			const api = window.namzu, workspace = await api.workspace();
			const visit = node => !node ? [] : node.kind === "group" ? [node] : [...visit(node.first), ...visit(node.second)];
			const win = workspace.layout.windows.find(row => row.id === workspace.windowId), owner = visit(win?.root).find(group => group.id === win.focusedGroupId);
			if (owner?.activeTabId !== publicId) throw new Error("The user changed the active session; stop readonly comparison.");
			const history = await api.openConversation(projectId, publicId);
			const messages = [];
			for (const row of history.messages) messages.push({ id: row.messageId ?? null, role: row.role, textSha256: await digest(row.text), textCharacters: row.text.length, time: row.time ?? null, phase: row.phase ?? null });
			const final = await api.workspace(), finalWin = final.layout.windows.find(row => row.id === final.windowId), finalOwner = visit(finalWin?.root).find(group => group.id === finalWin.focusedGroupId);
			return { envelopeKeys: Object.keys(history).sort(), partial: history.partial, running: Boolean(history.thread?.running), ownerUnchanged: owner?.id === finalOwner?.id && finalOwner?.activeTabId === publicId, messages };
		}, { projectId: alias.view.projectId, publicId: PUBLIC_ID });
		assert.equal(sha(read(journalFile, 128 * 1024 * 1024)), sha(journalBytes), "Journal changed during readonly comparison.");
		assert.equal(sha(read(registryPath, 48 * 1024 * 1024)), sha(registryBytes), "Desktop registry changed during readonly comparison.");
		const compared = history.messages.map(message => {
			const candidates = message.id ? publicMessages.filter(row => row.id === message.id) : publicMessages.filter(row => row.role === message.role && row.textSha256 === message.textSha256);
			const durable = candidates.length === 1 ? candidates[0] : undefined;
			return { liveMessageId: message.id, durableMessageId: durable?.id ?? null, identityMatchMethod: message.id ? "exact-id" : "unique-role-body-hash-for-live-prompt-without-id", journalMatch: Boolean(durable), roleEqual: durable?.role === message.role, bodyHashEqual: durable?.textSha256 === message.textSha256, bodyCharacters: message.textCharacters, time: message.time, durableRecordedAt: durable?.recordedAt ?? null, durableStartedAt: durable?.startedAt ?? null };
		});
		console.log(JSON.stringify({ readOnly: true, providerRequests: 0, uiActions: 0, publicId: PUBLIC_ID, runtimeId: alias.runtimeSessionId, registrySha256: sha(registryBytes), journalRelativePath: path.relative(home, journalFile), journalSha256: sha(journalBytes), journalBytes: journalBytes.length, recordCount: records.length, publicMessageRecords: publicMessages.length, toolMessageRecords: records.filter(row => row.type === "message" && row.role === "tool").length, projectScopeValidated: true, envelopeKeys: history.envelopeKeys, partial: history.partial, running: history.running, ownerUnchanged: history.ownerUnchanged, messages: compared, exactAllPublicBodyHashesAndIds: !history.partial && history.ownerUnchanged && publicMessages.length === history.messages.length && compared.every(row => row.journalMatch && row.roleEqual && row.bodyHashEqual) }));
	} finally { await browser.close(); }
})().catch(error => { console.error(JSON.stringify({ readOnly: true, failed: true, errorType: error.name, message: error.message })); process.exitCode = 1; });
