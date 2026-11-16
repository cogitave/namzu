// Every control in the title band takes the click, in every state, while empty title space still drags.
//
// Why this test replays the rule itself: on Windows and macOS the operating system asks the window what is
// under the pointer, and the answer comes from the draggable region Chromium builds out of `-webkit-app-region`.
// A Playwright click is sent through the browser protocol and never asks, so a click test passes while a real
// mouse is told "title bar" and starts a window drag (the control never sees the press).
//
// Chromium's rule: walk the elements in document order; each one whose computed -webkit-app-region is `drag`
// or `no-drag` adds its border box to the region and OVERRIDES whatever earlier elements decided for the
// same pixels. So a point is a drag point only if the LAST region rectangle that contains it says `drag`.
// A `no-drag` button therefore loses to any drag element that comes after it in the document and overlaps it,
// whatever the z-index, and the CSS cascade does not help (the property is not inherited and the order that
// counts is the tree's, not the stylesheet's).
//
// The test collects the regions, replays that rule at the centre and at the four edge midpoints of every visible
// control in the band, and asserts each is no-drag; it also asserts that some empty point of the band is drag.
// The states: the sidebar open and collapsed, a wide and a narrow window, the home screen, a conversation, a
// conversation with the side panel open, Settings, fullscreen, both themes, and each platform's frame rules
// (the macOS traffic-light offset, the Windows and Linux frame-controls inset; the platform is the page's
// `data-chrome-platform` attribute, set by hand here for the two the host is not).
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-titlebar-hit.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const write = { match: /write the file/i, steps: [{ tool: "write", args: { path: "out.txt", content: "hello\n" } }, { text: "Wrote out.txt." }] };

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
async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "light") await expect(w.page.locator("html")).not.toHaveClass(/dark/);
	else await expect(w.page.locator("html")).toHaveClass(/dark/);
}

/** Runs in the page: the replay. Returns the controls whose sampled points are not no-drag, and the band's empty drag points. */
function replay() {
	const CONTROLS = "button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=menuitem], [tabindex]:not([tabindex='-1'])";
	const band = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--frame-header-height")) || 36;
	// 1. Every element with a computed app region, in document order, with its box.
	const regions = [];
	for (const el of document.querySelectorAll("*")) {
		const kind = getComputedStyle(el).getPropertyValue("-webkit-app-region").trim();
		if (kind !== "drag" && kind !== "no-drag") continue;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) continue;
		regions.push({ kind, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
	}
	// 2. Later overrides earlier.
	const at = (x, y) => {
		let state = "none";
		for (const g of regions) if (x >= g.left && x < g.right && y >= g.top && y < g.bottom) state = g.kind;
		return state;
	};
	const visible = (el, r) => {
		const s = getComputedStyle(el);
		return r.width > 0 && r.height > 0 && s.visibility === "visible" && s.display !== "none" && s.pointerEvents !== "none";
	};
	const label = (el) => `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.className ?? el.textContent?.trim().slice(0, 20)}]`;
	const bad = [];
	let checked = 0;
	for (const el of document.querySelectorAll(CONTROLS)) {
		const r = el.getBoundingClientRect();
		if (!visible(el, r) || r.top >= band || r.bottom <= 0 || r.right <= 0 || r.left >= window.innerWidth) continue;
		const cx = (r.left + r.right) / 2;
		const cy = (r.top + r.bottom) / 2;
		const points = [
			["centre", cx, cy],
			["left", r.left + 2, cy],
			["right", r.right - 2, cy],
			["top", cx, Math.max(r.top, 0) + 2],
			["bottom", cx, Math.min(r.bottom, band) - 2],
		];
		for (const [where, x, y] of points) {
			// Only a point the control itself receives is a point a person can press on it.
			const hit = document.elementFromPoint(x, y);
			if (!hit || !(hit === el || el.contains(hit))) continue;
			checked += 1;
			const state = at(x, y);
			if (state !== "no-drag") bad.push(`${label(el)} ${where} (${Math.round(x)},${Math.round(y)}) is ${state}`);
		}
	}
	// 3. Empty title space still drags: some point of the band whose element is no control and no text input.
	let empty = 0;
	for (let x = 2; x < window.innerWidth; x += 6) {
		const y = band / 2;
		const hit = document.elementFromPoint(x, y);
		if (!hit || hit.closest(CONTROLS)) continue;
		if (at(x, y) === "drag") empty += 1;
	}
	return { bad, checked, empty, regions: regions.length };
}

async function check(w, state) {
	const result = await w.page.evaluate(replay);
	assert.ok(result.checked >= 4, `${state}: the replay looked at the controls (${result.checked} points)`);
	assert.deepEqual(result.bad, [], `${state}: every control in the band takes the click`);
	assert.ok(result.empty > 0, `${state}: empty title space still drags the window`);
}
async function everyPlatform(w, state) {
	for (const platform of ["win32", "darwin", "linux"]) {
		await w.page.evaluate((p) => {
			document.documentElement.dataset.chromePlatform = p;
		}, platform);
		await settled(w);
		await check(w, `${state}, ${platform}`);
	}
}
async function everyState(w, screen) {
	for (const mode of ["dark", "light"]) {
		await theme(w, mode);
		for (const [width, height] of [
			[1280, 820],
			[640, 720],
		]) {
			await size(w, width, height);
			for (const collapsed of [false, true]) {
				const app = w.page.locator(".app");
				const now = (await app.getAttribute("data-sidebar-collapsed")) === "true";
				if (now !== collapsed && width > 700) {
					await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
					await expect(app).toHaveAttribute("data-sidebar-collapsed", collapsed ? "true" : "false");
				}
				await settled(w);
				await everyPlatform(w, `${screen}, ${mode}, ${width}px, sidebar ${collapsed ? "collapsed" : "open"}`);
			}
		}
	}
	await theme(w, "dark");
	await size(w, 1280, 820);
}

test("every control in the title band takes the click and empty space still drags", { timeout: 540000 }, async () => {
	const w = await createWorld({ rules: [write], tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		// Home.
		await expect(w.page.locator("[data-composer-home]")).toBeVisible({ timeout: T });
		await everyState(w, "home");
		// A conversation.
		await send(w, "Please write the file");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		await card.getByRole("button", { name: "Accept", exact: true }).click();
		await expect(w.page.getByText("Wrote out.txt.").first()).toBeVisible({ timeout: T });
		await everyState(w, "conversation");
		// The side panel open.
		await w.page.getByRole("button", { name: /Open changes$/ }).last().click();
		await expect(w.page.getByRole("complementary", { name: "Changes" })).toBeVisible({ timeout: T });
		await settled(w);
		await everyState(w, "conversation with the panel open");
		// Settings, which has no top bar of its own.
		await w.page.getByRole("button", { name: "Settings", exact: true }).first().click();
		await expect(w.page.getByRole("region", { name: "Settings", exact: true })).toBeVisible({ timeout: T });
		await everyState(w, "settings");
		// Fullscreen.
		await w.app.evaluate(({ BrowserWindow }) => {
			for (const win of BrowserWindow.getAllWindows()) win.setFullScreen(true);
		});
		await expect.poll(() => w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isFullScreen())), { timeout: T }).toBe(true);
		await settled(w);
		await everyPlatform(w, "fullscreen");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
