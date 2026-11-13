// The frame obeys one rhythm, measured in the real app at 1280 by 820: both header bands are 36 high and
// end on one y (with the strip of tabs and with the conversation bar, in Settings and on the collapsed
// rail), a tab is 28 high and 4 from the top, every sidebar row is 32 high with 2 between rows and its
// box from x 8 to x 277, every label starts at x 44 (navigation, project, conversation and Settings
// section rows), the state mark's slot is 16 wide at x 18, a section title's text starts at x 18 in a
// 28 band with 22 above and 4 below, the end controls of a row are 24 by 24 and 4 from its end, the foot
// is 45 high with 28 buttons, and the selected row is 16 percent of the text colour in both themes. The
// main header draws its line on every screen but the home screen, Settings included.
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
		return { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
	};
	const labelX = (el) => {
		if (!el) return null;
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			return range.getBoundingClientRect().left;
		}
		return null;
	};
	const row = (el, label) => (el ? { ...rect(el), label: labelX(label), radius: getComputedStyle(el).borderTopLeftRadius } : null);
	const q = (s) => document.querySelector(s);
	const visible = (el) => el.getBoundingClientRect().width > 0;
	const heading = q(".sidebar-project-heading");
	const foot = [...document.querySelectorAll(".sidebar-foot")].find(visible);
	const conv = q("li[data-thread-item] .sidebar-conversation-button");
	const pal = q(".sidebar-pal-row");
	const title = (band) => {
		const previous = band.previousElementSibling ?? band.parentElement.previousElementSibling;
		const next = band.nextElementSibling;
		const b = band.getBoundingClientRect();
		const text = band.querySelector("h2, h3") ?? band;
		return {
			band: rect(band),
			x: labelX(text),
			fontSize: getComputedStyle(text).fontSize,
			lineHeight: getComputedStyle(text).lineHeight,
			weight: getComputedStyle(text).fontWeight,
			above: previous ? b.top - previous.getBoundingClientRect().bottom : null,
			below: next ? next.getBoundingClientRect().top - b.bottom : null,
			action: rect(band.querySelector(".sidebar-add-project, .sidebar-archive-toggle")),
		};
	};
	const projects = q('[data-sidebar-section="Projects"] .sidebar-section-head');
	const workspace = q(".workspace");
	return {
		sidebar: rect(q("aside.sidebar")),
		chrome: rect(q(".sidebar-chrome")),
		chromeShadow: getComputedStyle(q(".sidebar-chrome")).boxShadow,
		topbar: rect(q(".topbar")),
		topbarShadow: getComputedStyle(q(".topbar")).boxShadow,
		topbarVisible: visible(q(".topbar")),
		workspace: rect(workspace),
		paneLine: { height: getComputedStyle(workspace, "::before").height, shadow: getComputedStyle(workspace, "::before").boxShadow },
		settingsHeader: rect(q(".plugins-sidebar-header")),
		settingsHeaderShadow: q(".plugins-sidebar-header") ? getComputedStyle(q(".plugins-sidebar-header")).boxShadow : null,
		wordmark: rect(q(".namzu-wordmark")),
		beta: rect(q(".beta-badge")),
		dither: rect(q(".brand-dither")),
		ditherViewBox: q(".brand-dither")?.getAttribute("viewBox") ?? null,
		newConversation: row(q(".sidebar-new-conversation"), q(".sidebar-new-conversation")),
		pal: pal ? row(pal, pal.querySelector("span:not(.pal-character):not(.pal-avatar)")) : null,
		project: heading ? { ...row(heading, heading.querySelector(".sidebar-project-name")), icon: rect(heading.querySelector(".sidebar-project-folder")) } : null,
		conversation: conv ? row(conv, conv.querySelector(".conversation-row-title")) : null,
		conversationBackground: conv ? getComputedStyle(conv).backgroundColor : null,
		mark: rect(q("li[data-thread-item] .conversation-row-mark")),
		projectsTitle: projects ? title(projects) : null,
		settingsRows: [...document.querySelectorAll(".settings-sidebar-navigation button")].map((b) => row(b, b.querySelector("span"))),
		foot: rect(foot),
		footButtons: foot ? [...foot.querySelectorAll("button")].map((b) => ({ ...rect(b), icon: rect(b.querySelector("svg")) })) : [],
		windowHeight: window.innerHeight,
		tab: rect(q(".conversation-tab")),
		controls: [...document.querySelectorAll(".sidebar-search, .conversation-bar-buttons > button")].map(rect),
		titleX: labelX(q(".conversation-bar-title") ?? q(".breadcrumb")),
	};
};

