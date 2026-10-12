// The Recents heading carries one quiet button that switches the section to the archived
// conversations and back: the heading text and the button's tooltip change, an archived row offers
// Restore and nothing else, and the button sits on the Projects "+" button's right edge.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-sidebar-archive-toggle.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const CHATS = [
	{ match: /alpha/, steps: [{ text: "Reply alpha." }] },
	{ match: /beta/, steps: [{ text: "Reply beta." }] },
];

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld({
			...options,
			env: { SHELL: "/bin/sh", ...(options.env ?? {}) },
		});
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

async function chat(w, text, reply) {
	await send(w, text);
	await expect(w.page.getByText(reply, { exact: true }).first()).toBeVisible({ timeout: T });
}
async function twoChats(w) {
	await openProject(w);
	await chat(w, "alpha chat", "Reply alpha.");
	await w.page.getByRole("button", { name: "New conversation tab" }).click();
	await chat(w, "beta chat", "Reply beta.");
}

const tip = (w, text) =>
	w.page.locator('[data-slot="tooltip-popup"]', { hasText: text });
const section = (w) => w.page.locator(".sidebar-recents");
const heading = (w) => section(w).locator(".sidebar-recents-label");
const archivedRow = (w, title) =>
	w.page.locator("li[data-thread-item][data-archived-row]", { hasText: title });
const projectRow = (w, title) =>
	w.page.locator("nav.conversations li[data-thread-item]", { hasText: title });

flow(
	"the Recents heading switches to the archived conversations and back",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		// Nothing archived and both conversations listed under their project: no section yet.
		await expect(section(w)).toHaveCount(0);
		const row = projectRow(w, "alpha chat");
		await row.hover();
		await row.getByRole("button", { name: "Archive", exact: true }).click();
		await expect(projectRow(w, "alpha chat")).toHaveCount(0, { timeout: T });
		await expect(w.page.getByText(/^Conversation archived\./)).toBeVisible({ timeout: T });

		// One archived conversation and no recents: the section is there and says so.
		await expect(heading(w)).toHaveText("Recents", { timeout: T });
		await expect(section(w).getByText("No recent conversations.")).toBeVisible();
		const toggle = section(w).getByRole("button", { name: "Show archived conversations" });
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await toggle.hover();
		await expect(tip(w, "Show archived conversations")).toBeVisible({
			timeout: T,
		});

		// The button ends where the Projects "+" button ends.
		const edge = await w.page.evaluate(() => {
			const right = (selector) => document.querySelector(selector)?.getBoundingClientRect().right;
			return { toggle: right(".sidebar-archive-toggle"), add: right(".sidebar-add-project") };
		});
		assert.ok(edge.toggle !== undefined && edge.add !== undefined, "both buttons were measured");
		assert.ok(
			Math.abs(edge.toggle - edge.add) <= 1,
			`archive button right edge ${edge.toggle} matches the + button's ${edge.add}`,
		);

		// Switch: heading, button, tooltip and list all change.
		await toggle.click();
		await expect(heading(w)).toHaveText("Archived", { timeout: T });
		const back = section(w).getByRole("button", { name: "Back to recents" });
		await expect(back).toHaveAttribute("aria-pressed", "true");
		// A press closes the tooltip; it opens again when the pointer arrives afresh.
		await w.page.mouse.move(700, 400);
		await back.hover();
		await expect(tip(w, "Back to recents")).toBeVisible({
			timeout: T,
		});
		const archived = archivedRow(w, "alpha chat");
		await expect(archived).toHaveCount(1, { timeout: T });
		await expect(archived.locator(".conversation-row-project")).toHaveText("project");
		// The app cannot open an archived conversation, so the row is not a link.
		assert.equal(await archived.getByRole("button", { name: "alpha chat", exact: true }).count(), 0);
		const cursor = await archived
			.locator(".sidebar-conversation-button")
			.evaluate((el) => getComputedStyle(el).cursor);
		assert.notEqual(cursor, "pointer");

		// The keyboard toggles it: Enter and Space both, with the button focused.
		await back.focus();
		await expect(back).toBeFocused();
		await w.page.keyboard.press("Enter");
		await expect(heading(w)).toHaveText("Recents", { timeout: T });
		const again = section(w).getByRole("button", { name: "Show archived conversations" });
		await again.focus();
		await w.page.keyboard.press("Space");
		await expect(heading(w)).toHaveText("Archived", { timeout: T });
		await expect(archivedRow(w, "alpha chat")).toHaveCount(1, { timeout: T });

		// Restore is the row's one action, with its own tooltip.
		await archived.hover();
		const restore = archived.getByRole("button", { name: "Restore alpha chat" });
		await expect(restore).toBeVisible();
		await w.page.mouse.move(700, 400);
		await archived.hover();
		await restore.hover();
		await expect(tip(w, "Restore")).toBeVisible({ timeout: T });
		await restore.click();
		await expect(archivedRow(w, "alpha chat")).toHaveCount(0, { timeout: T });
		await expect(section(w).getByText("Nothing is archived.")).toBeVisible({ timeout: T });

		// With nothing left to show in either view, the section goes away.
		await back.click();
		await expect(section(w)).toHaveCount(0, { timeout: T });
		await expect(projectRow(w, "alpha chat")).toHaveCount(1, { timeout: T });
	},
);

flow(
	"the command palette entry switches the sidebar to the archived list and back",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		const row = projectRow(w, "alpha chat");
		await row.hover();
		await row.getByRole("button", { name: "Archive", exact: true }).click();
		await expect(heading(w)).toHaveText("Recents", { timeout: T });

		await w.page.keyboard.press("Control+k");
		await w.page.getByRole("combobox", { name: "Search conversations and actions" }).fill("Archived");
		await w.page.getByRole("option", { name: /Archived conversations/ }).click();
		await expect(heading(w)).toHaveText("Archived", { timeout: T });
		await expect(archivedRow(w, "alpha chat")).toHaveCount(1, { timeout: T });
		await expect(w.page.locator("[data-archive-list]")).toBeFocused();

		await w.page.keyboard.press("Control+k");
		await w.page.getByRole("combobox", { name: "Search conversations and actions" }).fill("Archived");
		await w.page.getByRole("option", { name: /Archived conversations/ }).click();
		await expect(heading(w)).toHaveText("Recents", { timeout: T });
	},
);
