// The transcript obeys the turn's layout numbers, measured in the real app. The text column is 736 wide
// (58 in from a pane of 600 or more, 42 in from a narrower one) on the input box's axis; the transcript
// starts 32 down; the person's message has 10 corners, 12 and 16 of padding, takes at most 80 percent of
// the column and is 34 above whatever follows; a reply's paragraphs are 12 apart, a list is a small square
// 13 in with its text 37 in and 4 between items, inline code is a chip 17 high; the folded row is 28 high
// with its chevron 7 after the last letter, 12 above the answer; the open block is 8 under it, has a
// hairline edge, rows 35 high and 20 above the answer; the working row is 28 high with a mark of four
// dots; the plan is one box in the flow under the message; the result line's counts are 13 px; the jump
// button is a 36 px circle 20 above the dock. Every vertical position is relative to a neighbour (the
// message's bottom, the row above), never to the window's top. Scripted model, no paid call.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-turn-measures.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 90000;
const REPLY =
	"I read the notes and the source file and found that the limit is set in one place only, which is why the change you asked for stays small and does not touch the callers that already pass a value of their own.\n\nThe second paragraph mentions `limit` inline, so the chip shows.\n\n- First item of the list\n- Second item with `code` inside it and enough words to run onto a second line when the column is narrow enough\n- Third item";
const LONG_MESSAGE = `hello ${"words ".repeat(120)}`;

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
const settled = (w) =>
	w.page
		.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
		.then(() => w.page.waitForTimeout(250));
const newConversation = (w) => w.page.getByRole("button", { name: "New conversation" }).first().click();

