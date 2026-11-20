// A turn a tool paused because it needs the person, in the real app. The scripted model opens a sign-in
// page in the agent's browser (served here: HTTP 401 with a password field, so the browser stops the
// turn). The card above the message box says what to do in plain words, Continue resumes the same turn
// from where it stopped, Stop closes it, and typing a message moves on, so none of it is a dead end.
// A second page answers 200 with a password field: there the model is told to ask the person (a question
// card) instead of naming a terminal command.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-handoff-card.test.mjs
// Needs the browser engine the agent drives: set PLAYWRIGHT_BROWSERS_PATH to a folder that holds it.
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 120000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
const FORM = '<title>Sign in</title><form><h1>Sign in</h1><input name="u"><input type="password" name="p"></form>';

async function pages() {
	const server = createServer((request, response) => {
		response.statusCode = request.url?.startsWith("/open") ? 200 : 401;
		response.setHeader("content-type", "text/html");
		response.end(FORM);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	return { server, hard: `${base}/login`, open: `${base}/open`, site: `127.0.0.1:${server.address().port}` };
}

const NAVIGATE = (url) => [
	{ tool: "search_tools", args: { query: "browser navigate page" } },
	{ tool: "browser", args: { action: "navigate", url } },
];

function flow(name, options, body) {
	test(name, { timeout: 360000 }, async () => {
		const site = await pages();
		const world = await createWorld({
			answerHistory: true,
			tabs: "hidden",
			env: process.env.PLAYWRIGHT_BROWSERS_PATH
				? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
				: {},
			...options(site),
		});
		let failed = true;
		try {
			await launch(world);
			await openProject(world);
			await body(world, site);
			assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			site.server.close();
			await dispose(world, { failed });
		}
	});
}

const card = (w) => w.page.getByRole("region", { name: "Namzu is waiting for you" });
const accept = async (w) => {
	await w.page.getByRole("button", { name: /Accept/ }).first().click({ timeout: T });
};

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

async function appearance(w, next) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, next);
	await expect(w.page.locator("html")).toHaveClass(next === "dark" ? /dark/ : /^(?!.*dark)/);
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

/** The layout audit: inside the window, nothing sideways, buttons inside the card, the box not covered. */
async function audit(w, label) {
	const found = await w.page.evaluate(() => {
		const card = document.querySelector(".handoff-card");
		if (!card) return { missing: true };
		const box = card.getBoundingClientRect();
		const bad = [];
		if (box.left < 0 || box.right > window.innerWidth + 0.5) bad.push("the card leaves the window");
		if (card.scrollWidth > card.clientWidth + 1) bad.push("the card scrolls sideways");
		for (const el of card.querySelectorAll(".handoff-text, .approval-button, .handoff-command")) {
			const b = el.getBoundingClientRect();
			if (b.right > box.right + 0.5 || b.left < box.left - 0.5) bad.push(`${el.className} sticks out`);
		}
		const composer = document.querySelector("[data-chat-composer-body]")?.getBoundingClientRect();
		if (composer && box.bottom > composer.top + 24) bad.push("the card covers the message box");
		return { bad };
	});
	assert.ok(!found.missing, `${label}: there is a card`);
	assert.deepEqual(found.bad, [], `${label}: the card passes the layout audit`);
}

const requestText = (request) => JSON.stringify(request.messages ?? []);

flow(
	"a sign-in page stops the turn with a card that says what to do, and Continue resumes the same turn",
	(site) => ({
		rules: [
			{
				match: /open the login/i,
				steps: [...NAVIGATE(site.hard), { text: "The sign-in page is open and I am carrying on." }],
			},
		],
	}),
	async (w, site) => {
		await send(w, "open the login page");
		await accept(w);
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(card(w).getByText(`Sign in to ${site.site} in the browser window Namzu opened`)).toBeVisible();
		// The dead-end sentence is gone, and so is the bare "Paused" with nothing to do about it.
		assert.equal(await w.page.getByText("waiting for a decision").count(), 0);
		await expect(card(w).getByRole("button", { name: /^Continue/ })).toBeEnabled();
		await expect(card(w).getByRole("button", { name: /^Stop/ })).toBeEnabled();
		await shot(w, "handoff-card-dark");
		for (const [width, height, name] of [
			[1280, 833, "1280"],
			[900, 700, "900"],
		]) {
			await size(w, width, height);
			for (const mode of ["dark", "light"]) {
				await appearance(w, mode);
				await audit(w, `${mode} ${width}`);
				await shot(w, `handoff-${name}-${mode}`);
			}
		}
		await size(w, 1280, 833);
		await appearance(w, "dark");
		// Typing does not get refused: the box takes it and the Send button is on.
		const box = w.page.getByRole("textbox", { name: "Message Namzu" });
		await box.click();
		await w.page.keyboard.type("I signed in, continue", { delay: 10 });
		await expect(w.page.getByRole("button", { name: "Send message" })).toBeEnabled();
		await shot(w, "handoff-typed");
		await box.fill("");
		// Continue with the key on the number pad's Enter: the card has the focus, so it works there too.
		const before = w.model.requests.length;
		await card(w).getByRole("button", { name: /^Continue/ }).focus();
		await w.page.keyboard.press("NumpadEnter");
		await expect(card(w)).toHaveCount(0, { timeout: T });
		await expect(w.page.getByText("The sign-in page is open and I am carrying on.").first()).toBeVisible({
			timeout: T,
		});
		await shot(w, "handoff-continued");
		// The same turn went on: the model was asked again, and told the person chose to continue.
		const asked = w.model.requests.slice(before);
		assert.ok(asked.length >= 1, "the model got a request after Continue");
		assert.ok(
			asked.some((r) => /The person chose to continue/.test(requestText(r))),
			"the model is told the person chose to continue",
		);
		// One message from the person in all: nothing was sent again.
		const last = w.model.requests.at(-1);
		const mine = (last.messages ?? []).filter(
			(m) => m.role === "user" && JSON.stringify(m.content).includes("open the login page"),
		);
		assert.equal(mine.length, 1, "the person's message is in the history once");
	},
);

flow(
	"Stop closes the paused turn and leaves a conversation that takes another message",
	(site) => ({
		rules: [
			{ match: /open the login/i, steps: [...NAVIGATE(site.hard), { text: "Should not be reached." }] },
			{ match: /something else/i, steps: [{ text: "Another turn, no trouble." }] },
		],
	}),
	async (w) => {
		await send(w, "open the login page");
		await accept(w);
		await expect(card(w)).toBeVisible({ timeout: T });
		await card(w).getByRole("button", { name: /^Stop/ }).click();
		await expect(card(w)).toHaveCount(0, { timeout: T });
		assert.equal(await w.page.getByText("Should not be reached.").count(), 0);
		await shot(w, "handoff-stopped");
		await send(w, "something else");
		await expect(w.page.getByText("Another turn, no trouble.").first()).toBeVisible({ timeout: T });
		assert.equal(await w.page.getByText("waiting for a decision").count(), 0);
	},
);

flow(
	"a message typed while the card waits moves on without it, never the refusal",
	(site) => ({
		rules: [
			{ match: /open the login/i, steps: [...NAVIGATE(site.hard), { text: "Should not be reached." }] },
			{ match: /I signed in/i, steps: [{ text: "Glad you are in." }] },
		],
	}),
	async (w) => {
		await send(w, "open the login page");
		await accept(w);
		await expect(card(w)).toBeVisible({ timeout: T });
		await send(w, "I signed in, go on");
		await expect(w.page.getByText("Glad you are in.").first()).toBeVisible({ timeout: T });
		await expect(card(w)).toHaveCount(0);
		assert.equal(await w.page.getByText("waiting for a decision").count(), 0);
	},
);

flow(
	"a page that only shows a password field is put to the person as a question, not as a terminal command",
	(site) => ({
		rules: [
			{
				match: /open the sign-in/i,
				steps: [
					...NAVIGATE(site.open),
					{
						tool: "ask_user_question",
						args: {
							questions: [
								{
									question: `Please sign in to ${site.site} in the browser window. Tell me when you are done.`,
									header: "Sign in",
									options: [{ label: "I signed in", recommended: true }, { label: "Skip this step" }],
								},
							],
						},
					},
					{ text: "Thanks, carrying on after the sign-in." },
				],
			},
		],
	}),
	async (w) => {
		await send(w, "open the sign-in page");
		await accept(w);
		const question = w.page.getByRole("region", { name: "A question from Namzu" });
		await expect(question).toBeVisible({ timeout: T });
		await expect(question.getByText("in the browser window")).toBeVisible();
		await shot(w, "signin-question");
		// What the model was told about the page: ask the person, and no terminal command.
		const seen = w.model.requests.map(requestText).join("\n");
		assert.match(seen, /ask_user_question to ask them to sign in in the browser window/);
		assert.doesNotMatch(seen, /namzu browser login/);
		await question.getByRole("radio", { name: /I signed in/ }).click();
		await question.getByRole("button", { name: /^Send/ }).click();
		await expect(question).toHaveCount(0, { timeout: T });
		await expect(w.page.getByText("Thanks, carrying on after the sign-in.").first()).toBeVisible({ timeout: T });
	},
);