/** The numbers every screen with the sidebar open holds. */
function checkSidebar(m, tag, { header = true } = {}) {
	if (header) {
		assert.equal(m.chrome.h, 36, `${tag}: the sidebar header is 36 high`);
		assert.equal(m.chromeShadow, "none", `${tag}: the sidebar header draws no line under it`);
	}
	assert.equal(m.foot.h, 45, `${tag}: the foot is 45 high`);
	assert.equal(m.foot.bottom, m.windowHeight, `${tag}: the foot ends the window`);
	for (const b of m.footButtons) {
		assert.equal(b.h, 28, `${tag}: a foot button is 28 high`);
		assert.equal(b.w, 28, `${tag}: and 28 wide`);
	}
	assert.equal(m.footButtons[0].icon.x + m.footButtons[0].icon.w / 2, 26, `${tag}: the first foot button's icon is on the icons' column (x 26)`);
	assert.equal(m.footButtons[0].y - m.foot.y, 9, `${tag}: a foot button is 8 under the foot's line (1px)`);
	assert.equal(m.foot.bottom - m.footButtons[0].bottom, 8, `${tag}: and 8 above the window's edge`);
}

for (const tabs of ["shown", "hidden"]) {
	test(`the frame holds its numbers with ${tabs === "shown" ? "the strip of tabs" : "the conversation bar"}`, { timeout: 280000 }, async () => {
		const w = await createWorld({ tabs, rules: RULES });
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			await size(w, 1280, 820);
			await expect(w.page.locator(".sidebar-chrome")).toBeVisible({ timeout: T });
			await settled(w);

			// The home screen: nothing to separate, so no line under the main header.
			const home = await w.page.evaluate(MEASURE);
			assert.equal(home.topbarShadow, "none", `${tabs} home: the main header draws no line`);
			assert.equal(home.topbar.h, 36, `${tabs} home: the main header is 36 high`);

			await send(w, "hello there");
			await expect(w.page.getByText("Hello there.").first()).toBeVisible({ timeout: T });
			await settled(w);
			const m = await w.page.evaluate(MEASURE);
			const tag = `${tabs} conversation`;

			// A. Both header bands are 36 and end on one y; B. the main one draws its line, the sidebar's does not.
			assert.equal(m.topbar.h, 36, `${tag}: the top bar is 36 high`);
			assert.equal(m.chrome.bottom, m.topbar.bottom, `${tag}: the two headers end on one y`);
			assert.match(m.topbarShadow, /^rgba?\(.*\) 0px -1px 0px 0px inset$/, `${tag}: the main header draws its 1px line inside the band`);
			if (tabs === "shown") {
				assert.equal(m.tab.h, 28, `${tag}: a tab is 28 high`);
				assert.equal(m.tab.y - m.topbar.y, 4, `${tag}: a tab sits 4 below the top of the header`);
			}
			for (const control of m.controls) {
				assert.equal(control.h, 28, `${tag}: a control in the band is 28 high`);
				assert.equal(control.y - m.topbar.y, 4, `${tag}: and 4 from the top of the band`);
			}
			// The wordmark, the Beta chip and the dither band fit in the 36 without being cut.
			for (const [name, r] of [["wordmark", m.wordmark], ["Beta chip", m.beta], ["dither band", m.dither]]) {
				assert.ok(r.y >= m.chrome.y && r.bottom <= m.chrome.bottom, `${tag}: the ${name} is inside the header band`);
			}
			assert.equal(m.dither.h, 36, `${tag}: the dither band is the band's height`);
			assert.equal(m.ditherViewBox.split(" ")[3], "36", `${tag}: its squares are drawn at the band's height, so they stay square`);
			// C. The title starts 24 from the main area's left edge (the bar's own title; the strip has its tabs).
			if (tabs === "hidden") assert.equal(m.titleX - m.workspace.x, 24, `${tag}: the title starts 24 from the main area's edge`);
			else assert.equal(m.tab.x - m.workspace.x, 24, `${tag}: the first tab starts 24 from the main area's edge`);

			// D. Rows: 32 high, 2 apart, the box from x 8 to x 277, every label at x 44, the slot at x 18.
			const rowRight = m.sidebar.right - 1 - 10;
			assert.equal(rowRight, 277, `${tag}: the sidebar is 288 wide with its 1px line`);
			for (const [name, r] of [["New conversation", m.newConversation], ["a project", m.project], ["a conversation", m.conversation]]) {
				assert.equal(r.h, 32, `${tag}: ${name} row is 32 high`);
				assert.equal(r.x, 8, `${tag}: ${name} row starts at x 8`);
				assert.equal(r.right, 277, `${tag}: ${name} row ends at x 277`);
				assert.equal(r.label, 44, `${tag}: ${name} label starts at x 44`);
				assert.equal(r.radius, "10px", `${tag}: ${name} row's corners are 10`);
			}
			assert.equal(m.newConversation.y - m.chrome.bottom, 8, `${tag}: the first row starts 8 under the header band`);
			assert.equal(m.pal.y - m.newConversation.y, 34, `${tag}: two neighbouring rows' tops are 34 apart (navigation)`);
			assert.equal(m.conversation.y - m.project.y, 34, `${tag}: two neighbouring rows' tops are 34 apart (project and conversation)`);
			assert.equal(m.pal.label, 44, `${tag}: a Pal row's label starts at x 44`);
			assert.equal(m.mark.x, 18, `${tag}: the state mark's slot starts at x 18`);
			assert.equal(m.mark.w, 16, `${tag}: and is 16 wide`);
			assert.equal(m.project.icon.x, 18, `${tag}: a project's folder is in the same slot`);
			assert.equal(m.conversationBackground, "rgba(241, 243, 247, 0.16)", `${tag}: the selected row is 16 percent of the text colour (dark)`);

			// E. A section title: the text at x 18 in a 28 band, 22 above and 4 below; 12/16 at weight 500; its button 24 by 24.
			const t = m.projectsTitle;
			assert.equal(t.x, 18, `${tag}: the Projects title starts at x 18`);
			assert.equal(t.band.h, 28, `${tag}: its band is 28 high`);
			assert.equal(t.above, 22, `${tag}: 22 above the band`);
			assert.equal(t.below, 4, `${tag}: 4 below it`);
			assert.deepEqual([t.fontSize, t.lineHeight, t.weight], ["12px", "16px", "500"], `${tag}: the title is 12/16 at weight 500`);
			assert.equal(t.action.w, 24, `${tag}: the plus beside it is 24 wide`);
			assert.equal(t.action.h, 24, `${tag}: and 24 high`);
			assert.equal(t.action.y - t.band.y, 2, `${tag}: centred in the band`);
			assert.equal(277 - t.action.right, 4, `${tag}: and 4 from the end of the row box`);

			// The end controls of a row appear with the pointer: 24 by 24, 4 from the row's end.
			await w.page.locator("li[data-thread-item]").first().hover();
			const hover = await w.page.evaluate(() => {
				const r = (el) => { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height, right: b.right }; };
				const li = document.querySelector("li[data-thread-item]");
				return { row: r(li.querySelector(".sidebar-conversation-button")), actions: [...li.querySelectorAll(".sidebar-thread-action")].map(r) };
			});
			assert.ok(hover.actions.length > 0, `${tag}: a conversation row has an end control`);
			for (const a of hover.actions) assert.deepEqual([a.w, a.h], [24, 24], `${tag}: a conversation's end control is 24 by 24`);
			assert.equal(hover.row.right - Math.max(...hover.actions.map((a) => a.right)), 4, `${tag}: and 4 from the end of the row`);
			await w.page.locator(".sidebar-project-heading").first().hover();
			const more = await w.page.evaluate(() => {
				const h = document.querySelector(".sidebar-project-heading");
				const b = h.querySelector(".sidebar-project-more").getBoundingClientRect();
				return { w: b.width, h: b.height, gap: h.getBoundingClientRect().right - b.right };
			});
			assert.deepEqual([more.w, more.h, more.gap], [24, 24, 4], `${tag}: a project's dots button is 24 by 24, 4 from its row's end`);
			await w.page.mouse.move(700, 400);

			// F. The foot: 45 high, 28 buttons.
			checkSidebar(m, tag);

			// B. Settings: the main pane gets the same line at the same y; the sidebar rows follow the same rhythm.
			await w.page.locator(".sidebar-foot").getByRole("button", { name: "Settings", exact: true }).click();
			await expect(w.page.getByRole("navigation", { name: "Settings sections" })).toBeVisible({ timeout: T });
			await settled(w);
			const settings = await w.page.evaluate(MEASURE);
			assert.equal(settings.settingsHeader.h, 36, "Settings: the sidebar header is 36 high");
			assert.equal(settings.settingsHeader.bottom, m.chrome.bottom, "Settings: the header ends where the conversation's does");
			assert.equal(settings.settingsHeaderShadow, "none", "Settings: its sidebar header draws no line");
			assert.equal(settings.paneLine.height, "36px", "Settings: the main pane has the 36 band");
			assert.match(settings.paneLine.shadow, /0px -1px 0px 0px inset$/, "Settings: with the 1px line inside it");
			assert.equal(settings.workspace.y + 36, m.topbar.bottom, "Settings: the line is at the same y as a conversation's");
			assert.ok(settings.settingsRows.length > 0, "Settings lists its sections");
			const settingsTop = await w.page.evaluate(() => ({
				page: document.querySelector(".settings-page").getBoundingClientRect().top,
				heading: document.querySelector(".settings-page-header").getBoundingClientRect().top,
			}));
			assert.equal(settingsTop.page, settings.workspace.y + 36, "Settings: the page starts under the 36 band");
			assert.ok(settingsTop.heading - settingsTop.page >= 20, "Settings: its first heading has room under the line");
			for (const [index, row] of settings.settingsRows.entries()) {
				assert.equal(row.h, 32, "Settings: a section row is 32 high");
				assert.equal(row.x, 8, "Settings: a row starts at x 8");
				assert.equal(row.right, 277, "Settings: and ends at x 277");
				assert.equal(row.label, 44, "Settings: its label starts at x 44");
				assert.equal(row.radius, "10px", "Settings: its corners are 10");
				if (index > 0) assert.equal(row.y - settings.settingsRows[index - 1].y, 34, "Settings: rows are 34 apart");
			}
			assert.equal(settings.settingsRows[0].y - settings.settingsHeader.bottom, 8, "Settings: the first row is 8 under the band");
			checkSidebar(settings, "Settings", { header: false });
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});
}

