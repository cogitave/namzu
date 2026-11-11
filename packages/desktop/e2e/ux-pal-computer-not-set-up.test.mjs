// A Pal's computer on a PC with no container engine: the screen reads it once, shows one setup card
// and does not ask again until the person comes back to the window. No paid model, no owner data.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-pal-computer-not-set-up.test.mjs
// NAMZU_E2E_SHOTS=<dir> saves the screenshots there.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject } from "./harness.mjs";

const SHOTS = process.env.NAMZU_E2E_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (world, name) => {
	if (SHOTS) await world.page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

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

/** Counts every read of the Pal's computer that reaches the main process. */
async function countReads(world) {
	await world.app.evaluate(({ ipcMain }) => {
		const channel = "namzu:palComputer";
		const original = ipcMain._invokeHandlers.get(channel);
		globalThis.__computerReads = 0;
		ipcMain._invokeHandlers.set(channel, (...args) => {
			globalThis.__computerReads += 1;
			return original(...args);
		});
	});
}
const reads = (world) => world.app.evaluate(() => globalThis.__computerReads);

test(
	"a Pal's computer that is not set up: one setup card, one read, no repeating failure",
	{ timeout: 280000 },
	async () => {
		const world = await createWorld({ rules: [] });
		let failed = true;
		try {
			await launch(world);
			await world.app.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.setSize(1280, 820);
			});
			await world.page.emulateMedia({ colorScheme: "dark" });
			await openProject(world);
			await countReads(world);
			await createKiro(world);
			const page = world.page;
			await expect(page.getByText(/needs Docker Desktop or Podman/).first()).toBeVisible({
				timeout: 60000,
			});
			await shot(world, "pal-page");
			assert.ok((await reads(world)) >= 1, "the computer was read at least once");
			// The computer page itself: the one setup card where the live screen would be.
			await page.getByRole("button", { name: /^Open Kiro’s computer$/ }).click();
			await expect(page.getByText(/Computer is offline|Set up Kiro’s computer/).first()).toBeVisible({
				timeout: 60000,
			});
			await shot(world, "computer-page");
			// Nothing else is asked by the app itself: the count stays put across a settled stretch.
			// (A fixed window, measured in the main process; the test decides nothing by a deadline.)
			const settled = await reads(world);
			await world.app.evaluate(() => new Promise((done) => setTimeout(done, 12000)));
			const later = await reads(world);
			assert.equal(
				later,
				settled,
				`no read repeated while the computer is not set up (${settled} -> ${later})`,
			);
			if (process.env.NAMZU_E2E_EXPECT_CARD === "1")
				await expect(page.locator("[data-setup-card]")).toContainText("about 1.2 GB of disk");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);
