// The top of the window is one band, 36 high, on every platform: the sidebar's header at the left, the
// main header beside it, no strip above them. The main header's left cluster is a menu button (where the
// platform has no menu bar), the sidebar toggle, back and forward, each 28 by 28 and 4 apart, 12 in from
// the sidebar's edge, with the title 12 after them. The menu button opens one menu: File, Edit, View and
// Window as rows, each opening its commands to the side; its commands are the application menu's, and
// the keyboard reaches every one. Vertical positions are relative to the band, so they hold whatever
// sits above it. Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-one-band.test.mjs
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
const settled = (w) =>
	w.page.evaluate(() =>
		Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
	);

const rect = (selector) => (document) => {
	const el = document.querySelector(selector);
	if (!el) return null;
	const b = el.getBoundingClientRect();
	return { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
};
/** A named button's box, read in the page. */
const box = (w, label) =>
	w.page.evaluate((name) => {
		const el = document.querySelector(`.window-titlebar [aria-label="${name}"]`);
		if (!el) return null;
		const b = el.getBoundingClientRect();
		return { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
	}, label);
const area = (w, selector) => w.page.evaluate((s) => {
	const el = document.querySelector(s);
	if (!el) return null;
	const b = el.getBoundingClientRect();
	return { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
}, selector);

/** What the application menu holds for a submenu, in order, as the main process sees it. */
const nativeLabels = (w, id) =>
	w.app.evaluate(({ Menu }, name) => {
		const items = Menu.getApplicationMenu()?.getMenuItemById(name)?.submenu?.items ?? [];
		return items.filter((item) => item.type !== "separator" && item.visible).map((item) => item.label);
	}, id);
const nativeChecked = (w) =>
	w.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("show-conversation-tabs")?.checked);

/** Moves the pointer onto a row of the open menu, as a hand does (the menu's own wrapper is inert while a submenu is open). */
async function pointAt(w, locator) {
	const b = await locator.boundingBox();
	assert.ok(b, "the row is drawn");
	await w.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 2);
	await w.page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2);
}
const menuButton = (w) => w.page.getByRole("button", { name: "Menu", exact: true });
const rows = (w) => w.page.getByRole("menu", { name: "Menu", exact: true }).getByRole("menuitem");
/** The labels of the open submenu's commands, without their shortcuts. */
const submenuLabels = (w, name) =>
	w.page.evaluate((label) => {
		const menu = [...document.querySelectorAll("[role=menu]")].find((m) => m.getAttribute("aria-label") === label);
		return [...(menu?.querySelectorAll("[role^=menuitem]") ?? [])].map((item) => item.querySelector("span")?.textContent ?? "");
	}, name);

