// The Pal's computer row: the status text is the quiet action. At rest it reads the status
// ("Offline", "Connected"); on hover or keyboard focus the same spot reads the action ("Start
// Kiro", "Stop computer"). "This computer" sits directly under it. No paid model, no owner data.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-pal-computer-row.test.mjs
// Set PAL_ROW_SHOTS to a directory to keep the screenshots (900 and 1280 wide, dark and light).
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const SHOTS = process.env.PAL_ROW_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function size(world, width, height) {
	await world.app.evaluate(
		({ BrowserWindow }, [w, h]) => {
			for (const window of BrowserWindow.getAllWindows()) window.setSize(w, h);
		},
		[width, height],
	);
	await world.page.waitForTimeout(300);
}
/** One screenshot per width and colour scheme; `prepare` puts the page in the state to capture. */
async function shots(world, name, prepare) {
	if (!SHOTS) return;
	for (const width of [900, 1280]) {
		await size(world, width, 900);
		// Below 720px the Pal card is a button that opens the same body in a popover.
		const trigger = world.page.getByRole("button", { name: /^Show Kiro details/ });
		const compact = (await trigger.count()) > 0;
		if (compact) await trigger.click();
		for (const scheme of ["dark", "light"]) {
			await world.page.evaluate((next) => {
				localStorage.setItem("namzu.appearance", next);
				window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
			}, scheme);
			await expect(world.page.locator("html")).toHaveClass(
				scheme === "dark" ? /dark/ : /^(?!.*dark)/,
			);
			await prepare?.();
			await world.page.screenshot({ path: join(SHOTS, `${name}-${width}-${scheme}.png`) });
		}
		if (compact) await world.page.keyboard.press("Escape");
	}
	await size(world, 1440, 900);
}

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

const card = (world) => world.page.locator(".pal-context-body").first();
const box = async (locator) => {
	const rect = await locator.boundingBox();
	assert.ok(rect, "element has a box");
	return rect;
};

