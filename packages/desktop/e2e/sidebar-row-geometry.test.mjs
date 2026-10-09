// Where the hover glyph of a sidebar row is drawn, measured on what is painted rather than on the
// button around it: the glyph's own paths must be centred on the row, the status dot it replaces must
// share that centre (both ways), and the title's letters must be in line with them.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/sidebar-row-geometry.test.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	createWorld,
	dispose,
	expect,
	launch,
	openProject,
	repoRoot,
	send,
} from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/sidebar-row-geometry-20261009");
const TOLERANCE = 0.5;

const CHATS = [
	{ match: /alpha/, steps: [{ text: "Reply alpha." }] },
	{ match: /beta/, steps: [{ text: "Reply beta." }] },
];

async function setAppearance(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}

/**
 * The geometry of the hovered row, in client pixels. `ink` is the union of the glyph's drawn
 * shapes (path, line, circle), not the svg's box. The title's letter band is taken from the font's own
 * metrics: the baseline sits fontBoundingBoxAscent below the top of the text's line box, and the
 * x-height band reaches the x glyph's ascent above it.
 */
function measureHovered(w, rowSelector) {
	return w.page.evaluate((selector) => {
		const li = document.querySelector(`${selector}:hover`);
		if (!li) return null;
		const box = (el) => {
			const b = el.getBoundingClientRect();
			return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height };
		};
		const union = (els) => {
			const bs = els.map((e) => e.getBoundingClientRect()).filter((b) => b.width || b.height);
			if (!bs.length) return null;
			const left = Math.min(...bs.map((b) => b.left));
			const right = Math.max(...bs.map((b) => b.right));
			const top = Math.min(...bs.map((b) => b.top));
			const bottom = Math.max(...bs.map((b) => b.bottom));
			return { cx: (left + right) / 2, cy: (top + bottom) / 2 };
		};
		const row = box(li);
		const button = box(li.querySelector(":scope > button"));
		const glyphs = [...li.querySelectorAll(".sidebar-thread-action")].map((button) => ({
			label: button.getAttribute("aria-label"),
			ink: union([...button.querySelectorAll("svg path, svg line, svg circle, svg rect")]),
		}));
		const dotElement = li.querySelector(
			".conversation-row-state .terminal-badge, .conversation-row-state .connection-dot, .conversation-row-state .thread-running-indicator",
		);
		const titleElement = li.querySelector(".conversation-row-title");
		let letters = null;
		const text = [...titleElement.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
		if (text) {
			const range = document.createRange();
			range.selectNodeContents(text);
			const line = range.getBoundingClientRect();
			const style = getComputedStyle(titleElement);
			const context = document.createElement("canvas").getContext("2d");
			context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const metrics = context.measureText("x");
			const baseline = line.top + metrics.fontBoundingBoxAscent;
			letters = { cy: baseline - metrics.actualBoundingBoxAscent / 2 };
		}
		return {
			row,
			button,
			glyphs,
			dot: dotElement ? box(dotElement) : null,
			letters,
		};
	}, rowSelector);
}

function check(label, m, { expectDot }) {
	assert.ok(m, `${label}: the hovered row was found`);
	assert.ok(m.glyphs.length > 0, `${label}: the hover glyphs were measured`);
	// The <li> the glyphs are centred on is exactly the row's button, not taller than it.
	assert.ok(
		Math.abs(m.row.h - m.button.h) <= 0.01 && Math.abs(m.row.cy - m.button.cy) <= 0.01,
		`${label}: the <li> is ${m.row.h}px tall around a ${m.button.h}px button`,
	);
	for (const glyph of m.glyphs) {
		assert.ok(glyph.ink, `${label}: ${glyph.label} has drawn shapes`);
		const off = Math.abs(glyph.ink.cy - m.row.cy);
		assert.ok(off <= TOLERANCE, `${label}: ${glyph.label} is drawn ${off.toFixed(2)}px off the row's middle`);
	}
	// The right-most glyph replaces the status dot: same centre across and down.
	const last = m.glyphs.at(-1);
	if (expectDot) {
		assert.ok(m.dot, `${label}: the status dot was measured`);
		const down = Math.abs(m.dot.cy - last.ink.cy);
		const across = Math.abs(m.dot.cx - last.ink.cx);
		assert.ok(down <= TOLERANCE, `${label}: dot and ${last.label} differ by ${down.toFixed(2)}px vertically`);
		assert.ok(across <= TOLERANCE, `${label}: dot and ${last.label} differ by ${across.toFixed(2)}px across`);
		const dotOff = Math.abs(m.dot.cy - m.row.cy);
		assert.ok(dotOff <= TOLERANCE, `${label}: the dot is ${dotOff.toFixed(2)}px off the row's middle`);
	}
	// The title's x-height band, from the font's metrics, within a pixel of the glyph (text is
	// snapped to whole device pixels, so half a pixel either way is the font's own rounding).
	assert.ok(m.letters, `${label}: the title's letters were measured`);
	const lettersOff = Math.abs(m.letters.cy - last.ink.cy);
	assert.ok(lettersOff <= 1, `${label}: the title's letters sit ${lettersOff.toFixed(2)}px from the glyph's middle`);
	return {
		glyphOff: Math.abs(last.ink.cy - m.row.cy),
		dotDown: m.dot ? Math.abs(m.dot.cy - last.ink.cy) : null,
		lettersOff,
	};
}

test("a row's hover glyph, its status dot and its title share one centre", {
	timeout: 300000,
}, async () => {
	const w = await createWorld({ rules: CHATS, env: { SHELL: "/bin/sh" } });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await send(w, "alpha chat");
		await expect(w.page.getByText("Reply alpha.", { exact: true }).first()).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: "New conversation tab" }).click();
		await send(w, "beta chat");
		await expect(w.page.getByText("Reply beta.", { exact: true }).first()).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: "New terminal tab" }).click();
		await expect(w.page.locator("[data-terminal-tab-id]")).toHaveCount(1, { timeout: T });
		await w.page.getByRole("button", { name: "New terminal tab" }).click();
		await expect(w.page.locator("[data-terminal-tab-id]")).toHaveCount(2, { timeout: T });
		// End the terminal in front so one terminal row has a status dot and one has none.
		await w.page.locator("section.terminal-pane .xterm-helper-textarea").focus();
		await w.page.keyboard.type("exit");
		await w.page.keyboard.press("Enter");
		await expect(w.page.locator("li[data-terminal-row] .terminal-badge")).toHaveAttribute(
			"title",
			"Session ended",
			{ timeout: T },
		);

		const kinds = [
			["conversation", "li[data-thread-item]:visible", false],
			["running terminal", "li[data-terminal-row]:not([data-ended])", false],
			["ended terminal", "li[data-terminal-row][data-ended]", true],
		];
		mkdirSync(SHOTS, { recursive: true });
		const table = [];
		for (const appearance of ["dark", "light"]) {
			await setAppearance(w, appearance);
			for (const [kind, selector, expectDot] of kinds) {
				const rows = w.page.locator(selector);
				const count = await rows.count();
				assert.ok(count > 0, `a ${kind} row exists`);
				for (let index = 0; index < count; index++) {
					await w.page.mouse.move(700, 600);
					await rows.nth(index).hover();
					const m = await measureHovered(w, selector.replace(":visible", ""));
					const result = check(`${kind} ${index} ${appearance}`, m, { expectDot });
					table.push({ kind, index, appearance, ...result });
					if (index === 0)
						await rows.nth(index).screenshot({ path: join(SHOTS, `${kind.replace(" ", "-")}-${appearance}.png`) });
				}
			}
		}
		console.log(JSON.stringify(table));
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
