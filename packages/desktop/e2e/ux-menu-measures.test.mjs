// Every menu and dialog obeys one set of numbers, measured in the real app at 1280 by 820 and 900 by 820:
// the permission menu, the model picker, the plus menu and a project row's menu (opened from its "…") have
// the surface radius 12 and padding 5, one-line rows 28 high and a row with a one-line description 46, rows
// with their own corner of 8 and text 10 in, the menu 6 from the control that opened it and inside the
// window; a conversation row's context menu has the same rows; the control that opened a menu carries a
// fill while it is open; a confirm dialog is 400 wide with padding 16, a 15 title, a 14 body, 8 between
// them, 16 above the buttons, buttons 28 high and 8 apart, and 50 percent black behind it (dark theme).
// Every vertical position is measured against the menu's own trigger or edges, never as a window y.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-menu-measures.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SIZES = [
	[1280, 820],
	[900, 820],
];

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

async function theme(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}

/** What the page has settled on: the open menu's own animations have finished. */
const settled = (w) =>
	w.page.evaluate(() =>
		Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
	);

/** The popup, its trigger and its rows, as boxes and computed styles; read by selector in the page. */
const READ = ({ popup, rows, trigger, surface }) => {
	const rect = (el) => {
		const b = el.getBoundingClientRect();
		return { x: b.left, y: b.top, w: b.width, h: b.height, bottom: b.bottom, right: b.right };
	};
	const p = document.querySelector(popup);
	const t = trigger ? document.querySelector(trigger) : null;
	const s = surface ? document.querySelector(surface) : p;
	const sc = getComputedStyle(s);
	const pc = getComputedStyle(p);
	return {
		win: { w: window.innerWidth, h: window.innerHeight },
		popup: rect(p),
		radius: pc.borderTopLeftRadius,
		border: Number.parseFloat(pc.borderTopWidth),
		padding: [sc.paddingTop, sc.paddingRight, sc.paddingBottom, sc.paddingLeft].map(Number.parseFloat),
		trigger: t ? { ...rect(t), fill: getComputedStyle(t).backgroundColor } : null,
		rows: [...document.querySelectorAll(rows)].map((r) => ({
			...rect(r),
			text: r.textContent.trim().slice(0, 30),
			radius: getComputedStyle(r).borderTopLeftRadius,
			described: !!r.querySelector("small, .composer-permission-description"),
			lines: r.querySelector(".composer-permission-description")
				? Math.round(r.querySelector(".composer-permission-description").getBoundingClientRect().height / 18)
				: 1,
		})),
	};
};

const MENUS = {
	permission: {
		popup: ".composer-permission-menu",
		rows: ".composer-permission-option",
		trigger: "[aria-label^='Permissions:']",
		surface: ".composer-permission-panel",
		open: (p) => p.getByRole("button", { name: /^Permissions:/ }).click(),
	},
	model: {
		popup: ".model-picker-popup",
		rows: ".model-picker-row",
		trigger: "[aria-label^='Model:']",
		surface: ".model-lineup",
		open: (p) => p.getByRole("button", { name: /^Model:/ }).click(),
	},
	plus: {
		popup: ".pal-composer-tools",
		rows: ".pal-composer-attach",
		trigger: "[aria-label='Attachments and message settings']",
		surface: ".pal-composer-tools [data-slot=popover-viewport]",
		open: (p) => p.getByRole("button", { name: "Attachments and message settings" }).click(),
	},
	project: {
		popup: ".conversation-actions-popup",
		rows: ".conversation-actions-item",
		trigger: ".sidebar-project-more",
		open: async (p) => {
			const heading = p.locator(".sidebar-project-heading").first();
			await heading.hover();
			await heading.locator(".sidebar-project-more").click();
		},
	},
	chooser: {
		popup: ".composer-project-popup",
		rows: ".composer-project-actions button",
		trigger: "[aria-label='Choose project folder']",
		surface: ".composer-project-popup [data-slot=popover-viewport]",
		open: (p) => p.getByRole("button", { name: "Choose project folder" }).click(),
	},
	context: {
		popup: ".conversation-actions-popup",
		rows: ".conversation-actions-item",
		trigger: null,
		open: (p) => p.locator("li[data-thread-item]").first().click({ button: "right" }),
	},
};

