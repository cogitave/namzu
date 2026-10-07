"use strict";
// Windows entry point keeps the explicit review flag inside the native process.
// Never install, kill by name, send a prompt, clear a queue, or change a preference.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const flag = process.argv[2];
if (process.argv.length !== 3 || !["--prepare-reviewed", "--apply-reviewed"].includes(flag)) {
	console.log(JSON.stringify({ preparedOnly: true, requires: "An explicit --prepare-reviewed or --apply-reviewed native owner invocation", actionsPerformed: 0 }));
} else {
	assert.equal(process.platform, "win32");
	const helper = path.join(__dirname, "native-alias-aware-activation.cjs");
	assert.equal(crypto.createHash("sha256").update(fs.readFileSync(helper)).digest("hex"), "4492325fd1e9532300483fb9de94773561e8c91d87b7f49b3ac82bd048d464aa");
	const repo = path.resolve(__dirname, "../..");
	const phase = flag === "--prepare-reviewed" ? "prepare" : "apply";
	const receipt = path.join(process.env.LOCALAPPDATA, "Namzu", "Development", `transcript-motion-alias-${phase}-private-20261007-v1.json`);
	assert(!fs.existsSync(receipt), "An immutable prior receipt already occupies this path.");
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
	process.env.NAMZU_NATIVE_ALIAS_ACTIVATION = "1";
	process.argv = [process.execPath, helper, path.join(repo, "packages/desktop/dist"), receipt, ...modules.map(([name, file]) => `--${name}-source=${path.join(repo, "packages", file)}`), phase === "prepare" ? "--prepare-only" : "--apply-reviewed", "--desktop-only", "--execute-reviewed-alias"];
	require(helper);
}
