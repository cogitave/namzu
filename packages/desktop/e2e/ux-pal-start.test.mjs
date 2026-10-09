// Starting a Pal from a conversation, with the person's go: a message to an idle Pal, the
// question under it, Start, and what the Pal's own tab shows. No paid model, no owner data.
// The success flow runs the real CLI host and the real dispatch over a recorder computer (see
// cli-entry.mjs); the other flow runs with no container engine, as on most machines.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-pal-start.test.mjs
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
	repoRoot,
	send,
} from "./harness.mjs";

const SHOTS = join(repoRoot, "research/pal-wake-20261009");
mkdirSync(SHOTS, { recursive: true });
async function size(world, width, height) {
	await world.app.evaluate(
		({ BrowserWindow }, [w, h]) => {
			for (const window of BrowserWindow.getAllWindows()) window.setSize(w, h);
		},
		[width, height],
	);
	await world.page.waitForTimeout(300);
}
/** Model requests made by Kiro's own run: they carry the message but not the sender's conversation. */
const palRequests = (world) =>
	world.model.requests.filter((request) => {
		const text = JSON.stringify(request.messages ?? []);
		return /check the note in your workspace/i.test(text) && !/Ask Kiro to check the note/.test(text);
	});
const shot = (world, name) => world.page.screenshot({ path: join(SHOTS, `${name}.png`) });

const BODY = "Check the note in your workspace and tell me what it says.";

async function createKiro(world) {
	const page = world.page;
	await expect(async () => {
		await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 60000 });
	await expect(async () => {
		const dialog = page.getByRole("dialog", { name: "Customize your Pal" });
		// The project's own first screen can still land after the Pals page opened and replace it;
		// opening the page again is the same click a person would make.
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

/** From the Pal's page to a fresh conversation that sends one approved message to Kiro. */
async function messageKiro(world) {
	const page = world.page;
	await page.getByRole("button", { name: "New conversation" }).first().click();
	await send(world, "Ask Kiro to check the note");
	const approval = page.getByRole("region", { name: "Tool approval" });
	await expect(approval).toBeVisible({ timeout: 60000 });
	await approval.getByRole("button", { name: /Accept/ }).click();
	return page.getByRole("list", { name: "Messages sent to Pals" });
}

function rules(palId) {
	return [
		{
			match: /ask kiro to check the note/i,
			steps: [
				{ tool: "send_pal_message", args: { palId, body: BODY } },
				{ text: "I sent Kiro your request." },
			],
		},
		{ match: /check the note in your workspace/i, steps: [{ text: "The note says: all clear." }] },
	];
}

test(
	"Start Kiro: the question under the send, the run on Kiro's own computer, and Kiro's own tab",
	{ timeout: 280000 },
	async () => {
		const scripted = [];
		const world = await createWorld({ rules: scripted, env: { NAMZU_E2E_PAL_COMPUTER: "fake" } });
		let failed = true;
		try {
			await launch(world);
			await size(world, 1440, 900);
			await openProject(world);
			const page = world.page;
			const palId = await createKiro(world);
			scripted.push(...rules(palId));
			const receipt = await messageKiro(world);

			// The tool returned its receipt: the question is its own card and the sender is not held.
			await expect(receipt).toContainText(
				"Kiro is not running. Start Kiro to let it read your message on its own computer.",
				{ timeout: 60000 },
			);
			await expect(receipt.getByRole("button", { name: "Start Kiro" })).toBeVisible();
			await expect(receipt.getByRole("button", { name: "Not now" })).toBeVisible();
			const composer = page.getByRole("textbox", { name: "Message Namzu" });
			await composer.fill("still typing while Kiro waits");
			await expect(composer).toBeEnabled();
			await composer.fill("");
			assert.equal(
				palRequests(world).length > 0,
				false,
				"nothing started Kiro before the click",
			);
			await shot(world, "01-question-1440");

			await receipt.getByRole("button", { name: "Start Kiro" }).click();
			// Kiro's run reads the message on its computer; the card follows it to the end.
			await expect(receipt).toContainText("Kiro read your message.", { timeout: 90000 });
			await expect(receipt.getByRole("button", { name: "Open Kiro" })).toBeVisible();
			await expect(receipt.getByRole("button", { name: "Start Kiro" })).toHaveCount(0);
			await shot(world, "02-read-1440");
			assert.equal(palRequests(world).length >= 1, true, "Kiro's own run read the message");

			// Kiro's own tab shows what it did, in Kiro's own conversation.
			await receipt.getByRole("button", { name: "Open Kiro" }).click();
			await expect(page.getByText("The note says: all clear.")).toBeVisible({ timeout: 60000 });
			await shot(world, "03-kiro-tab-1440");
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);

test(
	"Start Kiro with no computer: Start is switched off with what is missing, never a start that fails",
	{ timeout: 280000 },
	async () => {
		const scripted = [];
		const world = await createWorld({ rules: scripted });
		let failed = true;
		try {
			await launch(world);
			await size(world, 1440, 900);
			await openProject(world);
			const page = world.page;
			const palId = await createKiro(world);
			scripted.push(...rules(palId));
			const receipt = await messageKiro(world);
			// No container engine here: the offer says what is missing, in plain words, and Start is off.
			await expect(receipt).toContainText("Kiro’s computer cannot start yet", { timeout: 60000 });
			await expect(receipt).toContainText("needs Docker Desktop or Podman");
			await expect(receipt.getByRole("button", { name: "Start Kiro" })).toBeDisabled();
			await receipt.getByText("How to set up", { exact: true }).click();
			await expect(receipt.locator(".pal-setup-help p")).toContainText("Namzu computer image");
			await shot(world, "04-blocked-offer-1440");

			// The Pal's own page says the same, with the same single Start.
			await receipt.getByRole("button", { name: "See it in Kiro’s messages" }).click();
			await page.keyboard.press("Escape");
			const waiting = page.getByRole("region", { name: "Waiting messages" });
			await expect(waiting).toContainText("1 unread message", { timeout: 60000 });
			await expect(waiting).toContainText("cannot start yet");
			await expect(waiting.getByRole("button", { name: "Start Kiro" })).toBeDisabled();
			await waiting.getByText("How to set up", { exact: true }).click();
			const text = await waiting.innerText();
			assert.doesNotMatch(text, /Dockerfile|packages\/|ECONN|Error:|at \S+\.js/);
			await shot(world, "05-no-computer-1440");
			assert.equal(
				palRequests(world).length > 0,
				false,
				"a Pal that could not be started read nothing",
			);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);