/** What the turn draws, read from the page: every box is { x, y, w, h, bottom, right }, every style is as computed. */
const measure = (w) =>
	w.page.evaluate(() => {
		const rect = (el) => {
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return { x: b.left, y: b.top, w: b.width, h: b.height, bottom: b.bottom, right: b.right };
		};
		const q = (s) => document.querySelector(s);
		const qa = (s) => [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().width > 0);
		const st = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null);
		const probe = (v) => {
			const e = document.createElement("i");
			e.style.color = `var(${v})`;
			document.body.append(e);
			const c = getComputedStyle(e).color;
			e.remove();
			return c;
		};
		const textRight = (el) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			return range.getBoundingClientRect().right;
		};
		const bubble = q(".message.user > .message-bubble");
		const user = q(".message.user");
		const trigger = q(".activity-trigger");
		const block = q(".activity-block");
		const reply = q(".message.assistant:not(.commentary) .chat-markdown");
		const list = reply?.querySelector("ul");
		const items = list ? [...list.children].filter((c) => c.tagName === "LI") : [];
		const before = items[0] ? getComputedStyle(items[0], "::before") : null;
		const paragraphs = reply ? [...reply.children].filter((c) => c.tagName === "P") : [];
		const chip = reply?.querySelector(":not(pre) > code");
		const working = qa(".working").find((e) => !e.classList.contains("transcript-status-only"));
		const planBox = q(".plan-box");
		const edge = block ? getComputedStyle(block).borderTopColor : null;
		return {
			win: { w: innerWidth, h: innerHeight },
			muted: probe("--muted-foreground"),
			text: probe("--foreground"),
			transcript: rect(q(".transcript")),
			transcriptPadTop: st(q(".transcript"), "padding-top"),
			column: rect(q(".transcript .conversation-body")),
			box: rect(q('[data-slot="composer-host"]')),
			dock: rect(q("[data-composer-dock]")),
			bubble: rect(bubble),
			bubbleStyle: bubble && { radius: st(bubble, "border-top-left-radius"), pt: st(bubble, "padding-top"), pb: st(bubble, "padding-bottom"), pl: st(bubble, "padding-left"), pr: st(bubble, "padding-right") },
			user: rect(user),
			userFooter: rect(q(".message.user > .message-footer")),
			userFooterOpacity: st(q(".message.user > .message-footer"), "opacity"),
			trigger: rect(trigger),
			triggerStyle: trigger && { fs: st(trigger, "font-size"), lh: st(trigger, "line-height"), color: st(trigger, "color") },
			triggerText: trigger && rect(trigger.querySelector(".activity-text")),
			triggerTextRight: trigger && textRight(trigger.querySelector(".activity-text")),
			chevron: rect(trigger?.querySelector(".fold-chevron")),
			chevronColor: st(trigger?.querySelector(".fold-chevron"), "color"),
			elapsedColor: st(trigger?.querySelector(".turn-activity-elapsed"), "color"),
			labelColor: st(trigger?.querySelector(".transcript-phase-text"), "color"),
			block: rect(block),
			blockStyle: block && { radius: st(block, "border-top-left-radius"), width: st(block, "border-top-width"), edge },
			rows: qa(".activity-block .tool-trigger").map(rect),
			rowText: qa(".activity-block .tool-main").map((e) => ({ x: rect(e).x, verb: st(e.querySelector(".tool-verb"), "color"), object: st(e, "color") })),
			reply: rect(reply),
			paragraphs: paragraphs.map(rect),
			paragraphStyle: paragraphs[0] && { fs: st(paragraphs[0], "font-size"), lh: st(paragraphs[0], "line-height") },
			items: items.map(rect),
			itemGap: items[1] ? st(items[1], "margin-top") : null,
			marker: before && { w: before.width, h: before.height, left: before.left, top: before.top, bg: before.backgroundColor, content: before.content },
			chip: rect(chip),
			chipStyle: chip && { fs: st(chip, "font-size"), ff: st(chip, "font-family"), radius: st(chip, "border-top-left-radius"), pl: st(chip, "padding-left"), pr: st(chip, "padding-right") },
			working: rect(working),
			workingStyle: working && { fs: st(working, "font-size"), lh: st(working, "line-height"), color: st(working, "color") },
			workingLabelColor: st(working?.querySelector(".working-label"), "color"),
			workingElapsedColor: st(working?.querySelector(".working-elapsed"), "color"),
			workingMark: rect(working?.querySelector(".working-mark")),
			dots: [...(working ?? trigger ?? document).querySelectorAll(".working-mark > i")].map((d) => ({ ...rect(d), bg: st(d, "background-color"), anim: st(d, "animation-name"), delay: st(d, "animation-delay") })),
			liveMark: rect(q(".live-mark")),
			planBox: rect(planBox),
			planStyle: planBox && { pad: st(planBox, "padding-top"), padx: st(planBox, "padding-left"), radius: st(planBox, "border-top-left-radius"), border: st(planBox, "border-top-width"), edge: st(planBox, "border-top-color"), bg: st(planBox, "background-color"), page: probe("--background"), insideFold: !!planBox.closest(".turn-activity") },
			planRows: qa(".plan-box-steps > li").map((e) => ({ ...rect(e), fs: st(e, "font-size"), lh: st(e, "line-height"), color: st(e, "color"), mark: rect(e.querySelector(".plan-box-mark")), text: rect(e.querySelector(".plan-subject")), kind: e.dataset.status })),
			planTrigger: rect(q(".plan-trigger")),
			result: rect(q(".turn-result")),
			resultCounts: q(".turn-result-counts") && { fs: st(q(".turn-result-counts"), "font-size"), gap: st(q(".turn-result-counts"), "column-gap") },
			resultMainGap: st(q(".turn-result-main"), "column-gap"),
			latest: rect(q(".transcript-latest")),
			latestStyle: q(".transcript-latest") && { radius: st(q(".transcript-latest"), "border-top-left-radius") },
		};
	});

