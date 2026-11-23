// An instance on its own user-data folder says so: the window title reads "Namzu (test: <folder>)" and
// the header carries no mark (the tray shows it). Every e2e world runs on its own folder, so this is one.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/test-profile.test.mjs
// Set NAMZU_E2E_PICS to a folder to keep a picture.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch } from "./harness.mjs";

test("a test profile is named in the window title, not in the header", { timeout: 300000 }, async () => {
	const world = await createWorld({});
	let failed = true;
	try {
		await launch(world);
		const title = await world.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
		assert.equal(title, "Namzu (test: userdata)");
		await expect(world.page.locator(".window-titlebar")).toBeVisible({ timeout: 60000 });
		assert.equal(await world.page.locator(".window-titlebar-test-profile").count(), 0);
		const pics = process.env.NAMZU_E2E_PICS;
		if (pics) {
			mkdirSync(pics, { recursive: true });
			const header = world.page.locator(".window-titlebar");
			await header.screenshot({ path: join(pics, "test-profile-header.png") });
			await world.page.screenshot({ path: join(pics, "test-profile-window.png") });
			writeFileSync(join(pics, "test-profile-title.txt"), `window title: ${title}\n`);
		}
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
