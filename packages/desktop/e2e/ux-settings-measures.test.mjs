// Settings and the search overlay obey one set of numbers, measured in the real app.
//   Settings (1280 by 820): the content column is 768 wide and centred in the main area; the search field is
//   28 high with radius 8; a group heading is 15/22 at weight 600 with 40 above and 16 under, the first one 16
//   under the title block; a row with only a label and a control is 52 high and one with a single line of
//   description 68; every control ends on the column's right edge and is centred on its row; buttons and
//   selects are 28 high with radius 8; the switch is 36 by 20 with a 16 px knob 2 from its edge.
//   Selection controls are not lime: a switch that is on, a chosen radio and a checked box use the text
//   colour, the control stands at least 3 to 1 against its ground in both themes, and on and off differ by the
//   knob's side, not only by colour.
//   The search overlay: min(672px, 100vw - 32px) wide, min(584px, 70dvh) high, its centre 18 below the window's
//   centre, radius 16; the input row 33 high, 18 under the top edge and 24 from each side, with a bare close
//   glyph at the right; rows 36 high with radius 8, a 16 px icon 12 in and the title 40 in; only the
//   highlighted row shows its right-hand hints; a group's caption 12/16 with 8 above the first row; a footer
//   42 high under a full-width hairline with key boxes 18 high; the same 50 percent scrim as a dialog.
// Every vertical position is measured against the element it sits next to or the window's centre, never as an
// absolute window y. Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-settings-measures.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject } from "./harness.mjs";

const T = 60000;

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

const settled = (w) =>
	w.page.evaluate(() =>
		Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
	);

