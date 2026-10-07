"use strict";

// PREPARED ONLY by default. The owner supplies the inherited activation args
// plus --execute-reviewed-alias and NAMZU_NATIVE_ALIAS_ACTIVATION=1 after review.
// No immutable guard edits; only its compiled journal-ownership seams change.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), Module = require("node:module");
const original = path.resolve(__dirname, "../runtime-desktop-20260930/transcript-content-desktop-activation-native-20261007.cjs");
const adapter = path.resolve(__dirname, "../transcript-search-timing-20261007/native-search-speech-activation.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const ORIGINAL_SHA = "f85cd8f55dd95cd76ffdbfc166d15410d383470f7c6fd3296cfb8dee4693e56d";
const ADAPTER_SHA = "386844195e4c5ef6bc7352917434ba1f5d790eed1226c45e671a1c4510583e8f";

// These functions are compiled into the inherited module so its own fs/path/
// hash/receipt bindings and unchanged before/final/after call sites are used.
function aliasReadJson(file, maximum) {
	const stat = fs.lstatSync(file);
	assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, "Alias authority is redirected or oversized.");
	const bytes = fs.readFileSync(file);
	assert(bytes.length <= maximum);
	return JSON.parse(bytes);
}
function aliasScopeRoot(cwd, pal) {
	const start = fs.realpathSync(cwd);
	assert(fs.lstatSync(start).isDirectory() && !fs.lstatSync(start).isSymbolicLink());
	if (pal) return start;
	let current = start;
	for (let depth = 0; depth < 128; depth++) {
		const git = path.join(current, ".git");
		if (fs.existsSync(git)) { assert(!fs.lstatSync(git).isSymbolicLink()); return current; }
		const parent = path.dirname(current);
		if (parent === current) return start;
		current = parent;
	}
	assert.fail("Project ancestry exceeds the bounded alias review.");
}
function readRuntimeAliases(state) {
	const registryRoot = path.join(process.env.APPDATA, "Namzu");
	assert(fs.lstatSync(registryRoot).isDirectory() && !fs.lstatSync(registryRoot).isSymbolicLink());
	const registry = aliasReadJson(path.join(registryRoot, "desktop-conversations.json"), 48 * 1024 * 1024);
	assert.equal(registry.version, 1);
	assert(Array.isArray(registry.conversations) && registry.conversations.length <= 1000);
	assert(Array.isArray(registry.projects) && registry.projects.length <= 128);
	const safeId = value => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
	const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
	const publicIds = new Set(), runtimeOwners = new Set(), projectIds = new Set();
	for (const project of registry.projects) { assert(uuid(project.id) && typeof project.path === "string" && path.isAbsolute(project.path)); assert(!projectIds.has(project.id)); projectIds.add(project.id); }
	for (const row of registry.conversations) {
		assert(row.view && uuid(row.view.id) && uuid(row.view.projectId) && safeId(row.runtimeSessionId));
		assert(!publicIds.has(row.view.id), "Duplicate public conversation authority."); publicIds.add(row.view.id);
		if ((row.view.harness ?? "namzu") === "namzu") { assert(!runtimeOwners.has(row.runtimeSessionId), "Two public conversations claim one SDK runtime."); runtimeOwners.add(row.runtimeSessionId); }
	}
	const aliases = {};
	for (const session of state.sessions.filter(row => row.harness === "namzu")) {
		const rows = registry.conversations.filter(row => row.view.id === session.id);
		assert.equal(rows.length, 1, "SDK view has no unique durable runtime authority.");
		const row = rows[0];
		assert.equal(row.view.projectId, session.projectId, "Runtime alias crosses a Desktop project.");
		assert.equal(row.view.harness ?? "namzu", session.harness, "Runtime alias crosses execution engines.");
		assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.runtimeSessionId), "SDK runtime identity is not a safe session filename.");
		const projects = registry.projects.filter(project => project.id === row.view.projectId);
		assert.equal(projects.length, 1, "Runtime alias has no unique durable project.");
		if (session.messages.length) assert.equal(row.hasPrompted, true);
		aliases[session.id] = { publicId: session.id, runtimeId: row.runtimeSessionId, projectId: session.projectId, harness: session.harness, projectCwd: fs.realpathSync(projects[0].path), projectRoot: aliasScopeRoot(projects[0].path, Boolean(row.view.palId)), pal: Boolean(row.view.palId) };
	}
	if (receipt.runtimeAliases) assert.deepEqual(aliases, receipt.runtimeAliases, "Public/runtime/project ownership changed across activation.");
	else receipt.runtimeAliases = aliases;
	if (!receipt.aliasMessageProofs) receipt.aliasMessageProofs = {};
	return aliases;
}
function validateAliasProject(alias, captured) {
	assert(captured.records.every(record => record.sessionId === alias.runtimeId), "Journal contains a foreign runtime identity.");
	assert.equal(captured.records.filter(record => record.type === "session_started" && record.sessionId === alias.runtimeId).length, 1);
	const project = aliasReadJson(path.join(path.dirname(captured.file), "project.json"), 1024 * 1024);
	assert.equal(fs.realpathSync(project.cwd), alias.projectRoot, "Runtime journal belongs to another project scope.");
	assert.equal(project.slug, path.basename(path.dirname(captured.file)), "Runtime journal folder differs from its project authority.");
	assert.equal(path.resolve(path.dirname(captured.file)), path.resolve(journalRoot, project.slug), "Runtime journal is outside its canonical SDK project directory.");
	assert(typeof project.projectId === "string" && project.projectId.length > 0);
	const started = captured.records.find(record => record.type === "session_started");
	assert.equal(started.projectId, project.projectId, "Session start project identity differs from its project authority.");
	assert.equal(fs.realpathSync(started.cwd), alias.projectCwd, "Session start working directory differs from its Desktop owner.");
	if (started.tenantId !== undefined) {
		const identity = aliasReadJson(path.join(path.dirname(journalRoot), "identity.json"), 1024 * 1024);
		assert(typeof identity.tenantId === "string" && identity.tenantId.length > 0);
		assert.equal(started.tenantId, identity.tenantId, "Session start tenant differs from this installation.");
	}
}
function validateAliasedMessageBodies(session, alias, captured, requireClocks) {
	// Ordinary SDK views bind every ID/body even when public and runtime IDs
	// coincide. Pal output hygiene keeps its inherited byte/clock/body guards;
	// aliased Pal and mutation/compaction folds need an explicit separate review.
	if (alias.pal && alias.runtimeId === alias.publicId) return;
	assert(!alias.pal && !session.partial, "Aliased partial or Pal history is not covered by this activation review.");
	assert(!captured.records.some(record => ["message_replaced", "context_compacted"].includes(record.type)), "Aliased rewritten history needs a separately reviewed body fold.");
	const publicRecords = captured.records.filter(record => record.type === "message" && ["user", "assistant"].includes(record.role) && !(record.role === "assistant" && record.content?.content === null && record.content?.toolCalls?.length) && !(record.role === "user" && record.content?.source && !(record.content.source.type === "runtime-context" && record.content.source.kind === "steering")));
	const body = record => typeof record.content?.content === "string" ? record.content.content : "[Media message]";
	const used = new Set(), proofs = [];
	for (const message of session.messages) {
		let candidates;
		if (message.messageId) candidates = publicRecords.filter(record => record.messageId === message.messageId);
		else {
			assert(!requireClocks && message.role === "user" && message.time?.source === "host", "Only an admitted live user prompt may temporarily lack its durable identity.");
			candidates = publicRecords.filter(record => record.role === message.role && hash(body(record)) === hash(message.text));
		}
		assert.equal(candidates.length, 1, "Aliased public message has no unambiguous durable identity.");
		const record = candidates[0];
		assert(!used.has(record.messageId), "Aliased public messages duplicate one durable record."); used.add(record.messageId);
		assert.equal(record.role, message.role);
		assert.equal(hash(body(record)), hash(message.text), "Aliased public message body differs from its durable record.");
		proofs.push({ messageId: record.messageId, role: record.role, bodySha256: hash(message.text) });
	}
	assert.equal(publicRecords.length, proofs.length, "Aliased public history is incomplete or reordered beyond this review.");
	assert.deepEqual(proofs.map(row => row.messageId), publicRecords.map(row => row.messageId), "Aliased public message order differs from its durable journal.");
	if (!receipt.aliasMessageProofs) receipt.aliasMessageProofs = {};
	if (receipt.aliasMessageProofs[session.id]) assert.deepEqual(proofs, receipt.aliasMessageProofs[session.id], "Aliased authored identities or bodies changed across activation.");
	else receipt.aliasMessageProofs[session.id] = proofs;
}
function adaptAliasAwareGuard(input) {
	let code = input;
	const replace = (before, after) => { assert.equal(code.split(before).length, 2, "Reviewed alias seam changed."); code = code.replace(before, after); };
	const helpers = [aliasReadJson, aliasScopeRoot, readRuntimeAliases, validateAliasProject, validateAliasedMessageBodies].map(fn => fn.toString()).join("\n");
	replace("const journalRoot = path.join(process.env.USERPROFILE, '.namzu', 'projects');", `${helpers}\nconst journalRoot = path.join(process.env.USERPROFILE, '.namzu', 'projects');`);
	replace("  const ids = new Set(state.sessions.filter(session => session.harness === 'namzu').map(session => session.id));", "  const aliases = readRuntimeAliases(state);\n  const ids = new Set(Object.values(aliases).map(alias => alias.runtimeId));");
	replace("        found.set(id, { hash: hash(bytes), records });", "        found.set(id, { hash: hash(bytes), records, file });");
	replace("    const captured = found.get(session.id);", "    const alias = aliases[session.id];\n    assert(alias, 'SDK session alias is missing.');\n    const captured = found.get(alias.runtimeId);");
	replace("      if (previous) assert(!Object.hasOwn(previous, session.id), 'An authored journal disappeared.');", "      if (previous) assert(!Object.hasOwn(previous, alias.runtimeId), 'An authored journal disappeared.');");
	replace("    if (previous) assert.equal(captured.hash, previous[session.id], 'Durable authored journal changed across activation.');", "    validateAliasProject(alias, captured);\n    validateAliasedMessageBodies(session, alias, captured, requireClocks);\n    if (previous) assert.equal(captured.hash, previous[alias.runtimeId], 'Durable authored journal changed across activation.');");
	replace("      const previous = JSON.parse(previousBytes.toString('utf8'));", "      const previous = JSON.parse(previousBytes.toString('utf8'));\n      assert(previous.runtimeAliases && previous.aliasMessageProofs, 'Verification requires an alias-aware original receipt.');\n      receipt.runtimeAliases = previous.runtimeAliases;\n      receipt.aliasMessageProofs = previous.aliasMessageProofs;");
	return code;
}

