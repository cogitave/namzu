"use strict";

// Fresh Desktop-only application. Default is an inert plan. Explicit execution
// is bound to the new passed preparation, its raw snapshot, source manifest,
// current PID, immutable guards, and the unchanged CLI/SDK runtime graph.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const repo = path.resolve(__dirname, "../..");
const original = path.join(repo, "research/runtime-desktop-20260930/transcript-content-desktop-activation-native-20261007.cjs");
const adapter = path.join(repo, "research/transcript-search-timing-20261007/native-search-speech-activation.cjs");
const aliasGuard = path.join(repo, "research/transcript-motion-20261007/native-alias-aware-activation.cjs");
const pins = {
	original: "f85cd8f55dd95cd76ffdbfc166d15410d383470f7c6fd3296cfb8dee4693e56d",
	adapter: "386844195e4c5ef6bc7352917434ba1f5d790eed1226c45e671a1c4510583e8f",
	aliasGuard: "4492325fd1e9532300483fb9de94773561e8c91d87b7f49b3ac82bd048d464aa",
	prepare: "ef0638562ea3b1ab03589cce4da7e71448452e0c96853cf15175a2082f598263",
	snapshot: "0e400d1082948ee6a0916fad70c11924b11f9893c953427906aac5bd686cdaa7",
	sourceManifest: "5df55b80b2fea1d83874cd0e7fa1f0a33879707819bf1e08cdff30407c0a51d3",
};
const expectedPid = 16492;
const prepareName = "chat-surface-prepare-private-20261007-b5eee10c-3b2a-41ab-aaae-7f8b1ee84250.json";
const snapshotName = "chat-surface-before-private-20261007T105804748Z.json";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

