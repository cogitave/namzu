"use strict";
// PREPARED ONLY. Read-only verification through the unchanged reviewed adapter.
// Same arguments as native-search-speech-activation.cjs, plus --execute.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

if (!process.argv.includes("--execute") || process.env.NAMZU_NATIVE_MOTION_VERIFY !== "1") {
	console.log(JSON.stringify({ preparedOnly: true, readOnly: true, requires: "NAMZU_NATIVE_MOTION_VERIFY=1 and --execute", mode: "--verify-current --desktop-only", changes: "zero-copy bookkeeping only; strict state/journal/presentation/graph checks inherited" }));
} else {
	assert.equal(process.platform, "win32");
	assert.equal(process.argv.filter(arg => arg === "--execute").length, 1);
	assert.equal(process.argv.filter(arg => arg === "--verify-current").length, 1);
	assert.equal(process.argv.filter(arg => arg === "--desktop-only").length, 1);
	assert(!process.argv.includes("--apply-reviewed") && !process.argv.includes("--prepare-only"));
	const verifyFrom = process.argv.filter(arg => arg.startsWith("--verify-from="));
	assert.equal(verifyFrom.length, 1);
	assert(/^transcript-motion-apply-private-20261007-v[12]\.json$/.test(path.basename(verifyFrom[0].slice("--verify-from=".length))));
	const pidFlags = process.argv.filter(arg => arg.startsWith("--expected-after-pid="));
	assert.equal(pidFlags.length, 1);
	assert(/^\d+$/.test(pidFlags[0].slice("--expected-after-pid=".length)));
	const expectedAfterPid = Number(pidFlags[0].slice("--expected-after-pid=".length));
	assert(Number.isSafeInteger(expectedAfterPid) && expectedAfterPid > 0 && expectedAfterPid <= 2147483647);
	process.argv = process.argv.filter(arg => arg !== "--execute" && !arg.startsWith("--expected-after-pid="));
	const original = path.resolve(__dirname, "../runtime-desktop-20260930/transcript-content-desktop-activation-native-20261007.cjs");
	const adapter = path.resolve(__dirname, "../transcript-search-timing-20261007/native-search-speech-activation.cjs");
	const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
	assert.equal(hash(fs.readFileSync(original)), "f85cd8f55dd95cd76ffdbfc166d15410d383470f7c6fd3296cfb8dee4693e56d");
	assert.equal(hash(fs.readFileSync(adapter)), "386844195e4c5ef6bc7352917434ba1f5d790eed1226c45e671a1c4510583e8f");
	const compile = Module.prototype._compile;
	let seamCount = 0;
	Module.prototype._compile = function(code, filename) {
		if (path.resolve(filename) !== original) return compile.call(this, code, filename);
		Module.prototype._compile = compile;
		seamCount++;
		const previousSeam = "      const completedApplication = previous.phase === 'verify' &&\n        Number.isInteger(previous.cliModuleCopies) && previous.cliModuleCopies > 0 &&\n        previous.cliModuleCopies === previousChangedCli.length &&\n        previous.cliReviewedModules.length === cliModules.length &&\n        previous.sdkReviewedModules.length === sdkModules.length && previous.sdkCopies === previousChangedSdk.length;";
		assert.equal(code.split(previousSeam).length, 2, "Reviewed zero-copy bookkeeping seam changed");
		code = code.replace(previousSeam, `      // A Desktop-only update copied no CLI/SDK files. Retain the failed receipt;
      // reconstruct only its missing after-manifest bookkeeping in memory.
      assert.equal(expectedChangedRuntimeSet.length, 0, 'This wrapper is Desktop-only');
      assert.equal(mode, '--verify-current');
      assert.equal(previous.passed, false, 'The specific failed activation must remain unchanged');
      assert.equal(previous.phase, 'verify');
      assert.equal(previous.cliModuleCopies, 0); assert.equal(previous.sdkCopies, 0);
      assert.equal(previousChangedCli.length, 0); assert.equal(previousChangedSdk.length, 0);
      assert.equal(previous.cliReviewedModules.length, 7); assert.equal(cliModules.length, 7);
      assert.equal(previous.sdkReviewedModules.length, 2); assert.equal(sdkModules.length, 2);
      assert.equal(previous.ownedProcessesConfirmedClosed, true);
      assert.equal(previous.close?.status, 0);
      assert.equal(previous.error?.name, 'AssertionError');
      assert(previous.error.message.startsWith('Protected presentation changed across activation'));
      assert.deepEqual(previous.checks, [
        'applied 0 changed CLI and 0 changed SDK module(s) after graceful close; reviewed 7 CLI and 2 SDK module(s)',
        'staged complete built desktop and retained old dist as backup',
      ]);
      assert(previous.backupDirectory && path.basename(previous.backupDirectory) === previous.backupDirectory);
      assert(fs.statSync(path.join(config.app, previous.backupDirectory)).isDirectory());
      assert.deepEqual(Object.keys(previous.before).sort(), Object.keys(previous.after).sort());
      for (const key of Object.keys(previous.before)) if (key !== 'presentation')
        assert.equal(previous.before[key], previous.after[key], 'An unrelated protected field failed');
      assert.notEqual(previous.before.presentation, previous.after.presentation);
      assert.equal(Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim()), ${expectedAfterPid},
        'Only the same applied native process may be verified');
      for (const kind of ['cli', 'sdk']) {
        const reviewed = previous[kind + 'ReviewedModules'];
        const files = new Set();
        for (const item of reviewed) {
          assert(!files.has(item.file)); files.add(item.file);
          assert(/^[a-f0-9]{64}$/.test(item.beforeSha256));
          assert.equal(item.beforeSha256, item.afterSha256);
        }
        const prior = previous[kind + 'ManifestBeforeSha256'];
        assert(/^[a-f0-9]{64}$/.test(prior));
        if (previous[kind + 'ManifestAfterSha256'] !== undefined)
          assert.equal(previous[kind + 'ManifestAfterSha256'], prior);
        previous[kind + 'ManifestAfterSha256'] = prior;
      }
      receipt.zeroCopyBookkeeping = {
        rule: 'nine reviewed before/after module hashes equal; no runtime copies; derive missing after manifests from exact before manifests only in memory',
        originalGuardSha256: 'f85cd8f55dd95cd76ffdbfc166d15410d383470f7c6fd3296cfb8dee4693e56d',
        adapterSha256: '386844195e4c5ef6bc7352917434ba1f5d790eed1226c45e671a1c4510583e8f',
      };
      const completedApplication = true;`);
		return compile.call(this, code, filename);
	};
	try { require(adapter); assert.equal(seamCount, 1); }
	finally { Module.prototype._compile = compile; }
}
