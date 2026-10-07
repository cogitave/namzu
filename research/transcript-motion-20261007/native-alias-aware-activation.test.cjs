"use strict";
// Pure ownership/seam tests: mocked filesystem only; no native app or restart.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const { test } = require("node:test");
const filename = path.join(__dirname, "native-alias-aware-activation.cjs"), source = fs.readFileSync(filename, "utf8");
const publicId = "01a10870-3735-712c-b746-01bad4c61c55", runtimeId = "01a115b3-72f7-755e-a3f3-54afed5681ff", projectId = "3b950ddf-ba7f-4a6d-bac4-ea5930022f8c", sdkProjectId = "01a103e0-4e58-7294-badb-25b601475a6c";
const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
function fixture() {
	const registry = { version: 1, projects: [{ id: projectId, path: "/chat" }], conversations: [{ view: { id: publicId, projectId, harness: "namzu" }, runtimeSessionId: runtimeId, hasPrompted: true }] };
	const project = { projectId: sdkProjectId, cwd: "/chat", slug: "chat" }, identity = { tenantId: "tenant" };
	const receipt = {}, files = new Map([["/userdata/Namzu/desktop-conversations.json", registry], ["/home/projects/chat/project.json", project], ["/home/identity.json", identity]]);
	const mockedFs = {
		lstatSync: file => ({ isFile: () => files.has(file), isDirectory: () => !files.has(file), isSymbolicLink: () => false, size: files.has(file) ? JSON.stringify(files.get(file)).length : 0 }),
		readFileSync: file => { assert(files.has(file), `Unexpected filesystem read ${file}`); return Buffer.from(JSON.stringify(files.get(file))); },
		realpathSync: file => file,
		existsSync: () => false,
	};
	// Inputs are host-realm fixtures while proof arrays originate in the VM.
	// Compare their JSON value here; the native compiled helper has one realm.
	const portableAssert = Object.assign((...args) => assert(...args), assert, { deepEqual: (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message) });
	const context = { require: name => name === "node:fs" ? mockedFs : name === "node:assert/strict" ? portableAssert : require(name), process: { argv: ["node", filename], env: { APPDATA: "/userdata" } }, console: { log() {} }, __dirname, Buffer, receipt, hash, journalRoot: "/home/projects" };
	vm.runInNewContext(source + "\nglobalThis.methods = { readRuntimeAliases, validateAliasProject, validateAliasedMessageBodies, adaptAliasAwareGuard };", context, { filename });
	const session = { id: publicId, projectId, harness: "namzu", partial: false, messages: [{ role: "user", text: "Hello", time: { at: 1, source: "host" } }, { role: "assistant", messageId: "reply", text: "Ready", time: { at: 2, source: "host" } }] };
	const alias = { publicId, runtimeId, projectId, harness: "namzu", projectCwd: "/chat", projectRoot: "/chat", pal: false };
	const records = [{ type: "session_started", sessionId: runtimeId, projectId: sdkProjectId, cwd: "/chat", tenantId: "tenant" }, { type: "message", sessionId: runtimeId, messageId: "prompt", role: "user", content: { content: "Hello" } }, { type: "message", sessionId: runtimeId, messageId: "reply", role: "assistant", content: { content: "Ready" } }];
	return { methods: context.methods, session, alias, receipt, registry, project, identity, files, captured: { file: `/home/projects/chat/${runtimeId}.jsonl`, records } };
}

test("unique public/runtime ownership comes only from same-project durable registry", () => {
	const f = fixture(), aliases = f.methods.readRuntimeAliases({ sessions: [f.session] });
	assert.equal(aliases[publicId].runtimeId, runtimeId);
	assert.equal(aliases[publicId].projectCwd, "/chat");
	assert.equal(aliases[publicId].projectRoot, "/chat");
	assert(f.receipt.aliasMessageProofs);
	f.methods.readRuntimeAliases({ sessions: [f.session] });
	f.registry.conversations[0].runtimeSessionId = "01a115b3-72f7-755e-a3f3-54afed568100";
	assert.throws(() => f.methods.readRuntimeAliases({ sessions: [f.session] }), /ownership changed/);
});

test("duplicate public IDs, runtime owners, unsafe IDs and cross-engine/project aliases refuse", () => {
	for (const mutate of [
		f => f.registry.conversations.push(structuredClone(f.registry.conversations[0])),
		f => f.registry.conversations.push({ ...structuredClone(f.registry.conversations[0]), view: { ...f.registry.conversations[0].view, id: "01a10870-3735-712c-b746-01bad4c61c00" } }),
		f => { f.registry.conversations[0].runtimeSessionId = "../../foreign"; },
		f => { f.registry.conversations[0].view.id = "__proto__"; f.session.id = "__proto__"; },
		f => { f.registry.conversations[0].view.harness = "claude-code"; },
		f => { f.registry.conversations[0].view.projectId = "3b950ddf-ba7f-4a6d-bac4-ea5930022f00"; },
	]) { const f = fixture(); mutate(f); assert.throws(() => f.methods.readRuntimeAliases({ sessions: [f.session] })); }
});

