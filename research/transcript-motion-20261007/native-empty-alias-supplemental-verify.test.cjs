"use strict";
// Deterministic source/authority tests only. No native UI, filesystem writes,
// provider requests, real clocks, restart, or activation are performed.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const { test } = require("node:test");
const filename = path.join(__dirname, "native-empty-alias-supplemental-verify.cjs"), source = fs.readFileSync(filename, "utf8");
const publicId = "01a10c2b-0eb8-7043-b17f-727587393d68", oldRuntimeId = "01a115b3-7290-76e9-aa60-ac5e1a4b3c05", newRuntimeId = "01a115d7-46a9-7302-98b1-1ee72fe75353";
const authoredId = "01a10870-3735-712c-b746-01bad4c61c55", authoredRuntimeId = "01a115b3-72f7-755e-a3f3-54afed5681ff";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
	const alias = { publicId, runtimeId: oldRuntimeId, projectId: "3b950ddf-ba7f-4a6d-bac4-ea5930022f8c", harness: "namzu", projectCwd: "/chat", projectRoot: "/chat", pal: false };
	const authored = { ...alias, publicId: authoredId, runtimeId: authoredRuntimeId };
	const receipt = { runtimeAliases: { [publicId]: copy(alias), [authoredId]: copy(authored) }, aliasMessageProofs: { [authoredId]: [{ messageId: "reply", role: "assistant", bodySha256: "a".repeat(64) }] } };
	const session = { id: publicId, projectId: alias.projectId, harness: "namzu", partial: false, messages: [], thread: { turn: 0, turns: {}, running: false, responding: false, timeline: [], messages: [], tasks: [], tools: {}, reasoning: {}, queued: [], queuedItems: [], liveInputs: [], activeToolIds: [], permissions: [] } };
	const before = { sessions: [copy(session)] }, state = { sessions: [copy(session)] };
	const aliases = { [publicId]: { ...alias, runtimeId: newRuntimeId }, [authoredId]: copy(authored) };
	const registry = { conversations: [{ view: { id: publicId }, runtimeSessionId: newRuntimeId, hasPrompted: false }] };
	const files = new Set();
	const mockedFs = {
		lstatSync: file => ({ isDirectory: () => !file.endsWith(".jsonl"), isFile: () => file.endsWith(".jsonl"), isSymbolicLink: () => false }),
		readdirSync: directory => directory === "/home/projects" ? [{ name: "chat" }] : [...files].map(name => ({ name })),
	};
	const portableAssert = Object.assign((...args) => assert(...args), assert, { deepEqual: (a, b, message) => assert.deepEqual(copy(a), copy(b), message) });
	const context = { require: name => name === "node:fs" ? mockedFs : name === "node:assert/strict" ? portableAssert : require(name), process: { argv: ["node", filename], env: {} }, console: { log() {} }, __dirname, Buffer,
		Object, receipt, before, supplementOriginalJournals: { [authoredRuntimeId]: "b".repeat(64) }, journalRoot: "/home/projects" };
	vm.runInNewContext(source + "\nglobalThis.methods = { verifyRuntimeAliasRotations, adaptEmptyAliasSupplement };", context, { filename });
	return { methods: context.methods, context, receipt, before, state, aliases, registry, files, mockedFs };
}
test("only proved empty unprompted runtime slot rotates while authored proof stays exact", () => {
	const f = fixture(), proof = copy(f.receipt.aliasMessageProofs);
	f.methods.verifyRuntimeAliasRotations(f.state, f.aliases, f.registry);
	assert.equal(f.receipt.runtimeAliases[publicId].runtimeId, newRuntimeId);
	assert.equal(f.receipt.runtimeAliases[authoredId].runtimeId, authoredRuntimeId);
	assert.deepEqual(f.receipt.aliasMessageProofs, proof);
	assert.equal(f.receipt.emptyRuntimeAliasRotations.length, 1);
	assert.equal(f.receipt.emptyRuntimeAliasRotations[0].beforeMessages, 0);
	assert.equal(f.receipt.emptyRuntimeAliasRotations[0].currentHasPrompted, false);
});
test("authored, partial, prompted, turn-bearing and active histories refuse rotation", () => {
	for (const mutate of [
		f => f.before.sessions[0].messages.push({ role: "user", text: "private" }),
		f => f.state.sessions[0].messages.push({ role: "assistant", text: "private" }),
		f => { f.before.sessions[0].partial = true; },
		f => { f.registry.conversations[0].hasPrompted = true; },
		f => { delete f.registry.conversations[0].hasPrompted; },
		f => { f.before.sessions[0].thread.turn = 1; },
		f => { f.state.sessions[0].thread.turns[1] = { turn: 1 }; },
		f => { f.state.sessions[0].thread.turns = []; },
		f => { f.state.sessions[0].thread.turns = null; },
		f => { f.state.sessions[0].thread.running = true; },
		f => f.state.sessions[0].thread.permissions.push({ id: "approval" }),
		f => f.state.sessions[0].thread.tasks.push({ id: "task" }),
		f => { f.state.sessions[0].thread.tools.a = { status: "running" }; },
		f => { f.state.sessions[0].thread.reasoning.a = { text: "private" }; },
		f => { f.state.sessions[0].thread.retry = { status: "pending" }; },
		f => { f.state.sessions[0].thread.stopReason = "error"; },
		f => { f.receipt.aliasMessageProofs[publicId] = []; },
	]) { const f = fixture(); mutate(f); assert.throws(() => f.methods.verifyRuntimeAliasRotations(f.state, f.aliases, f.registry)); }
});
test("owner/project/canonical-path changes, Pal slots and reused runtime identities refuse", () => {
	for (const mutate of [
		f => { f.aliases[publicId].projectId = "foreign"; },
		f => { f.aliases[publicId].projectCwd = "/foreign"; },
		f => { f.aliases[publicId].projectRoot = "/foreign"; },
		f => { f.aliases[publicId].harness = "codex-cli"; },
		f => { f.aliases[publicId].pal = true; },
		f => { f.aliases[publicId].runtimeId = authoredRuntimeId; },
		f => { f.aliases[authoredId].runtimeId = "01a115d7-46a9-7302-98b1-1ee72fe75300"; },
		f => { delete f.aliases[authoredId]; },
		f => { f.state.sessions[0].projectId = "foreign"; },
		f => { f.registry.conversations[0].runtimeSessionId = "foreign"; },
	]) { const f = fixture(); mutate(f); assert.throws(() => f.methods.verifyRuntimeAliasRotations(f.state, f.aliases, f.registry)); }
});
test("old or new journal evidence, original journal hash, and redirects refuse", () => {
	for (const mutate of [
		f => f.files.add(`${oldRuntimeId}.jsonl`),
		f => f.files.add(`${newRuntimeId}.jsonl`),
		f => { f.context.supplementOriginalJournals[oldRuntimeId] = "c".repeat(64); },
		f => { f.context.supplementOriginalJournals[newRuntimeId] = "c".repeat(64); },
		f => { f.mockedFs.lstatSync = () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => true }); },
	]) { const f = fixture(); mutate(f); assert.throws(() => f.methods.verifyRuntimeAliasRotations(f.state, f.aliases, f.registry)); }
});
test("three pinned sources compile uniquely while all body/clock/presentation gates remain", () => {
	const adapterFile = path.join(__dirname, "../transcript-search-timing-20261007/native-search-speech-activation.cjs"), aliasFile = path.join(__dirname, "native-alias-aware-activation.cjs");
	const adapterSource = fs.readFileSync(adapterFile, "utf8"), aliasSource = fs.readFileSync(aliasFile, "utf8");
	assert.equal(hash(adapterSource), "386844195e4c5ef6bc7352917434ba1f5d790eed1226c45e671a1c4510583e8f");
	assert.equal(hash(aliasSource), "4492325fd1e9532300483fb9de94773561e8c91d87b7f49b3ac82bd048d464aa");
	let compiled;
	class CaptureModule { static _nodeModulePaths() { return []; } _compile(code) { assert.equal(compiled, undefined); compiled = code; } }
	vm.runInNewContext(adapterSource, { require: name => name === "node:module" ? CaptureModule : require(name), process: { argv: ["node", adapterFile, "source", "receipt", "--desktop-only"] }, __dirname: path.dirname(adapterFile), module: {} }, { filename: adapterFile });
	const aliasContext = { require, process: { argv: ["node", aliasFile], env: {} }, console: { log() {} }, __dirname, Buffer };
	vm.runInNewContext(aliasSource + "\nglobalThis.transform = adaptAliasAwareGuard;", aliasContext, { filename: aliasFile });
	const aliased = aliasContext.transform(compiled), transformed = fixture().methods.adaptEmptyAliasSupplement(aliased);
	new vm.Script(transformed);
	for (const gate of [
		"assert.deepEqual(receipt.after, receipt.before, 'Protected durable/display state differs');",
		"assert.equal(captured.hash, previous[alias.runtimeId], 'Durable authored journal changed across activation.');",
		"assert.deepEqual(proofs, receipt.aliasMessageProofs[session.id], \"Aliased authored identities or bodies changed across activation.\");",
		"assert.deepEqual(message.time, { at, source: 'journal' }, 'Known journal message clock differs or is missing.');",
		"assert.equal(hash(current), previous[`${kind}ManifestAfterSha256`], 'Applied runtime manifest changed.');",
		"assert.deepEqual(manifest(target), sourceFiles);",
	]) assert(transformed.includes(gate), gate);
	assert(transformed.includes("beforeHasPromptedCaptured: false"));
	assert(transformed.includes("presentationException: false"));
	assert.throws(() => fixture().methods.adaptEmptyAliasSupplement(aliased.replace("function readRuntimeAliases(state) {", "function movedReader(state) {")), /seam changed/);
});
