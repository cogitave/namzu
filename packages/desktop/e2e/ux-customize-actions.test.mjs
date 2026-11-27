// The Customize page's actions against the real Electron app and the real CLI host: Upload skill,
// Create a skill, Remove skill and Add custom connector.
// Pictures go to $NAMZU_UX_OUT (default research/ux-customize-actions/), at 1440x960 and 900x900, in both themes.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-customize-actions.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const OUT = process.env.NAMZU_UX_OUT ?? resolve(repoRoot, "research/ux-customize-actions");
const SIZES = [
	{ name: "1440", width: 1440, height: 960 },
	{ name: "900", width: 900, height: 900 },
];

const resize = (w, width, height) =>
	w.app.evaluate(
		({ BrowserWindow }, size) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(size.width, size.height);
		},
		{ width, height },
	);

async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "dark") await expect(w.page.locator("html")).toHaveClass(/dark/);
	else await expect(w.page.locator("html")).not.toHaveClass(/dark/);
}

/** Nothing the page or a dialog draws may spill past its frame or leave the window sideways. */
async function fits(w, label) {
	const bad = await w.page.evaluate(() => {
		const out = [];
		const view = { width: window.innerWidth, height: window.innerHeight };
		const page = document.querySelector(".customize-page");
		if (page && page.scrollWidth > page.clientWidth + 1) out.push(`page scrolls sideways (${page.scrollWidth} > ${page.clientWidth})`);
		const frame = page?.getBoundingClientRect();
		const content = document.querySelector(".customize-content");
		if (frame && content)
			for (const el of content.querySelectorAll("*")) {
				const box = el.getBoundingClientRect();
				if (box.width === 0 || box.height === 0) continue;
				if (box.right > frame.right + 1 || box.left < frame.left - 1)
					out.push(`${el.className || el.tagName} leaves the page (${Math.round(box.left)}..${Math.round(box.right)})`);
			}
		const dialog = document.querySelector(".customize-dialog, .dialog-popup");
		if (dialog) {
			const box = dialog.getBoundingClientRect();
			if (box.left < 0 || box.right > view.width) out.push(`dialog leaves the window sideways (${Math.round(box.left)}..${Math.round(box.right)})`);
			if (box.top < 0 || box.bottom > view.height) out.push(`dialog leaves the window (${Math.round(box.top)}..${Math.round(box.bottom)} of ${view.height})`);
			for (const el of dialog.querySelectorAll("button, input, textarea, label, p")) {
				const b = el.getBoundingClientRect();
				if (b.width === 0 || b.height === 0) continue;
				if (b.right > box.right + 1 || b.left < box.left - 1) out.push(`${el.tagName} ${el.className} leaves the dialog`);
			}
		}
		return out.slice(0, 6);
	});
	assert.deepEqual(bad, [], `${label}: everything fits`);
}

/** One picture per size and theme of whatever is on screen, each checked for fit first. */
async function shoot(w, name, { toast = false } = {}) {
	mkdirSync(OUT, { recursive: true });
	// A notice from an earlier step would sit over the picture; only the picture of the notice keeps it.
	await w.page.evaluate((hide) => {
		document.getElementById("e2e-hide-toasts")?.remove();
		if (!hide) return;
		const style = document.createElement("style");
		style.id = "e2e-hide-toasts";
		style.textContent = ".toast-viewport { visibility: hidden !important; }";
		document.head.append(style);
	}, !toast);
	for (const size of SIZES) {
		await resize(w, size.width, size.height);
		for (const mode of ["dark", "light"]) {
			await theme(w, mode);
			await w.page.evaluate(async () => {
				document.querySelector(".customize-page")?.scrollTo(0, 0);
				await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			});
			await fits(w, `${name} ${size.name} ${mode}`);
			await w.page.screenshot({ path: join(OUT, `${name}-${size.name}-${mode}.png`) });
		}
	}
	await resize(w, 1440, 960);
	await theme(w, "dark");
	await w.page.evaluate(() => document.getElementById("e2e-hide-toasts")?.remove());
}

function find(root, name, depth = 6) {
	if (depth < 0 || !existsSync(root)) return [];
	const found = [];
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		if (entry === name || entry.startsWith(`${name}-`) || entry.startsWith(`${name}.`)) found.push(path);
		let dir = false;
		try {
			dir = statSync(path).isDirectory();
		} catch {}
		if (dir) found.push(...find(path, name, depth - 1));
	}
	return found;
}

const page = (w) => w.page.locator(".customize-page");
const nav = (w) => w.page.getByRole("navigation", { name: "Main navigation" });

