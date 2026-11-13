// The frame obeys one rhythm, measured in the real app at 1280 by 820: both headers are 44 high and end
// on one y (with the strip of tabs and with the conversation bar, and in Settings), every sidebar row is
// 32 high with its label at x 40, and the foot is 48 high with 32 buttons.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-frame-measures.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const RULES = [{ match: /hello/, steps: [{ text: "Hello there." }] }];

async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [wide, high]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(wide, high);
		},
		[width, height],
	);
	await expect.poll(() => w.page.evaluate((x) => Math.abs(window.innerWidth - x), width), { timeout: T }).toBeLessThanOrEqual(2);
}

/** What the page has settled on: the animations of the grid have finished. */
const settled = (w) =>
	w.page.evaluate(() =>
		Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
	);

/** Where the first letter of an element's own text is drawn, and the box of the element. */
const MEASURE = () => {
	const rect = (el) => {
		if (!el) return null;
		const b = el.getBoundingClientRect();
		return { x: b.left, y: b.top, w: b.width, h: b.height, bottom: b.bottom };
	};
	const labelX = (el) => {
		const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
		if (!text) return null;
		const range = document.createRange();
		range.selectNodeContents(text);
		return range.getBoundingClientRect().left;
	};
	const row = (el, label) => (el && label ? { ...rect(el), label: labelX(label) } : null);
	const q = (s) => document.querySelector(s);
	const heading = q(".sidebar-project-heading");
	const foot = [...document.querySelectorAll(".sidebar-foot")].find((f) => f.getBoundingClientRect().height > 0);
	const conv = q("li[data-thread-item] .sidebar-conversation-button");
	return {
		chrome: rect(q(".sidebar-chrome")),
		topbar: rect(q(".topbar")),
		settingsHeader: rect(q(".plugins-sidebar-header")),
		newConversation: row(q(".sidebar-new-conversation"), q(".sidebar-new-conversation")),
		project: heading ? row(heading, heading.querySelector(".sidebar-project-name")) : null,
		conversation: conv ? row(conv, conv.querySelector(".conversation-row-title")) : null,
		mark: rect(q("li[data-thread-item] .conversation-row-mark")),
		settingsRows: [...document.querySelectorAll(".settings-sidebar-navigation button")].map((b) => row(b, b.querySelector("span"))),
		foot: rect(foot),
		footButtons: foot ? [...foot.querySelectorAll("button")].map(rect) : [],
		windowHeight: window.innerHeight,
		tabs: rect(q(".conversation-tab")),
	};
};

async function checkFrame(w, tag, { tabs }) {
	await expect(w.page.locator(".sidebar-chrome")).toBeVisible({ timeout: T });
	await settled(w);
	const m = await w.page.evaluate(MEASURE);
	assert.equal(m.chrome.h, 44, `${tag}: the sidebar header is 44 high`);
	assert.equal(m.topbar.h, 44, `${tag}: the top bar is 44 high`);
	assert.equal(m.chrome.bottom, m.topbar.bottom, `${tag}: the two headers end on one y`);
	assert.equal(m.newConversation.h, 32, `${tag}: the New conversation row is 32 high`);
	assert.equal(m.newConversation.label, 40, `${tag}: its label starts at x 40`);
	assert.equal(m.newConversation.x, 8, `${tag}: it is inset 8 from the sidebar's edge`);
	assert.equal(m.project.h, 32, `${tag}: a project row is 32 high`);
	assert.equal(m.project.label, 40, `${tag}: its name starts at x 40`);
	assert.equal(m.conversation.h, 32, `${tag}: a conversation row is 32 high`);
	assert.equal(m.conversation.label, 40, `${tag}: its title starts at x 40`);
	assert.equal(m.conversation.x, 8, `${tag}: a conversation row is inset 8 as well`);
	assert.equal(m.mark.w, 16, `${tag}: the state mark's slot is 16 wide`);
	assert.equal(m.mark.x, 16, `${tag}: the slot starts at x 16`);
	assert.equal(m.foot.h, 48, `${tag}: the foot is 48 high`);
	assert.equal(m.foot.bottom, m.windowHeight, `${tag}: the foot ends the window`);
	for (const b of m.footButtons) assert.equal(b.h, 32, `${tag}: a foot button is 32 high`);
	if (tabs) {
		assert.equal(m.tabs.h, 32, `${tag}: a tab is 32 high`);
		assert.equal(m.tabs.y - m.topbar.y, 6, `${tag}: a tab sits 6 below the top of the header`);
	}
	return m;
}

for (const tabs of ["shown", "hidden"]) {
	test(`the frame holds its numbers with ${tabs === "shown" ? "the strip of tabs" : "the conversation bar"}`, { timeout: 280000 }, async () => {
		const w = await createWorld({ tabs, rules: RULES });
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			await size(w, 1280, 820);
			await send(w, "hello there");
			await expect(w.page.getByText("Hello there.").first()).toBeVisible({ timeout: T });
			const conversation = await checkFrame(w, `${tabs} conversation`, { tabs: tabs === "shown" });

			// Settings: its sidebar header is the same 44 and ends on the same y; its rows follow the same rhythm.
			await w.page.locator(".sidebar-foot").getByRole("button", { name: "Settings", exact: true }).click();
			await expect(w.page.getByRole("navigation", { name: "Settings sections" })).toBeVisible({ timeout: T });
			await settled(w);
			const settings = await w.page.evaluate(MEASURE);
			assert.equal(settings.settingsHeader.h, 44, "Settings: the header is 44 high");
			assert.equal(settings.settingsHeader.bottom, conversation.chrome.bottom, "Settings: the header ends where the conversation's does");
			assert.ok(settings.settingsRows.length > 0, "Settings lists its sections");
			for (const row of settings.settingsRows) {
				assert.equal(row.h, 32, "Settings: a section row is 32 high");
				assert.equal(row.label, 40, "Settings: its label starts at x 40");
			}
			assert.equal(settings.foot.h, 48, "Settings: the foot is 48 high");
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});
}

test("the collapsed rail's buttons are 32 high", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden", rules: RULES });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
		await expect(w.page.locator(".app")).toHaveAttribute("data-sidebar-collapsed", "true", { timeout: T });
		await settled(w);
		const rail = await w.page.evaluate(() => {
			const r = document.querySelector(".navigation-rail").getBoundingClientRect();
			return { w: r.width, buttons: [...document.querySelectorAll(".navigation-rail button")].map((b) => { const x = b.getBoundingClientRect(); return { w: x.width, h: x.height }; }) };
		});
		assert.equal(Math.round(rail.w), 48, "the rail is 48 wide");
		assert.ok(rail.buttons.length >= 2, "the rail has its buttons");
		for (const b of rail.buttons) assert.deepEqual(b, { w: 32, h: 32 });
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