test(
	"Kiro's computer row: status at rest, action on hover and focus, This computer right under it",
	{ timeout: 280000 },
	async () => {
		const world = await createWorld({ rules: [], env: { NAMZU_E2E_PAL_COMPUTER: "fake" } });
		let failed = true;
		try {
			await launch(world);
			await size(world, 1440, 900);
			await openProject(world);
			const page = world.page;
			await createKiro(world);
			const context = card(world);
			await expect(context).toBeVisible({ timeout: 60000 });

			// The accessible name is the action; the visible text at rest is the status.
			const action = context.getByRole("button", { name: "Start Kiro" });
			await expect(action).toBeVisible({ timeout: 60000 });
			const rest = action.locator(".pal-status-rest");
			const hover = action.locator(".pal-status-hover");
			const entry = context.locator(".pal-computer-entry");
			await page.mouse.move(0, 0);
			await expect(rest).toHaveText("Offline");
			await expect(rest).toHaveCSS("opacity", "1");
			await expect(hover).toHaveCSS("opacity", "0");
			await expect(context.getByRole("status").filter({ hasText: "Offline" })).toHaveCount(1);
			// No visible outline button under the row.
			await expect(action).toHaveCSS("border-top-width", "0px");

			// The card can still be settling into place; measure once two reads agree.
			await expect(async () => {
				const first = await box(action);
				await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
				assert.deepEqual(await box(action), first);
			}).toPass();
			const restAction = await box(action);
			const restEntry = await box(entry);
			await shots(world, "offline-rest", () => page.mouse.move(0, 0));

			// (a) Hover reads the action in the same spot, with no layout shift.
			await action.hover();
			await expect(hover).toHaveText("Start Kiro");
			await expect(hover).toHaveCSS("opacity", "1");
			await expect(rest).toHaveCSS("opacity", "0");
			assert.deepEqual(await box(action), restAction, "the status button did not move or resize");
			assert.deepEqual(await box(entry), restEntry, "the row did not change size");
			await shots(world, "offline-hover", () => action.hover());
			await page.mouse.move(0, 0);

			// (c) This computer is directly under the Pal's computer row, with no note between.
			const host = context.locator(".pal-host-computer");
			await expect(host).toContainText("This computer");
			await expect(host).toContainText("Where Namzu is open");
			const between = await context.evaluate((root) => {
				const entryEl = root.querySelector(".pal-computer-entry");
				const hostEl = root.querySelector(".pal-host-computer");
				return entryEl?.nextElementSibling === hostEl;
			});
			assert.equal(between, true, "This computer follows the Pal's computer row in the DOM");
			const hostBox = await box(host);
			assert.ok(
				hostBox.y >= restEntry.y + restEntry.height - 1 && hostBox.y - (restEntry.y + restEntry.height) < 12,
				`This computer starts right under the row (gap ${hostBox.y - (restEntry.y + restEntry.height)})`,
			);
			const firstNote = context.locator(".pal-computer-entry ~ .pal-context-note").first();
			if (await firstNote.count()) assert.ok((await box(firstNote)).y >= hostBox.y + hostBox.height - 1);

			// (b) Keyboard focus shows the action, and Enter starts the computer.
			await page.keyboard.press("Shift");
			await action.focus();
			await expect(action).toBeFocused();
			await expect(hover).toHaveText("Start Kiro");
			await expect(hover).toHaveCSS("opacity", "1");
			assert.deepEqual(await box(action), restAction, "focus does not move the status button");
			await shots(world, "offline-focus", async () => {
				await page.keyboard.press("Shift");
				await action.focus();
			});
			await page.keyboard.press("Enter");

			// Connected: the status reads Connected, hover reads Stop computer.
			const stop = context.getByRole("button", { name: "Stop computer" });
			await expect(stop).toBeVisible({ timeout: 90000 });
			await page.mouse.move(0, 0);
			await expect(stop.locator(".pal-status-rest")).toHaveText("Connected");
			await stop.hover();
			await expect(stop.locator(".pal-status-hover")).toHaveText("Stop computer");
			await expect(stop.locator(".pal-status-hover")).toHaveCSS("opacity", "1");
			await shots(world, "connected-hover", () => stop.hover());
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);

const BODY = "Check the note in your workspace and tell me what it says.";
function messageRules(palId) {
	return [
		{
			match: /ask kiro to check the note/i,
			steps: [
				{ tool: "send_pal_message", args: { palId, body: BODY } },
				{ text: "I sent Kiro your request." },
			],
		},
	];
}
async function messageKiro(world) {
	const page = world.page;
	await page.getByRole("button", { name: "New conversation" }).first().click();
	await send(world, "Ask Kiro to check the note");
	const approval = page.getByRole("region", { name: "Tool approval" });
	await expect(approval).toBeVisible({ timeout: 60000 });
	await approval.getByRole("button", { name: /Accept/ }).click();
	const receipt = page.getByRole("list", { name: "Messages sent to Pals" });
	await receipt.getByRole("button", { name: "See it in Kiro’s messages" }).click();
	await page.keyboard.press("Escape");
}

for (const [label, env] of [
	["waiting message offers Start", { NAMZU_E2E_PAL_COMPUTER: "fake" }],
	["setup missing", undefined],
]) {
	test(
		`Kiro's computer row offers no action when ${label} (d)`,
		{ timeout: 280000 },
		async () => {
			const scripted = [];
			const world = await createWorld({ rules: scripted, env });
			let failed = true;
			try {
				await launch(world);
				await size(world, 1440, 900);
				await openProject(world);
				const page = world.page;
				const palId = await createKiro(world);
				scripted.push(...messageRules(palId));
				await messageKiro(world);
				const context = card(world);
				const waiting = page.getByRole("region", { name: "Waiting messages" });
				await expect(waiting).toContainText("1 unread message", { timeout: 60000 });
				const status = context.locator(".pal-computer-open .pal-computer-status");
				await expect(status).toHaveText("Offline");
				// Hovering the status shows no action: it is status text, not a button.
				await status.hover();
				await expect(context.locator(".pal-computer-action")).toHaveCount(0);
				await expect(status).toHaveText("Offline");
				await expect(context.locator(".pal-computer-entry").getByRole("button")).toHaveCount(1);
				if (env) {
					// The one Start is the message one.
					await expect(waiting.getByRole("button", { name: "Start Kiro" })).toBeEnabled();
					await expect(context.getByRole("button", { name: "Start Kiro" })).toHaveCount(1);
					await shots(world, "waiting-start", () => status.hover());
				} else {
					await expect(context).toContainText("cannot start yet", { timeout: 60000 });
					await expect(waiting.getByRole("button", { name: "Start Kiro" })).toBeDisabled();
					await expect(context.getByText("How to set up", { exact: true })).not.toHaveCount(0);
					await shots(world, "setup-missing", () => status.hover());
				}
				assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
				failed = false;
			} finally {
				await dispose(world, { failed });
			}
		},
	);
}
