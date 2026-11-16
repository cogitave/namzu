// Computer use in Namzu Desktop: the working pill (always on top, never takes focus, kept out of the
// agent's own screenshots, answers questions, has Stop), one question per application in place of a
// card per action, what the model saw drawn small beside the call, and bringing a covered window
// back for a question. Real Electron, real CLI host driving a stand-in screen, scripted model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/pill-computer.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computerStub } from "./computer-stub.mjs";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;

async function shot(w, name, page = w.page) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const bin = computerStub();
		// The Messages wire carries an image in a tool result; the chat-completions wire does not, and the
		// tool would then be mounted as a diagnostic that refuses every call.
		const { rules, ...rest } = options;
		const world = await createWorld({
			...rest,
			providers: [{ id: "anthropic", model: "claude-sonnet-5-5" }],
			messagesRules: rules,
			pathPrefix: bin,
		});
		let failed = true;
		try {
			await launch(world);
			// Every call to the window-protection switch is recorded, so the flow can see it was asked for.
			await world.app.evaluate(({ BrowserWindow }) => {
				globalThis.__protected = [];
				const original = BrowserWindow.prototype.setContentProtection;
				BrowserWindow.prototype.setContentProtection = function (value) {
					globalThis.__protected.push({ title: this.getTitle(), value });
					return original.call(this, value);
				};
			});
			await openProject(world);
			await body(world);
			assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
			rmSync(bin, { recursive: true, force: true });
		}
	});
}

/** The pill's own page, once it exists. */
async function pillPage(w) {
	let found;
	await expect
		.poll(
			async () => {
				for (const page of w.app.windows()) {
					if ((await page.title().catch(() => "")) === "Namzu working") {
						found = page;
						return true;
					}
				}
				return false;
			},
			{ timeout: T },
		)
		.toBe(true);
	return found;
}

/** What the system says about the pill's window. */
const pillWindow = (w) =>
	w.app.evaluate(({ BrowserWindow, screen }) => {
		const win = BrowserWindow.getAllWindows().find((item) => item.getTitle() === "Namzu working");
		if (!win) return null;
		const area = screen.getPrimaryDisplay().workArea;
		return {
			visible: win.isVisible(),
			onTop: win.isAlwaysOnTop(),
			focusable: win.isFocusable(),
			focused: win.isFocused(),
			bounds: win.getBounds(),
			area,
		};
	});

const pillVisible = async (w) => (await pillWindow(w))?.visible === true;

const screenCard = (w) => w.page.getByRole("region", { name: "Tool approval" });
const appCard = (w) => w.page.getByRole("region", { name: "Application access" });

const LOOK_AND_CLICK = {
	match: /use the screen/i,
	steps: [
		{ tool: "computer_use", args: { type: "screenshot" } },
		{ tool: "computer_use", args: { type: "mouse_click", at: { x: 100, y: 60 } } },
		{ tool: "computer_use", args: { type: "mouse_click", at: { x: 110, y: 70 } } },
		{ text: "Done with the screen." },
	],
};

flow(
	"the pill shows while Namzu works, answers the questions, and goes when the turn ends",
	{ rules: [LOOK_AND_CLICK] },
	async (w) => {
		await send(w, "Please use the screen");
		// The first look at the screen is asked in the window and in the pill.
		await expect(screenCard(w)).toBeVisible({ timeout: T });
		const pill = await pillPage(w);
		await expect(pill.locator("#title")).toHaveText("Namzu is using your computer", { timeout: T });
		await expect(pill.locator("#q")).toHaveText("Let Namzu look at your screen?");
		await expect(pill.locator("#once")).toBeHidden();
		// It is a window of its own that stays on top, near the top centre, and never takes focus.
		const placed = await pillWindow(w);
		assert.equal(placed.visible, true);
		assert.equal(placed.onTop, true);
		assert.equal(placed.focusable, false, "it cannot take focus from the application being driven");
		assert.equal(placed.focused, false);
		const centre = placed.bounds.x + placed.bounds.width / 2;
		assert.ok(
			Math.abs(centre - (placed.area.x + placed.area.width / 2)) <= 2,
			`centred on the work area (${centre})`,
		);
		assert.ok(placed.bounds.y - placed.area.y < 40, "near the top edge");
		// It asked to be left out of what the screen shows, which is what the agent's own look is.
		const asked = await w.app.evaluate(() => globalThis.__protected);
		assert.ok(
			asked.some((call) => call.title === "Namzu working" && call.value === true),
			`window protection requested: ${JSON.stringify(asked)}`,
		);
		await expect(pill.locator("html")).toHaveAttribute("data-capture-excluded", "true");
		await expect(pill.locator("html")).toHaveAttribute("data-focusable", "false");
		await shot(w, "pill-asking-about-the-screen", pill);
		await pill.locator("#allow").click();
		await expect(screenCard(w)).toHaveCount(0, { timeout: T });
		// Then the agent acts, and the question is about the application, not about the click.
		await expect(appCard(w)).toBeVisible({ timeout: T });
		await expect(appCard(w).getByRole("heading")).toHaveText(
			"Allow Namzu to use the screen in this conversation?",
		);
		await expect(pill.locator("#q")).toHaveText("Allow Namzu to use the screen in this conversation?");
		await expect(pill.locator("#once")).toBeVisible();
		await shot(w, "pill-asking-about-an-app", pill);
		await shot(w, "window-asking-about-an-app");
		await pill.locator("#allow").click();
		// One yes: the second click raises no card at all.
		await expect(w.page.getByText("Done with the screen.").first()).toBeVisible({ timeout: T });
		await expect(appCard(w)).toHaveCount(0);
		// The turn is over: the pill is gone.
		await expect.poll(() => pillVisible(w), { timeout: T }).toBe(false);
	},
);

