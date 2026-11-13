// The input box and the home screen obey the layout numbers, measured in the real app: the empty box is
// one row 44 high with 14 corners, the send control exists only when there is something to send, the row
// sits 8 under the box and 16 above the window's edge, the box does not move by a pixel when the first
// message is sent, the heading and the starters are one block centred above the dock, and the gutter is
// 20 (16 in a pane narrower than 560). Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-composer-measures.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject } from "./harness.mjs";

const T = 60000;
const RULES = [{ match: /hello/, steps: [{ text: "Hello there." }] }];

async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [wide, high]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(wide, high);
		},
		[width, height],
	);
	await expect
		.poll(() => w.page.evaluate(([x, y]) => Math.abs(window.innerWidth - x) + Math.abs(window.innerHeight - y), [width, height]), { timeout: T })
		.toBeLessThanOrEqual(4);
}

/** What the page has settled on: the animations have finished. */
const settled = (w) =>
	w.page.evaluate(() =>
		Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
	);

const MEASURE = () => {
	const rect = (el) => {
		if (!el) return null;
		const b = el.getBoundingClientRect();
		return { x: b.left, y: b.top, w: b.width, h: b.height, bottom: b.bottom, right: b.right };
	};
	const q = (s) => document.querySelector(s);
	const host = q('[data-slot="composer-host"]');
	const heading = q("[data-composer-heading]");
	return {
		box: rect(host),
		radius: host ? getComputedStyle(host).borderTopLeftRadius : null,
		row: rect(q("[data-composer-row]")),
		dock: rect(q("[data-composer-dock]")),
		heading: heading && getComputedStyle(heading).visibility !== "hidden" ? { ...rect(heading), font: getComputedStyle(heading).fontSize } : null,
		starters: rect(q(".starter-actions")),
		startersVisible: !!q(".starter-actions") && getComputedStyle(q(".starter-actions")).display !== "none",
		home: rect(q(".composer-home")),
		plus: rect(q(".composer-add")),
		sends: [...document.querySelectorAll('[data-chat-composer-main-surface] button[aria-label="Send message"]')].map(rect),
		text: rect(q(".composer-input textarea")),
		stack: rect(q("[data-chat-composer-stack]")),
		lane: rect(q(".conversation-lane")),
		window: { w: window.innerWidth, h: window.innerHeight },
	};
};

