// The window is two flat regions, the list of conversations and the conversation, divided by one line.
// The rail is the collapsed sidebar: open, its controls are the foot of the sidebar; collapsed, the rail is drawn.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-flat-frame.test.mjs
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
	await expect.poll(() => w.page.evaluate((x) => Math.abs(window.innerWidth - x), width), { timeout: T }).toBeLessThanOrEqual(2);
}
const sendUpdate = (w, state) =>
	w.app.evaluate(({ BrowserWindow }, next) => {
		for (const win of BrowserWindow.getAllWindows()) win.webContents.send("namzu:update-state", next);
	}, state);
const toggle = (w) => w.page.getByRole("button", { name: "Toggle sidebar" });
const open = (w) => expect(w.page.locator(".app")).toHaveAttribute("data-sidebar-collapsed", "false", { timeout: T });
const collapsed = (w) => expect(w.page.locator(".app")).toHaveAttribute("data-sidebar-collapsed", "true", { timeout: T });
/** What the page has settled on: the animations of the grid have finished. */
const settled = (w) =>
	w.page.evaluate(() =>
		Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
	);
const left = (w, selector) => w.page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().left, selector);
const focusedControl = (w) => w.page.evaluate(() => document.activeElement?.closest("[data-frame-control]")?.getAttribute("data-frame-control") ?? null);
const inRail = (w) => w.page.evaluate(() => !!document.activeElement?.closest(".navigation-rail"));
const inFoot = (w) => w.page.evaluate(() => !!document.activeElement?.closest(".sidebar-foot"));

