// Transcript, approvals and composer: what a person sees and does, against the real app.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test packages/desktop/e2e/ux-transcript-composer.test.mjs
// Screenshots land in research/ux-20261009/transcript-composer/ and are looked at, not asserted.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/**
 * The card's whole surface ends above the composer, and the line that names the state sits right
 * above the card.
 */
async function assertCardClear(w, label) {
	const m = await w.page.evaluate(() => {
		const box = (el) => (el ? el.getBoundingClientRect() : null);
		const card = box(document.querySelector('[aria-label="Tool approval"] [data-slot="composer-banner"]'));
		const caption = box(document.querySelector(".approval-waiting"));
		const composer = box(document.querySelector("[data-chat-composer-body]"));
		return { card, caption, composer };
	});
	assert.ok(m.card && m.caption && m.composer, `${label}: card, caption and composer are drawn`);
	assert.ok(m.card.bottom <= m.composer.top - 2, `${label}: the card ends ${m.card.bottom} but the composer starts at ${m.composer.top}`);
	assert.ok(m.caption.bottom <= m.card.top + 0.5 && m.card.top - m.caption.bottom <= 16, `${label}: "Waiting for your decision" is ${m.card.top - m.caption.bottom}px above the card`);
	await expect(w.page.locator(".working:not(.transcript-status-only)")).toHaveCount(0);
}

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
		// It is the person's message: the same right-hand bubble as anything they typed.
		await expect(
			w.page.locator('[data-message-role="user"].redirect-note').getByText("call it home.html"),
		).toBeVisible();
		// A picture is taken once the status line's own fade has finished.
		await expect
			.poll(() => w.page.evaluate(() => document.querySelector(".working")?.getAnimations().length ?? 0), { timeout: T })
			.toBe(0);
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
		await assertCardClear(w, "1280x800");
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
		await expect(approvalCard(w).getByText("Enter rejects it", { exact: false })).toBeVisible();
		await expect(approvalCard(w).getByRole("button", { name: "Reject" })).toBeFocused();
		const gap = await w.page.evaluate(() => {
			const buttons = document.querySelector('[aria-label="Tool approval"] .approval-footer');
			const box = document.querySelector('textarea[aria-label="Message Namzu"], [role="textbox"][aria-label="Message Namzu"]');
			if (!buttons || !box) return null;
			return box.getBoundingClientRect().top - buttons.getBoundingClientRect().bottom;
		});
		assert.ok(gap !== null && gap >= 8, `the buttons end ${gap}px above the message box`);
		await assertCardClear(w, "900x720");
		await shot(w, "approval-command-900");
	},
);

flow(
	"stopping while a command waits says it was not run, and Stop looks the same as while it runs",
	{ rules: [REMOVE] },
	async (w) => {
		await openProject(w);
		await send(w, "Please clean the build");
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		const stop = w.page.getByRole("button", { name: "Stop turn" });
		// The same red button as while a reply runs: waiting does not turn Stop into another control.
		await expect(stop).toHaveClass(/bg-destructive/);
		await stop.click();
		await expect(
			w.page.getByText("Stopped. The command waiting for your answer was not run."),
		).toBeVisible({ timeout: T });
		// Nothing is waiting any more: the live line is gone, not dimmed, and the sidebar stops spinning.
		await expect(w.page.locator(".working .working-label")).toBeHidden({ timeout: T });
		await expect(w.page.locator(".stage-line")).toHaveCount(0);
		await expect(w.page.getByRole("complementary").locator("[data-running], .animate-spin")).toHaveCount(0);
		await shot(w, "stopped-while-waiting-1280");
	},
);

flow("the live line says what is happening before the first action", {
	rules: [{ match: /slow/, steps: [{ hold: "slow", text: "Slow reply done." }] }],
}, async (w) => {
	await openProject(w);
	await send(w, "slow please");
	await expect(w.page.getByText("Reading your message")).toBeVisible({ timeout: T });
	// Once its entrance has finished the line is drawn whole: no inline clip, and nothing of the
	// text below the box it is drawn in.
	await expect
		.poll(
			() =>
				w.page.evaluate(() => {
					const line = document.querySelector(".working");
					if (!line || line.getAnimations().length) return "animating";
					const label = line.querySelector(".working-label");
					const a = line.getBoundingClientRect();
					const b = label?.getBoundingClientRect();
					return line.style.overflow === "hidden" || !b || b.bottom > a.bottom + 0.5 || label.scrollHeight > label.clientHeight + 1
						? "clipped"
						: "whole";
				}),
			{ timeout: T },
		)
		.toBe("whole");
	await w.page.getByRole("textbox", { name: "Message Namzu" }).fill("and then this");
	await w.page.getByRole("button", { name: "Queue message for next turn" }).hover();
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

flow(
	"a write that leaves the file as it is says so, instead of saying it cannot show the file",
	{
		rules: [
			{
				match: /rewrite hello/i,
				steps: [
					{ tool: "write", args: { path: "hello.txt", content: "hello from the scripted model" } },
					{ text: "Done." },
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		writeFileSync(join(w.project, "hello.txt"), "hello from the scripted model");
		await send(w, "Please rewrite hello");
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		await expect(approvalCard(w).getByText("No change to hello.txt.", { exact: false })).toBeVisible();
		await expect(approvalCard(w).getByText("couldn", { exact: false })).toHaveCount(0);
		await shot(w, "no-change-1280");
	},
);

flow(
	"after a reload the message shows the file as a chip, never the wrapper or the file's text",
	{
		rules: [{ match: /Ekimi/, steps: [{ text: "Tamam." }] }],
		files: { "Sözleşme İmzalı.txt": "gizli ek içerik\n" },
	},
	async (w) => {
		await openProject(w);
		await w.app.evaluate((_electron, path) => {
			globalThis.__e2eDialog.open = [path];
		}, join(w.project, "Sözleşme İmzalı.txt"));
		await w.page.getByRole("button", { name: /Add attachments|Attachments/ }).first().click();
		await w.page.getByRole("button", { name: "Attach files" }).click();
		await send(w, "Ekimi gör");
		await expect(w.page.getByText("Tamam.")).toBeVisible({ timeout: T });
		await relaunch(w);
		const bubble = w.page.locator('[data-message-role="user"]').first();
		await expect(bubble.getByText("Ekimi gör")).toBeVisible({ timeout: T });
		await expect(bubble.getByText("Sözleşme İmzalı.txt")).toBeVisible({ timeout: T });
		await expect(w.page.getByText("Attached text file", { exact: false })).toHaveCount(0);
		await expect(w.page.getByText("gizli ek içerik", { exact: false })).toHaveCount(0);
		await shot(w, "attachment-after-reload-1280");
	},
);
