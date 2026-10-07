"use strict";
// Observe only the two previously authored SDK histories. No readyConversation,
// settings, job calls, prompts, focus/navigation, renderer writes or restart.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const sha = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const read = (file, bound) => { const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= bound); const bytes = fs.readFileSync(file); assert(bytes.length <= bound); return bytes; };
if (process.argv.length !== 3 || process.argv[2] !== "--observe-existing") {
	console.log(JSON.stringify({ preparedOnly: true, readOnly: true, requires: "Native owner --observe-existing", expectedPid: 16492, authoredSessions: 2, uiActions: 0, providerRequests: 0 }));
} else {
	assert.equal(process.platform, "win32");
	(async () => {
		const dev = path.join(process.env.LOCALAPPDATA, "Namzu", "Development"), config = JSON.parse(read(path.join(dev, "launch.json"), 1024 * 1024));
		const output = path.join(dev, `transcript-authored-final-readonly-private-${crypto.randomUUID()}.json`);
		const receipt = { passed: false, readOnly: true, uiActions: 0, providerRequests: 0, restartActions: 0, originalApplyPassed: false, supplementalVerifierExecuted: false, expectedPid: 16492 };
		let browser;
		try {
			const assertPid = () => { assert.equal(Number(read(path.join(dev, "desktop.pid"), 128).toString().trim()), 16492); process.kill(16492, 0); };
			assertPid();
			const oldFile = path.join(dev, "transcript-motion-alias-apply-private-20261007-v1.json"), oldBytes = read(oldFile, 1024 * 1024);
			assert.equal(sha(oldBytes), "6b79f91a1a06d76b3b4bd8efd8e560556832de78a6e3e967a03ee0da29d60c28");
			const old = JSON.parse(oldBytes), publicIds = Object.keys(old.aliasMessageProofs);
			assert.equal(old.passed, false); assert.equal(publicIds.length, 2); assert.equal(Object.keys(old.durableJournals).length, 2);
			const registryFile = path.join(process.env.APPDATA, "Namzu", "desktop-conversations.json"), registry = JSON.parse(read(registryFile, 48 * 1024 * 1024));
			const journals = publicIds.map(publicId => {
				const alias = old.runtimeAliases[publicId]; assert(alias && !alias.pal && alias.harness === "namzu");
				assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(alias.runtimeId));
				const rows = registry.conversations.filter(row => row.view.id === publicId); assert.equal(rows.length, 1);
				const row = rows[0]; assert.equal(row.runtimeSessionId, alias.runtimeId); assert.equal(row.hasPrompted, true);
				assert.equal(row.view.projectId, alias.projectId); assert.equal(row.view.harness ?? "namzu", "namzu"); assert(!row.view.palId);
				assert.equal(registry.conversations.filter(item => item.runtimeSessionId === alias.runtimeId).length, 1);
				const projects = registry.projects.filter(project => project.id === alias.projectId); assert.equal(projects.length, 1);
				assert.equal(fs.realpathSync(projects[0].path), alias.projectCwd);
				const home = path.join(process.env.USERPROFILE, ".namzu"), slug = alias.projectRoot.replace(/[^A-Za-z0-9]/g, "-");
				const directory = path.join(home, "projects", slug);
				for (const folder of [home, path.join(home, "projects"), directory]) { const stat = fs.lstatSync(folder); assert(stat.isDirectory() && !stat.isSymbolicLink()); }
				const project = JSON.parse(read(path.join(directory, "project.json"), 1024 * 1024));
				assert.equal(project.slug, slug); assert.equal(fs.realpathSync(project.cwd), alias.projectRoot);
				const file = path.join(directory, `${alias.runtimeId}.jsonl`), bytes = read(file, 128 * 1024 * 1024);
				assert.equal(sha(bytes), old.durableJournals[alias.runtimeId], "Authored journal changed since original apply.");
				const records = bytes.toString().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
				assert(records.every(record => record.sessionId === alias.runtimeId));
				const started = records.filter(record => record.type === "session_started"); assert.equal(started.length, 1);
				assert.equal(started[0].projectId, project.projectId); assert.equal(fs.realpathSync(started[0].cwd), alias.projectCwd);
				if (started[0].tenantId !== undefined) assert.equal(started[0].tenantId, JSON.parse(read(path.join(home, "identity.json"), 1024 * 1024)).tenantId);
				return { publicId, alias, file, bytes, records, proof: old.aliasMessageProofs[publicId] };
			});
			const port = Number(read(path.join(process.env.APPDATA, "Namzu", "DevToolsActivePort"), 4096).toString().split(/\r?\n/)[0]); assert(Number.isInteger(port) && port > 0 && port < 65536);
			const { chromium } = require(path.join(dev, "runtime/packages/p39"));
			browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
			const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === new URL(config.url).href); assert.equal(pages.length, 1);
			const observation = await pages[0].evaluate(async owners => {
				const digest = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, "0")).join("");
				const api = window.namzu; if (!api) throw new Error("Preload API absent.");
				const before = await api.workspace(), histories = [];
				for (const owner of owners) {
					const history = await api.openConversation(owner.projectId, owner.publicId), messages = [];
					for (const message of history.messages) messages.push({ messageId: message.messageId ?? null, role: message.role,
						bodySha256: await digest(message.text), time: message.time ?? null });
					histories.push({ publicId: owner.publicId, partial: history.partial, running: Boolean(history.thread?.running), messages });
				}
				const after = await api.workspace();
				const layoutBefore = await digest(JSON.stringify({ windowId: before.windowId, layout: before.layout }));
				const layoutAfter = await digest(JSON.stringify({ windowId: after.windowId, layout: after.layout }));
				const groups = node => !node ? [] : node.kind === "group" ? [node] : [...groups(node.first), ...groups(node.second)];
				return { layoutBefore, layoutAfter, currentTabCount: before.layout.windows.flatMap(win => groups(win.root)).reduce((sum, group) => sum + group.tabs.length, 0), histories };
			}, journals.map(row => ({ publicId: row.publicId, projectId: row.alias.projectId })));
			assert.equal(observation.layoutAfter, observation.layoutBefore, "Current human workspace changed during observation.");
			let count = 0;
			receipt.histories = journals.map(journal => {
				const history = observation.histories.find(row => row.publicId === journal.publicId); assert(history && history.partial === false && !history.running);
				const publicRecords = journal.records.filter(record => record.type === "message" && ["user", "assistant"].includes(record.role) && !(record.role === "assistant" && record.content?.content === null && record.content?.toolCalls?.length) && !(record.role === "user" && record.content?.source && !(record.content.source.type === "runtime-context" && record.content.source.kind === "steering")));
				assert.equal(publicRecords.length, history.messages.length); assert.equal(history.messages.length, journal.proof.length);
				const starts = new Map(), messages = new Map();
				for (const record of journal.records) {
					const at = Date.parse(record.ts); if (!Number.isFinite(at) || at < 0) continue;
					if (record.type === "message_started") { const previous = starts.get(record.messageId); starts.set(record.messageId, { turnId: record.turnId, seq: previous?.seq ?? record.seq, at: previous?.at ?? at, ambiguous: Boolean(previous && (previous.ambiguous || previous.turnId !== record.turnId)) }); }
					else if (record.type === "message" && ["user", "assistant"].includes(record.role)) { const previous = messages.get(record.messageId); messages.set(record.messageId, { turnId: record.turnId, role: record.role, seq: previous?.seq ?? record.seq, at: previous?.at ?? at, ambiguous: Boolean(previous) }); }
				}
				for (let index = 0; index < history.messages.length; index++) {
					const actual = history.messages[index], proof = journal.proof[index], durable = publicRecords[index];
					assert.equal(actual.messageId, proof.messageId); assert.equal(actual.role, proof.role); assert.equal(actual.bodySha256, proof.bodySha256);
					assert.equal(durable.messageId, actual.messageId); assert.equal(durable.role, actual.role);
					assert.equal(typeof durable.content?.content, "string"); assert.equal(sha(durable.content.content), actual.bodySha256);
					const record = messages.get(actual.messageId); assert(record && !record.ambiguous && record.role === actual.role);
					const start = starts.get(actual.messageId), at = start && !start.ambiguous && start.turnId === record.turnId && start.seq <= record.seq ? start.at : record.at;
					assert.deepEqual(actual.time, { at, source: "journal" }, "Authored public clock differs from exact durable record.");
					count++;
				}
				assert.equal(sha(read(journal.file, 128 * 1024 * 1024)), sha(journal.bytes), "Authored journal changed during observation.");
				return { publicId: journal.publicId, runtimeId: journal.alias.runtimeId, messageCount: history.messages.length,
					journalSha256: sha(journal.bytes), exactIdsRolesBodiesOrderAndClocks: true, wholeJournalBytesUnchanged: true, messages: history.messages };
			});
			assert.equal(count, 13); assertPid(); assert.equal(sha(read(oldFile, 1024 * 1024)), sha(oldBytes));
			receipt.passed = true; receipt.authoredMessages = count; receipt.authoredJournals = journals.length;
			receipt.currentLayoutSha256 = observation.layoutBefore; receipt.currentLayoutUnchanged = true; receipt.currentTabCount = observation.currentTabCount;
			receipt.originalFailedReceiptSha256 = sha(oldBytes); receipt.helperSha256 = sha(read(__filename, 128 * 1024));
			receipt.scope = "Two authored SDK public owners only; not a full old presentation/group state preservation claim.";
		} catch (error) { receipt.error = { name: error.name, message: error.message }; process.exitCode = 1; }
		finally {
			if (browser) await browser.close();
			fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
			console.log(JSON.stringify({ passed: receipt.passed, readOnly: true, providerRequests: 0, uiActions: 0, restartActions: 0,
				authoredMessages: receipt.authoredMessages ?? null, authoredJournals: receipt.authoredJournals ?? null,
				exactIdsRolesBodiesOrderAndClocks: receipt.passed, wholeJournalBytesUnchanged: receipt.passed,
				currentLayoutUnchanged: receipt.currentLayoutUnchanged ?? false, currentTabCount: receipt.currentTabCount ?? null,
				privateReceipt: path.basename(output), helperSha256: receipt.helperSha256 ?? null,
				originalApplyPassed: false, supplementalVerifierExecuted: false, errorType: receipt.error?.name }));
		}
	})().catch(error => { console.error(JSON.stringify({ passed: false, readOnly: true, errorType: error.name })); process.exitCode = 1; });
}
