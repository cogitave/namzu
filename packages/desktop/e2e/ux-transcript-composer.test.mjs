// Transcript, approvals and composer: what a person sees and does, against the real app.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test packages/desktop/e2e/ux-transcript-composer.test.mjs
// Screenshots land in research/ux-20261009/transcript-composer/ and are looked at, not asserted.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	answerDialogs,
	createWorld,
	dialogsSeen,
	dispose,
	expect,
	launch,
	openProject,
	relaunch,
	repoRoot,
	send,
} from "./harness.mjs";

const T = 60000;
const SHOTS = join(repoRoot, "research/ux-20261009/transcript-composer");
mkdirSync(SHOTS, { recursive: true });

function flow(name, options, body) {
	test(name, { timeout: 180000 }, async () => {
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

const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
const size = (w, width, height) =>
	w.app.evaluate(
		({ BrowserWindow }, [x, y]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(x, y);
		},
		[width, height],
	);
const approvalCard = (w) => w.page.getByRole("region", { name: "Tool approval" });

const WRITE = {
	match: /write the file/i,
	steps: [
		{ tool: "write", args: { path: "out.txt", content: "hello from the model\n" } },
		{ text: "Wrote out.txt." },
	],
};
const REMOVE = {
	match: /clean the build/i,
	steps: [
		{ tool: "bash", args: { command: "rm -rf build && echo done" } },
		{ text: "Cleaned." },
	],
};

flow(
	"declining with a note keeps the note in the conversation",
	{ rules: [WRITE] },
	async (w) => {
		await openProject(w);
		await send(w, "Please write the file");
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		await approvalCard(w)
			.getByRole("button", { name: "Tell Namzu what to do instead", exact: true })
			.click();
		await approvalCard(w)
			.getByRole("textbox", { name: "Tell Namzu what to do instead" })
			.fill("call it home.html");
		await approvalCard(w).getByRole("button", { name: "Send", exact: true }).click();
		await expect(approvalCard(w)).toHaveCount(0, { timeout: T });
		await expect(
			w.page.getByText("You asked Namzu to do this instead:", { exact: false }),
		).toBeVisible({ timeout: T });
		await expect(w.page.getByText("call it home.html")).toBeVisible();
		await shot(w, "note-in-conversation-1280");
	},
);

flow(
	"the approval card has a filled Accept, takes the keyboard and Enter accepts",
	{ rules: [WRITE] },
	async (w) => {
		await openProject(w);
		await send(w, "Please write the file");
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		const accept = approvalCard(w).getByRole("button", { name: "Accept", exact: true });
		const reject = approvalCard(w).getByRole("button", { name: "Reject", exact: true });
		await expect(accept).toBeFocused();
		const fill = (button) =>
			button.evaluate((node) => getComputedStyle(node).backgroundColor);
		const filled = await fill(accept);
		assert.notEqual(filled, "rgba(0, 0, 0, 0)", "Accept is filled");
		assert.equal(await fill(reject), "rgba(0, 0, 0, 0)", "Reject is not");
		await expect(
			approvalCard(w).getByRole("button", { name: "Tell Namzu what to do instead" }),
		).toBeVisible();
		await expect(approvalCard(w).getByText("Enter accepts.", { exact: false })).toBeVisible();
		await shot(w, "approval-1280");
		await w.page.keyboard.press("Enter");
		await expect(w.page.getByText("Wrote out.txt.")).toBeVisible({ timeout: T });
		assert.equal(existsSync(join(w.project, "out.txt")), true);
	},
);

flow(
	"a command card names its folder and its risk, and sits clear of the message box at 900 by 720",
	{ rules: [REMOVE] },
	async (w) => {
		await openProject(w);
		await size(w, 900, 720);
		await send(w, "Please clean the build");
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		await expect(approvalCard(w).getByText(`Runs on your computer in ${w.project}`, { exact: false })).toBeVisible();
		await expect(approvalCard(w).getByText("deletes or overwrites files", { exact: false })).toBeVisible();
		const gap = await w.page.evaluate(() => {
			const buttons = document.querySelector('[aria-label="Tool approval"] .approval-footer');
			const box = document.querySelector('textarea[aria-label="Message Namzu"], [role="textbox"][aria-label="Message Namzu"]');
			if (!buttons || !box) return null;
			return box.getBoundingClientRect().top - buttons.getBoundingClientRect().bottom;
		});
		assert.ok(gap !== null && gap >= 8, `the buttons end ${gap}px above the message box`);
		await shot(w, "approval-command-900");
	},
);

flow(
	"stopping while a command waits says it was not run, and the stop button is not alarming",
	{ rules: [REMOVE] },
	async (w) => {
		await openProject(w);
		await send(w, "Please clean the build");
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		const stop = w.page.getByRole("button", { name: "Stop turn" });
		const colour = await stop.evaluate((node) => getComputedStyle(node).backgroundColor);
		assert.doesNotMatch(colour, /^rgb\(2[0-9][0-9], ?\d+, ?\d+\)$/, "not red while waiting");
		await stop.click();
		await expect(
			w.page.getByText("Stopped. The command waiting for your answer was not run."),
		).toBeVisible({ timeout: T });
		await shot(w, "stopped-while-waiting-1280");
	},
);

flow("the live line says what is happening before the first action", {
	rules: [{ match: /slow/, steps: [{ hold: "slow", text: "Slow reply done." }] }],
}, async (w) => {
	await openProject(w);
	await send(w, "slow please");
	await expect(w.page.getByText("Reading your message")).toBeVisible({ timeout: T });
	await w.page.getByRole("textbox", { name: "Message Namzu" }).fill("and then this");
	await w.page.getByRole("button", { name: "Queue for next turn" }).hover();
	await expect(
		w.page.getByText("Hold this message and send it when the current reply is done"),
	).toBeVisible({ timeout: T });
	w.model.release("slow");
	await expect(w.page.getByText("Slow reply done.")).toBeVisible({ timeout: T });
});

flow(
	"Full access asks once, in words, and Cancel keeps Ask first",
	{},
	async (w) => {
		await openProject(w);
		await w.page.getByRole("button", { name: /^Permissions/ }).click();
		await w.page.getByRole("menuitemradio", { name: /Full access/ }).click();
		const dialog = w.page.getByRole("alertdialog", { name: "Allow Namzu full access?" });
		await expect(dialog).toBeVisible({ timeout: T });
		await expect(dialog).toContainText("without asking you first");
		await expect(dialog).toContainText("only to this conversation");
		await shot(w, "full-access-confirm-1280");
		await dialog.getByRole("button", { name: "Keep current permissions" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(w.page.getByRole("button", { name: /Permissions: Ask first/ })).toBeVisible();
		await w.page.getByRole("button", { name: /^Permissions/ }).click();
		await w.page.getByRole("menuitemradio", { name: /Full access/ }).click();
		await w.page
			.getByRole("alertdialog", { name: "Allow Namzu full access?" })
			.getByRole("button", { name: "Enable full access" })
			.click();
		await expect(w.page.getByRole("button", { name: /Permissions: Full access/ })).toBeVisible({
			timeout: T,
		});
	},
);

flow(
	"the attach menu closes after a pick and the message box has the keyboard",
	{ files: { "notes.txt": "some notes\n" } },
	async (w) => {
		await openProject(w);
		await w.app.evaluate((_e, path) => {
			globalThis.__e2eDialog.open = [path];
		}, join(w.project, "notes.txt"));
		await w.page.getByRole("button", { name: /Add attachments|Attachments/ }).first().click();
		await w.page.getByRole("button", { name: "Attach files" }).click();
		await expect(w.page.getByRole("button", { name: "Attach files" })).toHaveCount(0, {
			timeout: T,
		});
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeFocused();
		await expect(w.page.getByText("notes.txt")).toBeVisible({ timeout: T });
		await shot(w, "attached-menu-closed-1280");
	},
);

flow(
	"a finished reply can be asked again, and its clock is a plain time",
	{ rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }] },
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({ timeout: T });
		const before = w.model.requests.length;
		await w.page.getByText("Scripted hello back.").hover();
		const names = await w.page.getByRole("button").evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("aria-label") ?? ""),
		);
		assert.ok(!names.some((name) => name.includes("Observed by Namzu")), "no jargon in a name");
		await shot(w, "reply-hover-1280");
		await w.page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect
			.poll(() => w.model.requests.length, { timeout: T })
			.toBeGreaterThan(before);
		assert.match(
			JSON.stringify(w.model.requests.at(-1).messages),
			/hello there/,
			"the same question went out again",
		);
	},
);

