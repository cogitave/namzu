// A shell command is one row with its output under it: the first lines, stderr in the error colour, how it
// ended said once, "(No output)", and a command handed to a background job says so and can be looked at.
// Real Electron app, real CLI host, scripted provider. No paid model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-shell-cells.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
const shot = async (w, name) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const row = (w, text) => w.page.locator(".tool[data-tool-call-id]", { hasText: text }).first();

test("commands show their output, how they ended once, and background ones say so", { timeout: 280000 }, async () => {
	const world = await createWorld({
		rules: [
			{
				match: /^komutlar/,
				steps: [
					{ tool: "bash", args: { command: "for i in $(seq 1 40); do echo satir $i; done" } },
					{ tool: "bash", args: { command: "echo hata-mesaji >&2; exit 3" } },
					{ tool: "bash", args: { command: "true" } },
					{ tool: "bash", args: { command: "echo sunucu; sleep 300", run_in_background: true } },
					{ text: "Bitti.", hold: "slow" },
				],
			},
		],
	});
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await w.page.getByRole("button", { name: /^Permissions/ }).click();
		await w.page.getByRole("menuitemradio", { name: /Full access/ }).click();
		await w.page.getByRole("alertdialog", { name: "Allow Namzu full access?" }).getByRole("button", { name: "Enable full access" }).click();
		await expect(w.page.getByRole("button", { name: /Permissions: Full access/ })).toBeVisible({ timeout: T });
		await send(w, "komutlar");
		await expect(w.page.locator("[data-shell-cell]")).toHaveCount(4, { timeout: T });
		// While the reply is still running the group says what is true about its commands.
		const group = w.page.locator(".tool-run-trigger, [data-run-summary]").first();
		const text = (await w.page.locator(".normal-transcript").innerText()).replace(/\s+/g, " ");
		assert.match(text, /commands?, 1 failed, 1 in the background/i, `the run header: ${text.slice(0, 400)}`);
		void group;
		await shot(w, "shell-running");
		// First three lines, then how many more.
		const seq = row(w, "for i in");
		await expect(seq.locator(".shell-cell-line")).toHaveCount(3);
		await expect(seq.getByRole("button", { name: "+37 lines" })).toBeVisible();
		// The failure: headline without a repeat, stderr in the error tone, "Exit code 3" once.
		const bad = row(w, "hata-mesaji");
		await expect(bad.locator(".shell-cell-err").first()).toContainText("hata-mesaji");
		assert.equal((await bad.innerText()).match(/Exit code 3/g)?.length, 1);
		assert.ok(!(await bad.innerText()).includes("failed (exit"), "the headline does not repeat the failure");
		await expect(row(w, "Ran true")).toContainText("(No output)");
		const background = row(w, "sleep 300");
		await expect(background).toContainText("Running in the background");
		await background.getByRole("button", { name: "See it" }).click();
		await expect(w.page.locator(".jobs-panel[data-open=true]")).toBeVisible();
		await shot(w, "shell-background-panel");
		await seq.getByRole("button", { name: "+37 lines" }).click();
		await expect(seq.getByRole("button", { name: "Show less" })).toBeVisible();
		w.model.release("slow");
		await expect(w.page.getByText("Bitti.")).toBeVisible({ timeout: T });
		await shot(w, "shell-finished");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
