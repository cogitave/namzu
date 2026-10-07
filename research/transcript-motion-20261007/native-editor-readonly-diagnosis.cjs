"use strict";
// Existing app only. No input, focus, navigation, draft write, prompt or model.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
assert.equal(process.platform, "win32");
(async () => {
	const dev = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const config = JSON.parse(fs.readFileSync(path.join(dev, "launch.json"), "utf8"));
	const port = Number(fs.readFileSync(path.join(process.env.APPDATA, "Namzu", "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]);
	const { chromium } = require(path.join(dev, "runtime/packages/p39"));
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	try {
		const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === new URL(config.url).href);
		assert.equal(pages.length, 1);
		const result = await pages[0].evaluate(async () => {
			const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(number => number.toString(16).padStart(2, "0")).join("");
			const api = window.namzu, workspace = await api.workspace();
			const visit = node => !node ? [] : node.kind === "group" ? [node] : [...visit(node.first), ...visit(node.second)];
			const win = workspace.layout.windows.find(row => row.id === workspace.windowId), groups = visit(win.root);
			const focused = groups.find(group => group.id === win.focusedGroupId);
			const rows = [];
			for (const project of (await api.projects()).filter(row => row.status === "ready")) rows.push(...await api.conversations(project.id));
			if (rows.length > 1000) throw new Error("Inventory exceeds bound.");
			const editors = [...document.querySelectorAll('textarea[aria-label="Message Namzu"]')], comparison = [];
			for (const row of rows) {
				const matches = editors.filter(input => input.closest("[data-workspace-group]")?.querySelector(`[data-tab-id="${CSS.escape(row.id)}"][data-active="true"]`));
				if (!matches.length) continue;
				const draft = await api.draft(row.id), nodes = [];
				for (const editor of matches) {
					const groupId = editor.closest("[data-workspace-group]")?.dataset.workspaceGroup;
					const group = groups.find(item => item.id === groupId), style = getComputedStyle(editor), rect = editor.getBoundingClientRect();
					nodes.push({ groupId, layoutActiveId: group?.activeTabId ?? null, isFocusedGroup: groupId === win.focusedGroupId, rowIsLayoutActive: row.id === group?.activeTabId, editorValueLength: editor.value.length, editorSha256: await digest(editor.value), equal: editor.value === draft, editorVisible: editor.getClientRects().length > 0, checkVisibility: editor.checkVisibility({ opacityProperty: true, visibilityProperty: true }), display: style.display, visibility: style.visibility, width: rect.width, height: rect.height, editorDisabled: editor.disabled, inComposerInput: !!editor.closest(".composer-input"), inertAncestor: !!editor.closest("[inert]"), ariaHiddenAncestor: !!editor.closest('[aria-hidden="true"]'), tag: editor.tagName });
				}
				comparison.push({ historicalRowId: row.id, rowHarness: row.harness ?? "namzu", rowIsPal: !!row.palId, savedDraftLength: draft.length, savedDraftSha256: await digest(draft), matchedTextareas: nodes });
			}
			return { readOnly: true, uiActions: 0, focus: { groupId: focused?.id, activeId: focused?.activeTabId }, comparison, editorCount: editors.length, perOwner: groups.map(group => ({ groupId: group.id, activeId: group.activeTabId, textareas: editors.filter(input => input.closest("[data-workspace-group]")?.dataset.workspaceGroup === group.id).length })) };
		});
		console.log(JSON.stringify(result));
	} finally { await browser.close(); }
})().catch(error => { console.error(JSON.stringify({ failed: true, errorType: error.name })); process.exitCode = 1; });