async function open(w, name) {
	const menu = MENUS[name];
	await menu.open(w.page);
	await w.page.locator(menu.popup).first().waitFor({ state: "visible", timeout: T });
	// The popup enters at a slightly smaller scale and grows to full size; measure it only once it has, so
	// a measure never reads a row mid-transition.
	await expect
		.poll(() => w.page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).transform, menu.popup), { timeout: T })
		.toBe("none");
	await settled(w);
	const { popup, rows, trigger, surface } = menu;
	return w.page.evaluate(READ, { popup, rows, trigger, surface });
}

async function close(w) {
	await w.page.keyboard.press("Escape");
	await expect(w.page.locator("[role=menu], .composer-permission-menu, .model-picker-popup, .pal-composer-tools, .composer-project-popup")).toHaveCount(0, { timeout: T });
}

const near = (actual, want, label) => assert.ok(Math.abs(actual - want) <= 0.5, `${label}: ${actual} is not ${want}`);

function checkSurface(m, label) {
	assert.equal(m.radius, "12px", `${label}: the surface has radius 12`);
	for (const side of m.padding) near(side, 5, `${label}: surface padding`);
	// The first row starts the border plus the padding in from the surface's edge.
	for (const row of m.rows) near(row.x - m.popup.x, m.border + 5, `${label}: a row's left edge from the surface`);
	for (const row of m.rows) assert.equal(row.radius, "8px", `${label}: "${row.text}" has radius 8`);
	assert.ok(m.popup.x >= 0 && m.popup.right <= m.win.w && m.popup.y >= 0 && m.popup.bottom <= m.win.h, `${label}: the menu is inside the window`);
}

function checkOffset(m, label) {
	// An upward menu ends 6 above its control; a downward menu starts 6 under it.
	const above = m.trigger.y - m.popup.bottom;
	const below = m.popup.y - m.trigger.bottom;
	assert.ok(Math.abs(above - 6) <= 0.5 || Math.abs(below - 6) <= 0.5, `${label}: sits 6 from its control (above ${above}, below ${below})`);
}

