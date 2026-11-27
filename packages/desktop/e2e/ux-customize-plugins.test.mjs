// The Customize page's plugin actions against the real Electron app and the real CLI host: Add
// marketplace, Discover and the consent card, Yours, Check for updates, Turn off, Remove, Upload
// plugin and Create with Namzu, all from a marketplace folder built on disk.
// Pictures go to $NAMZU_UX_OUT (default research/ux-customize-plugins/), at 1440x960 and 900x900, in both themes.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-customize-plugins.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const OUT = process.env.NAMZU_UX_OUT ?? resolve(repoRoot, "research/ux-customize-plugins");
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

/** A zip that stores its files as they are: enough for the engine's reader, and no tool is needed to make it. */
function zipOf(files) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, text] of Object.entries(files)) {
		const nameBytes = Buffer.from(name);
		const data = Buffer.from(text);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(local, nameBytes, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const size = centrals.reduce((n, b) => n + b.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(size, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, ...centrals, end]);
}

const manifest = (name, version, description) => JSON.stringify({ name, version, description });
const skillText = (name) => `---\nname: ${name}\ndescription: Does ${name}.\n---\nBody.\n`;

function fixtures() {
	const dir = mkdtempSync(join(tmpdir(), "namzu-e2e-plugins-"));
	const market = join(dir, "team-tools");
	const put = (path, text) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	};
	put(
		join(market, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			name: "team-tools",
			owner: { name: "Team Tools" },
			plugins: [
				{ name: "ledger", source: "./plugins/ledger", description: "Keep the books and close the month." },
				{ name: "notes", source: "./plugins/notes", description: "Keep short notes next to a project." },
			],
		}),
	);
	const ledger = join(market, "plugins", "ledger");
	put(join(ledger, ".claude-plugin", "plugin.json"), manifest("ledger", "1.0.0", "Keep the books and close the month."));
	put(join(ledger, "skills", "reconcile", "SKILL.md"), skillText("reconcile"));
	put(
		join(ledger, "hooks", "hooks.json"),
		JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo ledger-guard" }] }] } }),
	);
	const notes = join(market, "plugins", "notes");
	put(join(notes, ".claude-plugin", "plugin.json"), manifest("notes", "0.3.0", "Keep short notes next to a project."));
	put(join(notes, "skills", "jot", "SKILL.md"), skillText("jot"));
	const zip = join(dir, "zipper.zip");
	writeFileSync(
		zip,
		zipOf({
			".claude-plugin/plugin.json": manifest("zipper", "2.0.0", "A plugin that arrived as a zip file."),
			"skills/pack/SKILL.md": skillText("pack"),
		}),
	);
	return { dir, market, ledger, zip };
}