test("open: two flat regions, one hairline, no rail, a foot, and the header ends where the top bar does", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await open(w);
		await settled(w);
		await expect(w.page.locator(".navigation-rail")).toHaveCount(0);
		const foot = w.page.locator(".sidebar-foot");
		await expect(foot.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
		await expect(foot.getByRole("button", { name: "Home" })).toHaveCount(0);

		const frame = await w.page.evaluate(() => {
			const style = (selector) => {
				const el = document.querySelector(selector);
				return el ? getComputedStyle(el) : null;
			};
			const pick = (selector) => {
				const s = style(selector);
				return s && { radius: s.borderRadius, shadow: s.boxShadow, bg: s.backgroundColor, right: `${s.borderRightWidth} ${s.borderRightStyle}` };
			};
			const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
			return {
				sidebar: pick("aside.sidebar"),
				workspace: pick("main.workspace"),
				titlebar: pick(".window-titlebar"),
				foot: pick(".sidebar-foot"),
				appShadow: style(".app").boxShadow,
				sidebarRect: rect("aside.sidebar"),
				workspaceRect: rect("main.workspace"),
				header: rect(".sidebar-chrome")?.bottom,
				topbar: rect(".topbar")?.bottom,
				wordmark: rect(".sidebar .namzu-wordmark"),
				wordmarkFont: style(".sidebar .namzu-wordmark")?.fontSize,
				headerHeight: rect(".sidebar-chrome")?.height,
			};
		});
		for (const part of ["sidebar", "workspace", "titlebar", "foot"]) {
			assert.equal(frame[part].radius, "0px", `${part} has no rounded corners`);
			assert.equal(frame[part].shadow, "none", `${part} casts no shadow`);
		}
		assert.equal(frame.appShadow, "none");
		assert.equal(frame.sidebar.right, "1px solid", "the sidebar ends in one 1px line");
		assert.equal(frame.workspace.right.startsWith("0px"), true);
		// The sidebar and the conversation sit side by side from the top of the frame to the bottom of the window.
		assert.equal(Math.round(frame.sidebarRect.left), 0);
		assert.equal(Math.round(frame.sidebarRect.right), Math.round(frame.workspaceRect.left));
		// One seam: the header of the sidebar and the hairline under the top bar are the same line, and the wordmark still fits.
		assert.equal(Math.round(frame.header), Math.round(frame.topbar), "header and top bar end on one line");
		assert.equal(frame.headerHeight, 44);
		assert.equal(frame.wordmarkFont, "9.5px", "the wordmark is not shrunk to fit");
		assert.ok(frame.wordmark.height < 30, `the wordmark fits the header with room: ${frame.wordmark.height}`);

		// The foot says what the rail said: the name, and the tooltip with the shortcut.
		await foot.getByRole("button", { name: "Settings", exact: true }).hover();
		await expect(w.page.getByText(/^Settings \((Ctrl\+,|⌘,)\)$/)).toBeVisible({ timeout: T });
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("collapsed: the rail is drawn, and the conversation moves by exactly the width that changes", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await open(w);
		await settled(w);
		const wide = await left(w, "main.workspace");
		await toggle(w).click();
		await collapsed(w);
		await settled(w);
		const rail = w.page.getByRole("navigation", { name: "Main navigation" });
		await expect(rail.getByRole("button", { name: "Home", exact: true })).toBeVisible({ timeout: T });
		await expect(rail.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
		await expect(w.page.locator(".sidebar-foot")).toHaveCount(1);
		await expect(w.page.locator(".sidebar-foot").getByRole("button", { name: "Settings" })).toHaveCount(0);
		const narrow = await left(w, "main.workspace");
		assert.equal(Math.round(wide - narrow), 288 - 48, `the conversation moves ${wide - narrow}, the sidebar is 288 and the rail 48`);
		const railLine = await w.page.evaluate(() => {
			const s = getComputedStyle(document.querySelector(".navigation-rail"));
			return { right: `${s.borderRightWidth} ${s.borderRightStyle}`, shadow: s.boxShadow, radius: s.borderRadius };
		});
		assert.deepEqual(railLine, { right: "1px solid", shadow: "none", radius: "0px" }, "the rail is divided from the conversation by the same line");
		await toggle(w).click();
		await open(w);
		await settled(w);
		assert.equal(Math.round(await left(w, "main.workspace")), Math.round(wide));
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("the focus follows a control when the rail and the foot swap places", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await open(w);
		await settled(w);
		await w.page.locator(".sidebar-foot").getByRole("button", { name: "Settings", exact: true }).focus();
		assert.equal(await inFoot(w), true);
		// A narrow window keeps the rail beside an overlay sidebar: the foot gives way to it.
		await size(w, 700, 700);
		await expect.poll(() => inRail(w), { timeout: T }).toBe(true);
		assert.equal(await focusedControl(w), "settings");
		await size(w, 1280, 820);
		await expect.poll(() => inFoot(w), { timeout: T }).toBe(true);
		assert.equal(await focusedControl(w), "settings");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("an update shows in the foot and, collapsed, in the rail, with the same name and one announcement", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await open(w);
		const label = "Update ready. Restart Namzu to install version 9.9.9";
		const foot = w.page.locator(".sidebar-foot");
		await expect(foot.getByRole("button", { name: /^Update/ })).toHaveCount(0);
		await sendUpdate(w, { status: "ready", version: "9.9.9" });
		await expect(foot.getByRole("button", { name: label })).toBeVisible({ timeout: T });
		await expect(foot.locator("output")).toHaveText("Update downloaded. Restart Namzu to install version 9.9.9.");
		// Settings first, the update at the far end, one row.
		const order = await foot.evaluate((el) => [...el.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")));
		assert.deepEqual(order, ["Settings", label]);
		await foot.getByRole("button", { name: label }).hover();
		await expect(w.page.getByText("Update ready — restart to install", { exact: true })).toBeVisible({ timeout: T });
		await toggle(w).click();
		await collapsed(w);
		const rail = w.page.getByRole("navigation", { name: "Main navigation" });
		await expect(rail.getByRole("button", { name: label })).toBeVisible({ timeout: T });
		assert.equal(await w.page.getByRole("button", { name: label }).count(), 1, "one update button in the tree, never two");
		await sendUpdate(w, { status: "idle" });
		await expect(rail.getByRole("button", { name: label })).toHaveCount(0, { timeout: T });
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("Home is the sidebar's New conversation row; on a page with its own sidebar the foot carries Home", { timeout: 280000 }, async () => {
	const w = await createWorld({ tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await open(w);
		await w.page.getByRole("button", { name: "Settings", exact: true }).click();
		const sections = w.page.getByRole("navigation", { name: "Settings sections" });
		await expect(sections).toBeVisible({ timeout: T });
		await expect(w.page.locator(".navigation-rail")).toHaveCount(0);
		const foot = w.page.locator(".sidebar-foot");
		await expect(foot.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
		await foot.getByRole("button", { name: "Home", exact: true }).click();
		await expect(sections).toHaveCount(0, { timeout: T });
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
