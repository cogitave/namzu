"use strict";
// Plan only by default. The owner may verify the already-applied native process;
// this helper never selects an apply/prepare mode or changes the old receipt.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), Module = require("node:module");
const original = path.resolve(__dirname, "../runtime-desktop-20260930/transcript-content-desktop-activation-native-20261007.cjs");
const adapter = path.resolve(__dirname, "../transcript-search-timing-20261007/native-search-speech-activation.cjs");
const aliasGuard = path.resolve(__dirname, "native-alias-aware-activation.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const PINS = {
	original: "f85cd8f55dd95cd76ffdbfc166d15410d383470f7c6fd3296cfb8dee4693e56d",
	adapter: "386844195e4c5ef6bc7352917434ba1f5d790eed1226c45e671a1c4510583e8f",
	aliasGuard: "4492325fd1e9532300483fb9de94773561e8c91d87b7f49b3ac82bd048d464aa",
	failedReceipt: "6b79f91a1a06d76b3b4bd8efd8e560556832de78a6e3e967a03ee0da29d60c28",
	privateSnapshot: "1d6bde094241e23bfaf69109b787d6fce314c35bd96ee866987bb257ff4fac06",
};
const EXPECTED_PID = 16492;

// Compiled into the immutable guard's own lexical bindings. The original
// registry reader has already checked UUIDs, unique owners and canonical roots.
function assertEmptyAliasJournalAbsence(ids) {
	assert(fs.lstatSync(journalRoot).isDirectory() && !fs.lstatSync(journalRoot).isSymbolicLink());
	let entries = 0;
	function visit(directory, depth) {
		assert(depth <= 2);
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			assert(++entries <= 50000, "Empty alias journal inventory exceeded its bound.");
			const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
			assert(!stat.isSymbolicLink(), "Empty alias journal inventory refuses redirected paths.");
			if (stat.isDirectory()) { if (depth < 2) visit(file, depth + 1); }
			else if (stat.isFile() && entry.name.endsWith(".jsonl"))
				assert(!ids.has(entry.name.slice(0, -6)), "An empty alias has an old or new durable SDK journal.");
		}
	}
	visit(journalRoot, 0);
}
function assertEmptyAliasSession(session) {
	assert(session && session.harness === "namzu" && session.partial === false);
	assert(Array.isArray(session.messages) && session.messages.length === 0, "Only empty SDK public histories can rotate.");
	const turns = session.thread?.turns;
	assert(session.thread && session.thread.turn === 0 && turns && typeof turns === "object" && !Array.isArray(turns) &&
		Object.getPrototypeOf(turns) === Object.prototype && Object.keys(turns).length === 0,
		"Empty alias has authored turn evidence.");
	assert(!session.thread.running && !session.thread.responding);
	for (const field of ["timeline", "messages", "tasks", "queued", "queuedItems", "liveInputs", "activeToolIds", "permissions"])
		assert(Array.isArray(session.thread[field]) && session.thread[field].length === 0, "Empty alias has activity evidence.");
	for (const field of ["tools", "reasoning"]) {
		const record = session.thread[field];
		assert(record && typeof record === "object" && !Array.isArray(record) &&
			Object.getPrototypeOf(record) === Object.prototype && Object.keys(record).length === 0,
			"Empty alias has tool/reasoning evidence.");
	}
	for (const field of ["activeReasoningId", "retry", "error", "stopReason"])
		assert.equal(session.thread[field], undefined, "Empty alias has terminal/retry evidence.");
}
function verifyRuntimeAliasRotations(state, aliases, registry) {
	const previousAliases = receipt.runtimeAliases;
	assert(previousAliases && before && Array.isArray(before.sessions), "Supplement requires the exact original snapshot.");
	assert.deepEqual(Object.keys(aliases).sort(), Object.keys(previousAliases).sort(), "SDK public owners changed.");
	const oldIds = new Set(Object.values(previousAliases).map(alias => alias.runtimeId));
	assert.equal(oldIds.size, Object.keys(previousAliases).length, "Original runtime aliases are ambiguous.");
	const absent = new Set(), rotations = [];
	for (const [id, alias] of Object.entries(aliases)) {
		const previous = previousAliases[id];
		if (alias.runtimeId === previous.runtimeId) {
			assert.deepEqual(alias, previous, "An unchanged runtime crossed its owner/project scope.");
			continue;
		}
		assert.deepEqual({ ...alias, runtimeId: previous.runtimeId }, previous, "Rotated alias crossed its original owner/project scope.");
		assert(!alias.pal && alias.harness === "namzu", "Pal/native harness rotations are outside this supplement.");
		assert(!oldIds.has(alias.runtimeId), "Rotated runtime reuses another original owner.");
		const oldSessions = before.sessions.filter(session => session.id === id);
		const newSessions = state.sessions.filter(session => session.id === id);
		assert.equal(oldSessions.length, 1); assert.equal(newSessions.length, 1);
		assertEmptyAliasSession(oldSessions[0]); assertEmptyAliasSession(newSessions[0]);
		assert.equal(oldSessions[0].projectId, alias.projectId); assert.equal(newSessions[0].projectId, alias.projectId);
		const rows = registry.conversations.filter(row => row.view.id === id);
		assert.equal(rows.length, 1); assert.equal(rows[0].hasPrompted, false, "Rotated runtime has been prompted.");
		assert.equal(rows[0].runtimeSessionId, alias.runtimeId);
		assert(!Object.hasOwn(supplementOriginalJournals, previous.runtimeId) && !Object.hasOwn(supplementOriginalJournals, alias.runtimeId),
			"An original authored journal cannot rotate.");
		assert(!Object.hasOwn(receipt.aliasMessageProofs, id), "An authored public message proof cannot rotate.");
		absent.add(previous.runtimeId); absent.add(alias.runtimeId);
		rotations.push({ publicId: id, beforeRuntimeId: previous.runtimeId, afterRuntimeId: alias.runtimeId,
			beforeMessages: 0, afterMessages: 0, currentHasPrompted: false, oldAndNewJournalAbsent: true });
	}
	assert(rotations.length > 0 && rotations.length <= 32, "Supplement requires bounded proved empty-slot rotations.");
	assertEmptyAliasJournalAbsence(absent);
	if (receipt.emptyRuntimeAliasRotations) assert.deepEqual(rotations, receipt.emptyRuntimeAliasRotations,
		"Runtime aliases changed during read-only verification.");
	else receipt.emptyRuntimeAliasRotations = rotations;
	// Only the current lookup IDs change; authored IDs/body/clock proofs remain
	// strict, and all public state/presentation comparisons run unchanged.
	receipt.runtimeAliases = aliases;
}
function adaptEmptyAliasSupplement(input) {
	let code = input;
	const replace = (before, after) => { assert.equal(code.split(before).length, 2, "Reviewed supplemental seam changed."); code = code.replace(before, after); };
	const helpers = [assertEmptyAliasJournalAbsence, assertEmptyAliasSession, verifyRuntimeAliasRotations].map(fn => fn.toString()).join("\n");
	replace("function readRuntimeAliases(state) {", `let supplementOriginalJournals;\n${helpers}\nfunction readRuntimeAliases(state) {`);
	replace('if (receipt.runtimeAliases) assert.deepEqual(aliases, receipt.runtimeAliases, "Public/runtime/project ownership changed across activation.");',
		"if (receipt.runtimeAliases) verifyRuntimeAliasRotations(state, aliases, registry);");
	const previousSeam = "      const completedApplication = previous.phase === 'verify' &&\n        Number.isInteger(previous.cliModuleCopies) && previous.cliModuleCopies > 0 &&\n        previous.cliModuleCopies === previousChangedCli.length &&\n        previous.cliReviewedModules.length === cliModules.length &&\n        previous.sdkReviewedModules.length === sdkModules.length && previous.sdkCopies === previousChangedSdk.length;";
	replace(previousSeam, `      // Specific already-applied Desktop-only failure; derive only missing
      // zero-copy after-manifest bookkeeping in memory, retaining the old file.
      assert.equal(mode, '--verify-current'); assert.equal(expectedChangedRuntimeSet.length, 0);
      assert.equal(hash(previousBytes), '${PINS.failedReceipt}', 'Original failed receipt changed.');
      assert.equal(previous.passed, false); assert.equal(previous.phase, 'verify');
      assert.equal(previous.beforePid, 35180); assert.equal(previous.afterPid, undefined);
      assert.equal(previous.cliModuleCopies, 0); assert.equal(previous.sdkCopies, 0);
      assert.equal(previousChangedCli.length, 0); assert.equal(previousChangedSdk.length, 0);
      assert.equal(previous.cliReviewedModules.length, 7); assert.equal(cliModules.length, 7);
      assert.equal(previous.sdkReviewedModules.length, 2); assert.equal(sdkModules.length, 2);
      assert.equal(previous.ownedProcessesConfirmedClosed, true); assert.equal(previous.close?.status, 0);
      assert.equal(previous.error?.name, 'AssertionError');
      assert(previous.error.message.startsWith('Public/runtime/project ownership changed across activation.'));
      assert.deepEqual(previous.checks, [
        'applied 0 changed CLI and 0 changed SDK module(s) after graceful close; reviewed 7 CLI and 2 SDK module(s)',
        'staged complete built desktop and retained old dist as backup',
      ]);
      assert.equal(previous.privateSnapshot, 'removal-before-private-20261007T100907852Z.json');
      const snapshotProofFile = path.join(root, previous.privateSnapshot);
      assertConfinedFile(snapshotProofFile);
      assert(!fs.lstatSync(snapshotProofFile).isSymbolicLink());
      assert.equal(hash(fs.readFileSync(snapshotProofFile)), '${PINS.privateSnapshot}', 'Original private snapshot changed.');
      assert(previous.backupDirectory && path.basename(previous.backupDirectory) === previous.backupDirectory);
      const originalDistBackup = path.join(config.app, previous.backupDirectory);
      assert(fs.lstatSync(originalDistBackup).isDirectory() && !fs.lstatSync(originalDistBackup).isSymbolicLink());
      assert.deepEqual(Object.keys(previous.before).sort(), Object.keys(previous.after).sort());
      for (const key of Object.keys(previous.before)) if (key !== 'presentation')
        assert.equal(previous.before[key], previous.after[key], 'An unrelated protected field failed during apply.');
      assert.equal(Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim()), ${EXPECTED_PID},
        'Only the same already-applied native process may be verified.');
      for (const kind of ['cli', 'sdk']) {
        const reviewed = previous[kind + 'ReviewedModules'], files = new Set();
        for (const item of reviewed) {
          assert(!files.has(item.file)); files.add(item.file);
          assert(/^[a-f0-9]{64}$/.test(item.beforeSha256)); assert.equal(item.beforeSha256, item.afterSha256);
        }
        const prior = previous[kind + 'ManifestBeforeSha256']; assert(/^[a-f0-9]{64}$/.test(prior));
        assert.equal(previous[kind + 'ManifestAfterSha256'], undefined);
        previous[kind + 'ManifestAfterSha256'] = prior;
      }
      supplementOriginalJournals = previous.durableJournals;
      assert(supplementOriginalJournals && Object.keys(supplementOriginalJournals).length === 2);
      receipt.supplementalVerification = {
        originalGuardSha256: '${PINS.original}', adapterSha256: '${PINS.adapter}', aliasGuardSha256: '${PINS.aliasGuard}',
        originalFailedReceiptSha256: '${PINS.failedReceipt}', originalPrivateSnapshotSha256: '${PINS.privateSnapshot}',
        emptyRotationEvidence: 'Original zero-message/zero-turn snapshot and no recorded journal; current explicit unprompted row and empty history; old/new journals absent in bounded canonical SDK inventory; exact unchanged public/project/harness/pal/canonical paths.',
        beforeHasPromptedCaptured: false,
        zeroCopyBookkeeping: 'Nine reviewed before/after hashes equal; derive missing after-manifest hashes from exact before manifests only in memory.',
        presentationException: false,
      };
      const completedApplication = true;`);
	// Freeze the exact state used to validate aliases before any subsequent
	// journal read. This also captures the current process ownership twice.
	replace("      const after = await readState();\n      assertComputersQuiescent(after);\n      receipt.beforePid",
		`      const after = await readState();\n      assertComputersQuiescent(after);\n      assert.equal(Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim()), ${EXPECTED_PID});\n      receipt.beforePid`);
	return code;
}