flow(
	"an answer given in the window takes the pill's question away, and Deny is the person's no",
	{ rules: [LOOK_AND_CLICK] },
	async (w) => {
		await send(w, "Please use the screen");
		await expect(screenCard(w)).toBeVisible({ timeout: T });
		await screenCard(w).getByRole("button", { name: "Accept", exact: true }).click();
		await expect(appCard(w)).toBeVisible({ timeout: T });
		const pill = await pillPage(w);
		await expect(pill.locator("#ask")).toBeVisible();
		await appCard(w).getByRole("button", { name: "Deny" }).click();
		await expect(pill.locator("#ask")).toBeHidden({ timeout: T });
		// The refusal is the person's: the call row says it was declined, not that it failed.
		await expect(w.page.getByText("Declined computer use").first()).toBeVisible({ timeout: T });
	},
);

flow("Stop in the pill stops the turn like the stop button", { rules: [LOOK_AND_CLICK] }, async (w) => {
	await send(w, "Please use the screen");
	await expect(screenCard(w)).toBeVisible({ timeout: T });
	const pill = await pillPage(w);
	await expect(pill.locator("#stop")).toBeVisible();
	await pill.locator("#stop").click();
	// The turn ends without anyone answering, and the question is gone.
	await expect(screenCard(w)).toHaveCount(0, { timeout: T });
	await expect(w.page.getByText(/Stopped\./).first()).toBeVisible({ timeout: T });
	await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
	await expect.poll(() => pillVisible(w), { timeout: T }).toBe(false);
});

const MANY_CLICKS = {
	match: /click a lot/i,
	steps: [
		{ tool: "computer_use", args: { type: "screenshot" } },
		...Array.from({ length: 11 }, (_, i) => ({
			tool: "computer_use",
			args: { type: "mouse_click", at: { x: 60 + i * 10, y: 50 + i * 6 } },
		})),
		{ text: "Clicked a lot." },
	],
};

