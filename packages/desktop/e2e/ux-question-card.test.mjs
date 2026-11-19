// A question the agent puts to the person, in the real app: the card above the message box, its choices,
// the recommended mark, "Other" for the person's own words, a multiple choice, the keys (a number, Enter on
// the main keys and on the number pad, Ctrl+Enter, Esc), and the answer reaching the model. The scripted
// model calls ask_user_question; the next request it receives is read to see what the person's answer was.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-question-card.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set (dark and light at 1280 by 833, and 900 by 700).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 90000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;

const AUDIENCE = {
	question: "Who is the audience for the deck?",
	header: "Audience",
	options: [
		{ label: "Board", description: "High level, a few slides", recommended: true },
		{ label: "Engineers", description: "Details and diagrams" },
	],
};
const ENVIRONMENTS = {
	question: "Which environments should it cover?",
	header: "Environment",
	multiSelect: true,
	allowFreeText: false,
	options: [
		{ label: "Staging", description: "The shared test setup" },
		{ label: "Production" },
		{ label: "Local" },
	],
};

const rule = (match, questions) => ({
	match,
	steps: [{ tool: "ask_user_question", args: { questions } }, { text: "Noted, going on." }],
});

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld({ answerHistory: true, tabs: "hidden", ...options });
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

const card = (w) => w.page.getByRole("region", { name: "A question from Namzu" });
const row = (w, name) => card(w).locator('[role="radio"], [role="checkbox"]').filter({ hasText: name });
const send_ = (w) => card(w).getByRole("button", { name: /^Send/ });
const skip = (w) => card(w).getByRole("button", { name: /^Skip/ });

/** The tool result the model was handed after the person answered: the last tool message it received. */
function toolResult(w) {
	const request = [...w.model.requests].reverse().find((r) => r.messages?.some((m) => m.role === "tool"));
	assert.ok(request, "the model received a request that carries the tool result");
	const tool = [...request.messages].reverse().find((m) => m.role === "tool");
	return typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content);
}

async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [x, y]) => {
			for (const b of BrowserWindow.getAllWindows()) b.setContentSize(x, y);
		},
		[width, height],
	);
	await w.page.waitForFunction(([x]) => Math.abs(window.innerWidth - x) < 2, [width]);
}

async function appearance(w, next) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, next);
	await expect(w.page.locator("html")).toHaveClass(next === "dark" ? /dark/ : /^(?!.*dark)/);
}

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.evaluate(() =>
		Promise.all(
			document
				.getAnimations()
				.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
				.map((a) => a.finished.catch(() => {})),
		),
	);
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The layout audit: the card sits inside the window, nothing in it overflows sideways, and no two rows overlap. */
async function audit(w, label) {
	const found = await w.page.evaluate(() => {
		const card = document.querySelector(".question-card");
		if (!card) return { missing: true };
		const box = card.getBoundingClientRect();
		const bad = [];
		if (box.left < 0 || box.right > window.innerWidth + 0.5) bad.push("the card leaves the window");
		if (card.scrollWidth > card.clientWidth + 1) bad.push("the card scrolls sideways");
		const rows = [...card.querySelectorAll(".question-row")].map((el) => el.getBoundingClientRect());
		for (let i = 1; i < rows.length; i++)
			if (rows[i].top < rows[i - 1].bottom - 0.5) bad.push(`row ${i + 1} overlaps row ${i}`);
		for (const el of card.querySelectorAll(".question-row, .question-text, .approval-button")) {
			const b = el.getBoundingClientRect();
			if (b.right > box.right + 0.5 || b.left < box.left - 0.5) bad.push(`${el.className} sticks out of the card`);
		}
		const composer = document.querySelector("[data-chat-composer-body]")?.getBoundingClientRect();
		if (composer && box.bottom > composer.top + 24) bad.push("the card covers the message box");
		return { bad, width: box.width, height: box.height };
	});
	assert.ok(!found.missing, `${label}: there is a card`);
	assert.deepEqual(found.bad, [], `${label}: the card passes the layout audit`);
}

flow(
	"a question is a card above the box, the recommended choice is named, and a pick with Send answers it",
	{ rules: [rule(/make the deck/i, [AUDIENCE])] },
	async (w) => {
		await send(w, "Please make the deck");
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(card(w).getByText("Who is the audience for the deck?")).toBeVisible();
		await expect(row(w, /Board/)).toBeVisible();
		await expect(row(w, /Engineers/)).toBeVisible();
		await expect(row(w, /Other/)).toBeVisible();
		await expect(card(w).getByText("High level, a few slides")).toBeVisible();
		// The recommendation is said in words, on the one choice the model flagged.
		assert.equal(await card(w).getByText("Recommended", { exact: true }).count(), 1);
		await expect(row(w, /Board/).getByText("Recommended", { exact: true })).toBeVisible();
		// The conversation reads as waiting on a question, not on an approval.
		await expect(w.page.getByText("Question waiting").first()).toBeAttached();
		assert.equal(await w.page.getByRole("region", { name: "Tool approval" }).count(), 0);
		// The card is directly above the message box, in the same column.
		const above = await w.page.evaluate(() => {
			const c = document.querySelector(".question-card").getBoundingClientRect();
			const m = document.querySelector("[data-chat-composer-body]").getBoundingClientRect();
			return { gap: m.top - c.bottom };
		});
		assert.ok(above.gap >= 0 && above.gap < 80, `the card sits just above the box (gap ${above.gap})`);
		for (const [width, height, name] of [
			[1280, 833, "1280"],
			[900, 700, "900"],
		]) {
			await size(w, width, height);
			for (const mode of ["dark", "light"]) {
				await appearance(w, mode);
				await audit(w, `${mode} ${width}`);
				await shot(w, `question-${name}-${mode}`);
			}
		}
		await size(w, 1280, 833);
		await appearance(w, "dark");
		await row(w, /Engineers/).click();
		// A single choice is its own answer; Send is what hands it over.
		await expect(row(w, /Engineers/)).toHaveAttribute("aria-checked", "true");
		await send_(w).click();
		await expect(card(w)).toHaveCount(0, { timeout: T });
		await expect(w.page.getByText("Noted, going on.").first()).toBeVisible({ timeout: T });
		assert.match(toolResult(w), /User answered "Who is the audience for the deck\?": "Engineers"/);
	},
);

