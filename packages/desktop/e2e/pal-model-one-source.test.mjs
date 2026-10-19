// Does the model a person sets on a Pal reach that Pal's conversation? Real Electron, real CLI host, and
// THIS FILE: a Pal has ONE model. A pick in the composer plus menu and a change in the Pal settings
// show the same model, and the next turn runs on it. Set SHOTS_DIR to save screenshots.
// the scripted chat-completions service listing three model ids, so each request shows which one it carried.
// The configured default model (preferences) is a third, decoy id standing for an auto-picked default.
//   1. A Pal made with model A: its first message carries A, never the decoy.
//   2. The Pal's model changed to B before anything was sent: the first message carries B.
//   3. The Pal's model changed to B after its conversation began: what the composer shows and what the
//      next message carries. (A Pal has one conversation: the "+" tab opens an ordinary one, so there
//      is no "new conversation" for the Pal model to apply to.)
//   4. A Pal made without choosing a model (the page fills in the configured default) and then given A.
// A Pal's conversation follows the Pal's current model (acp.ts preferencesFor reads it on every call);
// only a model picked by hand in the composer is pinned.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/pal-model-applies.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const A = "gpt-6-luna";
const B = "gpt-5.6-luna";
const DECOY = "gpt-decoy-free";
const escape = (id) => new RegExp(id.replace(/\./g, "\\."));

