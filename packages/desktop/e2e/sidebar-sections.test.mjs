// The sidebar's Pals, Projects and Recents headings fold at any count, remember it across a
// restart, keep the Projects + a separate button, toggle from the keyboard, and show a dot while
// folded when something inside needs the person. Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/sidebar-sections.test.mjs
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
const SHOTS = join(repoRoot, "research/sidebar-sections-20261009");
mkdirSync(SHOTS, { recursive: true });

const section = (w, label) => w.page.locator(`[data-sidebar-section="${label}"]`);
const toggle = (w, label) => section(w, label).locator(".sidebar-section-toggle");
const folded = (w, label) => expect(toggle(w, label)).toHaveAttribute("aria-expanded", "false");
const open = (w, label) => expect(toggle(w, label)).toHaveAttribute("aria-expanded", "true");

async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "dark") await expect(w.page.locator("html")).toHaveClass(/dark/);
	else await expect(w.page.locator("html")).not.toHaveClass(/dark/);
}
/** Both themes of the sidebar column at the default 1280 px window. */
async function shoot(w, name) {
	for (const mode of ["dark", "light"]) {
		await theme(w, mode);
		await w.page.screenshot({ path: join(SHOTS, `${name}-${mode}.png`) });
	}
	await theme(w, "dark");
}

test("the sidebar sections fold, remember it, and flag what needs attention", {
	timeout: 400000,
}, async () => {
	const rules = [];
	const w = await createWorld({ rules });
	let failed = true;
	try {
		await launch(w);
		const page = w.page;
		await expect(toggle(w, "Pals")).toBeVisible({ timeout: T });

		// No Pals yet: the heading still folds and takes the "Create your first Pal" row with it.
		const create = page.getByRole("button", { name: "Create your first Pal" });
		await expect(create).toBeVisible();
		await open(w, "Pals");
		await shoot(w, "1-expanded-no-pals");
		await toggle(w, "Pals").click();
		await folded(w, "Pals");
		await expect(create).toBeHidden();
		await shoot(w, "2-pals-collapsed-no-pals");
		await toggle(w, "Pals").click();
		await open(w, "Pals");
		await expect(create).toBeVisible();

		// The + belongs to the Projects heading but is its own button: it opens the menu and
		// leaves the section as it was.
		await section(w, "Projects").locator(".sidebar-add-project").click();
		await expect(page.getByRole("menuitem", { name: "Use an existing folder" })).toBeVisible();
		await open(w, "Projects");
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menuitem", { name: "Use an existing folder" })).toBeHidden();
		await open(w, "Projects");

		// Enter and Space both toggle.
		await toggle(w, "Projects").focus();
		await page.keyboard.press("Enter");
		await folded(w, "Projects");
		await page.keyboard.press("Space");
		await open(w, "Projects");

		await openProject(w);

		// One Pal: still foldable (it used to need more than three).
		await toggle(w, "Pals").click();
		await folded(w, "Pals");
		await toggle(w, "Pals").click();
		await open(w, "Pals");
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
		const palRow = section(w, "Pals").locator(".sidebar-pal-row", { hasText: "Işık" });
		await expect(palRow).toBeVisible();
		await shoot(w, "3-expanded-one-pal");
		await toggle(w, "Pals").click();
		await folded(w, "Pals");
		await expect(palRow).toBeHidden();
		// Folding closes no tab and changes no conversation.
		await expect(page.getByRole("tab", { name: "Işık" })).toBeVisible();
		await shoot(w, "4-pals-collapsed-one-pal");

		// A message to the Pal while the heading is folded puts a dot on the heading.
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
		const dot = section(w, "Pals").locator("[data-attention]");
		await expect(dot).toHaveCount(1, { timeout: T });
		await expect(dot).toHaveAttribute("title", "1 Pal has a new message");
		await expect(palRow).toBeHidden();
		await shoot(w, "5-pals-collapsed-with-dot");

		// Folding the project's own list sends its conversation to Recents, which folds too.
		await page
			.getByRole("button", { name: /^Collapse .* conversations$/ })
			.first()
			.click();
		await expect(toggle(w, "Recents")).toBeVisible({ timeout: T });
		await open(w, "Recents");
		await shoot(w, "6-recents-expanded");
		await toggle(w, "Recents").click();
		await folded(w, "Recents");
		await toggle(w, "Projects").click();
		await folded(w, "Projects");
		await shoot(w, "7-all-collapsed");

		// A restart keeps all three folded, and the Pal's marker too.
		await relaunch(w);
		await expect(toggle(w, "Pals")).toBeVisible({ timeout: T });
		await folded(w, "Pals");
		await folded(w, "Projects");
		await expect(section(w, "Pals").locator("[data-attention]")).toHaveCount(1, { timeout: T });
		assert.deepEqual(await w.page.evaluate(() => window.namzu.sidebarCollapsed()), [
			"pals",
			"projects",
			"recents",
		]);
		await shoot(w, "8-all-collapsed-after-restart");

		// Expanding is remembered too.
		await toggle(w, "Pals").click();
		await toggle(w, "Projects").click();
		await open(w, "Pals");
		await open(w, "Projects");
		await shoot(w, "9-reopened");
		assert.deepEqual(await w.page.evaluate(() => window.namzu.sidebarCollapsed()), ["recents"]);
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
