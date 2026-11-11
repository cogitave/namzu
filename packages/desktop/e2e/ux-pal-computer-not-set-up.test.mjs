// A Pal's computer on a PC with no container engine: the screen reads it once, shows one setup card
// and does not ask again until the person comes back to the window. No paid model, no owner data.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-pal-computer-not-set-up.test.mjs
// NAMZU_E2E_SHOTS=<dir> saves the screenshots there.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject } from "./harness.mjs";

const SHOTS = process.env.NAMZU_E2E_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (world, name) => {
	if (SHOTS) await world.page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

async function createKiro(world) {
	const page = world.page;
	await expect(async () => {
		await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 60000 });
	await expect(async () => {
		const dialog = page.getByRole("dialog", { name: "Customize your Pal" });
		if (
			!(await dialog.isVisible()) &&
			!(await page.getByRole("button", { name: "Customize your Pal" }).isVisible())
		)
			await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		if (!(await dialog.isVisible()))
			await page.getByRole("button", { name: "Customize your Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("dialog", { name: "Customize your Pal" })).toBeVisible({
			timeout: 2000,
		});
	}).toPass({ timeout: 60000 });
	const customize = page.getByRole("dialog", { name: "Customize your Pal" });
	await customize.getByRole("textbox", { name: "Pal name" }).fill("Kiro");
	await customize.getByRole("textbox", { name: "Pal name" }).press("Enter");
	await expect(page.getByRole("tab", { name: "Kiro" })).toBeVisible({ timeout: 60000 });
	return readdirSync(join(world.home, "pals"))[0];
}

/** Counts every read of the Pal's computer that reaches the main process. */
async function countReads(world) {
	await world.app.evaluate(({ ipcMain }) => {
		const channel = "namzu:palComputer";
		const original = ipcMain._invokeHandlers.get(channel);
		globalThis.__computerReads = 0;
		ipcMain._invokeHandlers.set(channel, (...args) => {
			globalThis.__computerReads += 1;
			return original(...args);
		});
	});
}
const reads = (world) => world.app.evaluate(() => globalThis.__computerReads);
// A round trip on another channel: IPC from one window arrives in order, so once it answers every
// read the page had already sent has been counted.
const flush = (world) => world.page.evaluate(() => window.namzu.palComputerSetup(false));

test(
	"a Pal's computer that is not set up: one setup card, one read, no repeating failure",
	{ timeout: 280000 },
	async () => {
		const world = await createWorld({ rules: [] });
		let failed = true;
		try {
			await launch(world);
			await world.app.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.setSize(1280, 820);
			});
			await world.page.emulateMedia({ colorScheme: "dark" });
			// The page's clock is its own from here on, so the test moves time instead of waiting for it.
			await world.page.clock.install();
			await world.page.reload();
			await openProject(world);
			await countReads(world);
			await createKiro(world);
			const page = world.page;
			await expect(page.getByText(/needs Docker Desktop or Podman/).first()).toBeVisible({
				timeout: 60000,
			});
			await shot(world, "pal-page");
			assert.ok((await reads(world)) >= 1, "the computer was read at least once");
			// The computer page itself: the one setup card where the live screen would be.
			await page.getByRole("button", { name: /^Open Kiro’s computer$/ }).click();
			await expect(page.getByText(/Computer is offline|Set up Kiro’s computer/).first()).toBeVisible({
				timeout: 60000,
			});
			await shot(world, "computer-page");
			await expect(page.locator("[data-setup-card]")).toContainText("about 1.2 GB of disk");
			await expect(page.getByRole("region", { name: "Set up Kiro’s computer" })).toBeVisible();
			// Nothing else is asked by the app itself: ten minutes pass on the page's own clock (every
			// timer it holds fires), and the count of reads stays where it was.
			await flush(world);
			const settled = await reads(world);
			await page.clock.fastForward("10:00");
			await flush(world);
			const later = await reads(world);
			assert.equal(
				later,
				settled,
				`no read repeated while the computer is not set up (${settled} -> ${later})`,
			);
			// The diagnostic log holds no failure that repeats for this computer.
			const log = readFileSync(join(world.userData, "logs", "desktop.ndjson"), "utf8")
				.split("\n")
				.filter((line) => /palComputer/.test(line));
			const repeated = new Map();
			for (const line of log) {
				const entry = JSON.parse(line);
				const key = `${entry.event ?? entry.kind}:${entry.operation ?? ""}:${entry.error?.message ?? ""}`;
				repeated.set(key, (repeated.get(key) ?? 0) + 1);
			}
			assert.ok(
				[...repeated.values()].every((count) => count <= 1),
				`the log shows no repeated failure: ${JSON.stringify([...repeated])}`,
			);
			// The card's action works from the keyboard and shows the focus ring.
			await page.evaluate(() => {
				window.__opened = 0;
				window.addEventListener(
					"click",
					(event) => {
						if (event.target instanceof Element && event.target.closest("[data-setup-card] button")) {
							window.__opened += 1;
							event.stopImmediatePropagation();
						}
					},
					true,
				);
			});
			const docker = page.locator("[data-setup-card]").getByRole("button", { name: "Get Docker Desktop" });
			await expect(docker).toBeVisible();
			// Reached by the keyboard (a script's focus() alone does not show the ring).
			await docker.focus();
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Tab");
			await expect(docker).toBeFocused();
			assert.ok(
				await docker.evaluate((node) => {
					const style = getComputedStyle(node);
					return style.boxShadow !== "none" || style.outlineStyle !== "none";
				}),
				"the focused button shows a focus ring",
			);
			await shot(world, "computer-page-focus");
			await page.keyboard.press("Enter");
			assert.equal(await page.evaluate(() => window.__opened), 1, "Enter presses the button");
			// The light theme: the card reads the same way.
			const appearance = (name) =>
				page.evaluate((value) => {
					localStorage.setItem("namzu.appearance", value);
					window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
				}, name);
			await appearance("light");
			await expect(async () => {
				const [r] = (await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
					.match(/\d+/g)
					.map(Number);
				assert.ok(r > 200, "the page is light");
			}).toPass({ timeout: 10000 });
			await shot(world, "computer-page-light");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);

test(
	"a stopped Podman machine: the card says to start the machine and offers no download",
	{ timeout: 280000 },
	async () => {
		const world = await createWorld({ rules: [] });
		let failed = true;
		try {
			await launch(world);
			await world.app.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.setSize(1280, 820);
			});
			await world.page.emulateMedia({ colorScheme: "dark" });
			await openProject(world);
			// The host answers as it does when Podman is installed and its machine is stopped.
			await world.app.evaluate(({ ipcMain }) => {
				const channel = "namzu:palComputer";
				const original = ipcMain._invokeHandlers.get(channel);
				ipcMain._invokeHandlers.set(channel, async (...args) => ({
					...(await original(...args)),
					status: "unavailable",
					notice: "The Podman machine is stopped.",
				}));
			});
			await createKiro(world);
			const page = world.page;
			await expect(page.getByText(/your Podman machine is not running/).first()).toBeVisible({
				timeout: 60000,
			});
			await expect(page.getByText(/needs Docker Desktop or Podman/)).toHaveCount(0);
			await shot(world, "podman-pal-page");
			await page.getByRole("button", { name: /^Open Kiro’s computer$/ }).click();
			const card = page.locator("[data-setup-card]");
			await expect(card).toContainText("Start your Podman machine", { timeout: 60000 });
			assert.equal(await card.getByRole("button", { name: "Get Docker Desktop" }).count(), 0);
			await shot(world, "podman-computer-page");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);
