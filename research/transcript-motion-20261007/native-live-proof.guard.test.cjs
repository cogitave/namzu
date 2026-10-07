"use strict";
// Pure driver ownership checks. No native renderer, provider or wall clock.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const file = path.join(__dirname, "native-live-proof.cjs");
const context = { require, process: { argv: ["node", file], env: {} }, console: { log() {} }, structuredClone };
vm.runInNewContext(fs.readFileSync(file, "utf8") + "\nglobalThis.guards = { activatedWorkspace, assertExpectedUi, restoreOriginal };", context, { filename: file });
const { activatedWorkspace, assertExpectedUi, restoreOriginal } = context.guards;
const baseline = () => ({ sequence: 10, windowId: "window", layout: { windows: [{ id: "window", focusedGroupId: "group", root: { kind: "group", id: "group", tabs: ["first", "second"], activeTabId: "first" } }] } });
function readonlyPage(workspace, focusedNonemptyEditor = false) {
	let mutations = 0, historyReads = 0;
	return {
		get mutations() { return mutations; }, get historyReads() { return historyReads; },
		evaluate: async callback => {
			if (callback.toString().includes("focusedNonemptyEditor")) return { workspace, focusedNonemptyEditor };
			historyReads += 1;
			throw new Error("Unexpected history read after lost UI ownership.");
		},
		locator() { mutations += 1; throw new Error("Unexpected UI mutation after lost ownership."); }
	};
}

test("focused saved input still prevents taking the user's UI", async () => {
	const workspace = baseline();
	await assert.rejects(assertExpectedUi(readonlyPage(workspace, true), workspace, { rejectFocusedDraft: true }), /user-owned input/);
});

test("same layout with a changed snapshot sequence refuses before new UI work", async () => {
	const expected = baseline(), actual = structuredClone(expected);
	actual.sequence += 1;
	await assert.rejects(assertExpectedUi(readonlyPage(actual), expected, { sequence: true }), /changed after the protected snapshot/);
});

test("expected new tab is derived from the baseline, not accepted from current UI", () => {
	const original = baseline();
	const planned = activatedWorkspace(original, "group", "owned", true);
	assert.deepEqual(planned.layout.windows[0].root.tabs, ["first", "second", "owned"]);
	assert.equal(planned.layout.windows[0].root.activeTabId, "owned");
	assert.equal(original.layout.windows[0].root.activeTabId, "first");
	assert.deepEqual(original.layout.windows[0].root.tabs, ["first", "second"]);
});

test("user navigation during provider work retains actual focus and owned tab", async () => {
	const original = baseline();
	const expected = activatedWorkspace(original, "group", "owned", true);
	const actual = activatedWorkspace(expected, "group", "second");
	const page = readonlyPage(actual);
	const receipt = { privateExpectedWorkspace: expected };
	await restoreOriginal(page, { workspace: original }, { sessionId: "owned", groupId: "group" }, receipt);
	assert.equal(page.mutations, 0);
	assert.equal(page.historyReads, 0);
	assert.equal(receipt.restorationSkippedUnexpectedNavigation, true);
	assert.equal(receipt.ownedTabRetainedForManualReview, true);
	assert.equal(receipt.originalLayoutRestored, false);
	assert.equal(actual.layout.windows[0].root.activeTabId, "second");
	assert(actual.layout.windows[0].root.tabs.includes("owned"));
});

test("human input on the owned pane prevents cleanup from closing its tab", async () => {
	const original = baseline(), expected = activatedWorkspace(original, "group", "owned", true);
	const page = readonlyPage(expected, true), receipt = { privateExpectedWorkspace: expected };
	await restoreOriginal(page, { workspace: original }, { sessionId: "owned", groupId: "group" }, receipt);
	assert.equal(page.mutations, 0);
	assert.equal(page.historyReads, 0);
	assert.equal(receipt.ownedTabRetainedForManualReview, true);
	assert.equal(receipt.originalLayoutRestored, false);
});

test("preflight failure never restores an older tab after user navigation", async () => {
	const original = baseline(), actual = activatedWorkspace(original, "group", "second");
	const page = readonlyPage(actual), receipt = { privateExpectedWorkspace: original };
	await restoreOriginal(page, { workspace: original }, undefined, receipt);
	assert.equal(page.mutations, 0);
	assert.equal(page.historyReads, 0);
	assert.equal(receipt.restorationSkippedUnexpectedNavigation, true);
	assert.equal(actual.layout.windows[0].root.activeTabId, "second");
});