test("SDK journal session/project/cwd/tenant and exact canonical placement are mandatory", () => {
	const good = fixture(); good.methods.validateAliasProject(good.alias, good.captured);
	for (const mutate of [
		f => { f.captured.records[1].sessionId = "foreign"; },
		f => { delete f.captured.records[0].projectId; },
		f => { f.captured.records[0].projectId = "foreign"; },
		f => { f.captured.records[0].cwd = "/foreign"; },
		f => { f.captured.records[0].tenantId = "foreign"; },
		f => { f.captured.file = `/home/projects/other/chat/${runtimeId}.jsonl`; f.files.set("/home/projects/other/chat/project.json", f.project); },
	]) { const f = fixture(); mutate(f); assert.throws(() => f.methods.validateAliasProject(f.alias, f.captured)); }
});

test("aliased bodies bind exact durable IDs/hash/order; live user ID omission is temporary", () => {
	const f = fixture();
	f.methods.validateAliasedMessageBodies(f.session, f.alias, f.captured, false);
	assert.equal(f.receipt.aliasMessageProofs[publicId][0].messageId, "prompt");
	assert.throws(() => f.methods.validateAliasedMessageBodies(f.session, f.alias, f.captured, true), /temporarily lack/);
	f.session.messages[0].messageId = "prompt";
	f.methods.validateAliasedMessageBodies(f.session, f.alias, f.captured, true);
	assert.equal(f.receipt.aliasMessageProofs[publicId][1].bodySha256, hash("Ready"));
});

test("unknown, changed, reordered, ambiguous and unsupported aliased histories fail closed", () => {
	for (const mutate of [
		f => { f.session.messages[1].text = "Different"; },
		f => { f.session.messages[1].messageId = "foreign"; },
		f => { f.session.messages.reverse(); },
		f => { f.captured.records.push(structuredClone(f.captured.records[1])); },
		f => { f.session.partial = true; },
		f => { f.alias.pal = true; },
		f => { f.captured.records.push({ type: "message_replaced" }); },
	]) { const f = fixture(); mutate(f); assert.throws(() => f.methods.validateAliasedMessageBodies(f.session, f.alias, f.captured, false)); }
});

test("nonaliased ordinary cold history cannot lose a message ID or its exact body", () => {
	const f = fixture(); f.alias.publicId = runtimeId; f.session.id = runtimeId;
	f.session.messages[0].messageId = "prompt";
	f.methods.validateAliasedMessageBodies(f.session, f.alias, f.captured, true);
	f.session.messages[1].messageId = "unknown";
	assert.throws(() => f.methods.validateAliasedMessageBodies(f.session, f.alias, f.captured, true), /durable identity/);
	delete f.session.messages[1].messageId;
	delete f.session.messages[1].time;
	assert.throws(() => f.methods.validateAliasedMessageBodies(f.session, f.alias, f.captured, true), /temporarily lack/);
});

test("pinned inherited adapter compiles alias seams without changing old byte/clock/error gates", () => {
	const adapterFile = path.join(__dirname, "../transcript-search-timing-20261007/native-search-speech-activation.cjs");
	const adapterSource = fs.readFileSync(adapterFile, "utf8");
	assert.equal(hash(adapterSource), "386844195e4c5ef6bc7352917434ba1f5d790eed1226c45e671a1c4510583e8f");
	let compiled;
	class CaptureModule { static _nodeModulePaths() { return []; } _compile(code) { assert.equal(compiled, undefined); compiled = code; } }
	vm.runInNewContext(adapterSource, { require: name => name === "node:module" ? CaptureModule : require(name), process: { argv: ["node", adapterFile, "source", "receipt", "--desktop-only"] }, __dirname: path.dirname(adapterFile), module: {} }, { filename: adapterFile });
	assert(compiled);
	const transformed = fixture().methods.adaptAliasAwareGuard(compiled);
	new vm.Script(transformed);
	for (const preserved of [
		"assert.equal(session.messages.length, 0, 'A nonempty authored conversation journal is missing: ' + session.id);",
		"assert(!message.time, 'Unknown or ambiguous message identity acquired a clock.');",
		"assert.deepEqual(message.time, { at, source: 'journal' }, 'Known journal message clock differs or is missing.');",
		"assert(!stat.isSymbolicLink(), 'Journal scan refuses redirected paths.');",
		"assert(++journalEntries <= 50000, 'Journal scan exceeded its bounded inventory.');",
		"Protected ${key} changed across activation",
	]) assert(transformed.includes(preserved));
	assert(transformed.includes("const captured = found.get(alias.runtimeId);"));
	assert(transformed.includes("previous[alias.runtimeId], 'Durable authored journal changed across activation.'"));
	assert(transformed.includes("if (!record || record.ambiguous || record.role !== message.role)"));
	assert.throws(() => fixture().methods.adaptAliasAwareGuard(compiled.replace("const captured = found.get(session.id);", "const captured = unknown;")), /seam changed/);
});