test("the selected row is 16 percent of the text colour in the light theme too", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden", rules: RULES });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await send(w, "hello there");
		await expect(w.page.getByText("Hello there.").first()).toBeVisible({ timeout: T });
		await w.page.evaluate((v) => {
			localStorage.setItem("namzu.appearance", v);
			window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: v }));
		}, "light");
		await expect(w.page.locator("html")).not.toHaveClass(/dark/, { timeout: T });
		await settled(w);
		const m = await w.page.evaluate(MEASURE);
		assert.equal(m.conversationBackground, "rgba(39, 39, 42, 0.16)");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("the collapsed rail is 48 wide with the two bands and the same foot line", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden", rules: RULES });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await send(w, "hello there");
		await expect(w.page.getByText("Hello there.").first()).toBeVisible({ timeout: T });
		await settled(w);
		const open = await w.page.evaluate(MEASURE);
		await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
		await expect(w.page.locator(".app")).toHaveAttribute("data-sidebar-collapsed", "true", { timeout: T });
		await settled(w);
		const rail = await w.page.evaluate(() => {
			const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
			const top = document.querySelector(".topbar").getBoundingClientRect();
			return {
				rail: r(document.querySelector(".navigation-rail")),
				band: r(document.querySelector(".rail-band")),
				foot: r(document.querySelector(".rail-foot")),
				bandButtons: [...document.querySelectorAll(".rail-band button")].map(r),
				footButtons: [...document.querySelectorAll(".rail-foot button")].map(r),
				topbarBottom: top.bottom,
				footLine: getComputedStyle(document.querySelector(".rail-foot")).borderTopWidth,
			};
		});
		assert.equal(Math.round(rail.rail.w), 48, "the rail is 48 wide");
		assert.equal(rail.band.h, 36, "its header band is 36 high");
		assert.equal(rail.band.bottom, rail.topbarBottom, "and ends where the main header does");
		assert.equal(rail.foot.h, 45, "its foot is 45 high");
		assert.equal(rail.foot.y, open.foot.y, "and its line is at the sidebar foot's y, so the lines meet across the window");
		assert.equal(rail.foot.bottom, open.windowHeight, "it ends the window");
		assert.equal(rail.footLine, "1px", "with a 1px line");
		assert.ok(rail.bandButtons.length >= 1 && rail.footButtons.length >= 1, "a button sits in each band");
		for (const b of [...rail.bandButtons, ...rail.footButtons]) assert.deepEqual([b.w, b.h], [28, 28], "a button in a band is 28");
		assert.equal(rail.bandButtons[0].y - rail.band.y, 4, "the Home button is 4 from the top of its band");
		assert.equal(rail.footButtons[0].y - rail.foot.y, 9, "the Settings button is 8 under the foot's line");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