if (process.argv.length !== 3 || process.argv[2] !== "--apply-reviewed" ||
	process.env.NAMZU_CHAT_SURFACE_APPLY !== "1") {
	console.log(JSON.stringify({
		preparedOnly: true,
		requires: "NAMZU_CHAT_SURFACE_APPLY=1 and --apply-reviewed on the reviewed native Windows host",
		expectedPid,
		freshPrepareSha256: pins.prepare,
		desktopSourceManifestSha256: pins.sourceManifest,
		changedRuntimeModules: 0,
		oldReceiptsUsed: false,
		actionsPerformed: 0,
	}));
} else {
	assert.equal(process.platform, "win32");
	for (const [file, expected] of [[original, pins.original], [adapter, pins.adapter], [aliasGuard, pins.aliasGuard]])
		assert.equal(sha(fs.readFileSync(file)), expected, "A reviewed native guard changed.");
	const nativeRoot = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const readPinnedPrivate = (name, expected) => {
		const file = path.join(nativeRoot, name);
		const stat = fs.lstatSync(file);
		assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024,
			"A fresh private preparation input is redirected or oversized.");
		const bytes = fs.readFileSync(file);
		assert.equal(sha(bytes), expected, "The reviewed fresh preparation input changed.");
		return JSON.parse(bytes);
	};
	const prepared = readPinnedPrivate(prepareName, pins.prepare);
	readPinnedPrivate(snapshotName, pins.snapshot);
	assert.equal(prepared.passed, true);
	assert.equal(prepared.phase, "prepared");
	assert.equal(prepared.beforePid, expectedPid);
	assert.equal(prepared.privateSnapshot, snapshotName);
	assert.equal(prepared.sourceManifestSha256, pins.sourceManifest);
	assert.equal(prepared.cliModuleCopies, 0);
	assert.equal(prepared.sdkCopies, 0);
	assert.equal(Object.keys(prepared.runtimeAliases ?? {}).length, 4);
	assert.equal(Object.keys(prepared.durableJournals ?? {}).length, 4);
	assert(prepared.before && prepared.aliasMessageProofs && prepared.cliReviewedModules?.length === 7 &&
		prepared.sdkReviewedModules?.length === 2);
	assert.equal(Number(fs.readFileSync(path.join(nativeRoot, "desktop.pid"), "utf8").trim()), expectedPid,
		"Only the freshly prepared desktop process may be updated.");
	const receipt = path.join(nativeRoot,
		`chat-surface-apply-private-20261007-${crypto.randomUUID()}.json`);
	assert(!fs.existsSync(receipt));
	const modules = [
		["cli-history", "cli/dist/commands/desktop-host.js"],
		["cli-store", "cli/dist/pals/store.js"],
		["cli-environment", "cli/dist/pals/environment.js"],
		["cli-codex", "cli/dist/integrations/harness/codex-adapter.js"],
		["cli-native-archive", "cli/dist/commands/acp-harness.js"],
		["cli-pal-scope", "cli/dist/integrations/sessions/store.js"],
		["cli-claude-protocol", "cli/dist/integrations/harness/claude-protocol.js"],
		["sdk-pal-store", "sdk/dist/pals/store.js"],
		["sdk-web-activity", "sdk/dist/bridge/acp/update.js"],
	];
	const source = path.join(repo, "packages/desktop/dist");
	for (const file of ["main/index.js", "main/operator.js", "preload.cjs", "renderer/index.html"])
		assert(fs.statSync(path.join(source, file)).isFile(), `Missing built Desktop entry ${file}.`);
	const replaceOnce = (code, before, after) => {
		assert.equal(code.split(before).length, 2, "Reviewed fresh Desktop application seam changed.");
		return code.replace(before, after);
	};
	const compile = Module.prototype._compile;
	let compiled = 0;
	Module.prototype._compile = function (code, filename) {
		if (path.resolve(filename) !== original) return compile.call(this, code, filename);
		assert.equal(++compiled, 1, "Expected one reviewed native guard compilation.");
		let reviewed = replaceOnce(code,
			"const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');",
			"const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');\n" +
			`const freshPreparePath = path.join(root, '${prepareName}');\n` +
			`const freshSnapshotPath = path.join(root, '${snapshotName}');\n` +
			"function assertFreshPrepareUnchanged() {\n" +
			`  assert.equal(hash(fs.readFileSync(freshPreparePath)), '${pins.prepare}', 'Fresh preparation receipt changed.');\n` +
			`  assert.equal(hash(fs.readFileSync(freshSnapshotPath)), '${pins.snapshot}', 'Fresh preparation snapshot changed.');\n` +
			"}\n" +
			"assertFreshPrepareUnchanged();\n" +
			"const freshPrepared = JSON.parse(fs.readFileSync(freshPreparePath, 'utf8'));\n" +
			"const freshSnapshot = JSON.parse(fs.readFileSync(freshSnapshotPath, 'utf8'));");
		reviewed = replaceOnce(reviewed,
			"  desktopPackageSha256: hash(packageBytes), backupDirectory: path.basename(backup), phase: 'preflight', checks: [] };",
			"  desktopPackageSha256: hash(packageBytes), backupDirectory: path.basename(backup), phase: 'preflight', checks: [] };\n" +
			`assert.equal(receipt.sourceManifestSha256, '${pins.sourceManifest}', 'Built Desktop source differs from fresh preparation.');\n` +
			"assert.equal(receipt.sourceManifestSha256, freshPrepared.sourceManifestSha256);");
		reviewed = replaceOnce(reviewed,
			"    before = await readState();\n    receipt.durableJournals = captureJournals(before);",
			"    before = await readState();\n    receipt.durableJournals = captureJournals(before);\n" +
			"    assert.deepEqual(receipt.durableJournals, freshPrepared.durableJournals, 'Authored journals changed since fresh preparation.');\n" +
			"    assert.deepEqual(receipt.runtimeAliases, freshPrepared.runtimeAliases, 'SDK runtime owners changed since fresh preparation.');\n" +
			"    assert.deepEqual(receipt.aliasMessageProofs, freshPrepared.aliasMessageProofs, 'Authored message proofs changed since fresh preparation.');");
		reviewed = replaceOnce(reviewed,
			"    process.kill(oldPid, 0);\n    receipt.beforePid = oldPid; receipt.before = digests(before);\n    receipt.terminalAlertsBefore = before.dom.terminalAlerts;",
			`    process.kill(oldPid, 0);\n    assert.equal(oldPid, ${expectedPid}, 'The native process changed since fresh preparation.');\n` +
			"    receipt.beforePid = oldPid; receipt.before = digests(before);\n" +
			"    assert.deepEqual(receipt.before, freshPrepared.before, 'Protected user state changed since fresh preparation.');\n" +
			"    assert.equal(hash(before.workspace), hash(freshSnapshot.workspace), 'Workspace owner/layout changed since fresh preparation.');\n" +
			"    receipt.terminalAlertsBefore = before.dom.terminalAlerts;");
		reviewed = replaceOnce(reviewed,
			"const privateSnapshot = path.join(root, `removal-before-private-${stamp}.json`);",
			"const privateSnapshot = path.join(root, `chat-surface-before-private-${stamp}.json`);");
		reviewed = replaceOnce(reviewed,
			"    const oldPortStamp = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : null;",
			"    assertFreshPrepareUnchanged();\n" +
			"    const oldPortStamp = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : null;");
		return compile.call(this, reviewed, filename);
	};
	try {
		process.env.NAMZU_NATIVE_ALIAS_ACTIVATION = "1";
		process.argv = [process.execPath, aliasGuard, source, receipt,
			...modules.map(([name, file]) => `--${name}-source=${path.join(repo, "packages", file)}`),
			"--apply-reviewed", "--desktop-only", "--execute-reviewed-alias"];
		require(aliasGuard);
		assert.equal(compiled, 1, "The reviewed native guard did not run.");
	} finally {
		Module.prototype._compile = compile;
	}
}
