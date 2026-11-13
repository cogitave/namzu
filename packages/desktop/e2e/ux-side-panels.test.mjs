// The side panels. A reading panel (changes, a file) takes 60 percent of the main area, at least 360; a
// tool panel (tasks) takes 40 percent, between 320 and 560; the conversation keeps the rest, and when that
// would be under 360 the panel lies over it. A 1px seam divides them, with a 7px zone on it that can be
// dragged (a double click puts the share back, the arrow keys move it, each kind remembers its own width).
// A panel's header is 44 high with a line under it, the title 20 in, controls 28 square, 4 apart, the last
// 8 from the edge. The changes panel keeps its list of files at the right, 240 wide, rows 28 high. Vertical
// positions are relative to the panel's own top. Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-side-panels.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, relaunch, send } from "./harness.mjs";

const T = 60000;
const FOLDER = "src/some/very/deep/folder/for/the/list";
const RULES = [
	{
		match: /write the files/i,
		steps: [
			{ tool: "write", args: { path: `${FOLDER}/one/index.ts`, content: "export const one = 1\n" } },
			{ tool: "write", args: { path: `${FOLDER}/two/index.ts`, content: "export const two = 2\n" } },
			{ text: "Wrote the files." },
		],
	},
];

async function size(w, width, height = 820) {
	await w.app.evaluate(
		({ BrowserWindow }, [wide, high]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(wide, high);
		},
		[width, height],
	);
	await expect.poll(() => w.page.evaluate((x) => Math.abs(window.innerWidth - x), width), { timeout: T }).toBeLessThanOrEqual(2);
}