if (!process.argv.includes("--execute-reviewed-alias") || process.env.NAMZU_NATIVE_ALIAS_ACTIVATION !== "1") {
	console.log(JSON.stringify({ preparedOnly: true, requires: "NAMZU_NATIVE_ALIAS_ACTIVATION=1 and --execute-reviewed-alias plus inherited explicit mode/source/receipt arguments", inheritedOriginalSha256: ORIGINAL_SHA, inheritedAdapterSha256: ADAPTER_SHA, changes: "Journal lookup follows unique durable same-project public-to-runtime IDs; public protected digests and all unknown journal/clock/ownership gates remain.", aliasedBodies: "Exact IDs/roles/body hashes/order; only a proved unique admitted live user prompt can temporarily lack its durable ID.", actionsPerformed: 0 }));
} else {
	assert.equal(process.platform, "win32");
	assert.equal(process.argv.filter(flag => flag === "--execute-reviewed-alias").length, 1);
	assert.equal(sha(fs.readFileSync(original)), ORIGINAL_SHA);
	assert.equal(sha(fs.readFileSync(adapter)), ADAPTER_SHA);
	process.argv = process.argv.filter(flag => flag !== "--execute-reviewed-alias");
	const compile = Module.prototype._compile;
	let seams = 0;
	Module.prototype._compile = function(code, filename) {
		if (path.resolve(filename) !== original) return compile.call(this, code, filename);
		assert.equal(++seams, 1);
		Module.prototype._compile = compile;
		return compile.call(this, adaptAliasAwareGuard(code), filename);
	};
	try { require(adapter); assert.equal(seams, 1); }
	finally { Module.prototype._compile = compile; }
}