flow(
	"what the model saw is drawn small beside each call, with the click point, and only the newest few are kept",
	{ rules: [MANY_CLICKS] },
	async (w) => {
		await send(w, "Please click a lot");
		await expect(screenCard(w)).toBeVisible({ timeout: T });
		await screenCard(w).getByRole("button", { name: "Accept", exact: true }).click();
		await expect(appCard(w)).toBeVisible({ timeout: T });
		await appCard(w).getByRole("button", { name: "Allow", exact: true }).click();
		await expect(w.page.getByText("Clicked a lot.").first()).toBeVisible({ timeout: T });
		// The finished turn folds its work away; the pictures are in the rows it holds.
		await w.page.getByRole("button", { name: /^Ran .*used 11 tools/ }).click();
		const thumbs = w.page.getByTestId("computer-frame-thumb");
		// Twelve calls returned a picture; the window keeps the newest eight.
		await expect(thumbs).toHaveCount(8, { timeout: T });
		await expect(w.page.getByTestId("computer-frame-point").first()).toBeVisible();
		const first = thumbs.last();
		assert.match(await first.getAttribute("aria-label"), /What the model saw after: .*click/i);
		// The small picture is small; the large one is bigger and has the point on it.
		const small = await first.locator("img").boundingBox();
		assert.ok(small.width <= 160, `thumbnail width ${small.width}`);
		await shot(w, "thumbnails");
		await first.click();
		const large = w.page.getByTestId("computer-frame-large");
		await expect(large).toBeVisible();
		const big = await large.locator("img").boundingBox();
		assert.ok(big.width > small.width * 1.5, `enlarged ${big.width} vs ${small.width}`);
		await expect(large.getByTestId("computer-frame-point")).toBeVisible();
		await shot(w, "thumbnail-enlarged");
		await w.page.keyboard.press("Escape");
		await expect(large).toHaveCount(0);
		// What the picture holds is bounded: nothing in the window's memory is a full-size screenshot.
		const widest = await w.page.evaluate(() =>
			Math.max(...[...document.querySelectorAll(".computer-frame-thumb img")].map((img) => img.naturalWidth)),
		);
		assert.ok(widest <= 720, `a picture is at most 720 wide (${widest})`);
	},
);

flow(
	"an application is allowed for the conversation, listed in its details, and can be taken back",
	{ rules: [LOOK_AND_CLICK] },
	async (w) => {
		await send(w, "Please use the screen");
		await screenCard(w).getByRole("button", { name: "Accept", exact: true }).click({ timeout: T });
		await appCard(w).getByRole("button", { name: "Allow", exact: true }).click({ timeout: T });
		await expect(w.page.getByText("Done with the screen.").first()).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: "Conversation details" }).click();
		const row = w.page.getByTestId("computer-app-row");
		await expect(row).toContainText("the screen");
		await expect(row).toContainText("Allowed");
		await shot(w, "details-allowed-app");
		await w.page.getByRole("button", { name: "Take back access to the screen" }).click();
		await expect(row).toContainText("Used");
		await w.page.keyboard.press("Escape");
		// It is asked about again in the next turn, and that is the person's to answer.
		await send(w, "Please use the screen");
		await expect(appCard(w)).toBeVisible({ timeout: T });
		await appCard(w).getByRole("button", { name: "Deny" }).click();
	},
);

flow(
	"Allow once answers one step and the next one asks again",
	{ rules: [LOOK_AND_CLICK] },
	async (w) => {
		await send(w, "Please use the screen");
		await screenCard(w).getByRole("button", { name: "Accept", exact: true }).click({ timeout: T });
		await expect(appCard(w)).toBeVisible({ timeout: T });
		await appCard(w).getByRole("button", { name: "Allow once" }).click();
		// The second click is asked about too: nothing was kept.
		await expect(appCard(w)).toBeVisible({ timeout: T });
		await appCard(w).getByRole("button", { name: "Allow once" }).click();
		await expect(w.page.getByText("Done with the screen.").first()).toBeVisible({ timeout: T });
	},
);

const ASKS_A_QUESTION = {
	match: /ask me which/i,
	steps: [{ text: "Which file should I open?" }],
};

flow(
	"a window covered by another application is brought forward once when the turn ends on a question",
	{ rules: [ASKS_A_QUESTION] },
	async (w) => {
		await w.app.evaluate(({ BrowserWindow }) => {
			globalThis.__raised = [];
			const moveTop = BrowserWindow.prototype.moveTop;
			BrowserWindow.prototype.moveTop = function () {
				globalThis.__raised.push("moveTop");
				return moveTop.call(this);
			};
			const flash = BrowserWindow.prototype.flashFrame;
			BrowserWindow.prototype.flashFrame = function (value) {
				globalThis.__raised.push(`flash:${value}`);
				return flash.call(this, value);
			};
			// Another application has the focus.
			for (const win of BrowserWindow.getAllWindows()) win.blur();
		});
		await expect
			.poll(() => w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isFocused())))
			.toBe(false);
		await send(w, "Please ask me which file");
		await expect(w.page.getByText("Which file should I open?").first()).toBeVisible({ timeout: T });
		await expect
			.poll(() => w.app.evaluate(() => globalThis.__raised.filter((entry) => entry === "moveTop").length), {
				timeout: T,
			})
			.toBe(1);
		const raised = await w.app.evaluate(() => globalThis.__raised);
		assert.ok(raised.includes("flash:true"), `its taskbar entry flashed: ${raised}`);
	},
);
