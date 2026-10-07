"use strict";

// Fresh read-only Desktop preparation. This entry point never selects apply,
// verification against an old receipt, or any CLI/SDK module replacement.
// The inherited guard writes a new private snapshot and receipt only.
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
};
const expectedPid = 16492;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

if (process.argv.length !== 3 || process.argv[2] !== "--prepare-reviewed" ||
	process.env.NAMZU_CHAT_SURFACE_PREPARE !== "1") {
	console.log(JSON.stringify({
		preparedOnly: true,
		requires: "NAMZU_CHAT_SURFACE_PREPARE=1 and --prepare-reviewed on the reviewed native Windows host",
		expectedPid,
		mode: "fresh --prepare-only --desktop-only",
		cliCopies: 0,
		sdkCopies: 0,
		appRestarts: 0,
		oldReceiptsUsed: false,
		actionsPerformed: 0,
	}));
} else {
	assert.equal(process.platform, "win32");
	for (const [file, expected] of [[original, pins.original], [adapter, pins.adapter], [aliasGuard, pins.aliasGuard]])
		assert.equal(sha(fs.readFileSync(file)), expected, "A reviewed native guard changed.");
	const nativeRoot = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	assert.equal(Number(fs.readFileSync(path.join(nativeRoot, "desktop.pid"), "utf8").trim()), expectedPid,
		"Only the fresh reviewed desktop process may be prepared.");
	const receipt = path.join(nativeRoot,
		`chat-surface-prepare-private-20261007-${crypto.randomUUID()}.json`);
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
		assert.equal(code.split(before).length, 2, "Reviewed Desktop preparation seam changed.");
		return code.replace(before, after);
	};
	const compile = Module.prototype._compile;
	let compiled = 0;
	Module.prototype._compile = function (code, filename) {
		if (path.resolve(filename) !== original) return compile.call(this, code, filename);
		assert.equal(++compiled, 1, "Expected one reviewed native guard compilation.");
		let reviewed = replaceOnce(code,
			"    process.kill(oldPid, 0);\n    receipt.beforePid = oldPid; receipt.before = digests(before);\n    receipt.terminalAlertsBefore = before.dom.terminalAlerts;",
			`    process.kill(oldPid, 0);\n    assert.equal(oldPid, ${expectedPid}, 'The native process changed during fresh preparation.');\n    receipt.beforePid = oldPid; receipt.before = digests(before);\n    receipt.terminalAlertsBefore = before.dom.terminalAlerts;`);
		reviewed = replaceOnce(reviewed,
			"const privateSnapshot = path.join(root, `removal-before-private-${stamp}.json`);",
			"const privateSnapshot = path.join(root, `chat-surface-before-private-${stamp}.json`);");
		return compile.call(this, reviewed, filename);
	};
	try {
		process.env.NAMZU_NATIVE_ALIAS_ACTIVATION = "1";
		process.argv = [process.execPath, aliasGuard, source, receipt,
			...modules.map(([name, file]) => `--${name}-source=${path.join(repo, "packages", file)}`),
			"--prepare-only", "--desktop-only", "--execute-reviewed-alias"];
		require(aliasGuard);
		assert.equal(compiled, 1, "The reviewed native guard did not run.");
	} finally {
		Module.prototype._compile = compile;
	}
}
