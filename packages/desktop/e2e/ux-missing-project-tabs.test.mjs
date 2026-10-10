// A project whose folder is deleted before launch, with three restored conversations that never got
// a name: the tabs show the project's own page, with no "could not be loaded" banner and no pile of
// identical "New conversation" tabs. Pictures go to research/hygiene-20261010/t4-desktop/.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-missing-project-tabs.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/hygiene-20261010/t4-desktop");

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.waitForTimeout(300);
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
async function setAppearance(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}
async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [wide, high]) => {
			for (const window of BrowserWindow.getAllWindows()) window.setSize(wide, high);
		},
		[width, height],
	);
}

test("three untitled conversations of a project whose folder is gone", { timeout: 280000 }, async () => {
	const world = await createWorld({ rules: [] });
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		let page = world.page;
		const box = page.getByRole("textbox", { name: "Message Namzu" });
		// Three conversations, each holding an unsent line, so each is saved without a title.
		for (const [index, word] of ["alpha", "bravo", "charlie"].entries()) {
			if (index > 0) await page.getByRole("button", { name: "New conversation" }).first().click();
			await expect(box).toBeVisible({ timeout: T });
			await box.fill(`unsent ${word}`);
		}
		// The app has written what a restart needs: the last draft is on disk.
		await expect
			.poll(
				() => {
					try {
						return readFileSync(join(world.userData, "desktop-conversations.json"), "utf8").includes("unsent charlie");
					} catch {
						return false;
					}
				},
				{ timeout: T },
			)
			.toBe(true);
		const before = await page.getByRole("tab").count();
		await world.app.close();
		renameSync(world.project, join(world.root, "moved-project"));
		await launch(world);
		page = world.page;
		for (const scheme of ["dark", "light"]) {
			await setAppearance(world, scheme);
			for (const [width, height] of [
				[900, 700],
				[1280, 800],
			]) {
				await size(world, width, height);
				await expect(page.locator("[data-project-missing]")).toBeVisible({ timeout: T });
				await expect(page.locator(".sidebar-pals-loading")).toHaveCount(0, { timeout: T });
				await expect(page.locator("[data-project-folder-missing]")).toBeVisible({ timeout: T });
				await shot(world, `missing-project-${width}-${scheme}`);
			}
		}
		await expect(page.getByText(/could not be loaded|couldn’t be loaded/i)).toHaveCount(0);
		await expect(page.getByRole("alert")).toHaveCount(0);
		// One tab for the project's page, and nothing hidden behind an overflow control.
		await expect(page.getByRole("tab")).toHaveCount(1, { timeout: T });
		await expect(page.getByRole("button", { name: /Show all tabs/ })).toHaveCount(0);
		assert.ok(before >= 3, `three conversations were open before the restart (${before})`);
		assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