flow(
	"the keys answer a batch: a number, Other with the number pad's Enter, a multiple choice and Ctrl+Enter",
	{ rules: [rule(/plan the rollout/i, [AUDIENCE, ENVIRONMENTS])] },
	async (w) => {
		await send(w, "Please plan the rollout");
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(card(w).getByText("1 of 2", { exact: true })).toBeVisible();
		// The card has the keyboard: the third row is Other, so 3 opens its box and puts the caret in it.
		await w.page.keyboard.press("3");
		const words = card(w).getByRole("textbox", { name: "Your own answer" });
		await expect(words).toBeFocused();
		await shot(w, "question-other-open");
		await w.page.keyboard.type("the sales team");
		// Enter on the number pad confirms just as the main Enter does: on to the next question.
		await w.page.keyboard.press("NumpadEnter");
		await expect(card(w).getByText("Which environments should it cover?")).toBeVisible();
		await expect(card(w).getByText("2 of 2", { exact: true })).toBeVisible();
		await expect(card(w).getByRole("checkbox")).toHaveCount(3);
		await expect(card(w).getByText("Say it in your own words")).toHaveCount(0);
		await w.page.keyboard.press("1");
		await w.page.keyboard.press("2");
		await expect(row(w, /Staging/)).toHaveAttribute("aria-checked", "true");
		await expect(row(w, /Production/)).toHaveAttribute("aria-checked", "true");
		await expect(row(w, /Local/)).toHaveAttribute("aria-checked", "false");
		// Arrow keys move between rows; Space ticks the focused one.
		await w.page.keyboard.press("ArrowDown");
		await w.page.keyboard.press("ArrowDown");
		await expect(row(w, /Local/)).toBeFocused();
		await w.page.keyboard.press("Space");
		await expect(row(w, /Local/)).toHaveAttribute("aria-checked", "true");
		await w.page.keyboard.press("Space");
		await expect(row(w, /Local/)).toHaveAttribute("aria-checked", "false");
		await shot(w, "question-multiple");
		await w.page.keyboard.press("Control+Enter");
		await expect(card(w)).toHaveCount(0, { timeout: T });
		await expect(w.page.getByText("Noted, going on.").first()).toBeVisible({ timeout: T });
		const result = toolResult(w);
		assert.match(result, /Audience \(own words\): "the sales team"/);
		assert.match(result, /Environment: "Staging", "Production"/);
	},
);

flow(
	"Esc skips the question and the model is told nobody answered",
	{ rules: [rule(/make the deck/i, [AUDIENCE])] },
	async (w) => {
		await send(w, "Please make the deck");
		await expect(card(w)).toBeVisible({ timeout: T });
		await w.page.keyboard.press("Escape");
		await expect(card(w)).toHaveCount(0, { timeout: T });
		await expect(w.page.getByText("Noted, going on.").first()).toBeVisible({ timeout: T });
		assert.match(toolResult(w), /did not answer/);
	},
);

flow(
	"the number pad's Enter picks the focused choice, and Send stays off until something is answered",
	{ rules: [rule(/make the deck/i, [AUDIENCE])] },
	async (w) => {
		await send(w, "Please make the deck");
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(send_(w)).toBeDisabled();
		await w.page.keyboard.press("ArrowDown");
		await expect(row(w, /Engineers/)).toBeFocused();
		await w.page.keyboard.press("NumpadEnter");
		// A single choice is its own answer: Send takes the focus, and a second Enter sends it.
		await expect(send_(w)).toBeFocused();
		await expect(row(w, /Engineers/)).toHaveAttribute("aria-checked", "true");
		await shot(w, "question-picked");
		await w.page.keyboard.press("NumpadEnter");
		await expect(card(w)).toHaveCount(0, { timeout: T });
		await expect(w.page.getByText("Noted, going on.").first()).toBeVisible({ timeout: T });
		assert.match(toolResult(w), /"Engineers"/);
	},
);

flow(
	"stopping the reply while a question waits closes the card and leaves a usable box",
	{ rules: [rule(/make the deck/i, [AUDIENCE])] },
	async (w) => {
		await send(w, "Please make the deck");
		await expect(card(w)).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: "Stop reply" }).click();
		await expect(card(w)).toHaveCount(0, { timeout: T });
		await expect(w.page.getByText("Question waiting")).toHaveCount(0);
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		// The conversation takes another message.
		await send(w, "Please make the deck again");
		await expect(card(w)).toBeVisible({ timeout: T });
	},
);
