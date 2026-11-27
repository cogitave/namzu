// Record your screen in the real Electron app, with a painted screen and scripted control events
// standing in for the computer's own (NAMZU_RECORDING_FAKE=1 on a test profile; the real screen and the
// native helper are never touched). The flow: the Skills Add menu offers it, the chooser, the recorder
// pill with Pause and Done, the review sheet above the message box, Send putting the recording into the
// message, the model asked for a skill and the existing save card appearing, and the Privacy switch.
// Pictures go to $NAMZU_UX_OUT (default research/ux-record-skill/), at 1440x960 and 900x900, light and dark;
// the chooser and the pill are windows of their own and are shot at their own size, light and dark.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-record-skill.test.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const OUT = process.env.NAMZU_UX_OUT ?? resolve(repoRoot, "research/ux-record-skill");
const SIZES = [
	{ name: "1440", width: 1440, height: 960 },
	{ name: "900", width: 900, height: 900 },
];
const SKILL_BODY = `# Filter overdue invoices\n\n1. Open the spreadsheet for the quarter.\n2. Search for the overdue invoices.\n3. Export the filtered list.\n`;
const RULE = {
	match: /screen-recording version="1"/,
	steps: [
		{
			tool: "save_skill",
			args: {
				name: "filter-overdue-invoices",
				description: "Filter the overdue invoices in the quarterly spreadsheet and export them. Use when asked for the overdue list.",
				body: SKILL_BODY,
			},
		},
		{ text: "I proposed a skill from your recording." },
	],
};

const step = (name) => process.stderr.write(`STEP ${name} ${new Date().toISOString()}\n`);
const resize = async (w, width, height) => {
	await w.app.evaluate(({ BrowserWindow }, s) => {
		for (const win of BrowserWindow.getAllWindows()) if (win.getTitle() !== "Record your screen" && win.getTitle() !== "Namzu recording") win.setSize(s.width, s.height);
	}, { width, height });
	await expect.poll(() => w.page.evaluate(() => window.innerWidth), { timeout: T }).toBe(width);
};
async function appearance(w, mode) {
	await w.app.evaluate(({ nativeTheme }, m) => { nativeTheme.themeSource = m; }, mode);
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "dark") await expect(w.page.locator("html")).toHaveClass(/dark/);
	else await expect(w.page.locator("html")).not.toHaveClass(/dark/);
}
/** Pictures of the main window at both sizes and in both themes. */
async function shoot(w, name) {
	mkdirSync(OUT, { recursive: true });
	for (const size of SIZES) {
		await resize(w, size.width, size.height);
		for (const mode of ["dark", "light"]) {
			await appearance(w, mode);
			await w.page.evaluate(async () => {
				// A spinner that never ends must not hold the picture back.
				await Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished));
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			});
			await w.page.screenshot({ path: join(OUT, `${name}-${size.name}-${mode}.png`) });
		}
	}
	await resize(w, 1440, 960);
	await appearance(w, "dark");
}
/** A window of the app by its title, waited for. */
async function windowTitled(w, title) {
	let found;
	await expect
		.poll(async () => {
			for (const win of w.app.windows()) if ((await win.title().catch(() => "")) === title) { found = win; return true; }
			return false;
		}, { timeout: T })
		.toBe(true);
	return found;
}
const windowGone = (w, title) =>
	expect
		.poll(async () => {
			for (const win of w.app.windows()) if (!win.isClosed() && (await win.title().catch(() => "")) === title) return false;
			return true;
		}, { timeout: T })
		.toBe(true);
/** A small window shot in both themes. */
async function shootWindow(w, win, name) {
	mkdirSync(OUT, { recursive: true });
	for (const mode of ["dark", "light"]) {
		await w.app.evaluate(({ nativeTheme }, m) => { nativeTheme.themeSource = m; }, mode);
		// The window's colour scheme follows the system theme a moment after it changes.
		await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme), { timeout: T }).toBe(mode);
		await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
		await win.screenshot({ path: join(OUT, `${name}-${mode}.png`) });
	}
	await w.app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "dark"; });
}
/** Nothing in a small window spills out of it or is cut off. */
const auditWindow = (win) =>
	win.evaluate(() => {
		const bad = [];
		const root = document.documentElement;
		if (root.scrollWidth > window.innerWidth + 1) bad.push(`scrolls sideways (${root.scrollWidth} > ${window.innerWidth})`);
		if (document.body.scrollHeight > window.innerHeight + 1) bad.push(`taller than the window (${document.body.scrollHeight} > ${window.innerHeight})`);
		for (const el of document.querySelectorAll("button, p, h1, select, .pill")) {
			const box = el.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) continue;
			if (box.right > window.innerWidth + 1 || box.bottom > window.innerHeight + 1 || box.left < -1)
				bad.push(`${el.tagName}.${el.className || el.id} leaves the window (${Math.round(box.left)}..${Math.round(box.right)} x ${Math.round(box.bottom)})`);
		}
		return bad.slice(0, 6);
	});
