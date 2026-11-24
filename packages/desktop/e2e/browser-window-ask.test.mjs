// Computer use aimed at a browser window: the consent question in Desktop and what the click does after each
// answer. Real Electron, real CLI host, scripted model, a stand-in computer whose only window is Brave; the
// owner's own browser is never touched. The stand-in records every click in NAMZU_E2E_BROWSER_LOG.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/browser-window-ask.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	createWorld,
	dispose,
	expect,
	launch,
	openProject,
	send,
} from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function flow(name, setting, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld({
			providers: [{ id: "anthropic", model: "claude-sonnet-5-5" }],
			messagesRules: [
				{
					match: /Brave/i,
					steps: [
						{ tool: "search_tools", args: { query: "select:computer_use" } },
						{ tool: "computer_use", args: { type: "list_windows" } },
						{
							tool: "computer_use",
							args: { type: "screenshot", window_id: "0x4a00007" },
						},
						{
							tool: "computer_use",
							args: { type: "mouse_click", at: { x: 100, y: 60 } },
						},
						{ text: "Finished with the browser window." },
					],
				},
			],
		});
		world.log = join(world.root, "clicks.jsonl");
		world.env = {
			NAMZU_E2E_BROWSER_COMPUTER: "1",
			NAMZU_E2E_BROWSER_LOG: world.log,
		};
		writeFileSync(
			join(world.home, "config.yaml"),
			`computerUse:\n  enabled: true\n${setting ? `  browserWindows: ${setting}\n` : ""}`,
		);
		let failed = true;
		try {
			await launch(world);
			await openProject(world);
			await body(world);
			assert.deepEqual(
				world.faults ?? [],
				[],
				"the renderer raised no uncaught errors",
			);
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

const clicks = (w) =>
	existsSync(w.log)
		? readFileSync(w.log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
const questionCard = (w) =>
	w.page.getByRole("region", { name: "A question about a browser window" });
// Every computer action is a "Permission to act" card first (Accept is the person's, the scripted model never answers
// it). Accept those until `target` shows. The browser is asked about once: Desktop's own per-application card is
// never drawn for it, and the cards that name Brave are recorded in w.braveCards so a test can count them.
const braveCards = (w) => (w.braveCards ??= []);
async function acceptUntil(w, target) {
	const act = w.page.getByRole("region", { name: "Permission to act" });
	const access = w.page.getByRole("region", { name: "Use of an app" });
	const browser = questionCard(w);
	await expect
		.poll(
			async () => {
				if (await target.first().isVisible()) return true;
				for (const card of [access, browser, act]) {
					if (await card.count()) {
						const title = (await card.getByRole("heading").first().textContent()) ?? "";
						if (/Brave/i.test(title) && !braveCards(w).includes(title + (card === browser ? "|browser" : "|app")))
							braveCards(w).push(title + (card === browser ? "|browser" : "|app"));
					}
				}
				// The browser question is the person's: a test answers it itself, so it is left showing.
				if (await browser.count()) return false;
				if (await access.count())
					await access
						.getByRole("button", { name: "Allow", exact: true })
						.click();
				else if (await act.count())
					await act
						.getByRole("button", { name: "Accept", exact: true })
						.click();
				return false;
			},
			{ timeout: T },
		)
		.toBe(true);
}
const finished = (w) => w.page.getByText("Finished with the browser window.");

flow(
	"the question names the browser and Allow for this conversation lets the click through",
	undefined,
	async (w) => {
		await send(
			w,
			"Computer use'u kullan, açık Brave penceresinde Sites → Active sites'a tıkla (Brave)",
		);
		await acceptUntil(w, questionCard(w));
		// Exactly one card for the browser before the first click, in the browser's words: Desktop's own
		// "Allow Namzu to use Brave" card is not drawn as well.
		assert.deepEqual(
			braveCards(w),
			["Let Namzu click and type in Brave in this conversation?|browser"],
			"one card for Brave, and it is the browser card",
		);
		await expect(questionCard(w).getByRole("heading")).toContainText(
			"click and type in Brave",
		);
		await expect(questionCard(w)).toContainText("in this conversation");
		await expect(
			questionCard(w).getByRole("button", {
				name: "Allow for this conversation",
			}),
		).toBeVisible();
		await expect(
			questionCard(w).getByRole("button", { name: "Not now" }),
		).toBeVisible();
		await expect(
			questionCard(w).getByRole("button", { name: "Allow once" }),
		).toHaveCount(0);
		assert.deepEqual(clicks(w), [], "nothing is clicked before the answer");
		await shot(w, "desktop-browser-question");
		await questionCard(w)
			.getByRole("button", { name: "Allow for this conversation" })
			.click();
		await acceptUntil(w, finished(w));
		assert.equal(
			clicks(w).length,
			1,
			"one click reached the window after the yes",
		);
		assert.equal(
			braveCards(w).length,
			1,
			"the yes answered the application and the engine's question both: no second card for Brave",
		);
		await shot(w, "desktop-browser-after-allow");
	},
);

flow(
	"Not now keeps the window look-only and the click never happens",
	undefined,
	async (w) => {
		await send(
			w,
			"Computer use'u kullan, açık Brave penceresinde Sites → Active sites'a tıkla (Brave)",
		);
		await acceptUntil(w, questionCard(w));
		assert.equal(braveCards(w).length, 1, "one card for Brave");
		await questionCard(w).getByRole("button", { name: "Not now" }).click();
		await acceptUntil(w, finished(w));
		assert.deepEqual(clicks(w), [], "no click reached the browser");
		await shot(w, "desktop-browser-after-not-now");
	},
);

flow("look never asks and never clicks", "look", async (w) => {
	await send(
		w,
		"Computer use'u kullan, açık Brave penceresinde Sites → Active sites'a tıkla (Brave)",
	);
	await acceptUntil(w, finished(w));
	assert.equal(await questionCard(w).count(), 0, "no question under look");
	assert.deepEqual(clicks(w), []);
});

flow("act clicks with no question", "act", async (w) => {
	await send(
		w,
		"Computer use'u kullan, açık Brave penceresinde Sites → Active sites'a tıkla (Brave)",
	);
	await acceptUntil(w, finished(w));
	assert.equal(await questionCard(w).count(), 0);
	assert.equal(clicks(w).length, 1);
});
