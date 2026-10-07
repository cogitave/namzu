"use strict";

// Pure composition checks. No native app, CDP, provider, or file mutation.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const entry = path.join(__dirname, "native-desktop-apply.cjs");
const adapter = path.resolve(__dirname, "../transcript-search-timing-20261007/native-search-speech-activation.cjs");
const aliasGuard = path.resolve(__dirname, "../transcript-motion-20261007/native-alias-aware-activation.cjs");

test("default invocation is inert and carries only the fresh preparation", () => {
	const run = spawnSync(process.execPath, [entry], { encoding: "utf8" });
	assert.equal(run.status, 0);
	const plan = JSON.parse(run.stdout);
	assert.equal(plan.preparedOnly, true);
	assert.equal(plan.actionsPerformed, 0);
	assert.equal(plan.oldReceiptsUsed, false);
	assert.equal(plan.changedRuntimeModules, 0);
	assert.match(plan.requires, /--apply-reviewed/);
});

test("strict alias, journal, PID, and fresh snapshot seams compile together", () => {
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
	const aliasContext = {
		require,
		process: { argv: ["node", aliasGuard], env: {} },
		__dirname: path.dirname(aliasGuard),
		console: { log() {} },
	};
	vm.runInNewContext(fs.readFileSync(aliasGuard, "utf8") +
		"\nglobalThis.adapt = adaptAliasAwareGuard;", aliasContext, { filename: aliasGuard });
	const inherited = aliasContext.adapt(adapterCode);
	const wrapper = fs.readFileSync(entry, "utf8");
	const valuesStart = wrapper.indexOf("const pins = {");
	const valuesEnd = wrapper.indexOf("const sha =", valuesStart);
	assert(valuesStart >= 0 && valuesEnd > valuesStart);
	const values = {};
	vm.runInNewContext(wrapper.slice(valuesStart, valuesEnd) +
		"\nglobalThis.values = { pins, expectedPid, prepareName, snapshotName };", values);
	const start = wrapper.indexOf("\t\tlet reviewed = replaceOnce(code,");
	const end = wrapper.indexOf("\t\treturn compile.call(this, reviewed, filename);", start);
	assert(start >= 0 && end > start);
	const transform = new Function("code", "pins", "prepareName", "snapshotName", "expectedPid", "assert",
		"const replaceOnce = (code, before, after) => { assert.equal(code.split(before).length, 2); return code.replace(before, after); };\n" +
		wrapper.slice(start, end) + "\nreturn reviewed;");
	const reviewed = transform(inherited, values.values.pins, values.values.prepareName,
		values.values.snapshotName, values.values.expectedPid, assert);
	new vm.Script(reviewed);
	assert.match(reviewed, /Authored journals changed since fresh preparation/);
	assert.match(reviewed, /SDK runtime owners changed since fresh preparation/);
	assert.match(reviewed, /Authored message proofs changed since fresh preparation/);
	assert.match(reviewed, /Protected user state changed since fresh preparation/);
	assert.match(reviewed, /Workspace owner\/layout changed since fresh preparation/);
	assert.match(reviewed, /Public\/runtime\/project ownership changed across activation/);
	assert.match(reviewed, /Known journal message clock differs or is missing/);
	assert.match(reviewed, /Protected \$\{key\} changed across activation/);
	assert.match(reviewed, /assertFreshPrepareUnchanged\(\);\n    const oldPortStamp/);
});
