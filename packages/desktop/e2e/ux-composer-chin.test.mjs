// The home screen's composer, quiet: the lower edge carries the attach "+", the permission word, the model word
// and Send; the project and the computer are one line above the box with one menu; the starters fill the box and
// never send; the model popup opens on the list, a second line from the catalogue, the effort control and one
// More row. Real Electron app, real CLI host, scripted provider. No paid model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-composer-chin.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openModelMore, openProject } from "./harness.mjs";

const T = 60000;

test("the composer chin is quiet, one line holds project and computer, starters never send, the picker opens on the list", { timeout: 280000 }, async () => {
	const world = await createWorld({
		models: [
			{ id: "gpt-e2e-1", context_window: 128000, pricing: { prompt: "0", completion: "0" } },
			{ id: "gpt-e2e-0", context_window: 32000, pricing: { prompt: "0.000003", completion: "0.000015" } },
		],
	});
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const page = world.page;
		const box = page.getByRole("textbox", { name: "Message Namzu" });
		await expect(box).toBeVisible({ timeout: T });

		// Voice input is not set up: the composer has no microphone. Settings is where it is turned on.
		await expect(page.getByRole("button", { name: /voice input/i })).toHaveCount(0);

		// One line above the box: the project and the computer, 13px, one menu.
		const line = page.locator(".composer-context-above");
		await expect(line.getByRole("button")).toHaveCount(1);
		await expect(line).toContainText("This computer");
		await expect(page.locator(".composer-computer-label")).toHaveCount(0);
		assert.equal(await line.getByRole("button").evaluate((el) => getComputedStyle(el).fontSize), "13px");
		await line.getByRole("button").click();
		const runsOn = page.getByRole("group", { name: "Runs on" });
		await expect(runsOn).toContainText("This computer");
		await expect(page.getByRole("searchbox", { name: "Search projects" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(runsOn).toHaveCount(0);

		// The chin: permission and model are quiet words; the chevron is drawn on hover.
		const permission = page.getByRole("button", { name: /^Permissions:/ });
		const chevron = permission.locator("[data-composer-control-chevron]");
		const chevronWidth = () => chevron.evaluate((el) => el.getBoundingClientRect().width);
		assert.ok((await chevronWidth()) < 1, "no chevron at rest");
		await permission.hover();
		await expect.poll(chevronWidth, { timeout: T }).toBeGreaterThan(8);
		await page.mouse.move(5, 5);

		// Starters: three 32px rows; a click fills and focuses the box and sends nothing.
		const starters = page.locator(".starter-actions button");
		await expect(starters).toHaveCount(3);
		for (const row of await starters.all()) assert.equal(Math.round((await row.boundingBox()).height), 32);
		await starters.first().click();
		await expect(box).toHaveValue(/^Explore this project/);
		await expect(box).toBeFocused();
		assert.equal(world.model.requests.length, 0, "a starter spent no tokens");
		await box.fill("");

		// The model popup opens on the list, with a second line from what the catalogue published.
		await page.getByRole("button", { name: /^Model:/ }).click();
		const popup = page.locator(".model-picker-popup");
		const free = popup.getByRole("radio", { name: /gpt-e2e-1/ });
		await expect(free).toBeVisible({ timeout: T });
		await expect(free).toContainText("128k window · Free");
		await expect(popup.getByRole("radio", { name: /gpt-e2e-0/ })).toContainText("32k window · $3 in · $15 out per 1M");
		assert.ok((await free.boundingBox()).height >= 40, "a row is at least 40px");
		await expect(popup.locator(".engine-chip, .surface-switch, [role=tablist]")).toHaveCount(0);
		await expect(popup.locator(".model-picker-more")).toHaveCount(1);
		// The keyboard: arrows move, Enter chooses, the popup closes.
		await expect(free).toBeFocused({ timeout: T });
		await page.keyboard.press("ArrowDown");
		await expect(popup.getByRole("radio", { name: /gpt-e2e-0/ })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(popup).toHaveCount(0, { timeout: T });
		await expect(page.getByRole("button", { name: "Model: gpt-e2e-0" })).toBeVisible({ timeout: T });

		// Escape closes it too, and More holds the engine, where it runs and the provider filter.
		await page.getByRole("button", { name: /^Model:/ }).click();
		await openModelMore(page);
		await expect(page.getByRole("button", { name: /^Engine:/ })).toBeVisible();
		await expect(page.getByRole("radio", { name: "Desktop", exact: true })).toBeVisible();
		await expect(page.getByRole("radiogroup", { name: "Show models from" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(popup).toHaveCount(0, { timeout: T });
		assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
