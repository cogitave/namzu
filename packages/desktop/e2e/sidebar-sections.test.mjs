// Up to three Pals have no heading and sit directly under "New conversation"; four make a foldable
// "Pals" group that remembers its state across a restart and shows a dot while folded when a Pal
// has a message. Projects folds (its + is a separate button); Recents never folds.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/sidebar-sections.test.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
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
const SHOTS = join(repoRoot, "research/sidebar-sections-20261009b");
mkdirSync(SHOTS, { recursive: true });

const section = (w, label) => w.page.locator(`[data-sidebar-section="${label}"]`);
const toggle = (w, label) => section(w, label).locator(".sidebar-section-toggle");
const folded = (w, label) => expect(toggle(w, label)).toHaveAttribute("aria-expanded", "false");
const open = (w, label) => expect(toggle(w, label)).toHaveAttribute("aria-expanded", "true");
const palRows = (w) => w.page.locator(".sidebar-pals .sidebar-pal-row:not(.sidebar-pal-create)");

async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "dark") await expect(w.page.locator("html")).toHaveClass(/dark/);
	else await expect(w.page.locator("html")).not.toHaveClass(/dark/);
}
/** Both themes of the window at the default 1280 px width. */
async function shoot(w, name) {
	for (const mode of ["dark", "light"]) {
		await theme(w, mode);
		await w.page.screenshot({ path: join(SHOTS, `${name}-${mode}.png`) });
	}
	await theme(w, "dark");
}

/** Makes Pals through the app's own create call, then restarts so the sidebar reads the list. */
async function addPals(w, names) {
	for (const name of names)
		await w.page.evaluate((value) => window.namzu.createPal({ name: value }), name);
	await relaunch(w);
	await expect(w.page.getByRole("button", { name: "New conversation" }).first()).toBeVisible({
		timeout: T,
	});
}
/** No "Pals" heading, group, toggle or chevron; the rows sit between New conversation and Projects. */
async function noPalsGroup(w, count) {
	await expect(palRows(w)).toHaveCount(count, { timeout: T });
	await expect(section(w, "Pals")).toHaveCount(0);
	await expect(w.page.locator(".sidebar-pals .sidebar-section-toggle")).toHaveCount(0);
	await expect(w.page.locator(".sidebar-pals h2")).toHaveCount(0);
	await expect(w.page.getByRole("heading", { name: "Pals", exact: true })).toHaveCount(0);
	const order = await w.page.evaluate(() => {
		const y = (el) => el.getBoundingClientRect().top;
		const nc = [...document.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("New conversation"),
		);
		const first = document.querySelector(".sidebar-pals .sidebar-pal-row");
		const projects = document.querySelector('[data-sidebar-section="Projects"]');
		return { nc: y(nc), first: y(first), projects: y(projects) };
	});
	assert.ok(order.nc < order.first && order.first < order.projects, JSON.stringify(order));
}