test("Customize plugins: add a marketplace, discover, install, update, turn off, remove, upload", { timeout: 600000 }, async () => {
	const { market, ledger, zip } = fixtures();
	const world = await createWorld({
		env: { NAMZU_E2E_PLUGIN_PICK: JSON.stringify([zip]) },
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
		await page(w).getByRole("tab", { name: "Plugins" }).click();

		// The Add menu on Plugins: the three ways.
		await expect(page(w).getByRole("button", { name: "Add", exact: true })).toBeVisible({ timeout: T });
		await page(w).getByRole("button", { name: "Add", exact: true }).click();
		for (const name of ["Add marketplace", "Upload plugin", "Create with Namzu"])
			await expect(w.page.getByRole("menuitem", { name })).toBeVisible({ timeout: T });
		await shoot(w, "1-plugins-add-menu");

		// Add marketplace: the notice, the address, what it would add, then Add.
		await w.page.getByRole("menuitem", { name: "Add marketplace" }).click();
		const dialog = w.page.getByRole("dialog", { name: "Add marketplace" });
		await expect(dialog).toBeVisible({ timeout: T });
		await expect(dialog).toContainText("Only add marketplaces you trust.");
		await expect(dialog.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
		await expect(dialog).toContainText("Enter an address to continue.");
		await shoot(w, "2-marketplace-empty");
		// Escape closes the dialog and focus returns to the Add button that opened it.
		await w.page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0, { timeout: T });
		await expect(page(w).getByRole("button", { name: "Add", exact: true })).toBeFocused({ timeout: T });
		await page(w).getByRole("button", { name: "Add", exact: true }).click();
		await w.page.getByRole("menuitem", { name: "Add marketplace" }).click();
		await expect(dialog).toBeVisible({ timeout: T });
		await dialog.getByLabel("URL").fill(market);
		await expect(dialog.getByText(`Will add ${market}`)).toBeVisible({ timeout: T });
		await shoot(w, "3-marketplace-filled");
		await dialog.getByRole("button", { name: "Add", exact: true }).click();
		await expect(w.page.getByText('Marketplace "team-tools" added (2 plugins).')).toBeVisible({ timeout: T });

		// Discover: a card per plugin the marketplace offers; Yours | Discover is on the page now.
		const view = page(w).getByRole("group", { name: "Plugins view" });
		await expect(view.getByRole("button", { name: "Discover" })).toHaveAttribute("aria-pressed", "true", { timeout: T });
		const cards = page(w).locator(".customize-card-item");
		await expect(cards).toHaveCount(2, { timeout: T });
		await expect(cards.filter({ hasText: "ledger" })).toContainText("from team-tools");
		await shoot(w, "4-discover");

		// The + opens the consent sheet: what it adds, what runs, the digest; Install is the consent.
		await page(w).getByRole("button", { name: "Add ledger" }).click();
		const sheet = w.page.getByRole("dialog", { name: "Add ledger" });
		await expect(sheet.getByTestId("consent-card")).toBeVisible({ timeout: T });
		await expect(sheet).toContainText("This plugin adds");
		await expect(sheet).toContainText("Skills: ledger__reconcile");
		await expect(sheet).toContainText("Runs on this computer");
		await expect(sheet).toContainText("echo ledger-guard");
		await expect(sheet).toContainText("Plugins run code on your computer, with access to your files. Install only what you trust.");
		await shoot(w, "5-consent-sheet");
		const loading = sheet.getByLabel("Turn on plugin loading (needed for plugins to run)");
		if (await loading.count()) await loading.check();
		await sheet.getByRole("button", { name: "Install", exact: true }).click();
		await expect(sheet).toHaveCount(0, { timeout: T });
		await expect(page(w).getByRole("button", { name: "Add ledger" })).toHaveCount(0, { timeout: T });
		await expect(page(w).getByRole("img", { name: "ledger is installed" })).toBeVisible({ timeout: T });
		assert.ok(existsSync(join(w.home, "plugins")) || readdirSync(w.home).length > 0, "the plugin was written under the Namzu home");

		// Yours: the plugin under its marketplace, and the Marketplaces list.
		await view.getByRole("button", { name: "Yours" }).click();
		const ledgerRow = page(w).getByRole("button", { name: "Open ledger" });
		await expect(ledgerRow).toBeVisible({ timeout: T });
		await expect(page(w).getByRole("region", { name: "From team-tools plugins" })).toBeVisible();
		await expect(page(w).getByRole("region", { name: "Marketplaces" })).toContainText("team-tools");
		await shoot(w, "6-yours");

		// Check for updates after a version bump on disk.
		writeFileSync(join(ledger, ".claude-plugin", "plugin.json"), manifest("ledger", "1.1.0", "Keep the books and close the month."));
		await page(w).getByRole("button", { name: "Actions for ledger" }).click();
		for (const name of ["Turn off", "Check for updates", "Details", "Remove"])
			await expect(w.page.getByRole("menuitem", { name })).toBeVisible({ timeout: T });
		await shoot(w, "7-plugin-row-menu");
		await w.page.getByRole("menuitem", { name: "Check for updates" }).click();
		await expect(page(w).getByText("Version 1.1.0 is available")).toBeVisible({ timeout: T });
		await shoot(w, "8-update-available");
		await page(w).getByRole("button", { name: "Actions for ledger" }).click();
		await w.page.getByRole("menuitem", { name: "Update", exact: true }).click();
		await expect(w.page.getByText(/Updated team-tools|Updated ledger@team-tools|ledger@team-tools from 1.0.0 to 1.1.0/).first()).toBeVisible({ timeout: T });
		await expect(page(w).getByText("Version 1.1.0 is available")).toHaveCount(0, { timeout: T });

		// Details: the plugin's own page, with the same menu.
		await ledgerRow.click();
		await expect(page(w).getByRole("heading", { name: "ledger" })).toBeVisible({ timeout: T });
		await shoot(w, "9-plugin-detail");
		await page(w).getByRole("button", { name: "Your plugins" }).click();

		// Turn off: a confirm, then the saved record says off.
		await page(w).getByRole("button", { name: "Actions for ledger" }).click();
		await w.page.getByRole("menuitem", { name: "Turn off" }).click();
		const off = w.page.getByRole("alertdialog", { name: 'Turn off "ledger"?' });
		await expect(off).toContainText("Its skills, commands and servers stop being offered in new conversations.");
		await shoot(w, "10-turn-off-confirm");
		await off.getByRole("button", { name: "Turn off", exact: true }).click();
		await expect(w.page.getByText("Turned off ledger")).toBeVisible({ timeout: T });
		await expect(page(w).locator(".customize-row", { hasText: "ledger" }).getByText("Off", { exact: true })).toBeVisible({ timeout: T });
		await page(w).getByRole("button", { name: "Actions for ledger" }).click();
		await expect(w.page.getByRole("menuitem", { name: "Turn on" })).toBeVisible({ timeout: T });
		await w.page.keyboard.press("Escape");

		// Remove: the dialog with its data checkbox.
		await page(w).getByRole("button", { name: "Actions for ledger" }).click();
		await w.page.getByRole("menuitem", { name: "Remove" }).click();
		const remove = w.page.getByRole("dialog", { name: "Remove plugin?" });
		await expect(remove).toContainText('"ledger" will be removed from this computer. You can add it again from its marketplace.');
		await remove.getByLabel("Also delete its saved data").check();
		await shoot(w, "11-remove-plugin");
		await remove.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(w.page.getByText("Removed ledger.")).toBeVisible({ timeout: T });
		await expect(page(w).getByRole("button", { name: "Open ledger" })).toHaveCount(0, { timeout: T });

		// Upload plugin: the page, a zip through the test hook, the consent card, Install.
		await page(w).getByRole("button", { name: "Add", exact: true }).click();
		await w.page.getByRole("menuitem", { name: "Upload plugin" }).click();
		await expect(page(w).getByRole("heading", { name: "Upload a plugin" })).toBeVisible({ timeout: T });
		await expect(page(w).getByRole("button", { name: "Install", exact: true })).toBeDisabled();
		await expect(page(w).getByText("Choose a file to continue.")).toBeVisible();
		await shoot(w, "12-upload-empty");
		await page(w).getByRole("button", { name: "browse" }).click();
		const card = page(w).getByTestId("consent-card");
		await expect(card).toBeVisible({ timeout: T });
		await expect(card).toContainText("zipper");
		await expect(card).toContainText("Skills: zipper__pack");
		await shoot(w, "13-upload-consent");
		const uploadLoading = page(w).getByLabel("Turn on plugin loading (needed for plugins to run)");
		if (await uploadLoading.count()) await uploadLoading.check();
		await page(w).getByRole("button", { name: "Install", exact: true }).click();
		await expect(page(w).getByRole("heading", { level: 1, name: "Customize" })).toBeVisible({ timeout: T });
		await expect(page(w).getByRole("button", { name: "Open zipper" })).toBeVisible({ timeout: T });
		await expect(page(w).getByRole("region", { name: "Uploaded plugins" })).toBeVisible();
		await shoot(w, "14-uploaded");
		// An upload has no source to compare with: the check says why.
		await page(w).getByRole("button", { name: "Actions for zipper" }).click();
		const check = w.page.getByRole("menuitem", { name: "Check for updates" });
		await expect(check).toBeDisabled();
		await expect(check).toHaveAttribute("title", /no source/);
		await w.page.keyboard.press("Escape");

		// Remove the marketplace: the notice names what goes with it.
		await page(w).getByRole("button", { name: "Actions for marketplace team-tools" }).click();
		await expect(w.page.getByRole("menuitem", { name: "Update now" })).toBeVisible({ timeout: T });
		await shoot(w, "15-marketplace-menu");
		await w.page.getByRole("menuitem", { name: "Remove" }).click();
		const dropMarket = w.page.getByRole("dialog", { name: "Remove marketplace?" });
		await expect(dropMarket).toBeVisible({ timeout: T });
		await dropMarket.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(w.page.getByText('Marketplace "team-tools" removed.')).toBeVisible({ timeout: T });
		await expect(page(w).getByRole("region", { name: "Marketplaces" })).toHaveCount(0, { timeout: T });
		await expect(page(w).getByRole("group", { name: "Plugins view" })).toHaveCount(0);

		// Create with Namzu: a new conversation with the request in the box, not sent.
		await page(w).getByRole("button", { name: "Add", exact: true }).click();
		await w.page.getByRole("menuitem", { name: "Create with Namzu" }).click();
		const box = w.page.getByRole("textbox", { name: "Message Namzu" });
		await expect(box).toHaveValue(/Help me create a new Namzu plugin\./, { timeout: T });
		await shoot(w, "16-create-with-namzu");

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