const near = (actual, expected, message, tolerance = 0.6) =>
	assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not ${expected}`);

function flow(name, options, body, timeout = 300000) {
	test(name, { timeout }, async () => {
		const w = await createWorld(options);
		let failed = true;
		try {
			await launch(w);
			await body(w);
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});
}

const NESTED = "Lists of two kinds.\n\n- one\n- two with a second line that is long enough to wrap onto another line in a pane of this width, and then a bit more words to be sure of it\n  - nested a\n  - nested b\n\n1. first\n2. second\n\n- last bullet";
const RULES = [
	{ match: /nested lists/, steps: [{ text: NESTED }] },
	{ match: /hello/, steps: [{ text: REPLY }] },
	{ match: /do the work/, steps: [{ tool: "read", args: { path: "notes.txt" } }, { tool: "read", args: { path: "src/a.ts" } }, { text: REPLY }] },
];

flow(
	"the text column is 736 wide on the box's axis, 58 in from a wide pane and 42 from a narrow one, and the transcript starts 32 down",
	{ tabs: "hidden", files: { "notes.txt": "some notes\n", "src/a.ts": "x\n" }, rules: RULES },
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		await expect(w.page.getByText("Third item")).toBeVisible({ timeout: T });
		await size(w, 1280, 820);
		await settled(w);
		let m = await measure(w);
		assert.equal(m.transcriptPadTop, "32px", "the transcript starts 32 down");
		near(m.column.w, 736, "the column at 1280 is 736 wide");
		near(m.column.x + m.column.w / 2, m.box.x + m.box.w / 2, "the column is on the box's axis");
		near(m.box.w, 768, "the box keeps its own width");
		near(m.column.x - m.box.x, 16, "the text sits 16 inside the box's left edge");
		near(m.box.right - m.column.right, 16, "and 16 inside its right edge");
		// A pane of 600 or wider: 58 each side. 900 wide with the sidebar open is a 612 pane.
		await size(w, 900, 820);
		await settled(w);
		m = await measure(w);
		const lane = m.transcript.w;
		assert.ok(lane >= 600 && lane < 700, `a ${lane}px pane`);
		near(m.column.w, lane - 2 * 58, "58 in from each side of a pane of 600 or more");
		near(m.column.x + m.column.w / 2, m.box.x + m.box.w / 2, "still on the box's axis");
		// A pane narrower than 600: 42 each side.
		await size(w, 860, 820);
		await settled(w);
		m = await measure(w);
		near(m.column.w, m.transcript.w - 2 * 42, "42 in from each side of a pane narrower than 600");
		near(m.column.x + m.column.w / 2, m.box.x + m.box.w / 2, "on the box's axis in a narrow pane");
		assert.ok(m.column.w < 736, "the column narrows with the pane");
	},
);

flow(
	"the person's message: 10 corners, 12 and 16 of padding, 80 percent at most, its edge on the column's, and 34 above the next row with its hover row inside the 34",
	{ tabs: "hidden", files: { "notes.txt": "some notes\n", "src/a.ts": "x\n" }, rules: RULES },
	async (w) => {
		await openProject(w);
		await size(w, 1280, 820);
		await send(w, LONG_MESSAGE);
		await expect(w.page.getByText("Third item")).toBeVisible({ timeout: T });
		await settled(w);
		let m = await measure(w);
		assert.deepEqual(m.bubbleStyle, { radius: "10px", pt: "12px", pb: "12px", pl: "16px", pr: "16px" });
		near(m.bubble.right, m.column.right, "the bubble's right edge is the column's");
		near(m.bubble.w, 0.8 * m.column.w, "a long message takes 80 percent of the column");
		// From the bubble's bottom edge to the top of the first row under it: 34, with no row reserved for the clock.
		near(m.reply.y - m.bubble.bottom, 34, "the reply starts 34 under the bubble");
		near(m.user.bottom - m.bubble.bottom, 34, "the message's own height ends 34 under the bubble: the hover row takes none");
		// Hover shows the clock inside those 34 and moves nothing.
		const before = m.reply.y;
		await w.page.locator(".message.user > .message-bubble").hover();
		await expect.poll(async () => Number((await measure(w)).userFooterOpacity), { timeout: T }).toBe(1);
		m = await measure(w);
		assert.ok(m.userFooter.y >= m.bubble.bottom - 0.5 && m.userFooter.bottom <= m.bubble.bottom + 34.5, "the clock sits inside the 34");
		near(m.reply.y, before, "showing it moves nothing");
		// A short message sits on the same edge, and the same 34 holds when work follows it.
		await newConversation(w);
		await send(w, "do the work");
		await expect(w.page.getByText("Third item").last()).toBeVisible({ timeout: T });
		await settled(w);
		m = await measure(w);
		near(m.bubble.right, m.column.right, "a short bubble is on the column's right edge");
		near(m.trigger.y - m.bubble.bottom, 34, "the folded row starts 34 under the bubble");
	},
);

flow(
	"a reply: paragraphs 12 apart, a list of squares 13 in with its text 37 in and 4 between items, inline code a chip 17 high",
	{ tabs: "hidden", files: { "notes.txt": "some notes\n" }, rules: RULES },
	async (w) => {
		await openProject(w);
		await size(w, 1280, 820);
		await send(w, "hello there");
		await expect(w.page.getByText("Third item")).toBeVisible({ timeout: T });
		await settled(w);
		const m = await measure(w);
		assert.deepEqual(m.paragraphStyle, { fs: "15px", lh: "22px" });
		near(m.paragraphs[1].y - m.paragraphs[0].bottom, 12, "paragraphs are 12 apart");
		near(m.items[0].y - m.paragraphs[1].bottom, 12, "a list is 12 under the paragraph above");
		assert.equal(m.marker.w, "5px");
		assert.equal(m.marker.h, "5px");
		near(m.items[0].x + Number.parseFloat(m.marker.left) - m.column.x, 13, "the marker is 13 in from the column's edge");
		near(m.items[0].x - m.column.x, 37, "the item's text starts 37 in");
		assert.equal(m.marker.bg, m.muted, "the marker is the muted colour");
		near(m.items[1].y - m.items[0].bottom, 4, "items are 4 apart");
		near(m.items[2].y - m.items[1].bottom, 4, "all of them");
		near(m.chip.h, 17, "an inline code chip is 17 high");
		assert.equal(m.chipStyle.fs, "13px");
		assert.match(m.chipStyle.ff, /mono|Mono|Code|Courier/);
		assert.deepEqual([m.chipStyle.radius, m.chipStyle.pl, m.chipStyle.pr], ["4px", "4px", "4px"]);
	},
);

flow(
	"the folded row is 28 high with its chevron 7 after the text and the answer 12 under it; opened, the block is 8 under it with a hairline edge, rows 35 high and the answer 20 under it",
	{ tabs: "hidden", files: { "notes.txt": "some notes\n", "src/a.ts": "x\n" }, rules: RULES },
	async (w) => {
		await openProject(w);
		await size(w, 1280, 820);
		await send(w, "do the work");
		await expect(w.page.getByText("Third item")).toBeVisible({ timeout: T });
		await settled(w);
		let m = await measure(w);
		near(m.trigger.h, 28, "the folded row is 28 high");
		assert.equal(m.triggerStyle.fs, "15px");
		assert.equal(m.triggerStyle.lh, "22px");
		assert.equal(m.triggerStyle.color, m.muted, "the sentence is muted");
		assert.ok(m.chevron.x > m.triggerText.x, "the chevron comes after the text");
		near(m.chevron.x - m.triggerTextRight, 7, "the chevron starts 7 after the last letter");
		near(m.chevron.w, 6, "the chevron is 6 wide");
		near(m.chevron.h, 8, "and 8 high");
		near(m.paragraphs[0].y - m.trigger.bottom, 12, "the answer is 12 under the folded row");
		assert.equal(m.block.h, 0, "nothing is drawn under it while it is closed");
		// A row with something above it that is not the person's message or the plan is 14 under it.
		const above = await w.page.evaluate(() => {
			const row = document.querySelector(".turn-activity");
			const note = document.createElement("p");
			note.textContent = "x";
			row.before(note);
			const margin = getComputedStyle(row).marginTop;
			note.remove();
			return margin;
		});
		assert.equal(above, "14px", "a folded row is 14 under a paragraph");

		await w.page.locator(".activity-trigger").first().click();
		await expect(w.page.locator(".activity-block")).toBeVisible({ timeout: T });
		await settled(w);
		m = await measure(w);
		assert.ok(m.chevron.w > m.chevron.h, "the chevron points down once open (turned a quarter)");
		near(m.block.y - m.trigger.bottom, 8, "the block is 8 under the row");
		assert.deepEqual([m.blockStyle.radius, m.blockStyle.width], ["8px", "1px"]);
		// The edge is about 6 percent of the text colour.
		const channels = m.blockStyle.edge.match(/[\d.]+/g).map(Number);
		near(channels[3], 0.06, "the edge's strength", 0.01);
		assert.equal(m.rows.length, 2);
		for (const row of m.rows) near(row.h, 35, "a row is 35 high");
		near(m.rows[1].y - m.rows[0].bottom, 1, "rows are divided by a 1 px line");
		near(m.rowText[0].x - m.block.x, 1 + 12, "the text starts 12 in from the block's edge");
		assert.equal(m.rowText[0].verb, m.muted, "the verb is muted");
		assert.equal(m.rowText[0].object, m.text, "what it acted on is the text colour");
		near(m.paragraphs[0].y - m.block.bottom, 20, "the answer is 20 under the block");
	},
);

flow(
	"the working row is 28 high with a mark of four dots, 34 under the message; the plan is one box in the flow, 20 above the row",
	{
		tabs: "hidden",
		files: { "notes.txt": "some notes\n" },
		rules: [
			{ match: /slowstart/, steps: [{ hold: "slowstart", text: "Started late." }] },
			{ match: /noplan/, steps: [{ tool: "read", args: { path: "notes.txt" } }, { hold: "noplan", text: "Done without a plan." }] },
			{
				match: /withplan/,
				steps: [
					{ tool: "task_create", args: { subject: "Write the parser", activeForm: "Writing the parser" } },
					{ tool: "task_create", args: { subject: "Add the tests", activeForm: "Adding the tests" } },
					{ hold: "withplan", text: "Plan done." },
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await size(w, 1280, 820);
		// Before any action: the working row itself.
		await send(w, "slowstart please");
		await expect(w.page.locator(".working:not(.transcript-status-only)")).toBeVisible({ timeout: T });
		await settled(w);
		let m = await measure(w);
		near(m.working.h, 28, "the working row is 28 high");
		assert.equal(m.workingStyle.fs, "15px");
		assert.equal(m.workingStyle.lh, "22px");
		near(m.working.y - m.bubble.bottom, 34, "the working row is 34 under the message when there is no plan");
		near(m.workingMark.w, 14, "the mark is 14 wide");
		near(m.workingMark.h, 14, "and 14 high");
		assert.equal(m.dots.length, 4, "four dots");
		for (const dot of m.dots) {
			near(dot.w, 4, "a dot is 4 wide");
			near(dot.h, 4, "and 4 high");
			assert.equal(dot.bg, m.muted, "in the muted colour, never the accent");
			assert.equal(dot.anim, "working-mark-lit", "lit in turn");
		}
		assert.equal(new Set(m.dots.map((d) => d.delay)).size, 4, "each dot has its own turn");
		const xs = [...new Set(m.dots.map((d) => Math.round(d.x - m.workingMark.x)))].sort((a, b) => a - b);
		const ys = [...new Set(m.dots.map((d) => Math.round(d.y - m.workingMark.y)))].sort((a, b) => a - b);
		assert.deepEqual([xs, ys], [[0, 10], [0, 10]], "two by two, in the mark's corners");
		// One muted tone for the label and the time.
		assert.equal(m.workingLabelColor, m.muted, "the label is muted");
		assert.equal(m.workingElapsedColor, m.muted, "so is the time");
		// Reduced motion: the dots hold still.
		await w.page.emulateMedia({ reducedMotion: "reduce" });
		m = await measure(w);
		for (const dot of m.dots) assert.equal(dot.anim, "none", "the dots hold still for reduced motion");
		await w.page.emulateMedia({ reducedMotion: "no-preference" });
		w.model.release("slowstart");
		await expect(w.page.getByText("Started late.")).toBeVisible({ timeout: T });

		// Work with no plan: the folded row is the working row.
		await newConversation(w);
		await send(w, "noplan please");
		await expect(w.page.locator(".live-mark")).toBeVisible({ timeout: T });
		await settled(w);
		m = await measure(w);
		near(m.trigger.h, 28, "the live row is 28 high");
		assert.equal(m.triggerStyle.fs, "15px");
		assert.equal(m.triggerStyle.lh, "22px");
		near(m.trigger.y - m.bubble.bottom, 34, "34 under the message");
		near(m.liveMark.w, 14, "the live mark is 14 wide");
		assert.equal(m.chevronColor, m.muted, "the chevron is muted");
		assert.equal(m.elapsedColor, m.muted, "so is the time");
		assert.equal(m.labelColor, m.muted, "and the label");
		assert.equal(m.planBox, null, "no plan, no box");
		w.model.release("noplan");
		await expect(w.page.getByText("Done without a plan.")).toBeVisible({ timeout: T });

		// A plan: one box under the message, outside the fold; the row sits 20 under it.
		await newConversation(w);
		await send(w, "withplan please");
		await expect(w.page.locator(".plan-box")).toBeVisible({ timeout: T });
		await expect(w.page.locator(".live-mark")).toBeVisible({ timeout: T });
		await settled(w);
		m = await measure(w);
		assert.equal(m.planStyle.insideFold, false, "the box is not inside the fold");
		near(m.planBox.y - m.bubble.bottom, 34, "the box is 34 under the message");
		near(m.planBox.x, m.column.x, "on the text column's left edge");
		near(m.planBox.w, m.column.w, "as wide as the column");
		assert.deepEqual([m.planStyle.pad, m.planStyle.padx, m.planStyle.radius, m.planStyle.border], ["16px", "16px", "12px", "1px"]);
		assert.equal(m.planStyle.bg, m.planStyle.page, "the page's own fill");
		near(m.trigger.y - m.planBox.bottom, 20, "the working row is 20 under the box");
		assert.equal(m.planRows.length, 2);
		near(m.planRows[1].y - m.planRows[0].y, 28, "rows are on a 28 pitch");
		for (const row of m.planRows) {
			assert.equal(row.fs, "14px");
			assert.equal(row.lh, "20px");
			near(row.mark.w, 16, "a mark is 16 wide");
			near(row.mark.h, 16, "and 16 high");
			near(row.text.x - row.mark.right, 8, "8 from the mark to the text");
		}
		for (const row of m.planRows) {
			assert.equal(row.kind, "pending");
			assert.equal(row.color, m.text, "a task that has not started is full text");
		}
		near(m.planBox.h, 2 + 32 + 56, "a box of two rows: edge, padding and 2 x 28");
		// A task that has not started shows a dashed ring (the done disc and the spinning arc are in plan-row-view.test.ts).
		const kinds = await w.page.evaluate(() => [...document.querySelectorAll(".plan-box-steps > li")].map((e) => (e.querySelector(".plan-box-ring") ? "ring" : "other")));
		assert.deepEqual(kinds, ["ring", "ring"]);
		const dashed = await w.page.evaluate(() => getComputedStyle(document.querySelector(".plan-box-ring")).strokeDasharray);
		assert.notEqual(dashed, "none", "the ring is dashed");
		w.model.release("withplan");
		await expect(w.page.getByText("Plan done.")).toBeVisible({ timeout: T });
		await settled(w);
		// When the answer lands the box is gone and the plan is a row in the work block.
		await expect(w.page.locator(".plan-box")).toHaveCount(0);
		await expect(w.page.locator(".plan-trigger")).toHaveCount(1);
	},
);

// The result line needs a repository with changes; its own repository, as ux-result-line has.
const git = (cwd, ...a) =>
	execFileSync("git", a, {
		cwd,
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
	}).toString();
const seed = (w) => {
	rmSync(join(w.project, ".git"), { recursive: true, force: true });
	rmSync(join(w.project, "namzu.config.json"), { force: true });
	git(w.project, "init", "-q", "-b", "main");
	git(w.project, "add", "-A");
	git(w.project, "commit", "-q", "-m", "init");
};

flow(
	"the result line's counts are 13 px with its parts 8 apart, and jump to latest is a 36 px circle on the column's axis 20 above the dock",
	{
		tabs: "hidden",
		files: { "src/limits.js": "export const LIMITS = {};\n" },
		seed,
		rules: [
			{ match: /make a change/i, steps: [{ tool: "write", args: { path: "notes.txt", content: "one\ntwo\n" } }, { text: "Changed it." }] },
			{ match: /longone/, steps: [{ text: Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of a long reply that fills the pane so that the page scrolls.`).join("\n\n") }] },
		],
	},
	async (w) => {
		await w.page.getByRole("button", { name: "Add new project", exact: true }).last().click();
		await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await size(w, 1280, 820);
		await send(w, "Make a change please");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		const accept = card.getByRole("button", { name: "Accept", exact: true });
		await expect(accept).toBeVisible({ timeout: T });
		await expect(accept).not.toHaveAttribute("aria-disabled", "true", { timeout: T });
		await accept.click();
		await expect(w.page.getByRole("region", { name: "Result of this reply" })).toBeVisible({ timeout: T });
		await settled(w);
		let m = await measure(w);
		assert.equal(m.resultCounts.fs, "13px", "the counts are 13 px");
		assert.equal(m.resultCounts.gap, "8px", "the added and removed counts are 8 apart");
		assert.equal(m.resultMainGap, "8px", "the line's parts are 8 apart");
		near(m.result.h, 32, "the line stays 32 high");

		await newConversation(w);
		await send(w, "longone");
		await expect(w.page.getByText("Paragraph 30 of").last()).toBeVisible({ timeout: T });
		await w.page.locator(".transcript").evaluate((e) => {
			e.scrollTop = 0;
		});
		await expect(w.page.locator(".transcript-latest")).toBeVisible({ timeout: T });
		await settled(w);
		m = await measure(w);
		near(m.latest.w, 36, "the button is 36 wide");
		near(m.latest.h, 36, "and 36 high");
		assert.equal(m.latestStyle.radius, "999px", "a circle");
		near(m.latest.x + m.latest.w / 2, m.column.x + m.column.w / 2, "centred on the column");
		near(m.dock.y - m.latest.bottom, 20, "20 above the top of the dock");
	},
);