function fixtures() {
	const dir = mkdtempSync(join(tmpdir(), "namzu-e2e-skills-"));
	const md = join(dir, "trip-helper.md");
	writeFileSync(md, ["---", "name: trip-helper", "description: Plan a short trip with a packing list.", "---", "# Trip helper", "", "Ask where and when, then list what to pack.", ""].join("\n"));
	const folder = join(dir, "pack-runner");
	mkdirSync(join(folder, "scripts"), { recursive: true });
	writeFileSync(join(folder, "SKILL.md"), ["---", "name: pack-runner", "description: Run the packing script for a trip.", "---", "# Pack runner", "", "Run scripts/pack.sh.", ""].join("\n"));
	writeFileSync(join(folder, "scripts/pack.sh"), "#!/bin/sh\necho packing\n", { mode: 0o755 });
	return { dir, picks: [md, folder] };
}

test("Customize actions: upload, create, remove a skill and add a custom connector", { timeout: 480000 }, async () => {
	const { picks } = fixtures();
	const world = await createWorld({
		env: { NAMZU_E2E_SKILL_PICK: JSON.stringify(picks) },
		files: {
			"namzu.config.json": JSON.stringify({ sandbox: { enabled: false } }),
		},
	});
	let failed = true;
	try {
		await launch(world);
		const w = world;
		await openProject(w);
		await nav(w).getByRole("button", { name: "Customize" }).click();
		await expect(page(w).getByRole("heading", { level: 1, name: "Customize" })).toBeVisible({ timeout: T });

		// The Add menu on Skills: the three ways, and no screen recorder.
		await page(w).getByRole("button", { name: "Add", exact: true }).click();
		for (const name of ["Upload skill", "Create a skill", "Create with Namzu"])
			await expect(w.page.getByRole("menuitem", { name })).toBeVisible({ timeout: T });
		assert.equal(await w.page.getByRole("menuitem", { name: "Record your screen" }).count(), 0);
		await shoot(w, "1-skills-add-menu");

		// Upload skill: the page, then two cards, one that runs commands.
		await w.page.getByRole("menuitem", { name: "Upload skill" }).click();
		await expect(page(w).getByRole("heading", { name: "Upload a skill" })).toBeVisible({ timeout: T });
		await expect(page(w).getByRole("button", { name: "Upload", exact: true })).toBeDisabled();
		await expect(page(w).getByText("Choose a file to continue.")).toBeVisible();
		await shoot(w, "2-upload-empty");
		await page(w).getByRole("button", { name: "browse" }).click();
		const cards = page(w).locator(".customize-stage");
		await expect(cards).toHaveCount(2, { timeout: T });
		const runner = cards.filter({ hasText: "pack-runner" });
		await expect(runner.getByText("Runs commands", { exact: true })).toBeVisible({ timeout: T });
		await expect(cards.filter({ hasText: "trip-helper" }).getByText("Runs commands")).toHaveCount(0);
		await expect(cards.filter({ hasText: "trip-helper" })).toContainText("1 file");
		// What it can run needs a yes of its own before Upload opens.
		await expect(page(w).getByRole("button", { name: "Upload", exact: true })).toBeDisabled();
		await shoot(w, "3-upload-cards");
		await runner.getByLabel("I trust what it can run").check();
		await expect(page(w).getByRole("button", { name: "Upload", exact: true })).toBeEnabled();
		await page(w).getByRole("button", { name: "Upload", exact: true }).click();
		await expect(w.page.getByText("Added 2 skills. They are available from your next message.")).toBeVisible({ timeout: T });
		await shoot(w, "3b-upload-toast", { toast: true });
		await expect(page(w).getByRole("heading", { level: 1, name: "Customize" })).toBeVisible({ timeout: T });
		await expect(page(w).getByRole("button", { name: "Open trip-helper" })).toBeVisible({ timeout: T });
		await expect(page(w).getByRole("button", { name: "Open pack-runner" })).toBeVisible({ timeout: T });
		assert.ok(existsSync(join(w.home, "skills", "trip-helper", "SKILL.md")), "the skill file is on disk");
		assert.ok(existsSync(join(w.home, "skills", "pack-runner", "scripts", "pack.sh")), "the script is on disk");
		await fits(w, "skills after upload");

		// Create a skill: fill the form, create, and land on the new skill.
		await page(w).getByRole("button", { name: "Add", exact: true }).click();
		await w.page.getByRole("menuitem", { name: "Create a skill" }).click();
		const dialog = w.page.getByRole("dialog", { name: "Create a skill" });
		await expect(dialog).toBeVisible({ timeout: T });
		await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
		await shoot(w, "4-create-empty");
		await dialog.getByLabel("Skill name").fill("Weekly status report");
		await expect(dialog.getByText("weekly-status-report")).toBeVisible();
		await dialog.getByLabel("Description").fill("Write the weekly status report from recent work.");
		await dialog.getByLabel("Instructions").fill("Summarize my recent work in three sections: wins, blockers, and next steps.");
		await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
		await shoot(w, "5-create-filled");
		await dialog.getByRole("button", { name: "Create", exact: true }).click();
		await expect(page(w).getByRole("heading", { name: "weekly-status-report" })).toBeVisible({ timeout: T });
		const made = join(w.home, "skills", "weekly-status-report", "SKILL.md");
		assert.ok(existsSync(made), "the new skill is on disk");
		assert.match(readFileSync(made, "utf8"), /Summarize my recent work/);
		await page(w).getByRole("button", { name: "Your skills" }).click();
		await expect(page(w).getByRole("button", { name: "Open weekly-status-report" })).toBeVisible({ timeout: T });

		// Remove a skill of your own through the confirm; the copy stays in the backups.
		await page(w).getByRole("button", { name: "Actions for trip-helper" }).click();
		await expect(w.page.getByRole("menuitem", { name: "Remove" })).toBeVisible();
		await shoot(w, "6-skill-row-menu");
		await w.page.getByRole("menuitem", { name: "Remove" }).click();
		const confirm = w.page.getByRole("alertdialog", { name: "Remove skill?" });
		await expect(confirm).toBeVisible({ timeout: T });
		await expect(confirm).toContainText('"trip-helper" will be removed from this computer. A copy is kept in Namzu\'s backups, so you can put it back.');
		await shoot(w, "7-remove-confirm");
		await confirm.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(page(w).getByRole("button", { name: "Open trip-helper" })).toHaveCount(0, { timeout: T });
		assert.ok(!existsSync(join(w.home, "skills", "trip-helper")), "the skill folder is gone");
		const backups = find(w.home, "trip-helper").filter((path) => !path.includes(`${join(w.home, "skills")}/`));
		assert.ok(backups.length > 0, `a backup copy exists (looked under ${w.home})`);
		// A built-in skill has no Remove.
		await page(w).getByRole("button", { name: "Open weekly-status-report" }).waitFor({ timeout: T });

		// Add custom connector: a name, an https address and a header reference.
		await page(w).getByRole("tab", { name: "Connectors" }).click();
		await page(w).getByRole("button", { name: "Add", exact: true }).click();
		await expect(w.page.getByRole("menuitem", { name: "Add custom connector" })).toBeVisible({ timeout: T });
		await w.page.getByRole("menuitem", { name: "Add custom connector" }).click();
		const connector = w.page.getByRole("dialog", { name: "Add custom connector" });
		await expect(connector).toBeVisible({ timeout: T });
		await shoot(w, "8-connector-empty");
		await connector.getByLabel("Name", { exact: true }).fill("tickets-remote");
		await connector.getByLabel("MCP server URL").fill("https://mcp.example.com/mcp");
		await connector.getByLabel("Header", { exact: true }).check();
		await connector.getByLabel("Header name").fill("Authorization");
		await connector.getByLabel("Header value").fill("Bearer ${EXAMPLE_TOKEN}");
		await shoot(w, "9-connector-filled");
		await connector.getByRole("button", { name: "Save", exact: true }).click();
		const row = page(w).getByRole("row", { name: /tickets-remote/ });
		await expect(row).toBeVisible({ timeout: T });
		await expect(row).toContainText("Remote");
		// It is the person's own entry, so nothing waits for an approval: the row says where it is set.
		await expect(row).toContainText("Your own settings");
		await expect(w.page.getByText("Added tickets-remote. It loads in new conversations.")).toBeVisible({ timeout: T });
		const saved = find(w.home, "config.yaml").concat(find(w.osHome, "config.yaml"), find(w.home, "namzu.config.json"));
		const holds = saved.some((path) => /EXAMPLE_TOKEN/.test(readFileSync(path, "utf8")));
		assert.ok(holds, `the header reference is saved (looked in ${saved.join(", ")})`);
		await fits(w, "connectors after add");
		await shoot(w, "10-connector-added");

		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} catch (error) {
		const said = await world.page?.locator("[role=alert], [role=dialog]").allInnerTexts().catch(() => []);
		console.error("window alerts:", JSON.stringify(said));
		throw error;
	} finally {
		await dispose(world, { failed });
	}
});
