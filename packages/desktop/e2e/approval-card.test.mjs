// The approval card's holds and its extra answers, in the real app: "Allow for this conversation", Esc
// as a No, the keyboard starting on Reject for a delete, the end-of-command read gate and the click guard
// that keeps a click aimed at one card from answering the next. Real Electron, real CLI host, scripted model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/approval-card.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld(options);
		let failed = true;
		try {
			await launch(world);
			await openProject(world);
			await body(world);
			assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

const card = (w) => w.page.getByRole("region", { name: "Tool approval" });
const accept = (w) => card(w).getByRole("button", { name: "Accept", exact: true });
const reject = (w) => card(w).getByRole("button", { name: "Reject", exact: true });
const standing = (w) => card(w).getByRole("button", { name: "Allow for this conversation" });

const TWO_FILES = {
	match: /write both files/i,
	steps: [
		{ tool: "write", args: { path: "a.txt", content: "first\n" } },
		{ tool: "write", args: { path: "b.txt", content: "second\n" } },
		{ text: "Wrote both files." },
	],
};

// The scripted model sometimes sends its closing sentence twice; a flow looks at the first.
// A command long enough to overflow the card's command box, with the part that matters on its last line.
const LONG_COMMAND = `${Array.from({ length: 40 }, (_, i) => `# step ${i + 1}`).join("\n")}\necho done > ran.txt`;

flow(
	"Allow for this conversation answers this card and stops the next one from asking",
	{ rules: [TWO_FILES] },
	async (w) => {
		await send(w, "Please write both files");
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(card(w).getByRole("heading", { name: "Create a.txt?" })).toBeVisible();
		// A quiet action beside the two answers, never a filled button.
		await expect(standing(w)).toBeVisible();
		assert.equal(
			await standing(w).evaluate((node) => node.getAttribute("data-tone")),
			null,
			"it carries no accept or reject tone",
		);
		// It says what the latch does: ordinary asks stop, and the few that always need a person still come back.
		const said = await standing(w).getAttribute("title");
		assert.match(said, /stops asking about most actions in it, deletes and commands included/);
		assert.match(said, /still asks before the few things that always need you/);
		assert.doesNotMatch(said, /will not ask again|for anything/);
		await shot(w, "allow-for-conversation");
		assert.equal(existsSync(join(w.project, "a.txt")), false, "nothing is written before the answer");
		await standing(w).click();
		// The second write is the same conversation's next ask: the agent's latch answers it with no card.
		await expect(w.page.getByText("Wrote both files.").first()).toBeVisible({ timeout: T });
		assert.equal(readFileSync(join(w.project, "a.txt"), "utf8"), "first\n");
		assert.equal(readFileSync(join(w.project, "b.txt"), "utf8"), "second\n");
		await expect(card(w)).toHaveCount(0);
	},
);

// After the standing yes, an ordinary write runs with no card, and a write the agent always asks about
// (a git hook directory is protected in every mode) still gets a card, with no standing yes on it.
const THEN_A_HOOK = {
	match: /write a file and then a hook/i,
	steps: [
		{ tool: "write", args: { path: "a.txt", content: "first\n" } },
		{ tool: "write", args: { path: "b.txt", content: "second\n" } },
		{ tool: "write", args: { path: ".husky/pre-commit", content: "echo hi\n" } },
		{ text: "Wrote the hook." },
	],
};

flow(
	"Allow for this conversation does not cover a write the agent always asks about",
	{ rules: [THEN_A_HOOK] },
	async (w) => {
		await send(w, "Please write a file and then a hook");
		await expect(card(w).getByRole("heading", { name: "Create a.txt?" })).toBeVisible({ timeout: T });
		await standing(w).click();
		// b.txt is an ordinary ask: the latch answers it with no card, and the hook is the next card.
		await expect(card(w).getByRole("heading", { name: "Create .husky/pre-commit?" })).toBeVisible({
			timeout: T,
		});
		assert.equal(readFileSync(join(w.project, "b.txt"), "utf8"), "second\n");
		assert.equal(existsSync(join(w.project, ".husky", "pre-commit")), false, "the hook is not written before the answer");
		// The agent marked it, so the window does not offer a standing yes on it.
		await expect(standing(w)).toHaveCount(0);
		await shot(w, "always-asked-after-standing-yes");
		await accept(w).click();
		await expect(w.page.getByText("Wrote the hook.").first()).toBeVisible({ timeout: T });
		assert.equal(readFileSync(join(w.project, ".husky", "pre-commit"), "utf8"), "echo hi\n");
	},
);

flow(
	"a plain Accept still asks again for the next write",
	{ rules: [TWO_FILES] },
	async (w) => {
		await send(w, "Please write both files");
		await expect(card(w).getByRole("heading", { name: "Create a.txt?" })).toBeVisible({ timeout: T });
		await accept(w).click();
		await expect(card(w).getByRole("heading", { name: "Create b.txt?" })).toBeVisible({ timeout: T });
		assert.equal(existsSync(join(w.project, "b.txt")), false);
		await accept(w).click();
		await expect(w.page.getByText("Wrote both files.").first()).toBeVisible({ timeout: T });
	},
);

flow(
	"the standing yes is withheld from an overwrite, and Enter still lands on Accept for it",
	{
		rules: [
			{
				match: /replace the file/i,
				steps: [{ tool: "write", args: { path: "out.txt", content: "new\n" } }, { text: "Replaced." }],
			},
		],
		files: { "out.txt": "old\n" },
	},
	async (w) => {
		await send(w, "Please replace the file");
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(card(w).getByText("This replaces out.txt, which already exists.")).toBeVisible();
		await expect(standing(w)).toHaveCount(0);
		await expect(accept(w)).toBeFocused();
		await shot(w, "overwrite-no-standing-yes");
		await accept(w).click();
		await expect(w.page.getByText("Replaced.").first()).toBeVisible({ timeout: T });
	},
);

flow(
	"a command that deletes starts on Reject and offers no standing yes",
	{
		rules: [
			{
				match: /clean up/i,
				steps: [{ tool: "bash", args: { command: "rm -rf build" } }, { text: "Left it alone." }],
			},
		],
		files: { "build/keep.txt": "keep\n" },
	},
	async (w) => {
		await send(w, "Please clean up");
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(reject(w)).toBeFocused();
		await expect(standing(w)).toHaveCount(0);
		// The keys are said on the buttons now, not in a line of text under the card.
		await expect(reject(w)).toHaveAttribute("title", "Reject · Enter or Esc");
		await expect(accept(w)).toHaveAttribute("title", /Enter rejects it/);
		// What the kernel knows is the first thing on the card after the question.
		await expect(card(w).locator(".approval-flag").first()).toHaveText(
			"Looks like it deletes or overwrites files.",
		);
		await shot(w, "risky-command");
		// Enter on the focused button is a No.
		await w.page.keyboard.press("Enter");
		await expect(w.page.getByText("Left it alone.").first()).toBeVisible({ timeout: T });
		assert.equal(existsSync(join(w.project, "build", "keep.txt")), true);
	},
);

flow(
	"Esc answers the card with a No and the reply carries on",
	{
		rules: [
			{
				match: /write the file/i,
				steps: [{ tool: "write", args: { path: "out.txt", content: "x\n" } }, { text: "Carried on." }],
			},
		],
	},
	async (w) => {
		await send(w, "Please write the file");
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(accept(w)).toBeFocused();
		await w.page.keyboard.press("Escape");
		await expect(card(w)).toHaveCount(0, { timeout: T });
		// The turn was not stopped: the model got its next turn and finished it.
		await expect(w.page.getByText("Carried on.").first()).toBeVisible({ timeout: T });
		assert.equal(existsSync(join(w.project, "out.txt")), false, "a No writes nothing");
		const last = JSON.stringify(w.model.requests.at(-1)?.messages ?? []);
		assert.match(last, /declined/i, "the model is told the person declined");
	},
);

flow(
	"a long command is four rows and a link, and Accept is not held for scrolling",
	{
		rules: [
			{
				match: /run the long one/i,
				steps: [{ tool: "bash", args: { command: LONG_COMMAND } }, { text: "Ran it." }],
			},
		],
	},
	async (w) => {
		await send(w, "Please run the long one");
		await expect(card(w)).toBeVisible({ timeout: T });
		const rows = card(w).locator(".approval-row");
		await expect(rows).toHaveCount(4);
		// The link states how much more there is, and nothing asks for the end to be scrolled to.
		const more = card(w).getByRole("button", { name: "Show all 41 lines" });
		await expect(more).toBeVisible();
		await expect(card(w).getByText(/^Scroll /)).toHaveCount(0);
		await expect(accept(w)).not.toHaveAttribute("data-held", "true", { timeout: T });
		await expect(accept(w)).not.toHaveAttribute("aria-disabled", "true");
		await shot(w, "long-command-collapsed");
		// Opening it in place shows the whole command, the line that matters last.
		await more.click();
		await expect(card(w).getByLabel("Command")).toContainText("echo done > ran.txt");
		await expect(card(w).getByRole("button", { name: "Show less" })).toBeVisible();
		await shot(w, "long-command-open");
		await accept(w).click();
		await expect(w.page.getByText("Ran it.").first()).toBeVisible({ timeout: T });
		assert.equal(existsSync(join(w.project, "ran.txt")), true, "it ran once accepted");
	},
);

flow(
	"the box's menu holds the note, wrap and copy, and the note still redirects the model",
	{
		rules: [
			{
				match: /write the file/i,
				steps: [{ tool: "write", args: { path: "out.txt", content: "x\n" } }, { text: "Noted." }],
			},
		],
	},
	async (w) => {
		await send(w, "Please write the file");
		await expect(card(w)).toBeVisible({ timeout: T });
		await card(w).getByRole("button", { name: "More about this request" }).click();
		const menu = w.page.getByRole("menu", { name: "More about this request" });
		await expect(menu.getByRole("menuitem", { name: "Tell Namzu what to do instead" })).toBeVisible();
		await expect(menu.getByRole("menuitemcheckbox", { name: /Wrap lines/ })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Copy" })).toBeVisible();
		await shot(w, "box-menu");
		// Escape closes the menu, not the card: the card is still waiting.
		await w.page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(card(w)).toBeVisible();
		await card(w).getByRole("button", { name: "More about this request" }).click();
		await menu.getByRole("menuitem", { name: "Tell Namzu what to do instead" }).click();
		await card(w).getByRole("textbox", { name: "Tell Namzu what to do instead" }).fill("use notes.txt");
		await card(w).getByRole("button", { name: "Send", exact: true }).click();
		await expect(card(w)).toHaveCount(0, { timeout: T });
		await expect
			.poll(() => JSON.stringify(w.model.requests.at(-1)?.messages ?? []), { timeout: T })
			.toContain("use notes.txt");
		assert.equal(existsSync(join(w.project, "out.txt")), false);
	},
);

flow(
	"a short command is never held",
	{
		rules: [
			{
				match: /say hi/i,
				steps: [{ tool: "bash", args: { command: "echo hi > hi.txt" } }, { text: "Said hi." }],
			},
		],
	},
	async (w) => {
		await send(w, "Please say hi");
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(accept(w)).not.toHaveAttribute("data-held", "true");
		await expect(accept(w)).not.toHaveAttribute("aria-disabled", "true", { timeout: T });
		await expect(card(w).getByText(/^Scroll /)).toHaveCount(0);
		await accept(w).click();
		await expect(w.page.getByText("Said hi.").first()).toBeVisible({ timeout: T });
	},
);

flow(
	"a click aimed at one card does not answer the card that replaces it",
	{ rules: [TWO_FILES] },
	async (w) => {
		// The page's clock is held still so the 400 ms guard is decided by this flow, not by how fast
		// the machine is: time moves only when the flow moves it.
		await w.page.evaluate(() => {
			let now = Date.now();
			window.__advance = (ms) => {
				now += ms;
			};
			Date.now = () => now;
		});
		const advance = (ms) => w.page.evaluate((by) => window.__advance(by), ms);
		await send(w, "Please write both files");
		await expect(card(w).getByRole("heading", { name: "Create a.txt?" })).toBeVisible({ timeout: T });
		// The first card has not had its 400 ms: it says Accept is unavailable and a click does nothing.
		await expect(accept(w)).toHaveAttribute("aria-disabled", "true");
		await accept(w).click({ force: true });
		await expect(card(w).getByRole("heading", { name: "Create a.txt?" })).toBeVisible();
		assert.equal(existsSync(join(w.project, "a.txt")), false);
		await advance(400);
		// Another render is needed for the card to drop its marker; the guard itself has already ended.
		await accept(w).click();
		// The second request appears as a new card, whose guard starts over: a second click of the same
		// double-click lands on it and is ignored.
		await expect(card(w).getByRole("heading", { name: "Create b.txt?" })).toBeVisible({ timeout: T });
		await expect(accept(w)).toHaveAttribute("aria-disabled", "true");
		await accept(w).click({ force: true });
		await expect(card(w).getByRole("heading", { name: "Create b.txt?" })).toBeVisible();
		assert.equal(existsSync(join(w.project, "b.txt")), false, "the second card was not answered by the stray click");
		await advance(400);
		await accept(w).click();
		await expect(w.page.getByText("Wrote both files.").first()).toBeVisible({ timeout: T });
		assert.equal(readFileSync(join(w.project, "a.txt"), "utf8"), "first\n");
		assert.equal(readFileSync(join(w.project, "b.txt"), "utf8"), "second\n");
		// The request, each write's result and the reply, then the engine's own check on files written and never run:
		// nothing a stray click sent.
		assert.equal(w.model.requests.length, 4);
		assert.match(JSON.stringify(w.model.requests[3].messages.at(-1)), /nothing was run afterwards/);
	},
);
