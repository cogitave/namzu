"use strict";
// Reuse the immutable, previously audited native activation guard. This adapter
// changes only its exact reviewed module set and one removed named import.
// Invocation and all ownership/state/graph checks are inherited verbatim.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const original = path.resolve(
	__dirname,
	"../runtime-desktop-20260930/transcript-content-desktop-activation-native-20261007.cjs",
);
const bytes = fs.readFileSync(original);
assert.equal(
	crypto.createHash("sha256").update(bytes).digest("hex"),
	"f85cd8f55dd95cd76ffdbfc166d15410d383470f7c6fd3296cfb8dee4693e56d",
	"The inherited guard changed; review it before applying this adapter.",
);
const runtimeModes = process.argv.filter((arg) =>
	["--desktop-only", "--claude-protocol-only"].includes(arg),
);
assert(runtimeModes.length <= 1, "Choose one reviewed runtime change set.");
const runtimeMode = runtimeModes[0];
// These adapter flags never relax the inherited operation or source-path flags.
process.argv = process.argv.filter((arg) => !runtimeModes.includes(arg));
const changedRuntimeSet =
	runtimeMode === "--desktop-only"
		? []
		: runtimeMode === "--claude-protocol-only"
			? ["cli/integrations/harness/claude-protocol.js"]
			: ["cli/commands/desktop-host.js"];
let code = bytes.toString("utf8");
function replaceOnce(before, after) {
	assert.equal(
		code.split(before).length,
		2,
		"The reviewed guard seam changed.",
	);
	code = code.replace(before, after);
}
replaceOnce(
	"const config = JSON.parse(configBytes);",
	"const config = JSON.parse(configBytes);\n" +
		"const launcherBytes = fs.readFileSync(path.join(root, 'launch.cjs'));\n" +
		"assert.equal(crypto.createHash('sha256').update(launcherBytes).digest('hex'), 'ca9aafb2a9f00a335bc2c53fe24dcd07ec8c2cda9033e55a743280cfb0e16509', 'The reviewed launcher and selected Podman machine changed.');",
);
replaceOnce(
	"const expectedChangedRuntimeSet = [\n  'cli/commands/desktop-host.js',\n  'cli/integrations/harness/claude-protocol.js',\n  'cli/integrations/sessions/store.js',\n];",
	`const expectedChangedRuntimeSet = ${JSON.stringify(changedRuntimeSet)};`,
);
replaceOnce(
	"    assert.deepEqual(nextNames.filter(name => !additions.includes(name)), previousNames.filter(name => !additions.includes(name)),\n      `Import changed beyond reviewed additions in ${item.file}.`);",
	"    const removedHistoryReader = name => item.file === 'commands/desktop-host.js' && specifier === '../integrations/sessions/store.js' && name === 'loadConversation';\n" +
		"    if (previousNames.some(removedHistoryReader)) assert(!nextNames.includes('loadConversation'), 'The replaced history reader remains imported.');\n" +
		"    assert.deepEqual(nextNames.filter(name => !additions.includes(name)), previousNames.filter(name => !additions.includes(name) && !removedHistoryReader(name)),\n" +
		"      `Import changed beyond reviewed additions and the removed history reader in ${item.file}.`);",
);
replaceOnce(
	"'eight reviewed modules; only desktop-host, Claude protocol and session store may change'",
	`'eight reviewed modules; exact reviewed changes: ${changedRuntimeSet.join(", ") || "Desktop only"}; SDK byte exact'`,
);
replaceOnce(
	"\t\t\t\t\tcontrol: computer.control,\n",
	"\t\t\t\t\tcontrol: computer.control,\n\t\t\t\t\tnotice: computer.notice,\n\t\t\t\t\trequiresStop: computer.requiresStop,\n",
);
replaceOnce(
	"function digests(state) { return Object.fromEntries(Object.entries(semantic(state)).map(([name, value]) => [name, hash(value)])); }",
	"function digests(state) { return Object.fromEntries(Object.entries(semantic(state)).map(([name, value]) => [name, hash(value)])); }\n" +
		"function assertComputersQuiescent(state) {\n" +
		"  if (state.computers.every(computer => computer.status === 'stopped')) return;\n" +
		"  assert(state.computers.every(computer => computer.status === 'stopped' || (computer.status === 'unavailable' && computer.notice === 'The selected Podman machine is stopped or unavailable; start it explicitly' && !computer.requiresStop && !computer.environmentId && !computer.generation && !computer.control)), 'Unavailable computer has no proved quiescent lifetime.');\n" +
		"  assert(typeof config.podman === 'string' && fs.statSync(config.podman).isFile());\n" +
		"  assert.equal(hash(fs.readFileSync(path.join(root, 'launch.cjs'))), hash(launcherBytes), 'The selected-machine launcher changed.');\n" +
		"  const probe = cp.spawnSync(config.podman, ['machine', 'inspect', 'podman-machine-default'], { cwd: root, encoding: 'utf8', windowsHide: true });\n" +
		"  assert.equal(probe.status, 0, 'Podman machine state cannot be verified.');\n" +
		"  const machines = JSON.parse(probe.stdout);\n" +
		"  assert(Array.isArray(machines) && machines.length === 1 && machines[0].Name === 'podman-machine-default' && machines[0].State === 'stopped', 'The selected Podman machine must be physically stopped.');\n" +
		"  receipt.launcherSha256 = hash(launcherBytes);\n" +
		"  receipt.physicalStoppedMachineObservations = (receipt.physicalStoppedMachineObservations ?? 0) + 1;\n" +
		"}",
);
replaceOnce(
	"    assert(before.computers.every(computer => computer.status === 'stopped'), 'All Pal computers must be stopped before native restart.');",
	"    assertComputersQuiescent(before);",
);
replaceOnce(
	"    const oldPortStamp = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : null;",
	"    assertComputersQuiescent(finalState);\n    const oldPortStamp = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : null;",
);
replaceOnce(
	"      const after = await readState();\n      receipt.beforePid",
	"      const after = await readState();\n      assertComputersQuiescent(after);\n      receipt.beforePid",
);
replaceOnce(
	"    for (const key of Object.keys(receipt.before)) assert.equal(receipt.after[key], receipt.before[key], `Protected ${key} changed across activation`);",
	"    assertComputersQuiescent(after);\n    for (const key of Object.keys(receipt.before)) assert.equal(receipt.after[key], receipt.before[key], `Protected ${key} changed across activation`);",
);
// Preserve every original receipt and the original helper. No graph, authority,
// message, profile, draft, presentation or action check is loosened. The only
// computer exception requires exact inert metadata plus the stopped physical VM,
// checked before staging/close and after restart. Unknown is never treated as zero.
const inherited = new Module(original, module);
inherited.filename = original;
inherited.paths = Module._nodeModulePaths(path.dirname(original));
inherited._compile(code, original);
