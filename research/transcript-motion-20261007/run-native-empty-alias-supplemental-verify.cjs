"use strict";
// Native owner entry point. No activation/restart mode exists in this helper.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
if (process.argv.length !== 3 || process.argv[2] !== "--verify-reviewed") {
	console.log(JSON.stringify({ preparedOnly: true, readOnly: true, requires: "Explicit native owner --verify-reviewed invocation after source review", expectedPid: 16492, actionsPerformed: 0 }));
} else {
	assert.equal(process.platform, "win32");
	const helper = path.join(__dirname, "native-empty-alias-supplemental-verify.cjs");
	assert.equal(crypto.createHash("sha256").update(fs.readFileSync(helper)).digest("hex"), "fd97e9791ca0fade5cb14034bd014756057e40d3e1274f1f7e7d3f35ca818d54");
	const repo = path.resolve(__dirname, "../.."), root = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const original = path.join(root, "transcript-motion-alias-apply-private-20261007-v1.json");
	const output = path.join(root, "transcript-motion-empty-alias-supplemental-verify-private-20261007-v1.json");
	assert(!fs.existsSync(output), "Retain any prior supplemental receipt; choose a separately reviewed fresh output.");
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
	process.env.NAMZU_NATIVE_EMPTY_ALIAS_VERIFY = "1";
	process.argv = [process.execPath, helper, path.join(repo, "packages/desktop/dist"), output,
		...modules.map(([name, file]) => `--${name}-source=${path.join(repo, "packages", file)}`),
		"--verify-current", "--desktop-only", `--verify-from=${original}`, "--execute-reviewed-empty-alias-verify"];
	require(helper);
}
