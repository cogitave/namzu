// Does the model a person sets on a Pal reach that Pal's conversation? Real Electron, real CLI host, and
// the scripted chat-completions service listing three model ids, so each request shows which one it carried.
// The configured default model (preferences) is a third, decoy id standing for an auto-picked default.
//   1. A Pal made with model A: its first message carries A, never the decoy.
//   2. The Pal's model changed to B before anything was sent: the first message carries B.
//   3. The Pal's model changed to B after its conversation began: what the composer shows and what the
//      next message carries. (A Pal has one conversation: the "+" tab opens an ordinary one, so there
//      is no "new conversation" for the Pal model to apply to.)
//   4. A Pal made without choosing a model (the page fills in the configured default) and then given A.
// 1 passes. 2, 3 and 4 are one defect and are marked todo: the Pal's conversation pins the Pal's model
// from the moment it is opened (packages/cli/src/commands/acp.ts, preferencesFor caches it in
// `selections`), so a later change never reaches it.
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

flow("a Pal made with model A: its first message carries A, not the configured default", async (w) => {
	await createKiro(w, A);
	assert.equal(savedPalModel(w).model, A, "the Pal was saved with A");
	assert.match(await composerModel(w), escape(A), "the composer names A");
	assert.equal(await sendAndRead(w, "first message to Kiro", 1), A);
	assert.ok(!w.model.requests.some((r) => r.model === DECOY), "the configured default was never used");
});

flow("a Pal's model changed to B before its first message: the first message carries B", async (w) => {
	await createKiro(w, A);
	await changePalModel(w, B);
	assert.equal(savedPalModel(w).model, B, "the Pal was saved with B");
	assert.match(await composerModel(w), escape(B), "the composer names B");
	assert.equal(await sendAndRead(w, "first message after change", 1), B);
}, { todo: "the Pal's model is pinned when its conversation opens, not when the first message is sent" });

// The Pal's conversation is the only one it has (the "+" tab opens an ordinary conversation, and
// opening a Pal's conversation again is the same one), and it pins the model of its first message.
// Changing the Pal's model afterwards says "Model for new conversations" but there is no new
// conversation to receive it, so a Pal that was ever messaged keeps its first model for good.
// This asserts what the person is told: the change is used by the next message. It fails today.
flow(
	"a Pal's model changed to B after it was messaged: the next message carries B",
	async (w) => {
		await createKiro(w, A);
		assert.equal(await sendAndRead(w, "first message to Kiro", 1), A);
		await changePalModel(w, B);
		assert.equal(savedPalModel(w).model, B, "the Pal was saved with B");
		const shown = await composerModel(w);
		const carried = await sendAndRead(w, "second message to Kiro", 2);
		assert.deepEqual({ shown: shown.replace(/^Model: /, ""), carried }, { shown: B, carried: B });
	},
	{ todo: "a Pal's conversation pins its first model; the Pal's later model never reaches it" },
);

flow("a Pal made on the default and then given A: the next message carries A", async (w) => {
	const { page } = w;
	await expect(async () => {
		await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: T });
	// The page fills in a model by itself; wait for it, never choose one.
	const filled = page.locator(".pal-onboarding-model").getByRole("button", { name: /^Model: / });
	await expect(filled).toBeVisible({ timeout: T });
	const auto = ((await filled.getAttribute("aria-label")) ?? "").replace(/^Model: /, "");
	const dialog = page.getByRole("dialog", { name: "Customize your Pal" });
	await page.getByRole("button", { name: "Customize your Pal" }).last().click();
	await dialog.getByRole("textbox", { name: "Pal name" }).fill("Kiro");
	await dialog.getByRole("textbox", { name: "Pal name" }).press("Enter");
	await expect(page.getByRole("tab", { name: "Kiro" })).toBeVisible({ timeout: T });
	assert.equal(savedPalModel(w).model, auto, "the Pal was saved with the filled-in model");
	await changePalModel(w, A);
	assert.equal(savedPalModel(w).model, A, "the Pal was saved with A");
	assert.deepEqual(
		{ shown: (await composerModel(w)).replace(/^Model: /, ""), carried: await sendAndRead(w, "message after change", 1) },
		{ shown: A, carried: A },
	);
}, { todo: "the Pal's conversation keeps the model the Pal had when it was opened" });