function flow(name, body, options = {}) {
	test(name, { timeout: 280000, ...options }, async () => {
		const world = await createWorld({
			rules: [{ match: /./, steps: [{ text: "ok" }] }],
			models: [A, B, DECOY],
			providers: [{ id: "openai", model: DECOY }],
		});
		let failed = true;
		try {
			await launch(world);
			await openProject(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

/** Pick a model in the model chip inside `scope`, closing its popup by the chip (Escape would close a dialog too). */
async function pick(scope, page, model) {
	const chip = scope.getByRole("button", { name: /^Model/ });
	await chip.click();
	const change = page.getByRole("button", { name: /change model/ });
	if (await change.count()) await change.click();
	await page.getByRole("radio", { name: escape(model) }).click();
	await expect(chip).toHaveAttribute("aria-label", escape(model), { timeout: T });
	if ((await chip.getAttribute("aria-expanded")) === "true") await chip.click();
}

/** Create a Pal named Kiro with `model`, chosen on the welcome page. */
async function createKiro(w, model) {
	const { page } = w;
	await expect(async () => {
		await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: T });
	await pick(page.locator(".pal-onboarding-model"), page, model);
	const dialog = page.getByRole("dialog", { name: "Customize your Pal" });
	await expect(async () => {
		if (await dialog.isVisible()) return;
		await page.getByRole("button", { name: "Customize your Pal" }).last().click({ timeout: 2000 });
		await expect(dialog).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: T });
	await dialog.getByRole("textbox", { name: "Pal name" }).fill("Kiro");
	await dialog.getByRole("textbox", { name: "Pal name" }).press("Enter");
	await expect(page.getByRole("tab", { name: "Kiro" })).toBeVisible({ timeout: T });
}

/** The Pal's saved model, read from its newest revision on disk. */
function savedPalModel(w) {
	const dir = join(w.home, "pals", readdirSync(join(w.home, "pals"))[0], "revisions");
	const newest = readdirSync(dir).sort((a, b) => parseInt(a) - parseInt(b)).at(-1);
	return JSON.parse(readFileSync(join(dir, newest), "utf8")).model;
}

/** Change the Pal's model through its settings ("Change name, look or model"). */
async function changePalModel(w, model) {
	const { page } = w;
	await page.getByRole("complementary", { name: "Pal context" }).getByRole("button", { name: /settings/i }).click();
	const settings = page.getByRole("dialog", { name: "Kiro settings" });
	await expect(settings).toBeVisible({ timeout: T });
	await settings.getByRole("button", { name: "Change name, look or model" }).click();
	const edit = page.getByRole("dialog", { name: "Customize your Pal" });
	await expect(edit).toBeVisible({ timeout: T });
	await pick(edit, page, model);
	await edit.getByRole("button", { name: "Save" }).click();
	await expect(edit).toBeHidden({ timeout: T });
	// Saving closes the settings along with the form.
	await expect(settings).toBeHidden({ timeout: T });
}

/** The model the Pal's composer names for the next message (it sits under the plus button). */
async function composerModel(w) {
	const { page } = w;
	await page.getByRole("button", { name: "Attachments and message settings" }).click();
	const chip = page.getByRole("dialog", { name: "Attachments and message settings" }).getByRole("button", { name: /^Model/ });
	await expect(chip).toBeVisible({ timeout: T });
	await expect(chip).not.toHaveAttribute("aria-label", /loading/, { timeout: T });
	await shot(w, `${++n}-composer-plus-menu`);
	const label = (await chip.getAttribute("aria-label")) ?? "";
	await page.keyboard.press("Escape");
	return label;
}

/** Send `text` and return the model its request carried. */
async function sendAndRead(w, text, replies) {
	await send(w, text);
	await expect(w.page.getByText("ok", { exact: true })).toHaveCount(replies, { timeout: T });
	const carried = w.model.requests.filter((r) => JSON.stringify(r.messages).includes(text)).map((r) => r.model);
	assert.equal(carried.length, 1, `exactly one request carried "${text}"`);
	return carried[0];
}


/** The model the Pal's settings dialog names (the "Model" row), then close it. */
async function settingsModel(w) {
	const { page } = w;
	await page.getByRole("complementary", { name: "Pal context" }).getByRole("button", { name: /settings/i }).click();
	const settings = page.getByRole("dialog", { name: "Kiro settings" });
	await expect(settings).toBeVisible({ timeout: T });
	await shot(w, `${++n}-settings`);
	const text = (await settings.locator(".pal-settings-facts").innerText()).replace(/\s+/g, " ");
	await page.keyboard.press("Escape");
	await expect(settings).toBeHidden({ timeout: T });
	return text;
}

/** Pick a model in the composer's plus menu. */
async function pickInComposer(w, model) {
	const { page } = w;
	await page.getByRole("button", { name: "Attachments and message settings" }).click();
	const dialog = page.getByRole("dialog", { name: "Attachments and message settings" });
	await pick(dialog, page, model);
	await page.keyboard.press("Escape");
}

import { mkdirSync } from "node:fs";
let n = 0;
const SHOTS = process.env.SHOTS_DIR;
async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

flow("one source: composer pick and Pal settings agree, and the turn runs on it", async (w) => {
	const { page } = w;
	await createKiro(w, A);
	const log = [];
	// 1. Pick B by hand in the composer.
	await pickInComposer(w, B);
	log.push(["after composer pick B", { composer: await composerModel(w), settings: await settingsModel(w), saved: savedPalModel(w).model }]);
	// 2. Send: which model ran?
	log.push(["turn 1 carried", await sendAndRead(w, "turn one", 1)]);
	// 3. Change in settings to the decoy.
	await changePalModel(w, DECOY);
	log.push(["after settings change to DECOY", { composer: await composerModel(w), settings: await settingsModel(w), saved: savedPalModel(w).model }]);
	log.push(["turn 2 carried", await sendAndRead(w, "turn two", 2)]);
	console.log("PALMODEL " + JSON.stringify(log, null, 1));
	const [, c1] = [0, log[0][1]];
	assert.equal(c1.composer.replace(/^Model: /, ""), B);
	assert.match(c1.settings, escape(B), "settings names the model the composer shows");
	assert.equal(log[1][1], B);
	const c2 = log[2][1];
	assert.match(c2.settings, escape(DECOY));
	assert.equal(c2.composer.replace(/^Model: /, ""), DECOY, "composer follows the settings change");
	assert.equal(log[3][1], DECOY, "the next turn runs on the settings model");
});
