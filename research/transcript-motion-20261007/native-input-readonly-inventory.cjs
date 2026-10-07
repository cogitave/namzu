"use strict";
// Existing focused pane metadata only; no bodies, input, focus or host writes.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
assert.equal(process.platform, "win32");
(async () => {
	const dev = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const config = JSON.parse(fs.readFileSync(path.join(dev, "launch.json"), "utf8"));
	const pid = Number(fs.readFileSync(path.join(dev, "desktop.pid"), "utf8").trim());
	assert.equal(pid, 35180); process.kill(pid, 0);
	const port = Number(fs.readFileSync(path.join(process.env.APPDATA, "Namzu", "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]);
	assert(Number.isInteger(port) && port > 0 && port < 65536);
	const { chromium } = require(path.join(dev, "runtime/packages/p39"));
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
	try {
		const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === new URL(config.url).href);
		assert.equal(pages.length, 1);
		const result = await pages[0].evaluate(async () => {
			const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(number => number.toString(16).padStart(2, "0")).join("");
			const api = window.namzu, workspace = await api.workspace();
			const visit = node => !node ? [] : node.kind === "group" ? [node] : [...visit(node.first), ...visit(node.second)];
			const win = workspace.layout.windows.find(row => row.id === workspace.windowId), owner = visit(win?.root).find(group => group.id === win.focusedGroupId);
			if (!owner?.activeTabId) throw new Error("Focused conversation owner unavailable.");
			const pane = [...document.querySelectorAll("[data-workspace-group]")].find(item => item.dataset.workspaceGroup === owner.id);
			if (!pane) throw new Error("Focused pane unavailable.");
			const nodes = [...pane.querySelectorAll("textarea, input")];
			if (nodes.length > 128) throw new Error("Input inventory exceeds bound.");
			const controls = [];
			for (const node of nodes) {
				const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
				controls.push({ tag: node.tagName, type: node instanceof HTMLInputElement ? node.type : "textarea", ariaName: node.getAttribute("aria-label"), ariaLabelledBy: node.getAttribute("aria-labelledby"), role: node.getAttribute("role"), valueLength: node.value.length, valueSha256: await digest(node.value), visible: node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !node.closest('[inert], [aria-hidden="true"]'), focused: document.activeElement === node, disabled: node.disabled, inComposerInput: Boolean(node.closest(".composer-input")), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, display: style.display, visibility: style.visibility });
			}
			const finalWorkspace = await api.workspace();
			const finalWin = finalWorkspace.layout.windows.find(row => row.id === finalWorkspace.windowId), finalOwner = visit(finalWin?.root).find(group => group.id === finalWin.focusedGroupId);
			return { readOnly: true, uiActions: 0, providerRequests: 0, draftApiReads: 0, bodyReads: 0, owner: { groupId: owner.id, activeId: owner.activeTabId }, ownerUnchanged: owner.id === finalOwner?.id && owner.activeTabId === finalOwner?.activeTabId, typeCounts: controls.reduce((counts, item) => { const key = `${item.tag}:${item.type}`; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}), controls };
		});
		console.log(JSON.stringify(result));
	} finally { await browser.close(); }
})().catch(error => { console.error(JSON.stringify({ readOnly: true, failed: true, errorType: error.name })); process.exitCode = 1; });
