// A message put back in the message box is no longer a sent message: its bubble leaves the
// transcript, no "You continued without this reply." stays for it, and once it is sent again it
// shows exactly once, live and after the app is closed and opened again. Real Electron app, real
// CLI host, scripted provider. No network, no paid model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-message-put-back.test.mjs
// Pictures go to research/hygiene-20261010/message-put-back/.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, historySeenBy, launch, openProject, relaunch, repoRoot, send } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/hygiene-20261010/message-put-back");
const BAD_GATEWAY = { status: 502, contentType: "text/html", body: "<html><body>502 Bad Gateway</body></html>" };
const NOTE = "You continued without this reply.";

function flow(name, options, body) {
	test(name, { timeout: 280000 }, async () => {
		const world = await createWorld(options);
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [x, y]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(x, y);
		},
		[width, height],
	);
}
async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "light") await expect(w.page.locator("html")).not.toHaveClass(/dark/);
	else await expect(w.page.locator("html")).toHaveClass(/dark/);
}
/** The picture at 900 and 1280 px, in the dark theme and the light one. */
async function shots(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	for (const width of [900, 1280]) {
		await size(w, width, 820);
		for (const mode of ["dark", "light"]) {
			await theme(w, mode);
			await w.page.screenshot({ path: join(SHOTS, `${name}-${width}-${mode}.png`) });
		}
	}
	await theme(w, "dark");
	await size(w, 1280, 820);
}
const box = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });
const bubbles = (w, text) => w.page.locator('[data-message-role="user"]').filter({ hasText: text });

async function createKiro(w) {
	const page = w.page;
	await expect(async () => {
		await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: T });
	await expect(async () => {
		const dialog = page.getByRole("dialog", { name: "Customize your Pal" });
		if (!(await dialog.isVisible()) && !(await page.getByRole("button", { name: "Customize your Pal" }).isVisible()))
			await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		if (!(await dialog.isVisible())) await page.getByRole("button", { name: "Customize your Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("dialog", { name: "Customize your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: T });
	const customize = page.getByRole("dialog", { name: "Customize your Pal" });
	await customize.getByRole("textbox", { name: "Pal name" }).fill("Kiro");
	await customize.getByRole("textbox", { name: "Pal name" }).press("Enter");
	await expect(page.getByRole("tab", { name: "Kiro" })).toBeVisible({ timeout: T });
}

function budgetFiles(home) {
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".json") && dir.endsWith("budgets")) found.push(path);
		}
	};
	walk(home);
	return found;
}

const MESSAGE = "please go wrong";

/** What the window must show once the message is back in the box, and again after it is sent. */
async function continueAndSendAgain(w, shotName) {
	const region = w.page.locator(".turn-recovery");
	await region.getByRole("button", { name: "Continue without this reply" }).click();
	await expect(w.page.locator(".turn-recovery")).toHaveCount(0, { timeout: T });
	await expect(box(w)).toHaveValue(MESSAGE);
	// Back in the box, so it is not a sent message: no bubble and no note.
	await expect(bubbles(w, MESSAGE)).toHaveCount(0);
	await expect(w.page.getByText(NOTE)).toHaveCount(0);
	await shots(w, `${shotName}-continued`);
	w.model.rules[0].steps = [{ text: "The provider is back." }];
	await w.page.getByRole("button", { name: "Send message" }).click();
	await expect(w.page.getByText("The provider is back.")).toBeVisible({ timeout: T });
	await expect(bubbles(w, MESSAGE)).toHaveCount(1);
	await expect(w.page.getByText(NOTE)).toHaveCount(0);
	const seen = historySeenBy(w.model.requests.at(-1), MESSAGE);
	assert.equal(seen.copies, 1, `the provider saw the message once; it received ${seen.roles.join(", ")}`);
	await shots(w, `${shotName}-sent-again`);
}

flow(
	"a Pal's message put back in the box leaves the transcript, shows once when sent again, and still once after a restart",
	{ env: { NAMZU_E2E_PAL_COMPUTER: "fake" }, rules: [{ match: /go wrong/i, steps: [BAD_GATEWAY] }] },
	async (w) => {
		await openProject(w);
		await createKiro(w);
		await send(w, MESSAGE);
		await expect(w.page.locator(".turn-recovery").getByRole("button", { name: "Continue without this reply" })).toBeVisible({ timeout: T });
		await expect(bubbles(w, MESSAGE)).toHaveCount(1);
		await continueAndSendAgain(w, "pal");
		await relaunch(w);
		await w.page.getByRole("button", { name: /^Kiro/ }).first().click();
		await expect(w.page.getByText("The provider is back.")).toBeVisible({ timeout: T });
		await expect(bubbles(w, MESSAGE)).toHaveCount(1);
		await expect(w.page.getByText(NOTE)).toHaveCount(0);
		await shots(w, "pal-restarted");
	},
);

flow(
	"a project conversation's message put back in the box leaves the transcript, shows once when sent again, and still once after a restart",
	{ rules: [{ match: /go wrong/i, steps: [BAD_GATEWAY] }] },
	async (w) => {
		await openProject(w);
		await send(w, MESSAGE);
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: T });
		// Make the turn one that cannot be repeated, so Continue without this reply is offered.
		const ledgers = budgetFiles(w.home);
		assert.equal(ledgers.length, 1, "the turn has one durable ledger");
		const ledger = JSON.parse(readFileSync(ledgers[0], "utf8"));
		ledger.limit = 1000000;
		ledger.accounts.find((account) => account.id === ledger.rootAccountId).limit = 1000000;
		writeFileSync(ledgers[0], JSON.stringify(ledger));
		await w.page.reload();
		await expect(region.getByRole("button", { name: "Continue without this reply" })).toBeVisible({ timeout: T });
		await expect(bubbles(w, MESSAGE)).toHaveCount(1);
		await continueAndSendAgain(w, "project");
		await relaunch(w);
		await expect(w.page.getByText("The provider is back.")).toBeVisible({ timeout: T });
		await expect(bubbles(w, MESSAGE)).toHaveCount(1);
		await expect(w.page.getByText(NOTE)).toHaveCount(0);
		await shots(w, "project-restarted");
	},
);

flow(
	"a project message the person went on without keeps its bubble and its note",
	{ rules: [{ match: /go wrong/i, steps: [BAD_GATEWAY] }, { match: /different/i, steps: [{ text: "Answered differently." }] }] },
	async (w) => {
		await openProject(w);
		await send(w, MESSAGE);
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: T });
		const ledgers = budgetFiles(w.home);
		const ledger = JSON.parse(readFileSync(ledgers[0], "utf8"));
		ledger.limit = 1000000;
		ledger.accounts.find((account) => account.id === ledger.rootAccountId).limit = 1000000;
		writeFileSync(ledgers[0], JSON.stringify(ledger));
		await w.page.reload();
		await expect(region.getByRole("button", { name: "Continue without this reply" })).toBeVisible({ timeout: T });
		await send(w, "something different");
		await expect(w.page.getByText("Answered differently.")).toBeVisible({ timeout: T });
		await expect(bubbles(w, MESSAGE)).toHaveCount(1);
		await expect(w.page.getByText(NOTE)).toHaveCount(1);
	},
);
