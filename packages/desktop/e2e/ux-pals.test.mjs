// Pals, end to end in real Electron: what a person sees when they make a Pal, message it from
// a conversation, pause it, open its settings and delete it. No paid model, no owner data.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-pals.test.mjs
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

const SHOTS = join(repoRoot, "research/ux-20261009/pals");
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
async function shot(world, name) {
	await world.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test(
	"a Pal: made, messaged from a conversation, paused, set up and deleted, in plain words",
	{ timeout: 280000 },
	async () => {
		const rules = [];
		const world = await createWorld({ rules });
		let failed = true;
		try {
			await launch(world);
			await size(world, 1440, 900);
			const page = world.page;
			await openProject(world);

			// A first Pal: one Customize action, nothing nameless, a hint when the name is empty.
			// The project can still be settling into view right after it opens, so the page is reached by
			// retrying the whole step rather than clicking once.
			await expect(async () => {
				await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
				await expect(
					page.getByRole("region", { name: "Meet your Pal" }),
				).toBeVisible({ timeout: 2000 });
			}).toPass({ timeout: 60000 });
			await expect(
				page.getByRole("button", { name: "Customize your Pal" }),
			).toHaveCount(1);
			await expect(page.getByText("Your Pal", { exact: true })).toHaveCount(0);
			await shot(world, "01-welcome-1440");
			await expect(async () => {
				if (!(await page.getByRole("dialog", { name: "Customize your Pal" }).isVisible()))
					await page
						.getByRole("button", { name: "Customize your Pal" })
						.click({ timeout: 2000 });
				await expect(
					page.getByRole("dialog", { name: "Customize your Pal" }),
				).toBeVisible({ timeout: 2000 });
			}).toPass({ timeout: 60000 });
			const customize = page.getByRole("dialog", { name: "Customize your Pal" });
			await expect(customize).toBeVisible();
			await expect(customize.getByText("Give your Pal a name.")).toBeVisible();
			await expect(customize.getByRole("button", { name: "Save" })).toBeDisabled();
			await customize.getByRole("textbox", { name: "Pal name" }).press("Enter");
			await expect(
				customize.getByRole("alert").filter({ hasText: "Give your Pal a name to save it." }),
			).toBeVisible();
			await shot(world, "02-name-needed-1440");
			await customize.getByRole("textbox", { name: "Pal name" }).fill("Işık");
			await customize.getByRole("textbox", { name: "Pal name" }).press("Enter");

			// The Pal opens; no empty "New conversation" tab is left beside it; the sidebar has a heading.
			const palTab = page.getByRole("tab", { name: "Işık" });
			await expect(palTab).toBeVisible({ timeout: 60000 });
			await expect(page.getByRole("tab", { name: /New conversation/ })).toHaveCount(0);
			await expect(page.getByRole("heading", { name: "Pals", exact: true })).toBeVisible();
			await expect(palTab.locator(".pal-character")).toHaveCount(1);
			await expect(page.getByText("Ready to chat")).toBeVisible();
			await shot(world, "03-pal-opened-1440");

			// The computer panel never shows build instructions or repository paths.
			const card = page.getByRole("complementary", { name: "Pal context" });
			await expect(card).toBeVisible();
			await expect(card.getByText("Offline", { exact: true })).toBeVisible();
			const start = card.getByRole("button", { name: "Start computer" });
			await expect(start).toBeVisible();
			await start.click();
			// Starting never replaces the status with the action's name.
			await expect(
				card.locator(".pal-computer-open .pal-computer-status", { hasText: "Start computer" }),
			).toHaveCount(0);
			await expect(card.locator(".pal-context-note")).toContainText("Docker Desktop or Podman", {
				timeout: 60000,
			});
			const note = await card.locator(".pal-context-note").innerText();
			assert.doesNotMatch(note, /Dockerfile|packages\/|namzu-local-computer/);
			await expect(card.locator(".pal-computer-open .pal-computer-status")).toHaveText("Offline");
			await shot(world, "04-computer-notice-1440");
			// The computer page says what is missing in the same words and why Take over waits.
			await page.getByRole("button", { name: /Open Işık’s computer/ }).click();
			await expect(page.getByText("Computer is offline")).toBeVisible();
			await expect(page.getByText("Offline. Start the computer to take over.")).toBeVisible();
			assert.doesNotMatch(
				await page.locator(".pal-computer-view").innerText(),
				/Dockerfile|packages\//,
			);
			await shot(world, "05-computer-page-1440");
			await page.getByRole("tab", { name: "Işık" }).first().click();

			// Pause: the status says Paused, the one action says Resume, and typing says why it is blocked.
			await card.getByRole("button", { name: "Pause Işık" }).click();
			await expect(card.locator(".pal-context-status")).toHaveText("Paused");
			await expect(card.getByRole("button", { name: "Resume Işık" })).toHaveText("Resume");
			const composer = page.getByRole("textbox", { name: "Message Namzu" });
			await composer.fill("hello");
			await expect(page.getByText("Işık is paused. Resume Işık to chat.")).toBeVisible();
			await shot(world, "06-paused-1440");
			await card.getByRole("button", { name: "Resume Işık" }).click();
			await expect(card.locator(".pal-context-status")).toHaveText("Ready to chat");
			await composer.fill("");

			// A message from an ordinary conversation, approved, then readable in the Pal's messages.
			const palId = readdirSync(join(world.home, "pals"))[0];
			rules.push({
				match: /ask the pal/i,
				steps: [
					{
						tool: "send_pal_message",
						args: { palId, body: "Please summarise the README and tell me what is missing." },
					},
					{ text: "I sent your Pal the request." },
				],
			});
			await page.getByRole("button", { name: "New conversation" }).first().click();
			await send(world, "Ask the Pal to summarise the README");
			const approval = page.getByRole("region", { name: "Tool approval" });
			await expect(approval).toBeVisible({ timeout: 60000 });
			// What happens next is stated, and the message is prose, not a command.
			await expect(approval).toContainText("Goes to Işık’s inbox.");
			await expect(approval).toContainText("reads it the next time it runs");
			await expect(approval).toContainText("sending does not start it");
			await expect(approval).toContainText("namzu pal dispatch");
			await expect(approval.locator(".approval-command")).toHaveCount(0);
			const quote = approval.getByLabel("Message");
			await expect(quote).toHaveText(
				"Please summarise the README and tell me what is missing.",
			);
			assert.notEqual(
				await quote.evaluate((el) => getComputedStyle(el).fontFamily.includes("mono")),
				true,
			);
			await shot(world, "07-approval-1440");
			await approval.getByRole("button", { name: /Accept/ }).click();
			// The sent line stays in the transcript even though the work folds away.
			const receipt = page.getByRole("list", { name: "Messages sent to Pals" });
			await expect(receipt).toContainText("Sent to Işık’s inbox.", { timeout: 60000 });
			await shot(world, "08-sent-line-1440");
			// The Pal row carries an unread dot, since the person messaged it and has not opened it.
			const unread = page.locator(".sidebar-pal-row .sidebar-pal-unread");
			await expect(page.getByRole("button", { name: /Işık.*New message/ })).toBeVisible();
			await expect(unread).toHaveCount(1);
			await shot(world, "08b-unread-dot-1440");
			await receipt.getByRole("button", { name: "See it in Işık’s messages" }).click();
			const settings = page.getByRole("dialog", { name: "Işık settings" });
			await expect(settings).toBeVisible({ timeout: 60000 });
			await expect(settings.getByRole("tab", { name: "Messages" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await expect(settings).toContainText(
				"Please summarise the README and tell me what is missing.",
			);
			await expect(settings).toContainText("Waiting for Işık to read it");
			await expect(settings).toContainText("From your conversation");
			await expect(settings.locator("time")).toHaveCount(1);
			await shot(world, "09-inbox-1440");

			// The rest of the settings are in plain words with app-styled pickers and switches.
			await settings.getByRole("tab", { name: "Shared activity" }).click();
			await expect(settings.locator("select")).toHaveCount(0);
			await shot(world, "10-shared-activity-1440");
			await settings.getByRole("tab", { name: "General" }).click();
			await expect(settings).toContainText("Ready to chat");
			await shot(world, "11-general-1440");
			await page.keyboard.press("Escape");
			// Opening the Pal read its messages: the dot is gone and the message is quoted in its own
			// conversation with where it stands, worded as the person's own ("Sent at").
			await expect(unread).toHaveCount(0);
			const incoming = page.locator("[data-pal-incoming]");
			await expect(incoming).toHaveCount(1, { timeout: 60000 });
			await expect(incoming.locator("blockquote")).toHaveText(
				"Please summarise the README and tell me what is missing.",
			);
			await expect(incoming).toContainText("Waiting for Işık to read it");
			await expect(incoming.locator(".message-time")).toHaveAttribute("aria-label", /^Sent at /);
			await shot(world, "11b-incoming-quote-1440");

			// A second Pal with the same name is allowed but warned about.
			await page.getByRole("button", { name: "New Pal" }).click();
			await page.getByRole("button", { name: "Customize your Pal" }).click();
			const second = page.getByRole("dialog", { name: "Customize your Pal" });
			await second.getByRole("textbox", { name: "Pal name" }).fill("Işık");
			await expect(second.getByText(/already have a Pal called/)).toBeVisible();
			await shot(world, "12-duplicate-name-1440");
			await second.getByRole("button", { name: "Close customization" }).click();
			await page.getByRole("button", { name: "Işık", exact: true }).first().click();

			// 900px keeps a labelled Settings button on the compact bar.
			await size(world, 900, 720);
			const compact = page.locator(".pal-context-card[data-compact='true']");
			await expect(compact).toBeVisible();
			await expect(compact.getByRole("button", { name: "Işık settings" })).toBeVisible();
			await shot(world, "13-compact-900");
			await compact.getByRole("button", { name: "Işık settings" }).click();
			await expect(page.getByRole("dialog", { name: "Işık settings" })).toBeVisible();
			await shot(world, "14-settings-900");

			// Delete says exactly what goes and what stays.
			await page
				.getByRole("dialog", { name: "Işık settings" })
				.getByRole("button", { name: "Delete Işık" })
				.click();
			const removal = page.getByRole("alertdialog", { name: "Delete Işık?" });
			await expect(removal).toContainText(
				"Işık disappears from the sidebar and its computer is stopped.",
			);
			await expect(removal).toContainText("Its conversations and files are not deleted.");
			await expect(removal).not.toContainText("stored data");
			await shot(world, "15-delete-900");
			// Open folder reveals the Pal's own workspace and leaves the dialog open.
			await world.app.evaluate(({ shell }) => {
				globalThis.__revealed = [];
				shell.openPath = async (path) => {
					globalThis.__revealed.push(path);
					return "";
				};
			});
			await removal.getByRole("button", { name: "Open folder" }).click();
			await expect
				.poll(() => world.app.evaluate(() => globalThis.__revealed.length))
				.toBe(1);
			const revealed = await world.app.evaluate(() => globalThis.__revealed[0]);
			assert.ok(revealed.endsWith(palId), `the folder opened is the Pal's own (${revealed})`);
			await expect(removal).toBeVisible();
			await removal.getByRole("button", { name: "Cancel" }).click();

			// Light theme, the main Pal view and the settings.
			await size(world, 1440, 900);
			await page.evaluate(() => localStorage.setItem("namzu.appearance", "light"));
			await page.reload();
			await page.waitForLoadState("domcontentloaded");
			const lightCard = page.getByRole("complementary", { name: "Pal context" });
			await expect(lightCard).toBeVisible({ timeout: 60000 });
			await shot(world, "16-light-pal-1440");
			await lightCard.getByRole("button", { name: "Işık settings" }).click();
			await expect(page.getByRole("dialog", { name: "Işık settings" })).toBeVisible();
			await shot(world, "17-light-settings-1440");
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);