async function openSection(w, name) {
	const nav = w.page.getByRole("navigation", { name: "Settings sections" });
	if ((await nav.count()) === 0) await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(nav).toBeVisible({ timeout: T });
	await nav.getByRole("button", { name, exact: true }).click();
	await expect(w.page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible({ timeout: T });
	await settled(w);
}

const near = (actual, want, label, slack = 0.5) => assert.ok(Math.abs(actual - want) <= slack, `${label}: ${actual} is not ${want}`);

/** A colour of any CSS form, as [r, g, b, a] on a 0..255 scale, read by painting it. */
const PAINT = (css) => {
	const c = document.createElement("canvas").getContext("2d");
	c.clearRect(0, 0, 1, 1);
	c.fillStyle = css;
	c.fillRect(0, 0, 1, 1);
	return [...c.getImageData(0, 0, 1, 1).data];
};

const world = (options = {}) =>
	createWorld({ tabs: "hidden", models: [{ id: "gpt-e2e-1", context_window: 128000 }, "gpt-e2e-0"], rules: [{ match: /hello/, steps: [{ text: "Hello there." }] }], ...options });

test("Settings at 1280 by 820: column 768 and centred, rows 52 and 68, headings 40 and 16, switch 36 by 20, controls on one right edge", { timeout: 280000 }, async () => {
	const w = await world();
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await theme(w, "dark");
		let described = 0;
		let plain = 0;
		let switches = 0;
		let headingsSeen = 0;
		for (const section of ["General", "Updates", "Terminal", "Projects", "Agent", "Appearance"]) {
			await openSection(w, section);
			const m = await w.page.evaluate(() => {
				const rect = (el) => {
					const b = el.getBoundingClientRect();
					return { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
				};
				const style = (el, ...keys) => Object.fromEntries(keys.map((k) => [k, getComputedStyle(el)[k]]));
				const page = document.querySelector(".settings-page");
				const content = document.querySelector(".settings-page-content");
				const header = document.querySelector(".settings-page-header");
				const search = document.querySelector(".settings-page-search");
				const sectionEl = document.querySelector(".settings-section");
				const headings = [...document.querySelectorAll(".settings-section-title, .settings-subtitle")].map((el) => ({
					...rect(el),
					...style(el, "fontSize", "lineHeight", "fontWeight"),
					prev: el.previousElementSibling ? rect(el.previousElementSibling).bottom : null,
					next: el.nextElementSibling ? rect(el.nextElementSibling).y : null,
					first: sectionEl.firstElementChild === el || sectionEl.firstElementChild?.firstElementChild === el,
				}));
				const rows = [...document.querySelectorAll(".settings-row")].map((el) => {
					const control = el.querySelector(".settings-row-control");
					const copy = el.querySelector(".settings-row-copy");
					return {
						id: el.id,
						...rect(el),
						stacked: el.hasAttribute("data-stacked"),
						descLines: el.querySelector(".settings-row-copy p") ? Math.round(rect(el.querySelector(".settings-row-copy p")).h / 18) : 0,
						control: control ? rect(control) : null,
						copy: copy ? rect(copy) : null,
						pad: style(el, "paddingTop", "paddingBottom"),
					};
				});
				const sw = [...document.querySelectorAll(".settings-switch")].map((el) => ({
					...rect(el),
					knob: style(el, "width"),
					after: (({ width, height, left, top }) => ({ width, height, left, top }))(getComputedStyle(el, "::after")),
				}));
				const buttons = [...document.querySelectorAll(".settings-row-control button, .settings-row-control select, .settings-row-control input.settings-config-input")].map((el) => ({
					...rect(el),
					tag: el.tagName,
					radius: getComputedStyle(el).borderTopLeftRadius,
				}));
				return { page: { ...rect(page), right: page.getBoundingClientRect().left + page.clientWidth }, content: rect(content), header: rect(header), h1: rect(header.querySelector("h1")), search: { ...rect(search), radius: getComputedStyle(search).borderTopLeftRadius }, headings, rows, sw, buttons, first: sectionEl.firstElementChild ? rect(sectionEl.firstElementChild) : null };
			});
			const label = (what) => `${section}: ${what}`;
			near(m.content.w, 768, label("the content column"));
			near(m.content.x - m.page.x, m.page.right - m.content.right, label("the column is centred in the main area"), 1);
			assert.ok(m.h1.y >= m.page.y, label("the title block sits under the header band"));
			near(m.search.h, 28, label("the search field height"));
			assert.equal(m.search.radius, "8px", label("the search field radius"));
			// The title block ends 16 above the first thing in the section.
			if (m.first) near(m.first.y - m.header.bottom, 16, label("the first element is 16 under the title block"));
			for (const heading of m.headings) {
				headingsSeen += 1;
				assert.equal(heading.fontSize, "15px", label(`heading "${heading.fontSize}" size`));
				assert.equal(heading.lineHeight, "22px");
				assert.equal(heading.fontWeight, "600");
				if (heading.first) near(heading.y - m.header.bottom, 16, label("the first heading is 16 under the title block"));
				else if (heading.prev !== null) near(heading.y - heading.prev, 40, label("a heading is 40 under what came before"));
				if (heading.next !== null) near(heading.next - heading.bottom, 16, label("a heading is 16 above what follows"));
			}
			for (const row of m.rows) {
				assert.equal(row.pad.paddingTop, "12px", label(`${row.id} padding above`));
				assert.equal(row.pad.paddingBottom, "12px", label(`${row.id} padding below`));
				if (row.stacked || !row.control) continue;
				// The control ends on the column's right edge and is centred on the row.
				near(row.control.right, m.content.right, label(`${row.id}: the control ends on the column's right edge`), 1);
				near(row.control.y + row.control.h / 2, row.y + row.h / 2, label(`${row.id}: the control is centred on its row`), 1.5);
				if (row.descLines === 0 && row.control.h <= 28.5) {
					near(row.h, 52, label(`${row.id}: a row with only a label and a control`));
					plain += 1;
				}
				if (row.descLines === 1) {
					near(row.h, 68, label(`${row.id}: a row with one line of description`));
					described += 1;
				}
			}
			for (const control of m.buttons) {
				near(control.h, 28, label(`a ${control.tag.toLowerCase()} in a row`));
				assert.equal(control.radius, "8px", label(`a ${control.tag.toLowerCase()} corner`));
			}
			for (const sw of m.sw) {
				switches += 1;
				near(sw.w, 36, label("switch width"));
				near(sw.h, 20, label("switch height"));
				assert.equal(sw.after.width, "16px", label("knob width"));
				assert.equal(sw.after.height, "16px");
				assert.equal(sw.after.left, "2px", label("knob 2 from the edge"));
				assert.equal(sw.after.top, "2px");
			}
		}
		assert.ok(plain > 0, "a row with only a label and a control was measured");
		assert.ok(described > 0, "a row with one line of description was measured");
		assert.ok(switches >= 5, "switches were measured");
		assert.ok(headingsSeen > 0, "group headings were measured");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("selection controls use the text colour, stand 3 to 1 off their ground and differ by more than colour, in both themes", { timeout: 280000 }, async () => {
	const w = await world();
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await openSection(w, "General");
		for (const mode of ["dark", "light"]) {
			await theme(w, mode);
			await openSection(w, "General");
			const read = await w.page.evaluate(
				([paint]) => {
					const toRgb = new Function("css", `return (${paint})(css)`);
					const luminance = ([r, g, b]) => {
						const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
						return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
					};
					const ratio = (a, b) => {
						const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
						return (hi + 0.05) / (lo + 0.05);
					};
					const over = (top, ground) => {
						const a = top[3] / 255;
						return [0, 1, 2].map((i) => top[i] * a + ground[i] * (1 - a));
					};
					const ground = toRgb(getComputedStyle(document.querySelector(".settings-page")).backgroundColor === "rgba(0, 0, 0, 0)" ? getComputedStyle(document.body).backgroundColor : getComputedStyle(document.querySelector(".settings-page")).backgroundColor);
					const text = toRgb(getComputedStyle(document.querySelector(".settings-page")).color);
					const lime = toRgb(getComputedStyle(document.documentElement).getPropertyValue("--primary").trim());
					const switches = [...document.querySelectorAll(".settings-switch")];
					const on = switches.find((s) => s.checked);
					const off = switches.find((s) => !s.checked);
					const info = (s) => {
						const cs = getComputedStyle(s);
						const knob = getComputedStyle(s, "::after");
						return { track: toRgb(cs.backgroundColor), edge: cs.boxShadow, knobBg: toRgb(knob.backgroundColor), knobMove: knob.transform };
					};
					const result = { on: on && info(on), off: off && info(off), ground, text, lime };
					if (result.on) result.on.contrast = ratio(over(result.on.track, ground), ground);
					if (result.on) result.on.knobContrast = ratio(result.on.knobBg, over(result.on.track, ground));
					if (result.off) {
						const edgeColour = /(rgba?\([^)]*\)|color\([^)]*\))/.exec(result.off.edge)?.[1];
						result.off.edgeContrast = edgeColour ? ratio(over(toRgb(edgeColour), ground), ground) : 0;
					}
					return result;
				},
				[PAINT.toString()],
			);
			assert.ok(read.on && read.off, `${mode}: General has a switch that is on and one that is off`);
			assert.deepEqual(read.on.track.slice(0, 3), read.text.slice(0, 3), `${mode}: a switch that is on takes the text colour`);
			assert.notDeepEqual(read.on.track.slice(0, 3), read.lime.slice(0, 3), `${mode}: a switch that is on is not lime`);
			assert.ok(read.on.contrast >= 3, `${mode}: the on switch stands ${read.on.contrast.toFixed(2)} to 1 against its ground`);
			assert.ok(read.on.knobContrast >= 3, `${mode}: the knob stands ${read.on.knobContrast.toFixed(2)} to 1 against the on track`);
			assert.ok(read.off.edgeContrast >= 3, `${mode}: the off switch's outline stands ${read.off.edgeContrast.toFixed(2)} to 1 against its ground`);
			// On and off differ by the knob's side, not by colour alone.
			assert.notEqual(read.on.knobMove, read.off.knobMove, `${mode}: the knob sits on another side when on`);
			assert.match(read.on.knobMove, /matrix\(1, 0, 0, 1, 16, 0\)/, `${mode}: the knob travels 16 px`);
		}
		// A chosen radio and a checked box.
		await openSection(w, "Appearance");
		const choice = await w.page.evaluate(() => {
			const radio = document.querySelector(".settings-choice input[type=radio]:checked");
			const other = document.querySelector(".settings-choice input[type=radio]:not(:checked)");
			const cs = getComputedStyle(radio);
			const dot = getComputedStyle(radio, "::after");
			return {
				appearance: cs.appearance,
				background: cs.backgroundColor,
				text: getComputedStyle(document.querySelector(".settings-page")).color,
				dot: dot.content,
				otherDot: getComputedStyle(other, "::after").content,
				accent: cs.accentColor,
				size: [radio.getBoundingClientRect().width, radio.getBoundingClientRect().height],
			};
		});
		assert.equal(choice.appearance, "none", "a radio is drawn by the app, not by the system");
		assert.equal(choice.background, choice.text, "a chosen radio takes the text colour");
		assert.notEqual(choice.dot, "none", "a chosen radio has a dot");
		assert.ok(choice.otherDot === "none" || choice.otherDot === "normal", "an unchosen radio has none");
		assert.deepEqual(choice.size, [16, 16]);
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

for (const [width, height] of [
	[1280, 820],
	[900, 820],
	[700, 1000],
]) {
	test(`search overlay at ${width} by ${height}: size, centre, input row, rows, hints, footer and scrim`, { timeout: 280000 }, async () => {
		const w = await world();
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			await size(w, width, height);
			for (const mode of ["dark", "light"]) {
				await theme(w, mode);
				await w.page.keyboard.press("Control+k");
				await w.page.locator(".command-palette-popup").waitFor({ state: "visible", timeout: T });
				await settled(w);
				const m = await w.page.evaluate(() => {
					const rect = (el) => {
						const b = el.getBoundingClientRect();
						return { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
					};
					const popup = document.querySelector(".command-palette-popup");
					const pc = getComputedStyle(popup);
					const input = document.querySelector(".command-palette-input");
					const close = document.querySelector(".command-palette-close");
					const list = document.querySelector(".command-palette-list");
					const rows = [...document.querySelectorAll(".command-palette-item")];
					const first = rows[0];
					const captions = [...document.querySelectorAll(".command-palette-group-label")];
					const visible = (el) => !!el && getComputedStyle(el).display !== "none";
					const footer = document.querySelector(".command-palette-footer");
					const key = footer.querySelector("kbd");
					const kc = getComputedStyle(key);
					const backdrop = document.querySelector(".command-palette-backdrop");
					const border = popup.clientTop;
					return {
						win: { w: window.innerWidth, h: window.innerHeight },
						popup: rect(popup),
						border,
						radius: pc.borderTopLeftRadius,
						input: rect(input),
						close: close ? { ...rect(close), bg: getComputedStyle(close).backgroundColor, borderWidth: getComputedStyle(close).borderTopWidth } : null,
						inputChrome: [getComputedStyle(input).borderTopWidth, getComputedStyle(input).backgroundColor],
						icons: document.querySelectorAll(".command-palette-search svg:not(.command-palette-close svg)").length,
						list: rect(list),
						rows: rows.map((r) => ({
							...rect(r),
							radius: getComputedStyle(r).borderTopLeftRadius,
							icon: rect(r.querySelector(".command-palette-icon")),
							label: rect(r.querySelector(".command-palette-label")),
							shown: visible(r.querySelector(".command-palette-shortcut")) || visible(r.querySelector(".command-palette-meta")),
							hinted: !!(r.querySelector(".command-palette-shortcut") || r.querySelector(".command-palette-meta")),
							highlighted: r.hasAttribute("data-highlighted"),
						})),
						caption: captions[0] ? { ...rect(captions[0]), fontSize: getComputedStyle(captions[0]).fontSize, lineHeight: getComputedStyle(captions[0]).lineHeight, firstRowY: rect(first).y } : null,
						footer: { ...rect(footer), border: getComputedStyle(footer).borderTopWidth },
						key: { h: key.getBoundingClientRect().height, border: kc.borderTopWidth, radius: kc.borderTopLeftRadius, fontSize: kc.fontSize },
						scrim: getComputedStyle(backdrop).backgroundColor,
					};
				});
				const label = (what) => `${mode} ${width}x${height}: ${what}`;
				near(m.popup.w, Math.min(672, m.win.w - 32), label("width"));
				near(m.popup.h, Math.min(584, 0.7 * m.win.h), label("height"));
				near(m.popup.y + m.popup.h / 2 - m.win.h / 2, 18, label("centre below the window's centre"), 1);
				near(m.popup.x + m.popup.w / 2 - m.win.w / 2, 0, label("centred across the window"), 1);
				assert.equal(m.radius, "16px", label("radius"));
				near(m.input.h, 33, label("input row height"));
				near(m.input.y - (m.popup.y + m.border), 18, label("input row under the top edge"));
				near(m.input.x - (m.popup.x + m.border), 24, label("input row from the left edge"));
				assert.ok(m.close, label("a close glyph"));
				near(m.popup.right - m.border - m.close.right, 24, label("close glyph from the right edge"));
				assert.equal(m.close.bg, "rgba(0, 0, 0, 0)", label("the close glyph is bare"));
				assert.equal(m.close.borderWidth, "0px");
				assert.equal(m.inputChrome[0], "0px", label("no field chrome"));
				assert.equal(m.icons, 0, label("no search icon"));
				near(m.rows[0].x - (m.popup.x + m.border), 10, label("the list inset"));
				assert.ok(m.rows.length >= 3, label("rows were measured"));
				for (const row of m.rows) {
					near(row.h, 36, label("row height"));
					assert.equal(row.radius, "8px", label("row radius"));
					near(row.icon.w, 16, label("icon width"));
					near(row.icon.x - row.x, 12, label("icon 12 in"));
					near(row.label.x - row.x, 40, label("title 40 in"));
					if (!row.highlighted) assert.equal(row.shown, false, label("only the highlighted row shows its hints"));
				}
				assert.ok(m.caption, label("a group caption"));
				assert.equal(m.caption.fontSize, "12px");
				assert.equal(m.caption.lineHeight, "16px");
				near(m.caption.firstRowY - m.caption.bottom, 8, label("the caption stands 8 above the first row"));
				near(m.footer.h, 42, label("footer height"));
				assert.equal(m.footer.border, "1px", label("footer hairline"));
				near(m.footer.w, m.popup.w - 2 * m.border, label("the footer hairline runs full width"));
				near(m.popup.bottom - m.border - m.footer.bottom, 0, label("the footer ends at the surface's bottom"));
				near(m.key.h, 18, label("key box height"));
				assert.equal(m.key.border, "1px");
				assert.equal(m.key.radius, "4px");
				assert.equal(m.key.fontSize, "12px");
				// The scrim is the dialog's: 50 percent black in the dark theme, 40 in the light.
				const alpha = mode === "dark" ? "0.5" : "0.4";
				assert.ok(m.scrim.includes(alpha), label(`the scrim is ${alpha} black (${m.scrim})`));
				await w.page.keyboard.press("Escape");
				await expect(w.page.locator(".command-palette-popup")).toHaveCount(0, { timeout: T });
			}
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});
}

test("the search overlay shows hints for the highlighted row only, and its close glyph closes it", { timeout: 280000 }, async () => {
	const w = await world();
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await w.page.keyboard.press("Control+k");
		await w.page.locator(".command-palette-popup").waitFor({ state: "visible", timeout: T });
		await w.page.keyboard.type("conversation");
		const count = () => w.page.evaluate(() => [...document.querySelectorAll(".command-palette-item")].filter((r) => [".command-palette-shortcut", ".command-palette-meta"].some((s) => r.querySelector(s) && getComputedStyle(r.querySelector(s)).display !== "none")).length);
		assert.ok((await count()) <= 1, "at most the highlighted row shows hints");
		await w.page.getByRole("button", { name: "Close search" }).click();
		await expect(w.page.locator(".command-palette-popup")).toHaveCount(0, { timeout: T });
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