/** The main page: nothing leaves the window sideways, and the sheet sits inside the column. */
const auditPage = (w) =>
	w.page.evaluate(() => {
		const bad = [];
		if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${window.innerWidth})`);
		const sheet = document.querySelector("[data-testid=recording-review]");
		if (sheet) {
			const box = sheet.getBoundingClientRect();
			if (box.right > window.innerWidth + 1 || box.left < -1) bad.push(`sheet leaves the window (${Math.round(box.left)}..${Math.round(box.right)})`);
			for (const el of sheet.querySelectorAll("*")) {
				const b = el.getBoundingClientRect();
				if (b.width === 0 || b.height === 0) continue;
				if (b.right > box.right + 1 || b.left < box.left - 1) bad.push(`${el.className || el.tagName} leaves the sheet (${Math.round(b.left)}..${Math.round(b.right)})`);
			}
		}
		return bad.slice(0, 6);
	});

test("Record your screen: the menu, the chooser, the pill, the review, Send and the save card", { timeout: 480000 }, async () => {
	const world = await createWorld({ rules: [RULE], env: { NAMZU_RECORDING_FAKE: "1" } });
	let failed = true;
	try {
		await launch(world);
		const w = world;
		await openProject(w);

		step(0);
		// The way in: Customize, Skills, Add, "Record your screen".
		await w.page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Customize" }).click({ timeout: T });
		const page = w.page.locator(".customize-page");
		await expect(page.getByRole("heading", { level: 1, name: "Customize" })).toBeVisible({ timeout: T });
		await page.getByRole("button", { name: "Add" }).click({ timeout: T });
		const item = w.page.getByRole("menuitem", { name: "Record your screen" });
		await expect(item).toBeVisible({ timeout: T });
		await shoot(w, "1-skills-add-menu");
		await item.click({ timeout: T });

		step(1);
		// The chooser: what is recorded, where it goes, the warning, the end shortcut.
		const chooser = await windowTitled(w, "Record your screen");
		await expect(chooser.locator("#disclosure")).toContainText("goes to", { timeout: T });
		await expect(chooser.locator("#disclosure")).toContainText("as a message you can read first");
		await expect(chooser.locator("#warning")).toContainText("Don't type passwords or secrets");
		await expect(chooser.locator("#shortcut")).toContainText("Ctrl+Alt+Shift+R");
		await expect(chooser.getByRole("button", { name: "Start recording" })).toBeEnabled({ timeout: T });
		await expect(chooser.locator("#voiceHint")).toContainText("Download listening in Settings to use your voice.");
		assert.equal(await chooser.locator("#voiceOn").isDisabled(), true, "voice is off until listening is downloaded");
		assert.deepEqual(await auditWindow(chooser), [], "the chooser fits its window");
		await shootWindow(w, chooser, "2-chooser");
		await chooser.getByRole("button", { name: "Start recording" }).click({ timeout: T });
		await windowGone(w, "Record your screen");

		step(2);
		// The pill: always on top, Pause and Done and Discard, the time counting up.
		const pill = await windowTitled(w, "Namzu recording");
		await expect(pill.locator("#title")).toHaveText("Recording", { timeout: T });
		await expect(pill.locator("#time")).toHaveText(/^0:0[1-9]$/, { timeout: T });
		await expect(pill.getByRole("button", { name: "Pause" })).toBeVisible();
		await expect(pill.getByRole("button", { name: "Done" })).toBeVisible();
		await expect(pill.getByRole("button", { name: "Discard" })).toBeVisible();
		assert.deepEqual(await auditWindow(pill), [], "the pill fits its window");
		await shootWindow(w, pill, "3-pill-recording");
		await pill.getByRole("button", { name: "Pause" }).click({ timeout: T });
		await expect(pill.locator("#title")).toHaveText("Paused", { timeout: T });
		await shootWindow(w, pill, "4-pill-paused");
		await pill.getByRole("button", { name: "Resume" }).click({ timeout: T });
		await expect(pill.locator("#title")).toHaveText("Recording", { timeout: T });
		// The scripted controls arrive about every 0.3 s of recording; wait for the last (an export) to be noted.
		await expect(pill.locator("#time")).toHaveText(/^0:0[3-9]$|^0:[1-5][0-9]$/, { timeout: T });
		await pill.getByRole("button", { name: "Done" }).click({ timeout: T });
		await windowGone(w, "Namzu recording");

		step(3);
		// The review sheet above the message box.
		const sheet = w.page.getByTestId("recording-review");
		await expect(sheet).toBeVisible({ timeout: T });
		await expect(sheet.getByRole("heading")).toHaveText(/^Recording ready: 0:\d\d, \d+ pictures?, \d+ steps?, voice off$/);
		await expect(sheet).toContainText("Nothing has been sent");
		assert.deepEqual(await auditPage(w), [], "the sheet fits (closed)");
		await shoot(w, "5-review-closed");
		await sheet.getByRole("button", { name: "View" }).click({ timeout: T });
		await expect(sheet.getByRole("list", { name: "Steps" })).toContainText("Switched to sheet.exe: q3-report.xlsx", { timeout: T });
		await expect(sheet.getByRole("list", { name: "Steps" })).toContainText("Typed “overdue invoices” in Search");
		await expect(sheet.getByRole("list", { name: "Steps" })).toContainText("Pressed Button “Filter”");
		await expect(sheet.getByRole("list", { name: "Pictures" }).locator("img").first()).toBeVisible();
		assert.deepEqual(await auditPage(w), [], "the sheet fits (open)");
		await shoot(w, "6-review-open");

		step(4);
		// Remove a step: it leaves the list and the sheet says so.
		const stepsBefore = await sheet.getByRole("list", { name: "Steps" }).locator("li").count();
		await sheet.getByRole("button", { name: /^Remove the step: Pressed Button “Filter”/ }).click({ timeout: T });
		await expect(sheet.getByRole("list", { name: "Steps" }).locator("li")).toHaveCount(stepsBefore - 1, { timeout: T });
		await expect(sheet).toContainText("What was cut or removed");
		await expect(sheet).toContainText("You removed 1 step.");
		await shoot(w, "7-review-removed");

		step(5);
		// Send: the recording is one chip in the message, and the person's own note travels with it.
		await sheet.getByRole("textbox", { name: "Your note for this recording" }).fill("make this a weekly report skill", { timeout: T });
		await sheet.getByRole("button", { name: "Send" }).click({ timeout: T });
		await expect(sheet).toHaveCount(0, { timeout: T });
		const box = w.page.getByRole("textbox", { name: "Message Namzu" });
		await expect(box).toHaveValue(/^make this a weekly report skill\n\nLoad the skill-creator skill/, { timeout: T });
		await expect(w.page.getByText(/^Screen recording 0:\d\d$/).first()).toBeVisible({ timeout: T });
		await shoot(w, "8-attached");

		step(6);
		// Nothing has gone to the model yet; sending the message does it, and the model proposes through save_skill.
		assert.equal(w.model.requests.length, 0, "nothing reached the model before the message was sent");
		await w.page.getByRole("button", { name: "Send message" }).click({ timeout: T });
		const card = w.page.getByRole("region", { name: "A skill to save" });
		await expect(card).toBeVisible({ timeout: T });
		await expect(card.getByRole("button", { name: "Save skill" })).toBeVisible();
		const seen = JSON.stringify(w.model.requests.at(-1) ?? {});
		assert.match(seen, /screen-recording version=/, "the model received the recording block");
		assert.match(seen, /save_skill/, "and was told to propose a skill");
		assert.match(seen, /image/, "with the pictures attached");
		assert.doesNotMatch(seen, /hunter2/, "no secret in what was sent");
		await shoot(w, "9-save-card");
		await card.getByRole("button", { name: "Cancel" }).click({ timeout: T });

		step(7);
		// Settings, Privacy: the section and the switch that removes the menu item.
		await w.page.getByRole("button", { name: "Settings" }).first().click({ timeout: T });
		const dialog = w.page.getByRole("dialog", { name: "Settings" });
		await dialog.getByRole("button", { name: "Privacy" }).click({ timeout: T });
		await expect(dialog.getByRole("heading", { name: "Screen recording" })).toBeVisible({ timeout: T });
		await expect(dialog).toContainText("Password fields are never recorded");
		await expect(dialog).toContainText("Keystrokes are never captured");
		const toggle = dialog.getByRole("switch", { name: "Record your screen to make skills" });
		await expect(toggle).toBeChecked();
		await shoot(w, "10-settings-privacy");
		await toggle.click({ timeout: T });
		await expect(toggle).not.toBeChecked({ timeout: T });
		await w.page.keyboard.press("Escape");
		await w.page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Customize" }).click({ timeout: T });
		await page.getByRole("button", { name: "Add" }).click({ timeout: T });
		await expect(w.page.getByRole("menuitem", { name: "Create with Namzu" })).toBeVisible({ timeout: T });
		console.error("availability after the switch:", JSON.stringify(await w.page.evaluate(async () => ({ a: await window.namzu.recordingAvailability(), s: (await window.namzu.settings()).screenRecording }))));
		await expect(w.page.getByRole("menuitem", { name: "Record your screen" })).toHaveCount(0, { timeout: T });

		assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} catch (error) {
		console.error("model requests:", world.model.requests.length, JSON.stringify(world.model.requests.at(-1) ?? {}).slice(0, 1200));
		console.error("alerts:", JSON.stringify(await world.page?.locator("[role=alert], [role=dialog]").allInnerTexts().catch(() => [])));
		throw error;
	} finally {
		await dispose(world, { failed });
	}
});
