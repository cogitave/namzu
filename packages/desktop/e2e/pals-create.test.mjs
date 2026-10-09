// Creating a Pal against the real Electron app: one Pal however many times Save is pressed, a name
// that is already taken is refused, and a slow or failing start never leaves the app stuck.
// The start of the Pal's own host is held by a gate in the main process, so no flow here waits on
// the clock: each one releases the gate when it has seen what it came to see.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/pals-create.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createWorld,
	dispose,
	expect,
	freezeApp,
	launch,
	openProject,
	repoRoot,
	shoot,
} from "./harness.mjs";
import { readFileSync } from "node:fs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/pals-create-20261009");

/** Make `openPal` in the frozen copy wait on a gate the flow controls (and fail on demand). */
function gateOpenPal(world) {
	const app = freezeApp(world.root);
	const file = join(app, "dist/main/operator.js");
	const source = readFileSync(file, "utf8");
	const marker = "async openPal(id) {";
	assert.ok(source.includes(marker), "the patch point exists");
	writeFileSync(
		file,
		source.replace(
			marker,
			`${marker}
        const gate = globalThis.__palGate;
        if (gate) {
            gate.calls += 1;
            if (gate.hold) await new Promise((resolve) => gate.waiters.push(resolve));
            if (gate.failNext) { gate.failNext = false; throw new Error("The Pal's host did not start."); }
        }`,
		),
	);
}
const setGate = (world, gate) =>
	world.app.evaluate((_e, value) => {
		globalThis.__palGate = { calls: 0, hold: false, failNext: false, waiters: [], ...value };
	}, gate);
const releaseGate = (world) =>
	world.app.evaluate(() => {
		const gate = globalThis.__palGate;
		gate.hold = false;
		for (const resolve of gate.waiters.splice(0)) resolve();
	});
const gateCalls = (world) => world.app.evaluate(() => globalThis.__palGate.calls);
const palsOnDisk = (world) => {
	try {
		return readdirSync(join(world.home, "pals")).length;
	} catch {
		return 0;
	}
};

function flow(name, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld({ rules: [] });
		let failed = true;
		try {
			gateOpenPal(world);
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

/** Open the Pals page and the customize dialog, however the sidebar words it right now. */
async function openCreateDialog(world) {
	const { page } = world;
	const dialog = page.getByRole("dialog", { name: "Customize your Pal" });
	await expect(async () => {
		if (await dialog.isVisible()) return;
		const customize = page.getByRole("button", { name: "Customize your Pal" }).last();
		if (await customize.isVisible()) {
			await customize.click({ timeout: 2000 });
		} else {
			await page.getByRole("button", { name: /^(New Pal|Create your first Pal)$/ }).first().click({ timeout: 2000 });
		}
		await expect(dialog).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: T });
	return dialog;
}
const nameBox = (dialog) => dialog.getByRole("textbox", { name: "Pal name" });
const mainIsInert = (world) =>
	world.page.evaluate(() => document.querySelector("main.workspace")?.inert ?? null);

flow("a double click on Save makes one Pal, and Customize stays usable while it opens", async (w) => {
	mkdirSync(SHOTS, { recursive: true });
	await setGate(w, { hold: true });
	const dialog = await openCreateDialog(w);
	await nameBox(dialog).fill("pamir");
	await dialog.getByRole("button", { name: "Save" }).dblclick({ delay: 0 });

	// The Pal exists and is starting. The dialog is gone and says nothing about saving.
	const opening = w.page.getByRole("status").filter({ hasText: "Opening pamir" });
	await expect(opening).toBeVisible({ timeout: T });
	await expect(dialog).toBeHidden({ timeout: T });
	assert.equal(await mainIsInert(w), false, "the page takes clicks while the Pal starts");
	await shoot(w, "opening");
	await w.page.screenshot({ path: join(SHOTS, "linux-opening.png") });

	// A new dialog starts from nothing: not saving, nothing disabled.
	const again = await openCreateDialog(w);
	await expect(nameBox(again)).toBeEnabled();
	await expect(nameBox(again)).toHaveValue("");
	await expect(again.getByRole("button", { name: "Close customization" })).toBeEnabled();
	await expect(again.getByText("Saving…")).toHaveCount(0);

	// Trying the same name again (any case) is refused with a suggestion, and makes no Pal.
	await nameBox(again).fill(" PAMIR ");
	await again.getByRole("button", { name: "Save" }).click();
	await expect(again.getByRole("alert")).toContainText(
		"You already have a Pal called “PAMIR”. Try “PAMIR 2”.",
	);
	await w.page.screenshot({ path: join(SHOTS, "linux-duplicate-name.png") });
	assert.equal(palsOnDisk(w), 1, "exactly one Pal exists");
	assert.equal(await gateCalls(w), 1, "the Pal was opened once");
	await again.getByRole("button", { name: "Close customization" }).click();
	await expect(again).toBeHidden();

	await releaseGate(w);
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	await expect(opening).toHaveCount(0);
	assert.equal(palsOnDisk(w), 1, "still exactly one Pal");
	assert.equal(await mainIsInert(w), false);
});

flow("a start that fails leaves the Pal created, says what failed and retries", async (w) => {
	await setGate(w, { failNext: true });
	const dialog = await openCreateDialog(w);
	await nameBox(dialog).fill("kai");
	await dialog.getByRole("button", { name: "Save" }).click();

	const failed = w.page.getByRole("alert").filter({ hasText: "kai is created, but it could not start." });
	await expect(failed).toBeVisible({ timeout: T });
	await expect(failed).toContainText("The Pal's host did not start.");
	await w.page.screenshot({ path: join(SHOTS, "linux-failed.png") });
	assert.equal(palsOnDisk(w), 1);
	// Nothing is stuck: the dialog opens fresh and its fields take input.
	const next = await openCreateDialog(w);
	await expect(nameBox(next)).toBeEnabled();
	await next.getByRole("button", { name: "Close customization" }).click();
	await expect(next).toBeHidden();

	await failed.getByRole("button", { name: "Retry" }).click();
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	await expect(failed).toHaveCount(0);
	assert.equal(palsOnDisk(w), 1, "retrying the start made no second Pal");
	assert.equal(await gateCalls(w), 2);
});

flow("cancelling a start that is taking long keeps the Pal and frees the page", async (w) => {
	await setGate(w, { hold: true });
	const dialog = await openCreateDialog(w);
	await nameBox(dialog).fill("sol");
	await dialog.getByRole("button", { name: "Save" }).click();
	const opening = w.page.getByRole("status").filter({ hasText: "Opening sol" });
	await expect(opening).toBeVisible({ timeout: T });
	await opening.getByRole("button", { name: "Cancel" }).click();
	await expect(opening).toHaveCount(0);
	assert.equal(palsOnDisk(w), 1, "the Pal is still there");
	// The late answer of the held start changes nothing.
	await releaseGate(w);
	const next = await openCreateDialog(w);
	await expect(nameBox(next)).toBeEnabled();
	await next.getByRole("button", { name: "Close customization" }).click();
	await expect(next).toBeHidden();
	await expect(w.page.getByRole("button", { name: "sol", exact: true })).toBeVisible();
});