test("the box is one row of 44 with 14 corners; send appears with text; the home keeps the box where a conversation has it", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden", rules: RULES });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		const input = w.page.getByRole("textbox", { name: "Message Namzu" });
		await expect(input).toBeVisible({ timeout: T });
		await expect(w.page.locator(".starter-actions button")).toHaveCount(3, { timeout: T });
		await settled(w);

		const home = await w.page.evaluate(MEASURE);
		assert.equal(home.box.h, 44, "the empty box is 44 high");
		assert.equal(home.radius, "14px", "its corners are 14");
		assert.equal(home.sends.length, 0, "an empty box has no send control");
		assert.equal(home.plus.w, 28, "the plus is 28 wide");
		assert.equal(home.plus.h, 28, "the plus is 28 high");
		assert.equal(home.plus.x - home.box.x, 8, "the plus sits 8 inside the box");
		assert.equal(home.plus.y - home.box.y, 8, "and 8 below its top");
		assert.equal(home.row.y - home.box.bottom, 8, "the row's top is 8 under the box");
		assert.equal(home.window.h - home.row.bottom, 16, "the row ends 16 above the window's edge");
		assert.equal(home.box.y, home.dock.y, "the box is the top of the dock");
		assert.equal(home.dock.bottom, home.window.h, "the dock rests on the bottom of the window");
		assert.equal(home.box.w, 768, "the column is 768");
		assert.equal(Math.round(home.box.x - home.lane.x), Math.round(home.lane.right - home.box.right), "the column is centred");

		// The heading and the starters are one block, centred in the free area above the dock, 16 apart.
		assert.ok(home.heading, "the heading is drawn");
		assert.ok(home.startersVisible, "the starters are drawn");
		assert.equal(home.starters.y - home.heading.bottom, 16, "the starters are 16 under the heading");
		const blockTop = home.heading.y;
		const blockBottom = home.starters.bottom;
		const free = { top: home.lane.y, bottom: home.dock.y };
		assert.ok(Math.abs(blockTop - free.top - (free.bottom - blockBottom)) <= 1, "the block is centred vertically in the free area");
		const lane = home.lane;
		assert.ok(Math.abs(home.heading.x + home.heading.w / 2 - (lane.x + lane.w / 2)) <= 1, "the heading is centred across the pane");
		assert.ok(Math.abs(home.starters.x + home.starters.w / 2 - (lane.x + lane.w / 2)) <= 1, "the starters are centred across the pane");

		// One letter brings the send control: 28, at the right, and nothing else moves.
		await input.pressSequentially("x");
		await expect(w.page.getByRole("button", { name: "Send message" })).toHaveCount(1, { timeout: T });
		await settled(w);
		const typed = await w.page.evaluate(MEASURE);
		assert.equal(typed.sends.length, 1, "one send control is in the box");
		assert.equal(typed.sends[0].w, 28);
		assert.equal(typed.sends[0].h, 28);
		assert.equal(typed.box.right - typed.sends[0].right, 8, "it sits 8 inside the right edge");
		assert.deepEqual(typed.box, home.box, "typing a letter does not move the box");
		assert.deepEqual(typed.heading, home.heading, "nor the heading");
		await input.fill("");
		await expect(w.page.getByRole("button", { name: "Send message" })).toHaveCount(0, { timeout: T });

		// A line that wraps sends the controls to a second row under the text.
		await input.fill("a line\nand another");
		await expect.poll(() => w.page.locator('[data-chat-composer-main-surface]').getAttribute("data-expanded")).toBe("true");
		const wrapped = await w.page.evaluate(MEASURE);
		assert.ok(wrapped.plus.y >= wrapped.text.bottom, "the plus is under the text");
		assert.ok(wrapped.sends[0].y >= wrapped.text.bottom, "so is the send control");
		assert.equal(wrapped.box.bottom, home.box.bottom, "the box grows upward: its bottom stays");
		await input.fill("");
		await expect.poll(() => w.page.locator('[data-chat-composer-main-surface]').getAttribute("data-expanded")).toBe("false");

		// The first message does not move the box by a pixel.
		await input.fill("hello there");
		await input.press("Enter");
		await expect(w.page.getByText("Hello there.").first()).toBeVisible({ timeout: T });
		await settled(w);
		const after = await w.page.evaluate(MEASURE);
		assert.deepEqual(after.box, home.box, "the box's rectangle is the same after the first message");
		assert.deepEqual(after.row, home.row, "so is the row's");
		assert.equal(after.heading, null, "the heading is gone");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("a short window gives up the starters, then the heading steps down; the gutter closes under a 560 pane", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden", rules: RULES });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await expect(w.page.locator(".starter-actions button")).toHaveCount(3, { timeout: T });

		// Pane 612 wide: the gutter is 20. Pane 512 wide: 16.
		await size(w, 900, 820);
		await settled(w);
		let m = await w.page.evaluate(MEASURE);
		assert.ok(m.lane.w >= 560, `the pane is ${m.lane.w} wide`);
		assert.equal(m.stack.x - m.lane.x, 20, "the gutter is 20");
		await size(w, 800, 820);
		await expect.poll(() => w.page.evaluate(() => document.querySelector(".conversation-lane").getBoundingClientRect().width), { timeout: T }).toBeLessThan(560);
		await settled(w);
		m = await w.page.evaluate(MEASURE);
		assert.ok(m.lane.w < 560, `the pane is ${m.lane.w} wide`);
		assert.equal(m.stack.x - m.lane.x, 16, "under 560 the gutter is 16");
		assert.ok(m.box.bottom <= m.window.h, "the box is inside the window");

		// A short pane (the window cannot be shorter than 460, a stacked pane can): the lane is made
		// that high. The block never overlaps the dock; the starters go first, then the heading steps down.
		await size(w, 1280, 820);
		for (const lane of [300, 260, 160, 140]) {
			await w.page.evaluate((h) => {
				const el = document.querySelector(".conversation-lane");
				el.style.flex = "none";
				el.style.height = `${h}px`;
			}, lane);
			await settled(w);
			m = await w.page.evaluate(MEASURE);
			const tag = `a pane ${lane} high (free area ${m.home.h})`;
			const bottom = m.startersVisible ? m.starters.bottom : m.heading ? m.heading.bottom : m.home.y;
			assert.ok(bottom <= m.dock.y, `${tag}: nothing of the block reaches the dock`);
			if (m.heading) assert.ok(m.heading.y >= m.home.y, `${tag}: the heading is whole inside the free area`);
			assert.equal(m.startersVisible, m.home.h >= 180, `${tag}: the starters go first`);
			if (m.heading) assert.equal(m.heading.font, m.home.h >= 68 ? "28px" : "20px", `${tag}: the heading steps down`);
			assert.equal(m.heading !== null, m.home.h >= 60, `${tag}: the heading is dropped only with no room`);
			assert.equal(m.box.h, 44, `${tag}: the box is still 44`);
		}
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
