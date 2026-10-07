"use strict";

// Pure seam/default tests. No native app, CDP, model, or filesystem writes.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const entry = path.join(__dirname, "native-desktop-prepare.cjs");
const aliasGuard = path.resolve(__dirname, "../transcript-motion-20261007/native-alias-aware-activation.cjs");
const adapter = path.resolve(__dirname, "../transcript-search-timing-20261007/native-search-speech-activation.cjs");

test("default invocation is inert and selects no apply or old receipt", () => {
	const run = spawnSync(process.execPath, [entry], { encoding: "utf8" });
	assert.equal(run.status, 0);
	const plan = JSON.parse(run.stdout);
	assert.equal(plan.preparedOnly, true);
	assert.equal(plan.actionsPerformed, 0);
	assert.equal(plan.appRestarts, 0);
	assert.equal(plan.oldReceiptsUsed, false);
	assert.match(plan.mode, /--prepare-only --desktop-only/);
});

test("reviewed adapter and alias guard retain the exact fresh PID and private snapshot seams", () => {
	let adapterCode;
	class CaptureModule {
		static _nodeModulePaths() { return []; }
		_compile(code) { adapterCode = code; }
	}
	vm.runInNewContext(fs.readFileSync(adapter, "utf8"), {
		require: (name) => name === "node:module" ? CaptureModule : require(name),
		process: { argv: ["node", adapter, "source", "receipt", "--desktop-only"] },
		__dirname: path.dirname(adapter),
		module: {},
	}, { filename: adapter });
	assert(adapterCode);
	const context = {
		require,
		process: { argv: ["node", aliasGuard], env: {} },
		__dirname: path.dirname(aliasGuard),
		console: { log() {} },
	};
	vm.runInNewContext(fs.readFileSync(aliasGuard, "utf8") +
		"\nglobalThis.adapt = adaptAliasAwareGuard;", context, { filename: aliasGuard });
	const reviewed = context.adapt(adapterCode);
	for (const seam of [
		"    process.kill(oldPid, 0);\n    receipt.beforePid = oldPid; receipt.before = digests(before);\n    receipt.terminalAlertsBefore = before.dom.terminalAlerts;",
		"const privateSnapshot = path.join(root, `removal-before-private-${stamp}.json`);",
	]) assert.equal(reviewed.split(seam).length, 2, `Changed native preparation seam: ${seam}`);
	assert(reviewed.includes("Protected ${key} changed across activation"));
	assert(reviewed.includes("const captured = found.get(alias.runtimeId);"));
	new vm.Script(reviewed);
});
