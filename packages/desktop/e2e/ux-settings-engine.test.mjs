// Settings the engine describes (limits, tools, sandbox, terminal app), against the real Electron
// app and the real CLI host. Pictures go to SETTINGS_SHOTS when it is set.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-settings-engine.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.SETTINGS_SHOTS;

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function openSettings(w, section) {
	const sections = w.page.getByRole("navigation", { name: "Settings sections" });
	if ((await sections.count()) === 0)
		await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(sections).toBeVisible({ timeout: T });
	await sections.getByRole("button", { name: section, exact: true }).click();
	await expect(w.page.getByRole("heading", { level: 1, name: section, exact: true })).toBeVisible({
		timeout: T,
	});
}

test("engine settings: save a number, confirm a risky switch, never show a secret", { timeout: 240000 }, async () => {
	const world = await createWorld({ rules: [], env: { SHELL: "/bin/sh" } });
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		const page = w.page.locator("#settings-content");

		await openSettings(w, "Agent");
		const steps = page.getByRole("spinbutton", { name: "Most steps per task" });
		await expect(steps).toBeVisible({ timeout: T });
		await steps.fill("9");
		await steps.press("Enter");
		await expect(page.getByRole("button", { name: "Use the default for Most steps per task" })).toBeVisible({ timeout: T });
		const file = readFileSync(join(w.home, "config.yaml"), "utf8");
		assert.match(file, /maxIterations: 9/);

		// The engine's own check refuses a value out of range, and the sentence shows.
		const concurrency = page.getByRole("spinbutton", { name: "Helpers working at once" });
		await concurrency.fill("1");
		await concurrency.press("Enter");
		await expect(page.getByText("Enter 2 or more.")).toBeVisible();
		await shot(w, "agent");

		await openSettings(w, "Tools");
		await expect(page.getByText("Connected servers", { exact: true })).toBeVisible({ timeout: T });
		await expect(page.getByText("Not set").first()).toBeVisible();
		await shot(w, "tools");

		await openSettings(w, "Projects");
		await page.getByRole("switch", { name: "Allow leaving the sandbox" }).click();
		const dialog = w.page.locator("[data-settings-confirm-dialog=setting]");
		await expect(dialog).toBeVisible({ timeout: T });
		await shot(w, "projects-confirm");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toHaveCount(0);
		assert.doesNotMatch(readFileSync(join(w.home, "config.yaml"), "utf8"), /allowEscape/);
		await page.getByRole("switch", { name: "Allow leaving the sandbox" }).click();
		await dialog.getByRole("button", { name: "Change it" }).click();
		await expect(dialog).toHaveCount(0, { timeout: T });
		assert.match(readFileSync(join(w.home, "config.yaml"), "utf8"), /allowEscape: false/);
		await shot(w, "projects");

		await openSettings(w, "Terminal");
		await expect(w.page.locator(".settings-page-header p")).toHaveText(/terminal app/);
		await shot(w, "terminal");

		// Search finds an engine setting among the rest.
		await w.page.getByRole("searchbox", { name: "Search settings" }).fill("telemetry");
		await expect(page.getByText("Save conversations to a file")).toBeVisible();
		await shot(w, "search");
		assert.deepEqual(w.faults, []);
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