flow(
	"the edited-file chip keeps the file name in a narrow window",
	{ rules: [WRITE], files: {} },
	async (w) => {
		await openProject(w);
		await size(w, 900, 720);
		await send(w, "Please write the file");
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		await approvalCard(w).getByRole("button", { name: "Accept", exact: true }).click();
		const chip = w.page.getByRole("region", { name: "Files edited in this reply" });
		await expect(chip).toBeVisible({ timeout: T });
		const name = chip.locator(".turn-changes-title strong");
		await expect(name).toHaveText("out.txt");
		const clipped = await name.evaluate((node) => node.scrollWidth > node.clientWidth);
		assert.equal(clipped, false, "the file name is whole");
		await shot(w, "edited-chip-900");
	},
);

flow(
	"closing the window during a reply asks first, and the reply later says why it stopped",
	{
		rules: [
			{ match: /hello first/, steps: [{ text: "Hello back." }] },
			{ match: /slow/, steps: [{ hold: "slow", text: "Slow reply done." }] },
		],
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello first");
		await expect(w.page.getByText("Hello back.")).toBeVisible({ timeout: T });
		await send(w, "slow please");
		await expect(w.page.getByRole("button", { name: "Stop turn" })).toBeVisible({ timeout: T });
		await answerDialogs(w, 0);
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
		await expect
			.poll(async () => (await dialogsSeen(w)).map((box) => box.title), { timeout: T })
			.toContain("A reply is still running");
		assert.equal(await w.page.getByRole("button", { name: "Stop turn" }).count(), 1, "still open");
		await shot(w, "close-asks-1280");
		await answerDialogs(w, 1);
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
		await w.app.process().exitCode;
		await relaunch(w);
		const row = w.page.getByRole("button", { name: /hello first/ }).first();
		await expect(row).toBeVisible({ timeout: T });
		await row.click();
		await expect(w.page.getByText("Stopped because Namzu was closed.")).toBeVisible({
			timeout: T,
		});
		await shot(w, "stopped-because-closed-1280");
	},
);
