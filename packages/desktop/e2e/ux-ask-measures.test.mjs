// The request for permission, in the real app, on measured numbers. The card has 16 of padding; its band is 48
// high with a faint fill and holds the warning icon, the question (14/20, weight 500) and the counts; the path
// has a row of its own 10 under the band (43 high, 8 corners, mono 13/20, text 16 in); the preview is a framed
// block 16 under it (1px edge, 8 corners, rows 20 high, 6 of air above the first row and under the last, line
// numbers ending 28 in, the code starting 50 in, a 6px bar on each changed row, tints at 22 percent of the diff
// colours); the footer is 24 under it with buttons 28 high and 16 apart, 16 from the card's right and bottom
// edges, Reject a quiet fill in the text colour, the lasting yes a split control, Accept the lime button, and
// the bound keys drawn as small chips. A command of one line has the path-style row and no block. Every
// vertical position is relative to a neighbour. Scripted model, no paid call.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-ask-measures.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 90000;
const RULES = [
	{ match: /edit the limit/i, steps: [{ tool: "edit", args: { path: "src/limits.ts", old_string: "const b = 2", new_string: "const b = 20" } }, { text: "Edited." }] },
	{ match: /run the check/i, steps: [{ tool: "bash", args: { command: "pnpm test --silent" } }, { text: "Ran." }] },
];
const FILES = { "src/limits.ts": "const a = 1\nconst b = 2\nconst c = 3\n" };

const settled = (w) =>
	w.page
		.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
		.then(() => w.page.waitForTimeout(250));

const measure = (w) =>
	w.page.evaluate(() => {
		const rect = (el) => {
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return { x: b.left, y: b.top, w: b.width, h: b.height, bottom: b.bottom, right: b.right };
		};
		const q = (s, root = document) => root.querySelector(s);
		const css = (el, p, pseudo) => (el ? getComputedStyle(el, pseudo).getPropertyValue(p) : null);
		const textBox = (el) => {
			if (!el) return null;
			const range = document.createRange();
			range.selectNodeContents(el);
			return rect(range);
		};
		const probe = (value) => {
			const e = document.createElement("i");
			e.style.background = value;
			document.body.append(e);
			const c = getComputedStyle(e).backgroundColor;
			e.remove();
			return c;
		};
		const colour = (value) => {
			const e = document.createElement("i");
			e.style.color = value;
			document.body.append(e);
			const c = getComputedStyle(e).color;
			e.remove();
			return c;
		};
		const card = q(".approval-card");
		const head = q(".approval-head");
		const path = q(".approval-path");
		const block = q(".approval-box");
		const rows = [...document.querySelectorAll(".approval-row")];
		const rowsBox = q(".approval-rows");
		const add = q(".approval-row[data-kind=add]");
		const remove = q(".approval-row[data-kind=remove]");
		const footer = q(".approval-card > .approval-footer");
		const reject = q('[data-tone="reject"]');
		const accept = q('[data-tone="accept"]');
		const split = q(".approval-split");
		const label = q(".approval-split-label");
		const more = q(".approval-split-more");
		const divider = q(".approval-split-divider");
		const key = (b) => q(".approval-key", b);
		const textRight = (b) => {
			const t = [...b.childNodes].find((n) => n.nodeType === 3);
			if (!t) return null;
			const range = document.createRange();
			range.selectNodeContents(t);
			return range.getBoundingClientRect().right;
		};
		return {
			card: rect(card), cardPad: css(card, "padding-top"), cardRing: css(card, "border-top-width"),
			head: rect(head), headFill: css(head, "background-color"), icon: rect(q(".approval-head-icon")),
			title: { ...rect(q(".approval-title")), font: css(q(".approval-title"), "font-size"), lh: css(q(".approval-title"), "line-height"), weight: css(q(".approval-title"), "font-weight") },
			path: rect(path), pathFill: css(path, "background-color"), pathRadius: css(path, "border-top-left-radius"), pathFont: css(path, "font-size"), pathLh: css(path, "line-height"), pathMono: css(path, "font-family"), pathText: textBox(q(".approval-path-text")), pathKind: path?.dataset.kind,
			block: rect(block), blockRing: css(block, "border-top-width"), blockRadius: css(block, "border-top-left-radius"),
			rows: rows.map(rect), rowsBox: rect(rowsBox), rowFont: css(rows[0], "font-size"), rowLh: css(rows[0], "line-height"),
			lineRight: add ? rect(q(".approval-row-line", add)).right : null, rowLeft: add ? rect(add).x : null, codeLeft: add ? rect(q(".approval-row-text", add)).x : null,
			addBar: add ? { w: css(add, "width", "::before"), bg: css(add, "background-color", "::before"), image: css(add, "background-image", "::before") } : null,
			removeBar: remove ? { w: css(remove, "width", "::before"), image: css(remove, "background-image", "::before") } : null,
			addFill: add ? css(add, "background-color") : null, removeFill: remove ? css(remove, "background-color") : null,
			expectAdd: probe("color-mix(in srgb, var(--diff-addition) 22%, var(--background))"), expectRemove: probe("color-mix(in srgb, var(--diff-deletion) 22%, var(--background))"),
			footer: rect(footer), beforeFooter: rect(footer?.previousElementSibling),
			reject: { ...rect(reject), radius: css(reject, "border-top-left-radius"), font: css(reject, "font-size"), weight: css(reject, "font-weight"), bg: css(reject, "background-color"), color: css(reject, "color"), key: rect(key(reject)), keyRing: css(key(reject), "border-top-width"), keyRadius: css(key(reject), "border-top-left-radius"), keyFont: css(key(reject), "font-size"), textRight: textRight(reject) },
			accept: { ...rect(accept), radius: css(accept, "border-top-left-radius"), font: css(accept, "font-size"), weight: css(accept, "font-weight"), bg: css(accept, "background-color"), key: rect(key(accept)), textRight: textRight(accept) },
			split: rect(split), label: rect(label), more: rect(more), divider: rect(divider), moreRadius: css(more, "border-top-right-radius"),
			lime: probe("var(--message-action)"), text: colour("var(--foreground)"), error: colour("var(--error-foreground)"),
			quiet: probe("color-mix(in srgb, var(--foreground) 16%, transparent)"),
			headFillExpected: probe("color-mix(in srgb, var(--foreground) 6%, transparent)"),
		};
	});

