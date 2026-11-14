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
/** Enter on the card once its short click guard has ended (the button says so), never on how fast the machine is. */
const answerYes = async (w) => {
	await expect(approvalCard(w).getByRole("button", { name: "Accept", exact: true })).not.toHaveAttribute(
		"aria-disabled",
		"true",
		{ timeout: T },
	);
	await w.page.keyboard.press("Enter");
};

/**
 * The card is one surface that ends just above the composer, which is one 40 px bar that says it is
 * waiting for the person; there is no caption of its own above the card.
 */
async function assertCardClear(w, label) {
	const m = await w.page.evaluate(() => {
		const box = (el) => (el ? el.getBoundingClientRect() : null);
		const card = box(document.querySelector('[aria-label="Tool approval"] .approval-card'));
		const caption = document.querySelector(".approval-waiting");
		const composer = box(document.querySelector("[data-chat-composer-body]"));
		const bar = box(document.querySelector(".composer-waiting"));
		const field = document.querySelector('textarea[aria-label="Message Namzu"]');
		return { card, caption, composer, bar, placeholder: field?.getAttribute("placeholder") };
	});
	assert.ok(m.card && m.composer && m.bar, `${label}: card, bar and composer are drawn`);
	assert.equal(m.caption, null, `${label}: no caption above the card`);
	assert.ok(m.bar.height >= 38 && m.bar.height <= 46, `${label}: the waiting bar is ${m.bar.height}px tall`);
	assert.match(m.placeholder ?? "", /^Waiting for you\./, `${label}: the bar says it is waiting`);
	const gap = m.bar.top - m.card.bottom;
	assert.ok(gap >= 6 && gap <= 10, `${label}: the card ends ${m.card.bottom} and the bar starts at ${m.bar.top}: ${gap}px apart, not about 8`);
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
		await approvalCard(w).getByRole("button", { name: "More about this request" }).click();
		await w.page.getByRole("menuitem", { name: "Tell Namzu what to do instead" }).click();
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
		// Reject is a quiet fill in the normal text colour: neither the lime fill nor the error colour.
		assert.notEqual(await fill(reject), filled, "Reject is not filled like Accept");
		assert.notEqual(
			await reject.evaluate((node) => getComputedStyle(node).color),
			await reject.evaluate(() => {
				const probe = document.createElement("i");
				probe.style.color = "var(--error-foreground)";
				document.body.append(probe);
				const colour = getComputedStyle(probe).color;
				probe.remove();
				return colour;
			}),
			"and its text is not the error colour",
		);
		// What left the card's surface is one click away on its "..." menu, and the keys are on the buttons.
		await expect(
			approvalCard(w).getByRole("button", { name: "More about this request" }),
		).toBeVisible();
		await expect(accept).toHaveAttribute("title", "Accept · Enter");
		await expect(reject).toHaveAttribute("title", "Reject · Esc");
		await assertCardClear(w, "1280x800");
		await shot(w, "approval-1280");
		await answerYes(w);
		await expect(w.page.getByText("Wrote out.txt.").first()).toBeVisible({ timeout: T });
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
		// The project's name, never its folder: the full path rides the tooltip.
		await expect(approvalCard(w).getByText("Runs in project.", { exact: false })).toBeVisible();
		await expect(approvalCard(w).getByText(w.project, { exact: false })).toHaveCount(0);
		assert.equal(await approvalCard(w).locator(".approval-consequence").getAttribute("title"), w.project);
		await expect(approvalCard(w).getByText("deletes or overwrites files", { exact: false })).toBeVisible();
		await expect(approvalCard(w).getByRole("button", { name: "Reject" })).toHaveAttribute("title", "Reject · Enter or Esc");
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
	"stopping while a command waits says it was not run, and Stop is a quiet square while it waits",
	{ rules: [REMOVE] },
	async (w) => {
		await openProject(w);
		await send(w, "Please clean the build");
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		const stop = w.page.getByRole("button", { name: "Stop reply" });
		// Stop is never filled at rest: the one filled control is Accept. (Under the pointer it takes an 8 percent fill.)
		await expect(stop).toHaveClass(/composer-stop/);
		await w.page.mouse.move(5, 5);
		// The hover fill fades out over 120 ms; wait for the real end of it rather than for a time.
		await expect
			.poll(() => stop.evaluate((node) => getComputedStyle(node).backgroundColor), { timeout: T })
			.toBe("rgba(0, 0, 0, 0)");
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
	await w.page.getByRole("button", { name: "Queue message for the next reply" }).hover();
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
	"the result line stays whole in a narrow window, with its menu reachable",
	{ rules: [WRITE], files: {} },
	async (w) => {
		await openProject(w);
		await size(w, 900, 720);
		await send(w, "Please write the file");
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		await approvalCard(w).getByRole("button", { name: "Accept", exact: true }).click();
		const line = w.page.getByRole("region", { name: "Result of this reply" });
		await expect(line).toBeVisible({ timeout: T });
		const lead = line.locator(".turn-result-lead");
		await expect(lead).toContainText("Done");
		const clipped = await lead.evaluate((node) => node.scrollWidth > node.clientWidth);
		assert.equal(clipped, false, "the lead is whole");
		await expect(line.locator(".turn-result-files")).toHaveText("1 file");
		// The whole row opens the changes; the file itself is one menu item away.
		const open = line.getByRole("button", { name: /Open changes$/ });
		await expect(open).toBeVisible();
		await line.getByRole("button", { name: "More about this reply" }).click();
		await expect(w.page.getByRole("menuitem", { name: "Copy summary" })).toBeVisible();
		await w.page.keyboard.press("Escape");
		await shot(w, "result-line-900");
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
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toBeVisible({ timeout: T });
		await answerDialogs(w, 0);
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
		await expect
			.poll(async () => (await dialogsSeen(w)).map((box) => box.title), { timeout: T })
			.toContain("A reply is still running");
		assert.equal(await w.page.getByRole("button", { name: "Stop reply" }).count(), 1, "still open");
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

// ---- Tool rows: what the transcript says about reads, searches, edits, commands and failures ----
// Pictures: research/hygiene-20261010/transcript-tools/, dark and light at 1280 and 900 wide.
const TOOL_SHOTS = join(repoRoot, "research/hygiene-20261010/transcript-tools");
mkdirSync(TOOL_SHOTS, { recursive: true });

const ANSI =
	"printf '\\033[31mred\\033[0m \\033[1;32mgreen\\033[0m \\033[4mund\\033[0m\\n'";
const RANDOM_BYTES = "head -c 3000 /dev/urandom";
const SEQ = "seq 1 600";
const FAILING = "echo partial; echo oops >&2; ls /nonexistent; exit 3";
const TOOL_TOUR = {
	match: /tour of the tools/i,
	steps: [
		{ tool: "read", args: { path: "a.ts" } },
		{ tool: "read", args: { path: "b.ts" } },
		{ tool: "read", args: { path: "Çalışma-ğüş.md" } },
		{ tool: "grep", args: { pattern: "export", path: "." } },
		{ tool: "glob", args: { pattern: "**/*.ts" } },
		{ tool: "read", args: { path: "nope/missing.txt" } },
		{ tool: "ls", args: { path: "." } },
		{
			tool: "edit",
			args: {
				path: "a.ts",
				old_string: "a = 1",
				new_string: "a = 2\nexport const a2 = 3",
			},
		},
		{ tool: "write", args: { path: "new/deep/n.txt", content: "one\ntwo\n" } },
		{ tool: "bash", args: { command: ANSI } },
		{ tool: "bash", args: { command: RANDOM_BYTES } },
		{ tool: "bash", args: { command: SEQ } },
		{ tool: "bash", args: { command: FAILING } },
		{ text: "Tour finished." },
	],
};

async function appearance(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(
			new StorageEvent("storage", { key: "namzu.appearance", newValue: value }),
		);
	}, mode);
	if (mode === "dark") await expect(w.page.locator("html")).toHaveClass(/dark/);
	else await expect(w.page.locator("html")).not.toHaveClass(/dark/);
}

/** Every transition and animation on the page has finished: a picture of a half-faded colour proves nothing. */
const settled = (w) =>
	expect
		.poll(
			() =>
				w.page.evaluate(
					() =>
						document.getAnimations().filter((a) => a.playState === "running")
							.length,
				),
			{ timeout: T },
		)
		.toBe(0);

/** Both themes at both widths of whatever is on screen, scrolled so `focus` is in the middle. */
async function shootTool(w, name, focus) {
	for (const width of [1280, 900]) {
		await size(w, width, 820);
		await expect
			.poll(() => w.page.evaluate(() => Math.round(window.innerWidth)), {
				timeout: T,
			})
			.toBeLessThanOrEqual(width);
		for (const mode of ["dark", "light"]) {
			await appearance(w, mode);
			await focus?.evaluate((node) => node.scrollIntoView({ block: "center" }));
			await settled(w);
			await w.page.screenshot({
				path: join(TOOL_SHOTS, `${name}-${width}-${mode}.png`),
			});
		}
	}
	await size(w, 1280, 820);
	await appearance(w, "dark");
}

/** The row whose headline starts with this text. */
const toolRow = (w, text) =>
	w.page.locator(".tool[data-tool-call-id]").filter({ hasText: text }).first();

flow(
	"every tool row reads as one plain line, and its output as colour, notes or a folded block",
	{
		rules: [TOOL_TOUR],
		files: {
			"a.ts": "export const a = 1\n",
			"b.ts": "export const b = 2\n",
			"Çalışma-ğüş.md": "# Günlük\n",
		},
	},
	async (w) => {
		await openProject(w);
		await send(w, "Give me a tour of the tools");
		// Each change and command asks first; the card names where it runs and which file it touches.
		await expect(approvalCard(w)).toBeVisible({ timeout: T });
		await expect(approvalCard(w).getByRole("heading", { name: "Edit a.ts?" })).toBeVisible();
		// The full path rides the question's tooltip; the sentence names the file by its place in the project.
		assert.equal(
			await approvalCard(w).locator(".approval-title").getAttribute("title"),
			join(w.project, "a.ts"),
		);
		await w.page.screenshot({
			path: join(TOOL_SHOTS, "approval-edit-1280-dark.png"),
		});
		await answerYes(w);
		await expect(
			approvalCard(w).getByRole("heading", { name: "Create n.txt?" }),
		).toBeVisible({ timeout: T });
		await expect(
			approvalCard(w).getByText(w.project, { exact: false }),
		).toHaveCount(0);
		await w.page.screenshot({
			path: join(TOOL_SHOTS, "approval-create-1280-dark.png"),
		});
		await answerYes(w);
		// The kernel decides which of the four commands need a person (a read-only one may run unasked), so
		// each card that does come is answered and named, and the tour is over when its last line shows.
		await expect(approvalCard(w).getByRole("heading", { name: "Create n.txt?" })).toHaveCount(0, { timeout: T });
		const asked = [];
		const finished = w.page.getByText("Tour finished.").first();
		const rowText = approvalCard(w).locator(".approval-path-text").first();
		for (let step = 0; step < 6; step++) {
			await expect(rowText.or(finished)).toBeVisible({ timeout: T });
			if (await finished.isVisible()) break;
			const command = (await rowText.textContent()) ?? "";
			await expect(
				approvalCard(w).getByText("Runs in project.", { exact: false }),
			).toBeVisible({ timeout: T });
			if (asked.length === 0)
				await w.page.screenshot({
					path: join(TOOL_SHOTS, "approval-command-1280-dark.png"),
				});
			asked.push(command);
			await answerYes(w);
			await expect(approvalCard(w).locator(".approval-path-text").filter({ hasText: command })).toHaveCount(0, { timeout: T });
		}
		assert.ok(asked.length >= 1 && asked.every((command) => [ANSI, RANDOM_BYTES, SEQ, FAILING].includes(command)), `asked: ${asked.join(" | ")}`);
		assert.equal(asked.at(-1), FAILING, "the failing command is the last one asked");
		// The engine's own check on written files makes the scripted model say its last line twice.
		await expect(w.page.getByText("Tour finished.").first()).toBeVisible({
			timeout: T,
		});

		// The folded work: open it, then the run inside it.
		const work = w.page.locator(".activity-trigger").first();
		if ((await work.getAttribute("aria-expanded")) !== "true")
			await work.click();
		// A group that would only repeat the fold line's sentence is not drawn: its rows are.
		const group = w.page.locator(".tool-run-trigger").first();
		if ((await group.count()) > 0 && (await group.getAttribute("aria-expanded")) !== "true")
			await group.click();

		// Headlines come from fields: no prefix, no wire text, no absolute path.
		const page = w.page;
		await expect(toolRow(w, "Read a.ts")).toBeVisible();
		await expect(toolRow(w, "Read b.ts")).toBeVisible();
		await expect(toolRow(w, "Read Çalışma-ğüş.md")).toBeVisible();
		await expect(toolRow(w, "Searched for export")).toContainText("matches in");
		await expect(toolRow(w, "Listed **/*.ts")).toBeVisible();
		await expect(
			toolRow(w, "Couldn’t read missing.txt: file not found"),
		).toBeVisible();
		await expect(
			toolRow(w, "Namzu tried a tool it doesn’t have (ls)"),
		).toBeVisible();
		await expect(toolRow(w, "Edited a.ts")).toBeVisible();
		await expect(toolRow(w, "Edited a.ts")).toContainText("+2");
		await expect(toolRow(w, "Created n.txt")).toBeVisible();
		await expect(toolRow(w, "Ran printf")).toBeVisible();
		await expect(toolRow(w, "Ran head -c 3000 /dev/urandom")).toBeVisible();
		await expect(toolRow(w, "Ran seq 1 600")).toBeVisible();
		await expect(toolRow(w, `Ran ${FAILING}`)).toContainText("Exit code 3");
		const transcript = await page.locator(".normal-transcript").innerText();
		for (const forbidden of [
			"STDOUT",
			"STDERR",
			"Error:",
			"ENOENT",
			"replacement(s)",
			"match(es)",
			"credential",
			"withheld",
			"retained output",
			"host-authorized",
			"�",
			"\u001b",
			w.project,
		]) {
			assert.ok(
				!transcript.includes(forbidden),
				`the transcript never shows ${JSON.stringify(forbidden)}`,
			);
		}
		// The fold line is the header: its one group would only repeat it, so the group is not drawn.
		const header = (await work.innerText()).replace(/\s+/g, " ");
		assert.match(
			header,
			/^Read \d+ files?, searched \d+ times?/,
			`the group header counts by kind: ${header}`,
		);
		await shootTool(w, "tour-collapsed", work);

		// Output sits under its row: colour drawn, bytes never dumped, a long one folded, an error in the error tone.
		const printf = toolRow(w, "Ran printf");
		await expect(printf.locator(".ansi-red")).toHaveText("red");
		await expect(printf.locator(".ansi-green.ansi-bold")).toHaveText("green");
		await expect(printf.locator(".ansi-underline")).toHaveText("und");
		assert.equal(
			(await printf.locator(".shell-cell-output").innerText()).trim(),
			"red green und",
			"the output is the words, with no escape text left",
		);
		await expect(toolRow(w, "Ran head -c 3000")).toContainText("Binary output, 3 KB");
		const seq = toolRow(w, "Ran seq 1 600");
		await expect(seq.locator(".shell-cell-line")).toHaveCount(3);
		const more = seq.getByRole("button", { name: /^\+\d+ lines$/ });
		await expect(more).toBeVisible();
		assert.ok(
			!(await seq.innerText()).includes("\n300\n"),
			"the middle of a long output is folded away",
		);
		const failing = toolRow(w, `Ran ${FAILING}`);
		// Output first, then how it ended: said once, in the error colour, never beside the headline.
		await expect(failing).toContainText("partial");
		await expect(failing.locator(".shell-cell-err").first()).toContainText("oops");
		assert.equal((await failing.innerText()).match(/Exit code 3/g)?.length, 1);
		await expect(failing).not.toContainText("failed (exit 3)");
		await shootTool(w, "tour-open", failing);

		await more.click();
		await expect(seq.getByRole("button", { name: "Show less" })).toBeVisible();
		await expect(seq).toContainText("lines not shown");
		// No row scrolls sideways: output wraps.
		const wide = await page.evaluate(
			() =>
				[
					...document.querySelectorAll(
						".tool-output, .tool-content, .tool-label",
					),
				].filter((node) => {
					const style = getComputedStyle(node);
					return (
						node.scrollWidth > node.clientWidth + 1 &&
						style.overflowX !== "hidden" &&
						style.textOverflow !== "ellipsis"
					);
				}).length,
		);
		assert.equal(wide, 0, "no tool output scrolls sideways");
		await shootTool(w, "tour-expanded", seq);
	},
);