if (!process.argv.includes("--execute-reviewed-empty-alias-verify") || process.env.NAMZU_NATIVE_EMPTY_ALIAS_VERIFY !== "1") {
	console.log(JSON.stringify({ preparedOnly: true, readOnly: true, requires: "NAMZU_NATIVE_EMPTY_ALIAS_VERIFY=1 and --execute-reviewed-empty-alias-verify plus --verify-current --desktop-only --verify-from=<pinned failed receipt> and inherited source/output arguments", expectedPid: EXPECTED_PID, actionsPerformed: 0,
		changes: "Only bounded empty/unprompted runtime slots may rotate; exact authored journal/message/clock and protected presentation checks remain. Missing zero-copy after manifests are derived only in memory.", pins: PINS }));
} else {
	assert.equal(process.platform, "win32");
	for (const flag of ["--execute-reviewed-empty-alias-verify", "--verify-current", "--desktop-only"])
		assert.equal(process.argv.filter(arg => arg === flag).length, 1);
	assert(!process.argv.includes("--apply-reviewed") && !process.argv.includes("--prepare-only") && !process.argv.includes("--execute-reviewed-alias"));
	const from = process.argv.filter(arg => arg.startsWith("--verify-from="));
	assert.equal(from.length, 1); assert.equal(path.basename(from[0].slice("--verify-from=".length)), "transcript-motion-alias-apply-private-20261007-v1.json");
	for (const [file, pin] of [[original, PINS.original], [adapter, PINS.adapter], [aliasGuard, PINS.aliasGuard]])
		assert.equal(sha(fs.readFileSync(file)), pin, "An inherited immutable helper changed.");
	process.argv = process.argv.filter(arg => arg !== "--execute-reviewed-empty-alias-verify");
	process.argv.push("--execute-reviewed-alias"); process.env.NAMZU_NATIVE_ALIAS_ACTIVATION = "1";
	const compile = Module.prototype._compile;
	let seams = 0;
	Module.prototype._compile = function(code, filename) {
		if (path.resolve(filename) !== original) return compile.call(this, code, filename);
		assert.equal(++seams, 1); Module.prototype._compile = compile;
		return compile.call(this, adaptEmptyAliasSupplement(code), filename);
	};
	try { require(aliasGuard); assert.equal(seams, 1); }
	finally { Module.prototype._compile = compile; }
}