test("the approval card is on the measured numbers: padding, band, path row, framed block, footer, buttons, chips", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden", rules: RULES, files: FILES, models: ["gpt-e2e-1"] });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await w.app.evaluate(({ BrowserWindow }) => { for (const b of BrowserWindow.getAllWindows()) b.setSize(1280, 820); });
		await send(w, "Please edit the limit");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		await expect(card.getByRole("button", { name: "Accept", exact: true })).not.toHaveAttribute("aria-disabled", "true", { timeout: T });
		await settled(w);
		const m = await measure(w);
		const ring = 1;
		assert.equal(m.cardPad, "16px", "the card has 16 of padding");
		// The band: across the top of the card, 48 high, 16 at the sides.
		assert.equal(m.head.h, 48, "the band is 48 high");
		assert.equal(m.head.y, m.card.y + ring, "it is the top of the card");
		assert.equal(m.head.w, m.card.w - 2 * ring, "it runs across the card");
		assert.equal(m.headFill, m.headFillExpected, "its fill is 6 percent of the text colour");
		assert.equal(m.icon.w, 16, "the icon is 16");
		assert.equal(m.icon.x - m.head.x, 16, "16 in from the band's left edge");
		assert.equal(m.title.x - m.icon.right, 8, "the question is 8 after the icon");
		assert.equal(`${m.title.font}/${m.title.lh}/${m.title.weight}`, "14px/20px/500", "the question is 14/20 at weight 500");
		// The path row: 10 under the band, 43 high, 8 corners, text 16 in, mono 13/20, the faint fill.
		assert.equal(m.path.y - m.head.bottom, 10, "the path row is 10 under the band");
		assert.equal(m.path.h, 43, "43 high");
		assert.equal(m.pathRadius, "8px", "8 corners");
		assert.equal(m.pathFill, m.headFillExpected, "the same faint fill");
		assert.equal(m.pathText.x - m.path.x, 16, "its text is 16 in");
		assert.equal(`${m.pathFont}/${m.pathLh}`, "13px/20px", "13/20");
		assert.match(m.pathMono, /mono|Mono|Menlo|Consolas|monospace/, "in the mono face");
		assert.equal(m.path.x - m.card.x, ring + 16, "the row is 16 in from the card's left edge");
		// The framed block: 16 under the path row, a 1px edge, 8 corners, 6 of air, rows 20 high.
		assert.equal(m.block.y - m.path.bottom, 16, "the block is 16 under the path row");
		assert.equal(m.blockRing, "1px", "a 1px edge");
		assert.equal(m.blockRadius, "8px", "8 corners");
		assert.equal(m.rows[0].y - m.block.y, ring + 6, "6 above the first row");
		assert.equal(m.rowsBox.bottom - m.rows.at(-1).bottom, 6, "6 under the last row");
		for (const r of m.rows) assert.equal(r.h, 20, "a row is 20 high");
		assert.equal(`${m.rowFont}/${m.rowLh}`, "13px/20px", "rows are mono 13/20");
		assert.equal(m.lineRight - m.rowLeft, 28, "line numbers end 28 in");
		assert.equal(m.codeLeft - m.rowLeft, 50, "the code starts 50 in");
		assert.equal(m.addBar.w, "6px", "a changed row has a 6px bar");
		assert.equal(m.removeBar.w, "6px");
		assert.equal(m.addBar.image, "none", "an added row's bar is solid");
		assert.match(m.removeBar.image, /repeating-linear-gradient/, "a removed row's bar is hatched");
		assert.equal(m.addFill, m.expectAdd, "an added row is tinted at 22 percent of the addition colour");
		assert.equal(m.removeFill, m.expectRemove, "a removed row at 22 percent of the deletion colour");
		// The footer: 24 under the block; buttons 28 high, 8 corners, 13 px weight 500, 16 apart, 16 from the edges.
		assert.equal(m.footer.y - m.block.bottom, 24, "the footer is 24 under the block");
		for (const [name, b] of [["Reject", m.reject], ["Accept", m.accept], ["the lasting yes", m.split]]) assert.equal(b.h, 28, `${name} is 28 high`);
		assert.equal(m.reject.radius, "8px");
		assert.equal(m.accept.radius, "8px");
		assert.equal(`${m.reject.font}/${m.reject.weight}`, "13px/500");
		assert.equal(`${m.accept.font}/${m.accept.weight}`, "13px/500");
		assert.equal(m.split.x - m.reject.right, 16, "Reject and the lasting yes are 16 apart");
		assert.equal(m.accept.x - m.split.right, 16, "the lasting yes and Accept are 16 apart");
		assert.equal(m.card.right - ring - m.accept.right, 16, "Accept ends 16 from the card's right edge");
		assert.equal(m.card.bottom - ring - m.accept.bottom, 16, "and 16 from its bottom edge");
		// Reject is quiet and in the text colour; the lasting yes is split; Accept is lime.
		assert.equal(m.reject.bg, m.quiet, "Reject is a quiet fill (16 percent of the text colour)");
		assert.equal(m.reject.color, m.text, "in the normal text colour");
		assert.notEqual(m.reject.color, m.error, "not the error colour");
		assert.equal(m.accept.bg, m.lime, "Accept is the lime button");
		assert.equal(m.more.w, 28, "the chevron part is 28 wide");
		assert.equal(m.more.h, 28, "and 28 high");
		assert.equal(m.divider.w, 1, "the divider is 1 wide");
		assert.equal(m.divider.h, 14, "and 14 tall");
		assert.equal(m.divider.x - m.label.right, 0, "right after the label part");
		assert.equal(m.more.x - m.divider.right, 0, "and right before the chevron part");
		// The bound keys: chips 18 high, a 1px outline, 4 corners, 12 px, 8 after the label.
		for (const b of [m.reject, m.accept]) {
			assert.equal(b.key.h, 18, "a chip is 18 high");
			assert.ok(Math.abs(b.key.x - b.textRight - 8) <= 0.6, `a chip is 8 after the label (${b.key.x - b.textRight})`);
		}
		assert.equal(m.reject.keyRing, "1px");
		assert.equal(m.reject.keyRadius, "4px");
		assert.equal(m.reject.keyFont, "12px");
		// The chip is no part of the button's name.
		await expect(card.getByRole("button", { name: "Reject", exact: true })).toBeVisible();
		// The chevron opens what the lasting yes covers.
		await card.getByRole("button", { name: "More ways to allow" }).click();
		await expect(w.page.getByRole("menuitem", { name: "Allow for this conversation" })).toBeVisible();
		await w.page.keyboard.press("Escape");
		await card.getByRole("button", { name: "Reject", exact: true }).click();
		await expect(card).toHaveCount(0, { timeout: T });
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("a command of one line has the path-style row and the same band and footer, with no block", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden", rules: RULES, files: FILES, models: ["gpt-e2e-1"] });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await w.app.evaluate(({ BrowserWindow }) => { for (const b of BrowserWindow.getAllWindows()) b.setSize(1280, 820); });
		await send(w, "Please run the check");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		await settled(w);
		const m = await measure(w);
		assert.equal(m.pathKind, "command");
		assert.equal(m.block, null, "no block is drawn for a command that fits its row");
		assert.equal(m.head.h, 48);
		assert.equal(m.path.y - m.head.bottom, 10);
		assert.equal(m.path.h, 43);
		assert.equal(m.footer.y - m.beforeFooter.bottom, 24, "the footer is 24 under whatever is above it (the row, then the Details line)");
		await expect(card.locator(".approval-path-text")).toHaveText("pnpm test --silent");
		for (const b of [m.reject, m.accept]) assert.equal(b.h, 28);
		await card.getByRole("button", { name: "Reject", exact: true }).click();
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("a long path is cut in the middle so both ends stay, and its whole text is kept for a screen reader", { timeout: 280000 }, async () => {
	const deep = `${"nested-folder/".repeat(14)}last-file-name.ts`;
	const w = await createWorld({
		tabs: "hidden",
		models: ["gpt-e2e-1"],
		rules: [{ match: /write deep/i, steps: [{ tool: "write", args: { path: deep, content: "x\n" } }, { text: "Done." }] }],
	});
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await w.app.evaluate(({ BrowserWindow }) => { for (const b of BrowserWindow.getAllWindows()) b.setSize(1000, 820); });
		await send(w, "Please write deep");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		await settled(w);
		const shown = await card.locator(".approval-path-text > span").first().textContent();
		assert.ok(shown.includes("…"), `the path is cut (${shown})`);
		assert.ok(shown.startsWith("nested-folder/") && shown.endsWith("last-file-name.ts"), "both ends stay");
		await expect(card.locator(".approval-path-text .sr-only")).toHaveText(deep);
		const fits = await card.locator(".approval-path-text").evaluate((el) => el.scrollWidth <= el.clientWidth);
		assert.equal(fits, true, "the cut text fits its row");
		await card.getByRole("button", { name: "Reject", exact: true }).click();
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