/** Boxes by selector, read in the page. */
const boxes = (w, selectors) =>
	w.page.evaluate((all) => {
		const out = {};
		for (const [name, selector] of Object.entries(all)) {
			const el = document.querySelector(selector);
			if (!el) {
				out[name] = null;
				continue;
			}
			const b = el.getBoundingClientRect();
			out[name] = { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
		}
		return out;
	}, selectors);

const PANEL = { ws: ".workspace", panel: ".jobs-panel", band: ".topbar", chat: ".chat-stage", grab: ".panel-resize-handle" };

async function writeFiles(w) {
	await openProject(w);
	await send(w, "Please write the files");
	const accept = w.page.getByRole("region", { name: "Tool approval" }).getByRole("button", { name: "Accept", exact: true });
	// Both writes ask; answer each as it comes, and finish when the reply is on screen.
	await expect
		.poll(
			async () => {
				if (await accept.count()) await accept.first().click().catch(() => {});
				return w.page.getByText("Wrote the files.").count();
			},
			{ timeout: T },
		)
		.toBeGreaterThan(0);
}
const openChanges = async (w) => {
	await w.page.getByRole("button", { name: /Open changes$/ }).last().click();
	await expect(w.page.getByRole("complementary", { name: "Changes" })).toBeVisible({ timeout: T });
};
const openTasks = async (w) => {
	await w.page.getByRole("button", { name: /details/i }).first().click();
	await w.page.getByRole("button", { name: /Background work/ }).click();
	await expect(w.page.getByRole("complementary", { name: "Activity" })).toBeVisible({ timeout: T });
};
const openFiles = async (w) => {
	await w.page.getByRole("button", { name: "Project files" }).first().click();
	await expect(w.page.getByRole("complementary", { name: "Project files" })).toBeVisible({ timeout: T });
};
/** Waits until the panel has finished sliding in and the main area has stopped changing. */
async function settled(w, share) {
	await expect
		.poll(
			async () => {
				const b = await boxes(w, PANEL);
				if (!b.panel || !b.ws) return false;
				const want = share(b.ws.w);
				return Math.abs(b.panel.w - want) < 1.5 && Math.abs(b.panel.right - b.ws.right) < 1.5;
			},
			{ timeout: T },
		)
		.toBe(true);
	await w.page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
	return boxes(w, PANEL);
}
const reading = (ws) => Math.max(360, ws * 0.6);
const tool = (ws) => Math.min(560, Math.max(320, ws * 0.4));
const near = (a, b, why, tolerance = 1) => assert.ok(Math.abs(a - b) <= tolerance, `${why}: ${a} is not ${b}`);

for (const [width, height] of [
	[1280, 820],
	[1440, 900],
]) {
	test(`${width} by ${height}: the changes panel is 60 percent, header 44, files at the right 240 wide`, { timeout: 280000 }, async () => {
		const w = await createWorld({ rules: RULES, tabs: "hidden" });
		let failed = true;
		try {
			await launch(w);
			await size(w, width, height);
			await writeFiles(w);
			await openChanges(w);
			const b = await settled(w, reading);
			near(b.panel.w, b.ws.w * 0.6, "a reading panel is 60 percent of the main area");
			assert.ok(b.panel.w >= 360);
			near(b.chat.w, b.ws.w - b.panel.w, "the conversation keeps the rest");
			// The panel starts at the band's bottom edge and runs to the window's bottom.
			near(b.panel.y, b.band.bottom, "the panel starts under the band");
			near(b.panel.bottom, b.ws.bottom, "and runs to the window's bottom");
			const m = await boxes(w, {
				bar: ".changes-bar",
				title: ".changes-title",
				files: ".changes-files",
				diff: ".changes-diff",
				row: ".changes-flat-row, .changes-tree-row",
			});
			assert.equal(m.bar.h, 44, "the header is 44 high");
			near(m.bar.y, b.panel.y, "the header is the panel's first row");
			const line = await w.page.evaluate(() => {
				const cs = getComputedStyle(document.querySelector(".changes-bar"));
				const panel = getComputedStyle(document.querySelector(".jobs-panel"));
				return { under: cs.borderBottomWidth, edge: panel.borderLeftWidth, sizing: cs.boxSizing, title: cs.getPropertyValue("--panel-title-inset") };
			});
			assert.equal(line.under, "1px", "a 1px line under the header");
			assert.equal(line.edge, "1px", "a 1px seam");
			// The title starts 20 in from the panel's content edge, 14/20 at weight 500.
			near(m.title.x - (b.panel.x + 1), 20, "the title is 20 in");
			const type = await w.page.evaluate(() => {
				const cs = getComputedStyle(document.querySelector(".changes-title"));
				return [cs.fontSize, cs.lineHeight, cs.fontWeight];
			});
			assert.deepEqual(type, ["14px", "20px", "500"]);
			// Controls: View and Close, 28 high, 4 apart, the last 8 from the right edge.
			const controls = await w.page.evaluate(() =>
				[...document.querySelectorAll(".changes-controls > *")].map((el) => {
					const r = el.getBoundingClientRect();
					return { x: r.left, w: r.width, h: r.height, right: r.right };
				}),
			);
			assert.equal(controls.length, 2);
			for (const c of controls) assert.equal(c.h, 28, "controls are 28 high");
			assert.equal(controls[1].w, 28);
			near(controls[1].x - controls[0].right, 4, "controls are 4 apart");
			near(b.panel.right - controls[1].right, 8, "the last control is 8 from the right edge");
			// The list of files is at the right, 240 wide, with a 1px line between it and the diff.
			assert.equal(m.files.w, 240, "the list is 240 wide");
			near(m.files.right, b.panel.right, "the list is at the panel's right");
			near(m.diff.right, m.files.x, "the diff takes the left and ends where the list begins");
			assert.ok(m.diff.x < m.files.x, "the diff is left of the list");
			const divider = await w.page.evaluate(() => {
				const cs = getComputedStyle(document.querySelector(".changes-files"));
				return [cs.borderLeftWidth, cs.borderRightWidth];
			});
			assert.deepEqual(divider, ["1px", "0px"]);
			assert.equal(m.row.h, 28, "rows are 28 high");
			// The seam: a 7px zone centred on the 1px line.
			near(b.grab.w, 7, "the grab zone is 7 wide", 0.01);
			near(b.grab.x + b.grab.w / 2, b.panel.x + 0.5, "centred on the seam");
			// The button of the open panel carries an 8 percent fill; the others do not.
			const tools = await w.page.evaluate(() =>
				[...document.querySelectorAll(".conversation-bar-buttons > button")].map((el) => ({
					label: el.getAttribute("aria-label"),
					pressed: el.getAttribute("aria-pressed"),
					fill: getComputedStyle(el).backgroundColor,
					w: el.getBoundingClientRect().width,
					h: el.getBoundingClientRect().height,
				})),
			);
			const open = tools.find((t) => /^Changes/.test(t.label));
			assert.equal(open.pressed, "true");
			assert.match(open.fill, /\/ 0\.08\)$/, `the open tool has an 8 percent fill: ${open.fill}`);
			for (const t of tools.filter((t) => t !== open)) assert.equal(t.pressed, null), assert.match(t.fill, /rgba\(0, 0, 0, 0\)|transparent/);
			// With the panel closed the fill goes.
			await w.page.getByRole("button", { name: "Close changes" }).click();
			await expect(w.page.getByRole("complementary", { name: "Changes" })).toBeHidden({ timeout: T });
			assert.equal(await w.page.locator(".conversation-bar-changes").getAttribute("aria-pressed"), null);
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});

	test(`${width} by ${height}: the tasks panel takes 40 percent, header 44, controls 28 and 4 apart`, { timeout: 280000 }, async () => {
		const w = await createWorld({ rules: RULES, tabs: "hidden" });
		let failed = true;
		try {
			await launch(w);
			await size(w, width, height);
			await writeFiles(w);
			await openTasks(w);
			const b = await settled(w, tool);
			near(b.panel.w, Math.min(560, Math.max(320, b.ws.w * 0.4)), "a tool panel is 40 percent, 320 to 560");
			near(b.chat.w, b.ws.w - b.panel.w, "the conversation keeps the rest");
			const strip = await boxes(w, { strip: ".panel-heading" });
			assert.equal(strip.strip.h, 44, "the header is 44 high");
			near(strip.strip.y, b.panel.y, "it is the panel's first row");
			const controls = await w.page.evaluate(() =>
				[...document.querySelectorAll(".panel-heading .panel-strip-actions > button")].map((el) => {
					const r = el.getBoundingClientRect();
					return { x: r.left, w: r.width, h: r.height, right: r.right };
				}),
			);
			assert.equal(controls.length, 2);
			for (const c of controls) assert.deepEqual([c.w, c.h], [28, 28]);
			near(controls[1].x - controls[0].right, 4, "controls are 4 apart");
			near(b.panel.right - controls[1].right, 8, "the last control is 8 from the right edge");
			const first = await w.page.evaluate(() => document.querySelector(".panel-tab-scroll .panel-tab").getBoundingClientRect().left - document.querySelector(".jobs-panel").getBoundingClientRect().left);
			near(first, 21, "the first tab begins 20 in from the panel content edge");
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});
}

test("a tool panel stops at 560 in a wide window", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules: RULES, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await size(w, 1760, 900);
		await writeFiles(w);
		await openTasks(w);
		const b = await settled(w, tool);
		assert.ok(b.ws.w * 0.4 > 560, `the main area is wide enough that 40 percent is over 560 (${b.ws.w})`);
		near(b.panel.w, 560, "a tool panel is at most 560");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("where the conversation would keep under 360 the panel lies over it, at the edge and not before", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules: RULES, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await size(w, 1280);
		await writeFiles(w);
		const sidebar = await w.page.evaluate(() => innerWidth - document.querySelector(".workspace").getBoundingClientRect().width);
		// A reading panel: 900 is the first main area that leaves the conversation 360.
		await openFiles(w);
		await size(w, sidebar + 900);
		let b = await settled(w, reading);
		near(b.panel.w, 540, "at 900 the panel is 60 percent and beside the conversation");
		near(b.chat.w, 360, "which keeps 360");
		await size(w, sidebar + 899);
		b = await settled(w, (ws) => ws);
		near(b.panel.w, b.ws.w, "one pixel narrower the panel takes the pane");
		near(b.chat.w, b.ws.w, "the conversation is full width underneath it");
		assert.equal(await w.page.getByRole("button", { name: "Back to conversation" }).isVisible(), true, "the way back is a word");
		assert.equal(await w.page.locator(".panel-resize-handle").isVisible(), false, "no seam to move while it lies over");
		await w.page.getByRole("button", { name: "Back to conversation" }).click();
		// A tool panel: its floor of 320 and the conversation's 360 make 680.
		await size(w, sidebar + 680);
		await openTasks(w);
		b = await settled(w, tool);
		near(b.panel.w, 320, "at 680 the tool panel is at its floor, beside the conversation");
		near(b.chat.w, 360, "which keeps 360");
		await size(w, sidebar + 679);
		b = await settled(w, (ws) => ws);
		near(b.panel.w, b.ws.w, "one pixel narrower it takes the pane");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("the seam drags, a double click puts the share back, the arrows move it, and each kind keeps its own", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules: RULES, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await size(w, 1280);
		await writeFiles(w);
		const stored = () => w.page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith("namzu.workspace.panel-width:")).map(([k, v]) => [k.split(":").slice(2).join(":"), v])));
		await openFiles(w);
		let b = await settled(w, reading);
		const share = b.panel.w;
		const grab = async () => {
			const g = (await boxes(w, PANEL)).grab;
			return { x: g.x + g.w / 2, y: g.y + g.h / 2 };
		};
		// Drag the seam 100 to the right: the panel is 100 narrower, and the width is remembered for this kind.
		let at = await grab();
		await w.page.mouse.move(at.x, at.y);
		await w.page.mouse.down();
		await w.page.mouse.move(at.x + 50, at.y, { steps: 5 });
		await w.page.mouse.move(at.x + 100, at.y, { steps: 5 });
		await w.page.mouse.up();
		b = await settled(w, () => share - 100);
		near(b.panel.w, share - 100, "a drag moves the seam");
		assert.deepEqual(Object.values(await stored()), [String(Math.round(share - 100))]);
		assert.match(Object.keys(await stored())[0], /reading$/);
		// The line on the seam is 2 wide, in the primary colour, while the pointer is on it.
		at = await grab();
		await w.page.mouse.move(at.x, at.y);
		const line = await w.page.evaluate(() => {
			const cs = getComputedStyle(document.querySelector(".panel-resize-handle"), "::after");
			return { w: cs.width, bg: cs.backgroundColor, primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() };
		});
		assert.equal(line.w, "2px");
		assert.notEqual(line.bg, "rgba(0, 0, 0, 0)", "the line shows while hovered");
		// A tool panel has its own width: it is at its own share, not at the dragged one.
		await openTasks(w);
		b = await settled(w, tool);
		near(b.panel.w, tool(b.ws.w), "the tasks panel keeps its share");
		await openFiles(w);
		b = await settled(w, () => share - 100);
		near(b.panel.w, share - 100, "the reading panel is as it was dragged");
		// The arrow keys move it by 24, and by 80 with shift; left makes it wider.
		await w.page.locator(".panel-resize-handle").focus();
		await w.page.keyboard.press("ArrowLeft");
		b = await settled(w, () => share - 100 + 24);
		near(b.panel.w, share - 100 + 24, "an arrow moves it 24");
		await w.page.keyboard.press("Shift+ArrowRight");
		b = await settled(w, () => share - 100 + 24 - 80);
		near(b.panel.w, share - 100 + 24 - 80, "shift moves it 80");
		// A double click on the seam puts the share back and forgets the width.
		at = await grab();
		await w.page.mouse.dblclick(at.x, at.y);
		b = await settled(w, reading);
		near(b.panel.w, b.ws.w * 0.6, "a double click puts the share back");
		assert.deepEqual(await stored(), {}, "and nothing is remembered");
		// A drag is remembered over a restart.
		at = await grab();
		await w.page.mouse.move(at.x, at.y);
		await w.page.mouse.down();
		await w.page.mouse.move(at.x + 120, at.y, { steps: 10 });
		await w.page.mouse.up();
		b = await settled(w, () => share - 120);
		const dragged = b.panel.w;
		await relaunch(w);
		await size(w, 1280);
		if (!(await w.page.getByRole("button", { name: "Project files" }).first().isVisible().catch(() => false)))
			await w.page.getByText("Please write the files").first().click();
		await openFiles(w);
		b = await settled(w, () => dragged);
		near(b.panel.w, dragged, "a restart keeps the dragged width");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
