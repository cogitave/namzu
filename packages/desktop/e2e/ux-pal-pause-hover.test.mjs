// The Pal panel header: the status under the Pal's name is the quiet action. At rest it reads the
// status ("Ready to chat", "Paused"); on hover or keyboard focus the same spot reads "Pause Kiro" or
// "Resume Kiro". There is no visible Pause button. No paid model, no owner data.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-pal-pause-hover.test.mjs
// Set PAL_PAUSE_SHOTS to a directory to keep the screenshots (900 and 1280 wide, dark and light).
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const SHOTS = process.env.PAL_PAUSE_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function size(world, width, height) {
	await world.app.evaluate(
		({ BrowserWindow }, [w, h]) => {
			for (const window of BrowserWindow.getAllWindows()) window.setSize(w, h);
		},
		[width, height],
	);
	await world.page.waitForTimeout(300);
}
/** One screenshot per width and colour scheme; `prepare` puts the page in the state to capture. */
async function shots(world, name, prepare) {
	if (!SHOTS) return;
	for (const width of [900, 1280]) {
		await size(world, width, 900);
		// Below 720px the Pal card is a button that opens the same body in a popover.
		const trigger = world.page.getByRole("button", { name: /^Show Kiro details/ });
		const compact = (await trigger.count()) > 0;
		if (compact) await trigger.click();
		for (const scheme of ["dark", "light"]) {
			await world.page.evaluate((next) => {
				localStorage.setItem("namzu.appearance", next);
				window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
			}, scheme);
			await expect(world.page.locator("html")).toHaveClass(
				scheme === "dark" ? /dark/ : /^(?!.*dark)/,
			);
			await prepare?.();
			// Let the fade between status and action finish so the picture shows one text.
			await world.page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished)));
			await world.page.screenshot({ path: join(SHOTS, `${name}-${width}-${scheme}.png`) });
		}
		if (compact) await world.page.keyboard.press("Escape");
	}
	await size(world, 1440, 900);
}

async function createKiro(world) {
	const page = world.page;
	await expect(async () => {
		await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 60000 });
	await expect(async () => {
		const dialog = page.getByRole("dialog", { name: "Customize your Pal" });
		if (
			!(await dialog.isVisible()) &&
			!(await page.getByRole("button", { name: "Customize your Pal" }).isVisible())
		)
			await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		if (!(await dialog.isVisible()))
			await page.getByRole("button", { name: "Customize your Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("dialog", { name: "Customize your Pal" })).toBeVisible({
			timeout: 2000,
		});
	}).toPass({ timeout: 60000 });
	const customize = page.getByRole("dialog", { name: "Customize your Pal" });
	await customize.getByRole("textbox", { name: "Pal name" }).fill("Kiro");
	await customize.getByRole("textbox", { name: "Pal name" }).press("Enter");
	await expect(page.getByRole("tab", { name: "Kiro" })).toBeVisible({ timeout: 60000 });
	return readdirSync(join(world.home, "pals"))[0];
}

const card = (world) => world.page.locator(".pal-context-body").first();
const box = async (locator) => {
	const rect = await locator.boundingBox();
	assert.ok(rect, "element has a box");
	return rect;
};

test(
	"Kiro's header status: status at rest, Pause on hover and focus, Resume when paused",
	{ timeout: 280000 },
	async () => {
		const world = await createWorld({ rules: [], env: { NAMZU_E2E_PAL_COMPUTER: "fake" } });
		let failed = true;
		try {
			await launch(world);
			await size(world, 1440, 900);
			await openProject(world);
			const page = world.page;
			await createKiro(world);
			const context = card(world);
			await expect(context).toBeVisible({ timeout: 60000 });
			const identity = context.locator(".pal-context-identity");

			// (a) At rest the header reads the status; the accessible name is the action.
			const action = identity.getByRole("button", { name: "Pause Kiro" });
			await expect(action).toBeVisible({ timeout: 60000 });
			const rest = action.locator(".pal-status-rest");
			const hover = action.locator(".pal-status-hover");
			await page.mouse.move(0, 0);
			await expect(rest).toHaveText("Ready to chat");
			await expect(rest).toHaveCSS("opacity", "1");
			await expect(hover).toHaveCSS("opacity", "0");
			await expect(identity.getByRole("status").filter({ hasText: "Ready to chat" })).toHaveCount(1);
			// No outline or filled button look.
			await expect(action).toHaveCSS("border-top-width", "0px");
			await expect(action).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			// (c) No visible element reads exactly "Pause".
			await expect(context.getByText("Pause", { exact: true })).toHaveCount(0);
			// The card can still be settling into place; measure once two reads agree.
			await expect(async () => {
				const first = await box(action);
				await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
				assert.deepEqual(await box(action), first);
			}).toPass();
			const restAction = await box(action);
			await shots(world, "rest", () => page.mouse.move(0, 0));

			// Hover reads the action in the same spot, with the same footprint.
			await action.hover();
			await expect(hover).toHaveText("Pause Kiro");
			await expect(hover).toHaveCSS("opacity", "1");
			await expect(rest).toHaveCSS("opacity", "0");
			assert.deepEqual(await box(action), restAction, "the status button did not move or resize");
			await shots(world, "hover", () => action.hover());
			await page.mouse.move(0, 0);

			// (b) Keyboard focus shows the action, and Enter pauses.
			await page.keyboard.press("Shift");
			await action.focus();
			await expect(action).toBeFocused();
			await expect(hover).toHaveText("Pause Kiro");
			await expect(hover).toHaveCSS("opacity", "1");
			assert.deepEqual(await box(action), restAction, "focus does not move the status button");
			await shots(world, "focus", async () => {
				await page.keyboard.press("Shift");
				await action.focus();
			});
			await page.keyboard.press("Enter");

			// Paused: the status reads Paused, hover reads Resume Kiro.
			const resume = identity.getByRole("button", { name: "Resume Kiro" });
			await expect(resume).toBeVisible({ timeout: 60000 });
			await page.mouse.move(0, 0);
			await expect(resume.locator(".pal-status-rest")).toHaveText("Paused");
			await expect(identity.getByRole("status").filter({ hasText: "Paused" })).toHaveCount(1);
			await expect(context.getByText("Resume", { exact: true })).toHaveCount(0);
			await shots(world, "paused-rest", () => page.mouse.move(0, 0));
			const pausedRest = await box(resume);
			await resume.hover();
			await expect(resume.locator(".pal-status-hover")).toHaveText("Resume Kiro");
			await expect(resume.locator(".pal-status-hover")).toHaveCSS("opacity", "1");
			assert.deepEqual(await box(resume), pausedRest, "the paused status button did not move or resize");
			await shots(world, "paused-hover", () => resume.hover());
			await page.mouse.move(0, 0);

			// The paused Pal's composer still says why.
			const composer = page.getByRole("textbox", { name: "Message Namzu" });
			await composer.fill("hello");
			await expect(page.getByText("Kiro is paused. Resume Kiro to chat.")).toBeVisible();
			await composer.fill("");

			await resume.click();
			await expect(identity.getByRole("button", { name: "Pause Kiro" })).toBeVisible();
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);
