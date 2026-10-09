// The Pal "New message" marker survives a restart: it is kept by main, not by the window.
// A message is sent to a Pal from an ordinary conversation, the app is closed and opened again,
// the marker is still on the Pal's row, opening the Pal clears it, and it stays cleared after a
// second restart. Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/pal-unread-restart.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	createWorld,
	dispose,
	expect,
	launch,
	openProject,
	relaunch,
	repoRoot,
	send,
} from "./harness.mjs";

const T = 60000;
const SHOTS = join(repoRoot, "research/pal-unread-20261009");
mkdirSync(SHOTS, { recursive: true });

const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
const row = (w) => w.page.getByRole("button", { name: /Işık.*Your message is waiting for Işık/ });
const dot = (w) => w.page.locator(".sidebar-pal-row .sidebar-pal-unread");

test("a Pal's New message marker survives a restart until its conversation is opened", {
	timeout: 280000,
}, async () => {
	const rules = [];
	const w = await createWorld({ rules });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		const page = w.page;

		await expect(async () => {
			await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
			await expect(page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({
				timeout: 2000,
			});
		}).toPass({ timeout: T });
		await expect(async () => {
			if (!(await page.getByRole("dialog", { name: "Customize your Pal" }).isVisible()))
				await page.getByRole("button", { name: "Customize your Pal" }).click({ timeout: 2000 });
			await expect(page.getByRole("dialog", { name: "Customize your Pal" })).toBeVisible({
				timeout: 2000,
			});
		}).toPass({ timeout: T });
		const name = page.getByRole("textbox", { name: "Pal name" });
		await name.fill("Işık");
		await name.press("Enter");
		await expect(page.getByRole("tab", { name: "Işık" })).toBeVisible({ timeout: T });
		await expect(page.getByText("Ready to chat")).toBeVisible({ timeout: T });

		const palId = readdirSync(join(w.home, "pals"))[0];
		rules.push({
			match: /ask the pal/i,
			steps: [
				{ tool: "send_pal_message", args: { palId, body: "Please summarise the README." } },
				{ text: "I sent your Pal the request." },
			],
		});
		await page.getByRole("button", { name: "New conversation" }).first().click();
		await send(w, "Ask the Pal to summarise the README");
		const approval = page.getByRole("region", { name: "Tool approval" });
		await expect(approval).toBeVisible({ timeout: T });
		await approval.getByRole("button", { name: /Accept/ }).click();
		await expect(page.getByRole("list", { name: "Messages sent to Pals" })).toContainText(
			"Sent to Işık’s inbox.",
			{ timeout: T },
		);
		await expect(row(w)).toBeVisible({ timeout: T });
		await expect(dot(w)).toHaveCount(1);
		await shot(w, "1-marker-before-restart");

		// Main holds it, so a window closed and opened again still shows it.
		await relaunch(w);
		await expect(row(w)).toBeVisible({ timeout: T });
		await expect(dot(w)).toHaveCount(1);
		await shot(w, "2-marker-after-restart");

		// Opening the Pal reads its messages; the marker goes and stays gone after another restart.
		await w.page.getByRole("button", { name: /Işık/ }).first().click();
		await expect(dot(w)).toHaveCount(0, { timeout: T });
		await relaunch(w);
		await expect(w.page.getByRole("button", { name: /^Işık/ }).first()).toBeVisible({ timeout: T });
		await expect(dot(w)).toHaveCount(0);
		await shot(w, "3-marker-cleared-after-restart");

		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