for (const [width, height] of SIZES) {
	test(`menus at ${width} by ${height}: surface 12 and 5, rows 28 and 46, 6 from the control, inside the window`, { timeout: 280000 }, async () => {
		const w = await createWorld({
			models: [{ id: "gpt-e2e-1", context_window: 128000 }, "gpt-e2e-0"],
			rules: [{ match: /hello/, steps: [{ text: "Hello there." }] }],
		});
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			await size(w, width, height);
			await send(w, "hello there");
			await expect(w.page.getByText("Hello there.").first()).toBeVisible({ timeout: T });
			for (const mode of ["dark", "light"]) {
				await theme(w, mode);
				const label = (name) => `${name} ${mode} ${width}x${height}`;

				// The permission menu: every row has a one-line description, so every row is 46 high.
				const permission = await open(w, "permission");
				checkSurface(permission, label("permission"));
				checkOffset(permission, label("permission"));
				assert.ok(permission.rows.length >= 3, "the permission menu lists its modes");
				for (const row of permission.rows) {
					assert.equal(row.lines, 1, `${label("permission")}: "${row.text}" keeps its description on one line`);
					near(row.h, 46, `${label("permission")}: "${row.text}" height`);
				}
				// The title is a 25 px block and the chosen row's check is 9 from its right edge.
				const caption = await w.page.evaluate(() => document.querySelector(".composer-permission-title").getBoundingClientRect().height);
				near(caption, 25, `${label("permission")}: the caption block`);
				const check = await w.page.evaluate(() => {
					const mark = document.querySelector(".composer-permission-check svg");
					const row = mark?.closest(".composer-permission-option");
					if (!mark || !row) return null;
					const c = mark.getBoundingClientRect();
					const l = row.querySelector(".composer-permission-label").getBoundingClientRect();
					return { fromEdge: row.getBoundingClientRect().right - c.right, line: c.top >= l.top - 2 && c.bottom <= l.bottom + 2 };
				});
				assert.ok(check, "the chosen row carries a check");
				near(check.fromEdge, 9, `${label("permission")}: the check from the row's right edge`);
				assert.ok(check.line, `${label("permission")}: the check sits on the title's line`);
				// While the menu is open the control carries a fill (8 percent of the text colour).
				assert.match(permission.trigger.fill, /0\.08\)?$/, `${label("permission")}: the open control carries an 8 percent fill`);
				await close(w);

				// The model picker: a row with its facts under the name is 46, a single line is 28.
				const model = await open(w, "model");
				checkSurface(model, label("model"));
				checkOffset(model, label("model"));
				const described = model.rows.find((row) => row.described);
				const single = model.rows.find((row) => !row.described);
				assert.ok(described && single, "the picker lists a row with facts and one without");
				near(described.h, 46, `${label("model")}: a described row`);
				near(single.h, 28, `${label("model")}: a one-line row`);
				const pickerCheck = await w.page.evaluate(() => {
					const c = document.querySelector(".model-picker-checked svg")?.getBoundingClientRect();
					const r = document.querySelector(".model-picker-checked")?.closest(".model-picker-row")?.getBoundingClientRect();
					return c && r ? r.right - c.right : null;
				});
				near(pickerCheck, 9, `${label("model")}: the check from the row's right edge`);
				const textStart = await w.page.evaluate(() => {
					const row = document.querySelector(".model-picker-row");
					const name = row.querySelector(".model-picker-name span");
					return name.getBoundingClientRect().left - row.getBoundingClientRect().left;
				});
				near(textStart, 10, `${label("model")}: the text starts 10 in`);
				await close(w);

				// The plus menu.
				const plus = await open(w, "plus");
				checkSurface(plus, label("plus"));
				checkOffset(plus, label("plus"));
				near(plus.rows[0].h, 28, `${label("plus")}: the attach row`);
				const labelStart = await w.page.evaluate(() => {
					const row = document.querySelector(".pal-composer-attach");
					const range = document.createRange();
					range.selectNodeContents([...row.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()));
					return range.getBoundingClientRect().left - row.getBoundingClientRect().left;
				});
				near(labelStart, 38, `${label("plus")}: a row with an icon starts its label 38 in`);
				await close(w);

				// A project row's menu, opened from the "…" on the row.
				const project = await open(w, "project");
				checkSurface(project, label("project"));
				checkOffset(project, label("project"));
				for (const row of project.rows) near(row.h, 28, `${label("project")}: "${row.text}"`);
				const separator = await w.page.evaluate(() => {
					const s = document.querySelector(".conversation-actions-separator");
					const b = s.getBoundingClientRect();
					const before = s.previousElementSibling.getBoundingClientRect();
					const after = s.nextElementSibling.getBoundingClientRect();
					return { h: b.height, above: b.top - before.bottom, below: after.top - b.bottom, inset: b.left - before.left };
				});
				near(separator.h, 1, `${label("project")}: the separator is 1 px`);
				near(separator.above, 4, `${label("project")}: 4 above the separator`);
				near(separator.below, 4, `${label("project")}: 4 below the separator`);
				near(separator.inset, 10, `${label("project")}: the separator is inset 10`);
				// A highlighted row (the pointer is over it) carries an 8 percent fill.
				await w.page.locator(".conversation-actions-item").nth(1).hover();
				await expect(w.page.locator(".conversation-actions-item[data-highlighted]")).toHaveCount(1, { timeout: T });
				await settled(w);
				const fill = await w.page.evaluate(() => {
					const hi = document.querySelector(".conversation-actions-item[data-highlighted]");
					return hi ? getComputedStyle(hi).backgroundColor : null;
				});
				assert.ok(fill && /0\.08\)?$/.test(fill), `${label("project")}: the highlighted row has an 8 percent fill (${fill})`);
				await close(w);

				// A conversation row's context menu: the same rows (it opens at the pointer, so no trigger).
				const context = await open(w, "context");
				checkSurface(context, label("context"));
				for (const row of context.rows) near(row.h, 28, `${label("context")}: "${row.text}"`);
				assert.ok(context.popup.w >= 128 && context.popup.w <= 320, `${label("context")}: width by content between 128 and 320 (${context.popup.w})`);
				await close(w);
			}
			assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});
}