test("Pals have no group up to three, a foldable one at four, and Recents never folds", {
	timeout: 600000,
}, async () => {
	const rules = [];
	const w = await createWorld({ rules });
	let failed = true;
	try {
		await launch(w);
		const page = w.page;
		await expect(section(w, "Projects")).toBeVisible({ timeout: T });

		// 0 Pals: the create row sits directly under New conversation, with no heading.
		await expect(page.getByRole("button", { name: "Create your first Pal" })).toBeVisible();
		await noPalsGroup(w, 0);
		await shoot(w, "0-pals");

		// The + belongs to the Projects heading but is its own button.
		await section(w, "Projects").locator(".sidebar-add-project").click();
		await expect(page.getByRole("menuitem", { name: "Use an existing folder" })).toBeVisible();
		await open(w, "Projects");
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menuitem", { name: "Use an existing folder" })).toBeHidden();
		await open(w, "Projects");
		// Enter and Space both fold Projects.
		await toggle(w, "Projects").focus();
		await page.keyboard.press("Enter");
		await folded(w, "Projects");
		await page.keyboard.press("Space");
		await open(w, "Projects");

		await openProject(w);

		// 1 Pal, made through the app's own screens: still no group.
		await page.getByRole("button", { name: "Create your first Pal" }).click();
		const name = page.getByRole("textbox", { name: "Pal name" });
		await expect(async () => {
			if (!(await page.getByRole("dialog", { name: "Customize your Pal" }).isVisible()))
				await page.getByRole("button", { name: "Customize your Pal" }).click({ timeout: 2000 });
			await expect(name).toBeVisible({ timeout: 2000 });
		}).toPass({ timeout: T });
		await name.fill("Işık");
		await name.press("Enter");
		await expect(page.getByRole("tab", { name: "Işık" })).toBeVisible({ timeout: T });
		await expect(page.getByText("Ready to chat")).toBeVisible({ timeout: T });
		await noPalsGroup(w, 1);
		await shoot(w, "1-pal");

		// 3 Pals: still no group.
		await addPals(w, ["Bora", "Deniz"]);
		await noPalsGroup(w, 3);
		await shoot(w, "3-pals");

		// 4 Pals: the foldable group appears, folds without closing a tab, and shows a dot.
		await addPals(w, ["Ece"]);
		await open(w, "Pals");
		await expect(palRows(w)).toHaveCount(4);
		await shoot(w, "4-pals");
		const palRow = section(w, "Pals").locator(".sidebar-pal-row", { hasText: "Işık" });
		await toggle(w, "Pals").click();
		await folded(w, "Pals");
		await expect(palRow).toBeHidden();
		await shoot(w, "4-pals-folded");

		// A message to the Pal while the group is folded puts a dot on its heading.
		const palId = (await w.page.evaluate(() => window.namzu.pals())).find((p) => p.name === "Işık").id;
		rules.push({
			match: /ask the pal/i,
			steps: [
				{ tool: "send_pal_message", args: { palId, body: "Please summarise the README." } },
				{ text: "I sent your Pal the request." },
			],
		});
		await w.page.getByRole("button", { name: "New conversation" }).first().click();
		await send(w, "Ask the Pal to summarise the README");
		const approval = w.page.getByRole("region", { name: "Tool approval" });
		await expect(approval).toBeVisible({ timeout: T });
		await approval.getByRole("button", { name: /Accept/ }).click();
		const dot = section(w, "Pals").locator("[data-attention]");
		await expect(dot).toHaveCount(1, { timeout: T });
		await expect(dot).toHaveAttribute("title", "1 Pal has a new message");

		// Recents has a plain heading: no toggle, no chevron, and it is not a foldable section.
		await w.page
			.getByRole("button", { name: /^Collapse .* conversations$/ })
			.first()
			.click();
		const recents = w.page.locator("section.sidebar-recents");
		await expect(recents.getByRole("heading", { name: "Recents" })).toBeVisible({ timeout: T });
		await expect(recents.locator(".sidebar-section-toggle")).toHaveCount(0);
		await expect(recents.locator("[aria-expanded]")).toHaveCount(0);
		await expect(section(w, "Recents")).toHaveCount(0);
		await shoot(w, "recents-plain");

		// Fold Projects too; a restart keeps both folded and nothing else.
		await toggle(w, "Projects").click();
		await folded(w, "Projects");
		await relaunch(w);
		await expect(toggle(w, "Pals")).toBeVisible({ timeout: T });
		await folded(w, "Pals");
		await folded(w, "Projects");
		await expect(section(w, "Pals").locator("[data-attention]")).toHaveCount(1, { timeout: T });
		assert.deepEqual(await w.page.evaluate(() => window.namzu.sidebarCollapsed()), [
			"pals",
			"projects",
		]);
		await shoot(w, "4-pals-folded-after-restart");

		// Opening again is remembered too.
		await toggle(w, "Pals").click();
		await toggle(w, "Projects").click();
		await open(w, "Pals");
		await open(w, "Projects");
		assert.deepEqual(await w.page.evaluate(() => window.namzu.sidebarCollapsed()), []);
		await relaunch(w);
		await expect(toggle(w, "Pals")).toBeVisible({ timeout: T });
		await open(w, "Pals");
		await open(w, "Projects");

		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
