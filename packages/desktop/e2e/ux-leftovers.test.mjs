// Leftovers of the interface review, in real Electron with the scripted model: a missing project in the
// composer's chooser, why Queue is off (the Stop tooltip), the File menu's tab entries, and the wording
// of message times. Pictures go to research/ux-20261009/leftovers/.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-leftovers.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/ux-20261009/leftovers");

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

/** Everything that animates has settled, so a picture shows the resting state. */
async function settled(w) {
	await w.page.evaluate(async () => {
		const ending = document
			.getAnimations()
			.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
		await Promise.all(ending.map((a) => a.finished.catch(() => undefined)));
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
}
const shot = async (w, name) => {
	await settled(w);
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const CHATS = [
	{ match: /alpha/, steps: [{ text: "Reply alpha." }] },
	{ match: /beta/, steps: [{ text: "Reply beta." }] },
	{ match: /slow/, steps: [{ hold: "slow", text: "Slow reply done." }] },
];
const tabs = (w) => w.page.locator(".conversation-tab");
const activeTab = (w) => w.page.locator('.conversation-tab[data-active="true"]');

async function chat(w, text, reply) {
	await send(w, text);
	await expect(w.page.getByText(reply, { exact: true }).first()).toBeVisible({ timeout: T });
}

/** Clicks one entry of the native File menu, as a person would. */
const fileMenu = (w, label) =>
	w.app.evaluate(({ Menu }, wanted) => {
		const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
		const entry = file?.submenu?.items.find((item) => item.label === wanted);
		if (!entry) throw new Error(`no File menu entry ${wanted}`);
		entry.click();
	}, label);

flow("a project whose folder is gone is listed in the chooser, marked and not selectable", {}, async (w) => {
	await openProject(w);
	await w.page.getByRole("textbox", { name: "Message Namzu" }).fill("hello");
	await expect(w.page.locator("[data-project-group]")).toHaveCount(1);
	await w.app.close();
	renameSync(w.project, join(w.root, "moved-project"));
	const other = join(w.root, "other-folder");
	mkdirSync(join(other, ".git"), { recursive: true });
	await launch(w);
	await expect(w.page.locator("[data-project-missing]")).toBeVisible({ timeout: T });
	await w.app.evaluate((_e, folder) => {
		globalThis.__e2eDialog.open = [folder];
	}, other);
	await w.page.getByRole("button", { name: "Add new project", exact: true }).last().click();
	await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	const consent = w.page.getByRole("dialog", { name: "Trust this folder?" });
	await consent
		.getByRole("button", { name: "Trust and open" })
		.click({ timeout: 5000 })
		.catch(() => undefined);
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	const trigger = w.page.getByRole("button", { name: "Choose project folder" });
	await expect(trigger).toContainText("other-folder");
	await trigger.click();
	const list = w.page.getByRole("dialog", { name: "Project chooser" });
	const missing = list.locator("[data-project-missing]");
	await expect(missing).toHaveCount(1, { timeout: T });
	await expect(missing).toContainText("Folder not found");
	await expect(missing).toBeDisabled();
	await shot(w, "chooser-missing-project");
	// It cannot be chosen: a click leaves the composer on the folder it was on.
	await missing.click({ force: true });
	await expect(trigger).toContainText("other-folder");
	await expect(list).toBeVisible();
});

flow("the Stop tooltip says why Queue is off, and goes back to plain when it is on", { rules: CHATS }, async (w) => {
	await openProject(w);
	await send(w, "slow please");
	await expect(w.page.getByText("Reading your message")).toBeVisible({ timeout: T });
	const stop = w.page.getByRole("button", { name: "Stop turn" });
	await stop.hover();
	await expect(w.page.getByText("Stop · Esc. Queue is off until you type a message.")).toBeVisible({
		timeout: T,
	});
	await shot(w, "stop-tooltip-queue-off");
	await w.page.getByRole("textbox", { name: "Message Namzu" }).fill("and then this");
	await expect(w.page.getByRole("button", { name: "Queue message for next turn" })).toBeEnabled();
	await w.page.getByRole("button", { name: "Queue message for next turn" }).hover();
	await stop.hover();
	await expect(w.page.getByText("Stop · Esc", { exact: true })).toBeVisible({ timeout: T });
	w.model.release("slow");
	await expect(w.page.getByText("Slow reply done.")).toBeVisible({ timeout: T });
});

flow("the File menu lists the tab entries and runs the same actions as the keys", { rules: CHATS }, async (w) => {
	await openProject(w);
	await chat(w, "alpha chat", "Reply alpha.");
	await w.page.getByRole("button", { name: "New conversation tab" }).click();
	await chat(w, "beta chat", "Reply beta.");
	await expect(tabs(w)).toHaveCount(2);
	const entries = await w.app.evaluate(({ Menu }) => {
		const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
		return file?.submenu?.items
			.filter((item) => item.type !== "separator")
			.map((item) => [item.label, String(item.accelerator)]);
	});
	assert.deepEqual(entries.slice(0, 3), [
		["Close tab", "CmdOrCtrl+W"],
		["Next tab", "Ctrl+Tab"],
		["Previous tab", "Ctrl+Shift+Tab"],
	]);
	await expect(activeTab(w)).toContainText("beta chat");
	await fileMenu(w, "Previous tab");
	await expect(activeTab(w)).toContainText("alpha chat");
	await fileMenu(w, "Next tab");
	await expect(activeTab(w)).toContainText("beta chat");
	await shot(w, "file-menu-tabs");
	await fileMenu(w, "Close tab");
	await expect(tabs(w)).toHaveCount(1);
	await expect(activeTab(w)).toContainText("alpha chat");
	// Ctrl+W with a terminal holding the keyboard closes the terminal, not a word of the shell's line.
	await w.page.getByRole("button", { name: "New terminal tab" }).click();
	const terminal = w.page.locator("[data-terminal-tab-id]");
	await expect(terminal).toHaveCount(1, { timeout: T });
	await w.page.locator("section.terminal-pane .xterm-helper-textarea").focus();
	await w.page.keyboard.press("Control+w");
	await expect(terminal).toHaveCount(0, { timeout: T });
});

flow("message times read Sent at for the person and Received at for replies", { rules: CHATS }, async (w) => {
	await openProject(w);
	await chat(w, "alpha chat", "Reply alpha.");
	const mine = w.page.locator('[data-message-role="user"] .message-time').first();
	const reply = w.page.locator('[data-message-role="assistant"] .message-time').first();
	await expect(mine).toHaveAttribute("aria-label", /^Sent at /);
	await expect(reply).toHaveAttribute("aria-label", /^Received at /);
	const wording = await w.page.evaluate(() => document.body.innerHTML);
	assert.doesNotMatch(wording, /Seen by Namzu|Saved in the conversation|Saved in this conversation/);
	await w.page.getByText("Reply alpha.", { exact: true }).hover();
	await shot(w, "reply-time-wording");
});