for (const [width, height] of SIZES) {
	test(`the project chooser at ${width} by ${height}: surface 12 and 5, action rows 28, 6 from its control, inside the window`, { timeout: 280000 }, async () => {
		const w = await createWorld({ models: [{ id: "gpt-e2e-1", context_window: 128000 }, "gpt-e2e-0"], rules: [] });
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			await size(w, width, height);
			for (const mode of ["dark", "light"]) {
				await theme(w, mode);
				const label = (name) => `${name} ${mode} ${width}x${height}`;
				// The project chooser opens upward from the row under the input box; its action rows are 28
				// high with nothing between them, set off from the list by a separator inset 10.
				const chooser = await open(w, "chooser");
				checkSurface(chooser, label("chooser"));
				checkOffset(chooser, label("chooser"));
				assert.ok(chooser.rows.length >= 2, "the chooser lists its actions");
				for (const row of chooser.rows) near(row.h, 28, `${label("chooser")}: "${row.text}"`);
				for (let i = 1; i < chooser.rows.length; i++) near(chooser.rows[i].y - chooser.rows[i - 1].bottom, 0, `${label("chooser")}: no space between action rows`);
				await close(w);

			}
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});
}

test("a confirm dialog is 400 wide with padding 16, a 15 title, a 14 body, buttons 28 and 50 percent black behind it", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules: [{ match: /hello/, steps: [{ text: "Hello there." }] }] });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		for (const [mode, alpha] of [["dark", 0.5], ["light", 0.4]]) {
			await theme(w, mode);
			await w.page.getByRole("button", { name: /^Permissions:/ }).click();
			await w.page.getByRole("menuitemradio", { name: /Full access/ }).click();
			const dialog = w.page.getByRole("alertdialog");
			await expect(dialog).toBeVisible({ timeout: T });
			await settled(w);
			const m = await w.page.evaluate(() => {
				const rect = (el) => {
					const b = el.getBoundingClientRect();
					return { x: b.left, y: b.top, w: b.width, h: b.height, bottom: b.bottom, right: b.right };
				};
				const d = document.querySelector("[role=alertdialog]");
				const c = getComputedStyle(d);
				const title = d.querySelector("h2");
				const body = d.querySelector(".dialog-body");
				const actions = d.querySelector(".dialog-actions");
				const scrim = document.querySelector(".dialog-scrim");
				const sc = getComputedStyle(scrim);
				return {
					popup: rect(d),
					padding: [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].map(Number.parseFloat),
					radius: c.borderTopLeftRadius,
					title: { ...rect(title), size: getComputedStyle(title).fontSize, line: getComputedStyle(title).lineHeight, weight: getComputedStyle(title).fontWeight },
					body: { ...rect(body), size: getComputedStyle(body).fontSize, line: getComputedStyle(body).lineHeight },
					actions: rect(actions),
					buttons: [...actions.querySelectorAll("button")].map((b) => ({ ...rect(b), radius: getComputedStyle(b).borderTopLeftRadius })),
					scrim: { ...rect(scrim), color: sc.backgroundColor },
					win: { w: innerWidth, h: innerHeight },
				};
			});
			near(m.popup.w, 400, `${mode}: the confirm dialog is 400 wide`);
			for (const side of m.padding) near(side, 16, `${mode}: dialog padding`);
			assert.equal(m.radius, "12px");
			assert.deepEqual([m.title.size, m.title.line, m.title.weight], ["15px", "22px", "600"]);
			assert.deepEqual([m.body.size, m.body.line], ["14px", "20px"]);
			near(m.body.y - m.title.bottom, 8, `${mode}: 8 between title and body`);
			near(m.actions.y - m.body.bottom, 16, `${mode}: 16 above the buttons`);
			assert.ok(m.buttons.length >= 2);
			for (const b of m.buttons) {
				near(b.h, 28, `${mode}: button height`);
				assert.equal(b.radius, "8px");
			}
			for (let i = 1; i < m.buttons.length; i++) near(m.buttons[i].x - m.buttons[i - 1].right, 8, `${mode}: 8 between buttons`);
			near(m.popup.right - 1 - 16, m.buttons.at(-1).right, `${mode}: the buttons are at the right`);
			// The scrim covers the whole window, including the sidebar and the header.
			assert.deepEqual([m.scrim.x, m.scrim.y, m.scrim.w, m.scrim.h], [0, 0, m.win.w, m.win.h]);
			const channels = m.scrim.color.match(/[\d.]+/g).map(Number);
			assert.deepEqual(channels.slice(0, 3), [0, 0, 0], `${mode}: the scrim is black`);
			near(channels[3], alpha, `${mode}: the scrim is ${alpha * 100} percent`);
			await w.page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0, { timeout: T });
		}
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
