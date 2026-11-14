// The home screen's composer, quiet: the box carries the attach "+" and Send; the permission word, the model word
// and the project and the computer are one row under the box, the project with one menu; the starters fill the box and
// never send; the model popup opens on the list, a second line from the catalogue, the effort control and one
// More row. Real Electron app, real CLI host, scripted provider. No paid model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-composer-chin.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { createWorld, dispose, expect, launch, openModelMore, openProject, showProvider } from "./harness.mjs";

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

		// In the row under the box: the project and the computer, 13px, one menu.
		const line = page.locator(".composer-row-project");
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

		// The row: permission and model are quiet words. No chevron is drawn, at rest or under the pointer, so
		// nothing that only shows on hover keeps room and nothing moves when the pointer arrives.
		const permission = page.getByRole("button", { name: /^Permissions:/ });
		const chevron = permission.locator("[data-composer-control-chevron]");
		await expect(chevron).toBeHidden();
		const wordLeft = () => permission.locator("span").first().evaluate((el) => el.getBoundingClientRect().left);
		const rest = { left: await wordLeft(), width: (await permission.boundingBox()).width };
		await permission.hover();
		await expect.poll(() => permission.evaluate((el) => getComputedStyle(el).backgroundColor), { timeout: T }).not.toBe("rgba(0, 0, 0, 0)");
		await expect(chevron).toBeHidden();
		assert.equal(await wordLeft(), rest.left, "the word does not move under the pointer");
		assert.equal((await permission.boundingBox()).width, rest.width, "the control does not grow on hover");
		await page.mouse.move(5, 5);

		// Starters: three 40px rows; a click fills and focuses the box and sends nothing.
		const starters = page.locator(".starter-actions button");
		await expect(starters).toHaveCount(3);
		for (const row of await starters.all()) assert.equal(Math.round((await row.boundingBox()).height), 40);
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

		// More holds the engine, where it runs and the provider filter.
		const trigger = page.getByRole("button", { name: /^Model:/ });
		await trigger.click();
		await openModelMore(page);
		await expect(page.getByRole("button", { name: /^Engine:/ })).toBeVisible();
		await expect(page.getByRole("radio", { name: "Desktop", exact: true })).toBeVisible();
		await expect(page.getByRole("radiogroup", { name: "Show models from" })).toBeVisible();
		// Escape goes back one step, with focus on the More row; a second Escape closes, focus on the model control.
		await page.keyboard.press("Escape");
		await expect(page.getByRole("heading", { name: "More", exact: true })).toHaveCount(0, { timeout: T });
		await expect(popup).toHaveCount(1);
		await expect(popup.locator(".model-picker-more")).toBeFocused({ timeout: T });
		await page.keyboard.press("Escape");
		await expect(popup).toHaveCount(0, { timeout: T });
		await expect(trigger).toBeFocused({ timeout: T });
		// The back button returns to the same place.
		await trigger.click();
		await openModelMore(page);
		await page.getByRole("button", { name: "Models", exact: true }).click();
		await expect(popup.locator(".model-picker-more")).toBeFocused({ timeout: T });
		await page.keyboard.press("Escape");
		await expect(popup).toHaveCount(0, { timeout: T });
		assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});

test("the effort control belongs to the model in use: it is left out beside another provider's list, and a long project name gives way before the computer", { timeout: 280000 }, async () => {
	const world = await createWorld({
		models: ["gpt-5.6-luna", "gpt-6-luna"],
		model: "gpt-5.6-luna",
		providers: [
			{ id: "openai", model: "gpt-5.6-luna" },
			{ id: "anthropic", model: "claude-sonnet-5-5" },
		],
		messagesRules: [],
		messagesModels: ["claude-sonnet-5-5", "claude-haiku-5-5"],
	});
	const long = "a-very-long-project-name-that-keeps-going-on-and-on-and-on-x";
	assert.equal(long.length, 60);
	const named = join(dirname(world.project), long);
	renameSync(world.project, named);
	world.project = named;
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const page = world.page;
		await expect(page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });

		// A narrow, zoomed window: the project name takes the ellipsis, the computer stays whole.
		await world.app.evaluate(({ BrowserWindow }) => {
			for (const win of BrowserWindow.getAllWindows()) {
				win.setSize(960, 700);
				win.webContents.setZoomFactor(1.6);
			}
		});
		const line = page.locator(".composer-project-control");
		await expect
			.poll(() => line.locator(".composer-project-title").evaluate((el) => el.scrollWidth > el.clientWidth), { timeout: T })
			.toBe(true);
		const place = line.locator(".composer-project-place");
		assert.equal(await place.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "the place is not cut");
		await expect(place).toContainText("This computer");
		await world.app.evaluate(({ BrowserWindow }) => {
			for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(1);
		});

		// The list of the model in use carries the effort control; another provider's list does not.
		const popup = page.locator(".model-picker-popup");
		await page.getByRole("button", { name: /^Model:/ }).click();
		await expect(popup.getByRole("radio").first()).toBeVisible({ timeout: T });
		await expect(popup.locator(".composer-effort-panel")).toHaveCount(1, { timeout: T });
		await showProvider(page, "Anthropic (Claude)");
		await expect(popup.getByRole("radio", { name: "claude-sonnet-5-5" })).toBeVisible({ timeout: T });
		await expect(popup.locator(".composer-effort-panel")).toHaveCount(0);
		await showProvider(page, new RegExp("OpenAI"));
		await expect(popup.locator(".composer-effort-panel")).toHaveCount(1, { timeout: T });
		assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