flow(
	"lists share one marker axis, and a nested list is one item gap under its parent's text",
	{ tabs: "hidden", rules: RULES },
	async (w) => {
		await openProject(w);
		await size(w, 1280, 820);
		await send(w, "nested lists please");
		await expect(w.page.getByText("last bullet")).toBeVisible({ timeout: T });
		await settled(w);
		const m = await w.page.evaluate(() => {
			const reply = document.querySelector(".message.assistant:not(.commentary) .chat-markdown");
			const column = document.querySelector(".transcript .conversation-body").getBoundingClientRect();
			const top = [...reply.querySelectorAll(":scope > ul, :scope > ol")];
			const [bullets, numbers, last] = top;
			const markerX = (li, ordered) => {
				const cs = getComputedStyle(li, "::before");
				return li.getBoundingClientRect().left + Number.parseFloat(cs.left) - column.left;
			};
			const lineBottom = (li) => {
				const r = document.createRange();
				const own = [...li.childNodes].filter((n) => (n.nodeType === 3 && n.textContent.trim() !== "") || (n.nodeType === 1 && !/^(UL|OL)$/.test(n.tagName)));
				r.setStartBefore(own[0]);
				r.setEndAfter(own.at(-1));
				const last = [...r.getClientRects()].at(-1);
				// The text's own box is shorter than its 22 px line: the line ends half the difference lower.
				return last.bottom + (22 - last.height) / 2;
			};
			const parent = bullets.children[1];
			const nested = parent.querySelector(":scope > ul");
			const nestedItems = [...nested.children];
			return {
				bulletX: markerX(bullets.children[0]),
				numberX: markerX(numbers.children[0]),
				numberText: numbers.children[0].getBoundingClientRect().left - column.left,
				numberContent: getComputedStyle(numbers.children[0], "::before").content,
				numberColor: getComputedStyle(numbers.children[0], "::before").color,
				muted: getComputedStyle(bullets.children[0], "::before").backgroundColor,
				secondNumber: getComputedStyle(numbers.children[1], "::before").content,
				nestedGap: nestedItems[0].getBoundingClientRect().top - lineBottom(parent),
				nestedPitch: nestedItems[1].getBoundingClientRect().top - nestedItems[0].getBoundingClientRect().bottom,
				nestedMarker: nestedItems[0].getBoundingClientRect().left + Number.parseFloat(getComputedStyle(nestedItems[0], "::before").left) - parent.getBoundingClientRect().left,
				afterNested: numbers.getBoundingClientRect().top - bullets.getBoundingClientRect().bottom,
				lastGap: last.getBoundingClientRect().top - numbers.getBoundingClientRect().bottom,
			};
		});
		near(m.bulletX, 13, "a bullet sits 13 in");
		near(m.numberX, 13, "a number starts on the same x as a bullet");
		near(m.numberText, 37, "the numbered text starts 37 in, as the bullets' does");
		assert.equal(m.numberContent, 'counter(list-item) "."', "the number is the list's own counter");
		assert.equal(m.secondNumber, m.numberContent);
		near(m.nestedGap, 4, "a nested list is one item gap under its parent's last line");
		near(m.nestedPitch, 4, "its items are 4 apart");
		near(m.nestedMarker, 0, "its markers start where the parent's text starts (the parent's text is 0 right of its own box)");
		near(m.afterNested, 12, "the next list is 12 under the nested one");
		near(m.lastGap, 12, "lists are 12 apart");
	},
);