test("one band: both headers start at the top and are 36 high, with the left cluster measured", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules: RULES, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await settled(w);

		for (const screen of ["home", "conversation"]) {
			if (screen === "conversation") {
				await send(w, "hello there");
				await expect(w.page.getByText("Hello there.").first()).toBeVisible({ timeout: T });
			}
			const sidebar = await area(w, ".sidebar-chrome");
			const main = await area(w, ".topbar");
			const workspace = await area(w, ".workspace");
			assert.equal(sidebar.y, 0, `${screen}: the sidebar's header is the top of the window`);
			assert.equal(main.y, 0, `${screen}: the main header is the top of the window`);
			assert.equal(sidebar.h, 36, `${screen}: the sidebar's header is 36 high`);
			assert.equal(main.h, 36, `${screen}: the main header is 36 high`);
			assert.equal(workspace.y, 0, `${screen}: the main area starts at the top`);
			assert.equal(await w.page.locator(".window-titlebar-caption").count(), 0, `${screen}: the window's title is not drawn as text`);
			assert.equal(
				await w.page.evaluate(() => /Namzu/.test(document.querySelector(".window-titlebar")?.textContent ?? "")),
				false,
				`${screen}: no text in the band names the window`,
			);

			// The four controls: 28 by 28, 4 apart, the first 12 in from the sidebar's edge, centred in the band.
			const [menu, toggle, back, forward] = await Promise.all(["Menu", "Toggle sidebar", "Go back", "Go forward"].map((n) => box(w, n)));
			const edge = workspace.x;
			assert.equal(edge, 288, `${screen}: the main area starts where the sidebar ends`);
			for (const [name, b] of Object.entries({ menu, toggle, back, forward })) {
				assert.ok(b, `${screen}: ${name} is drawn`);
				assert.equal(b.w, 28, `${screen}: ${name} is 28 wide`);
				assert.equal(b.h, 28, `${screen}: ${name} is 28 high`);
				assert.equal(b.y - main.y, 4, `${screen}: ${name} is centred in the band`);
			}
			assert.equal(menu.x - edge, 12, `${screen}: the menu button is 12 in from the sidebar's edge`);
			assert.equal(toggle.x - menu.right, 4, `${screen}: the toggle is 4 after the menu button`);
			assert.equal(back.x - toggle.right, 4, `${screen}: back is 4 after the toggle`);
			assert.equal(forward.x - back.right, 4, `${screen}: forward is 4 after back`);
			if (screen === "conversation") {
				const title = await area(w, ".conversation-bar-title");
				assert.equal(title.x - forward.right, 12, "the title starts 12 after the cluster");
				assert.equal(title.h <= 36, true);
			}
			// Nowhere to go is half strength; the history has somewhere to go forward to only after going back.
			const opacity = await w.page.evaluate(() => ({
				back: getComputedStyle(document.querySelector('[aria-label="Go back"]')).opacity,
				forward: getComputedStyle(document.querySelector('[aria-label="Go forward"]')).opacity,
				toggle: getComputedStyle(document.querySelector('[aria-label="Toggle sidebar"]')).opacity,
			}));
			assert.equal(opacity.forward, "0.5", `${screen}: forward is at half strength with nowhere to go`);
			assert.equal(opacity.toggle, "1", `${screen}: the toggle is at full strength`);
			// The band is the drag region except over its controls.
			const regions = await w.page.evaluate(() => {
				const region = (s) => getComputedStyle(document.querySelector(s)).getPropertyValue("-webkit-app-region");
				return { main: region(".topbar"), side: region(".sidebar-chrome"), button: region('.window-titlebar [aria-label="Menu"]'), cluster: region(".window-titlebar-cluster") };
			});
			assert.equal(regions.main, "drag", `${screen}: the main header drags the window`);
			assert.equal(regions.side, "drag", `${screen}: the sidebar's header drags the window`);
			assert.equal(regions.button, "no-drag", `${screen}: a control does not`);
		}

		// The line: none under the home screen's header, one under every other screen's.
		await w.page.getByRole("button", { name: "New conversation" }).first().click();
		await expect(w.page.locator("[data-composer-home]")).toBeVisible({ timeout: T });
		assert.equal(await w.page.evaluate(() => getComputedStyle(document.querySelector(".topbar")).boxShadow), "none", "the home screen draws no line");
		await w.page.getByRole("button", { name: "Settings", exact: true }).first().click();
		await expect(w.page.getByRole("navigation", { name: "Settings sections" })).toBeVisible({ timeout: T });
		const settings = await w.page.evaluate(() => {
			const pane = getComputedStyle(document.querySelector(".workspace"), "::before");
			return { height: pane.height, shadow: pane.boxShadow, workspaceTop: document.querySelector(".workspace").getBoundingClientRect().top, sidebar: document.querySelector(".settings-navigation-sidebar .sidebar-chrome, .sidebar-chrome")?.getBoundingClientRect().top };
		});
		assert.equal(settings.height, "36px", "Settings draws its line at the band's bottom");
		assert.notEqual(settings.shadow, "none");
		assert.equal(settings.workspaceTop, 0);
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("the cluster stays at the main header's left when the sidebar is collapsed to its rail", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules: RULES, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
		await expect(w.page.locator(".app")).toHaveAttribute("data-sidebar-collapsed", "true");
		await settled(w);
		const rail = await area(w, ".navigation-rail");
		const band = await area(w, ".rail-band");
		const main = await area(w, ".topbar");
		assert.equal(rail.w, 48, "the rail is 48 wide");
		assert.equal(band.y, 0, "the rail's band is the top of the window");
		assert.equal(band.h, 36, "the rail's band is 36 high");
		assert.equal(main.y, 0);
		assert.equal(main.x, 48, "the main header starts at the rail's edge");
		const menu = await box(w, "Menu");
		const toggle = await box(w, "Toggle sidebar");
		assert.equal(menu.x - main.x, 12, "the cluster is 12 in from the rail");
		assert.equal(toggle.x - menu.right, 4);
		assert.equal(menu.y - main.y, 4);
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("nothing in the header sits under the window's own buttons, and the window's controls end the band", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules: RULES, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await send(w, "hello there");
		await expect(w.page.getByText("Hello there.").first()).toBeVisible({ timeout: T });
		for (const width of [1280, 900]) {
			await size(w, width, 820);
			await settled(w);
			// The system tells the page where its buttons begin after the resize; wait for that, not a clock.
			await expect
				.poll(
					() =>
						w.page.evaluate((x) => {
							const probe = document.createElement("div");
							probe.style.cssText = "position:fixed;top:0;left:env(titlebar-area-x,0px);width:env(titlebar-area-width,0px);height:1px;pointer-events:none";
							document.body.append(probe);
							const right = probe.getBoundingClientRect().right;
							probe.remove();
							return right < x;
						}, width),
					{ timeout: T },
				)
				.toBe(true);
			const read = await w.page.evaluate(() => {
				// The system's overlay is as wide as the page's environment says, and as high as the band.
				const probe = document.createElement("div");
				probe.style.cssText = "position:fixed;top:0;left:env(titlebar-area-x,0px);width:env(titlebar-area-width,0px);height:env(titlebar-area-height,0px);pointer-events:none";
				document.body.append(probe);
				const b = probe.getBoundingClientRect();
				probe.remove();
				const buttons = [...document.querySelectorAll(".topbar button, .topbar [role=button]")].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
				return { areaRight: b.right, areaHeight: b.height, innerWidth: window.innerWidth, rightmost: Math.max(...buttons.map((r) => r.right)) };
			});
			assert.equal(read.areaHeight, 36, `${width}: the window's own buttons are as high as the band`);
			assert.ok(read.innerWidth - read.areaRight > 0, `${width}: the system reserves a width at the right end`);
			assert.ok(read.rightmost <= read.areaRight, `${width}: no header control is under the reserved width (${read.rightmost} > ${read.areaRight})`);
		}
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("the menu button opens one menu with File, Edit, View and Window, and runs a command", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules: RULES, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await menuButton(w).click();
		const popup = w.page.getByRole("menu", { name: "Menu", exact: true });
		await expect(popup).toBeVisible({ timeout: T });
		await expect(rows(w)).toHaveText(["File", "Edit", "View", "Window"]);
		// Each row has a chevron; the menu sits 4 under the button.
		assert.equal(await popup.locator("svg.window-titlebar-chevron").count(), 4, "four rows with a chevron");
		const open = await area(w, '[role=menu][aria-label="Menu"]');
		const button = await box(w, "Menu");
		assert.equal(open.y - button.bottom, 4, "the menu opens 4 under the button");
		assert.equal(open.x, button.x, "and starts at the button's left edge");

		// File is the app's own; Edit, View and Window are the application menu's, in its order.
		const groups = { File: null, Edit: "edit", View: "view", Window: "window" };
		for (const [name, id] of Object.entries(groups)) {
			const row = popup.getByRole("menuitem", { name, exact: true });
			await pointAt(w, row);
			await expect(w.page.getByRole("menu", { name, exact: true })).toBeVisible({ timeout: T });
			const labels = await submenuLabels(w, name);
			if (id) assert.deepEqual(labels, await nativeLabels(w, id), `${name} lists the application menu's commands in its order`);
			else assert.deepEqual(labels, ["New conversation", "Start from scratch", "Use an existing folder"], "File lists today's three commands");
			const rowBox = await area(w, `[data-menu-group="${name.toLowerCase()}"]`);
			const sub = await area(w, `[role=menu][aria-label="${name}"]`);
			assert.equal(sub.y, rowBox.y, `${name}: the submenu is top aligned with its row`);
			assert.equal(sub.x - open.right, 4, `${name}: the submenu is 4 from the menu`);
		}
		// A shortcut is shown at the right of its command.
		await pointAt(w, popup.getByRole("menuitem", { name: "View", exact: true }));
		await expect(w.page.getByRole("menu", { name: "View", exact: true }).getByRole("menuitem", { name: /Actual Size/ }).locator("kbd")).toHaveText("Ctrl+0");

		// Running one: the checkbox flips the strip of tabs, in the app menu and in the page, and the menu closes.
		assert.equal(await nativeChecked(w), false);
		await w.page.getByRole("menu", { name: "View", exact: true }).getByRole("menuitemcheckbox", { name: /Show conversation tabs/ }).click();
		await expect(popup).toHaveCount(0, { timeout: T });
		await expect.poll(() => nativeChecked(w), { timeout: T }).toBe(true);
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("Escape closes the menu with focus back on its button; the keyboard reaches every command", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules: RULES, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		const popup = w.page.getByRole("menu", { name: "Menu", exact: true });
		const onButton = () => w.page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Menu" && document.activeElement.closest(".window-titlebar") !== null);

		await menuButton(w).click();
		await expect(popup).toBeVisible({ timeout: T });
		await w.page.keyboard.press("Escape");
		await expect(popup).toHaveCount(0, { timeout: T });
		assert.equal(await onButton(), true, "focus is back on the button");

		// Alt on its own opens it.
		await w.page.keyboard.down("Alt");
		await w.page.keyboard.up("Alt");
		await expect(popup).toBeVisible({ timeout: T });
		// Arrows walk the rows, Right opens a submenu, Escape closes the submenu and then the menu.
		await w.page.keyboard.press("ArrowDown");
		await expect(rows(w).first()).toBeFocused();
		await w.page.keyboard.press("ArrowDown");
		await w.page.keyboard.press("ArrowDown");
		await expect(popup.getByRole("menuitem", { name: "View", exact: true })).toBeFocused();
		await w.page.keyboard.press("ArrowRight");
		const view = w.page.getByRole("menu", { name: "View", exact: true });
		await expect(view).toBeVisible({ timeout: T });
		await w.page.keyboard.press("Escape");
		await expect(view).toHaveCount(0, { timeout: T });
		await expect(popup).toBeVisible();
		await w.page.keyboard.press("Escape");
		await expect(popup).toHaveCount(0, { timeout: T });
		assert.equal(await onButton(), true, "focus is back on the button after the submenu and the menu close");

		// Enter runs a command from the keyboard alone: View, then "Show conversation tabs".
		assert.equal(await nativeChecked(w), false);
		await w.page.keyboard.down("Alt");
		await w.page.keyboard.up("Alt");
		await expect(popup).toBeVisible({ timeout: T });
		for (let i = 0; i < 3; i++) await w.page.keyboard.press("ArrowDown");
		await w.page.keyboard.press("ArrowRight");
		await expect(view).toBeVisible({ timeout: T });
		const checkbox = view.getByRole("menuitemcheckbox", { name: /Show conversation tabs/ });
		for (let i = 0; i < 8 && !(await checkbox.evaluate((el) => document.activeElement === el)); i++) await w.page.keyboard.press("ArrowDown");
		await expect(checkbox).toBeFocused();
		await w.page.keyboard.press("Enter");
		await expect(popup).toHaveCount(0, { timeout: T });
		await expect.poll(() => nativeChecked(w), { timeout: T }).toBe(true);
		
		// With the menu closed its accelerator still runs: Ctrl+0 puts a zoomed page back to its size.
		const zoom = () => w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
		assert.equal(await zoom(), 1.5);
		// A key event sent through the window's own input path, as the system would deliver it.
		await w.app.evaluate(({ BrowserWindow }) => {
			const contents = BrowserWindow.getAllWindows()[0].webContents;
			contents.focus();
			for (const type of ["keyDown", "char", "keyUp"]) contents.sendInputEvent({ type, keyCode: "0", modifiers: ["control"] });
		});
		await expect.poll(zoom, { timeout: T }).toBe(1);
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("on macOS the header keeps the system menu bar and the traffic lights' inset", { timeout: 280000 }, async () => {
	// The platform is the main process's to name and a Linux run cannot change it, so this sets the
	// attribute the page's rules read and checks what those rules do; the unit test covers which
	// platform draws the menu button.
	const w = await createWorld({ rules: RULES, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await w.page.evaluate(() => {
			document.documentElement.dataset.chromePlatform = "darwin";
		});
		const side = await w.page.evaluate(() => {
			const chrome = document.querySelector(".sidebar-chrome");
			const brand = document.querySelector(".sidebar-workspace-menu").getBoundingClientRect();
			return { pad: getComputedStyle(chrome).paddingInlineStart, brand: brand.left };
		});
		assert.equal(side.pad, "80px", "the sidebar's header keeps an 80 inset for the traffic lights");
		assert.equal(side.brand, 80, "the wordmark begins after them");
		const cluster = await w.page.evaluate(() => getComputedStyle(document.querySelector(".app")).getPropertyValue("--frame-cluster-width").trim());
		assert.ok(cluster.includes("calc"), "the cluster's width is computed from the control count");
		const count = await w.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--frame-cluster-count").trim());
		assert.equal(count, "3", "three controls without the menu button");
		// Collapsed, the cluster starts after the lights, and Home sits under the band they cover.
		await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
		await expect(w.page.locator(".app")).toHaveAttribute("data-sidebar-collapsed", "true");
		await settled(w);
		const collapsed = await w.page.evaluate(() => {
			const r = (s) => document.querySelector(s).getBoundingClientRect();
			return { toggle: r('.window-titlebar [aria-label="Toggle sidebar"]').left, home: r(".rail-band > .rail-button").top, band: r(".rail-band").bottom, main: r(".topbar").left };
		});
		assert.equal(collapsed.toggle - collapsed.main, 32 + 28 + 4, "the cluster starts at x 80 of the window (after the menu button's slot here)");
		assert.equal(collapsed.home, collapsed.band, "Home is the first row under the band the lights cover");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("a side panel starts under the band, so the band runs the whole width and nothing is under the window's buttons", { timeout: 280000 }, async () => {
	const write = { match: /write the file/i, steps: [{ tool: "write", args: { path: "out.txt", content: "hello\n" } }, { text: "Wrote out.txt." }] };
	const w = await createWorld({ rules: [write], tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 800);
		await send(w, "Please write the file");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		await card.getByRole("button", { name: "Accept", exact: true }).click();
		await expect(w.page.getByText("Wrote out.txt.").first()).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: /Open changes$/ }).last().click();
		const side = w.page.getByRole("complementary", { name: "Changes" });
		await expect(side).toBeVisible({ timeout: T });
		await settled(w);
		const read = () =>
			w.page.evaluate(() => {
				const probe = document.createElement("div");
				probe.style.cssText = "position:fixed;top:0;left:env(titlebar-area-x,0px);width:env(titlebar-area-width,0px);height:1px;pointer-events:none";
				document.body.append(probe);
				const areaRight = probe.getBoundingClientRect().right;
				probe.remove();
				const r = (el) => el.getBoundingClientRect();
				const topbar = r(document.querySelector(".topbar"));
				const workspace = r(document.querySelector(".workspace"));
				const aside = r(document.querySelector("aside[aria-label=Changes]"));
				const controls = [...document.querySelectorAll(".topbar button")].map((b) => r(b)).filter((b) => b.width > 0);
				return { areaRight, topbar, workspace, aside, rightmost: Math.max(...controls.map((b) => b.right)) };
			});
		const wide = await read();
		assert.equal(wide.topbar.height, 36, "the band is 36 high");
		assert.equal(wide.topbar.width, wide.workspace.width, "the band runs the whole width of the main area, over the panel");
		assert.equal(wide.aside.top - wide.topbar.bottom, 0, "the panel starts at the band's bottom");
		assert.equal(wide.aside.right, wide.workspace.right, "and ends at the window's right edge");
		assert.ok(wide.rightmost <= wide.areaRight, `no band control is under the window's buttons (${wide.rightmost} > ${wide.areaRight})`);
		// Over the whole pane (a narrow window) it still starts under the band, so the cluster is clear.
		await size(w, 900, 800);
		await expect.poll(async () => (await read()).aside.width, { timeout: T }).toBeGreaterThan(700);
		await settled(w);
		const narrow = await read();
		assert.equal(narrow.aside.top - narrow.topbar.bottom, 0, "the panel starts at the band's bottom in a narrow window");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
