// A failed reply ends with the same quiet action row as a settled reply, against the real Electron
// app, the real CLI host and a scripted model.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-failed-reply-row.test.mjs
// Pictures go to research/ux-20261010/failed-reply-row/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/ux-20261010/failed-reply-row");
const BAD_GATEWAY = {
	status: 502,
	contentType: "text/html",
	body: "<html><body>502 Bad Gateway</body></html>",
};

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
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

const box = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });
async function sendText(w, text) {
	await box(w).fill(text);
	await w.page.getByRole("button", { name: "Send message" }).click();
}
async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "light") await expect(w.page.locator("html")).not.toHaveClass(/dark/);
	else await expect(w.page.locator("html")).toHaveClass(/dark/);
}
async function resize(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, size) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(size.width, size.height);
		},
		{ width, height },
	);
	await expect
		.poll(() => w.page.evaluate(() => window.innerWidth), { timeout: T })
		.toBe(width);
}
/** Dark and light, at 1280 and 900 px. */
async function shots(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	for (const [width, height] of [
		[1280, 820],
		[900, 720],
	]) {
		await resize(w, width, height);
		for (const mode of ["dark", "light"]) {
			await theme(w, mode);
			await w.page.screenshot({ path: join(SHOTS, `${name}-${width}-${mode}.png`) });
		}
	}
	await theme(w, "dark");
	await resize(w, 1280, 820);
}

/** Centre line and left edges of the visible items of one row. */
async function rowItems(locator) {
	return locator.evaluate((row) => {
		const items = [];
		const add = (name, element) => {
			if (!element) return;
			const rect = element.getBoundingClientRect();
			items.push({ name, left: rect.left, right: rect.right, centre: rect.top + rect.height / 2 });
		};
		for (const element of row.querySelectorAll("button, time")) {
			const name = element.getAttribute("aria-label") || element.textContent?.trim() || "?";
			add(name, element);
		}
		return items;
	});
}
function assertOneLine(items, label) {
	assert.ok(items.length >= 3, `${label}: the row has its items`);
	const first = items[0].centre;
	for (const item of items)
		assert.ok(
			Math.abs(item.centre - first) <= 0.5,
			`${label}: "${item.name}" centre ${item.centre} is on the row's centre line ${first}`,
		);
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

flow(
	"a failed reply's row shares one centre line and the spacing of a settled reply's row",
	{
		rules: [
			{ match: /hello/i, steps: [{ text: "Scripted hello back." }] },
			{ match: /go wrong/i, steps: [BAD_GATEWAY] },
		],
	},
	async (w) => {
		await openProject(w);
		await sendText(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({ timeout: T });
		await w.page.getByText("Scripted hello back.").hover();
		const settledRow = w.page.locator(".message-actions").first();
		await expect(settledRow.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
		const settled = await rowItems(settledRow);
		const settledGap = settled[1].left - settled[0].right;
		await shots(w, "settled-reply");

		await sendText(w, "please go wrong");
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Retry", exact: true })).toBeVisible({
			timeout: T,
		});
		// No filled or outlined text buttons, no native disclosure marker.
		assert.equal(await region.locator("details, summary").count(), 0, "no native disclosure");
		const row = region.locator(".message-actions");
		const names = (await rowItems(row)).map((item) => item.name);
		assert.deepEqual(
			names.map((name) => (/^\d|^[A-Z][a-z]+ at/.test(name) ? "time" : name)).slice(0, 3),
			["time", "Retry", "Copy"],
		);
		const items = await rowItems(row);
		assertOneLine(items, "failed 502 row");
		const gap = items[2].left - items[1].right;
		assert.ok(Math.abs(gap - settledGap) <= 0.5, `icon spacing ${gap} equals the settled row's ${settledGap}`);
		const text = region.locator(".turn-recovery-text");
		const details = region.getByRole("button", { name: "Details", exact: true });
		await expect(details).toHaveAttribute("aria-expanded", "false");
		await expect(region.locator("time")).toHaveCount(1);
		await shots(w, "502");

		// Keyboard: Tab reaches the controls with a ring; Enter and Space open and close Details.
		await region.getByRole("button", { name: "Retry", exact: true }).focus();
		await w.page.keyboard.press("Tab");
		await expect(region.getByRole("button", { name: "Copy", exact: true })).toBeFocused();
		await w.page.keyboard.press("Tab");
		await expect(details).toBeFocused();
		const ring = await details.evaluate((node) => getComputedStyle(node).boxShadow);
		assert.notEqual(ring, "none", "a visible focus ring");
		await w.page.keyboard.press("Enter");
		await expect(details).toHaveAttribute("aria-expanded", "true");
		const detailText = region.locator(".turn-recovery-details-text");
		await expect(detailText).toBeVisible();
		const left = await text.evaluate((node) => node.getBoundingClientRect().left);
		const detailLeft = await detailText.evaluate((node) => node.getBoundingClientRect().left);
		assert.ok(Math.abs(left - detailLeft) <= 0.5, "details share the sentence's left edge");
		await shots(w, "502-details");
		await w.page.keyboard.press("Space");
		await expect(details).toHaveAttribute("aria-expanded", "false");
	},
);

flow(
	"a rejected key shows Open model settings as a quiet text action on the same line",
	{
		rules: [
			{
				match: /go wrong/i,
				steps: [
					{
						status: 401,
						body: JSON.stringify({
							error: { message: "Incorrect API key provided: sk-e2e***.", type: "invalid_request_error" },
						}),
					},
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await sendText(w, "please go wrong");
		const region = w.page.locator(".turn-recovery");
		const action = region.getByRole("button", { name: "Open model settings" });
		await expect(action).toBeVisible({ timeout: T });
		const items = await rowItems(region.locator(".message-actions"));
		assertOneLine(items, "rejected key row");
		await shots(w, "rejected-key");
	},
);

flow(
	"the limited case offers Continue without this reply in the same row",
	{ rules: [{ match: /go wrong/i, steps: [BAD_GATEWAY] }] },
	async (w) => {
		await openProject(w);
		await sendText(w, "please go wrong");
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Retry", exact: true })).toBeVisible({
			timeout: T,
		});
		const ledgers = budgetFiles(w.home);
		assert.equal(ledgers.length, 1, "the turn has one durable ledger");
		const ledger = JSON.parse(readFileSync(ledgers[0], "utf8"));
		ledger.limit = 1000000;
		ledger.accounts.find((account) => account.id === ledger.rootAccountId).limit = 1000000;
		writeFileSync(ledgers[0], JSON.stringify(ledger));
		await w.page.reload();
		const action = region.getByRole("button", { name: "Continue without this reply" });
		await expect(action).toBeVisible({ timeout: T });
		assertOneLine(await rowItems(region.locator(".message-actions")), "limited row");
		await shots(w, "limited");
	},
);
