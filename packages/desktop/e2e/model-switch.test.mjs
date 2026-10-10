// Switching the model, against the real Electron app, the real CLI host and two scripted services:
// one on the Anthropic wire, one on the OpenAI chat wire (gpt-6-luna).
//   (a) a healthy conversation on Claude, with a tool call and a reasoning block in its history,
//       moves to gpt-6-luna and the history goes with it;
//   (b) the first reply on Claude stops on a rate limit, the model is switched and a new message sent;
//   (c) the same, but Try again is pressed after the switch;
//   (d) the reverse direction, healthy and after a stopped reply.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/model-switch.test.mjs
// Pictures go to research/model-switch-20261010/.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/model-switch-20261010");

const THROTTLED = {
	status: 429,
	headers: { "retry-after": "0" },
	body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
};
const THROTTLED_OPENAI = {
	status: 429,
	headers: { "retry-after": "0" },
	body: JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }),
};
const PLAN_ARGS = { subject: "Write the parser", activeForm: "Writing the parser" };

function flow(name, options, body) {
	test(name, { timeout: 300000 }, async () => {
		const world = await createWorld({
			models: ["gpt-6-luna", "gpt-5.6-luna"],
			anthropicModels: ["claude-sonnet-5-5", "claude-haiku-5-5"],
			strictHistory: true,
			providers: [{ id: "anthropic", model: "claude-sonnet-5-5" }],
			...options,
		});
		let failed = true;
		try {
			await launch(world);
			world.console = [];
			// What the renderer says about itself, read where the app's own diagnostics read it.
			await world.app.evaluate(({ BrowserWindow }) => {
				globalThis.__console = [];
				for (const win of BrowserWindow.getAllWindows())
					win.webContents.on("console-message", (details) => {
						if (details.level === "error")
							globalThis.__console.push(`${details.message} @${details.lineNumber}`);
					});
			});
			await world.page.evaluate(() => {
				window.__errors = [];
				window.addEventListener("error", (e) => window.__errors.push(`${e.message} @${e.lineno}:${e.colno}`));
				window.addEventListener("unhandledrejection", (e) => window.__errors.push(`rejection ${e.reason}`));
			});
			world.page.on("console", (message) => {
				if (message.type() === "error") world.console.push(message.text());
			});
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			assert.deepEqual(world.console, [], "the renderer logged no errors");
			// What the app wrote about itself: a switch and a send are not renderer failures.
			const log = join(world.userData, "logs", "desktop.ndjson");
			const written = existsSync(log) ? readFileSync(log, "utf8") : "";
			assert.doesNotMatch(written, /renderer_failed/, "no renderer failure was recorded");
			failed = false;
		} finally {
			if (failed || process.env.E2E_SHOW_CONSOLE)
				console.error(
					"renderer console:",
					world.console,
					"faults:",
					world.faults,
					"main console:",
					await world.app.evaluate(() => globalThis.__console).catch(() => []),
					"window errors:",
					await world.page.evaluate(() => window.__errors).catch(() => []),
				);
			await dispose(world, { failed });
		}
	});
}

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Choose a model in the composer's picker: the service's tab, then the model. */
async function chooseModel(w, tab, model) {
	await w.page.getByRole("button", { name: /^Model:/ }).click();
	// The popup opens on the effort step when the model has one; the list is one step further.
	const change = w.page.getByRole("button", { name: /change model/ });
	if (await change.count()) await change.click();
	await w.page.getByRole("tab", { name: tab, exact: true }).click();
	await w.page.getByRole("radio", { name: new RegExp(model) }).click();
	await w.page.keyboard.press("Escape");
	await expect(w.page.getByRole("button", { name: new RegExp(`^Model: .*${model}`) })).toBeVisible({
		timeout: T,
	});
}

/** What the person typed, newest last; the host's own context notes ride along as user messages and are not it. */
const typed = (request) =>
	request.messages
		.filter((m) => m.role === "user")
		.map((m) =>
			typeof m.content === "string"
				? m.content
				: (m.content ?? []).map((part) => part.text ?? "").join(""),
		)
		.filter((text) => text && !text.startsWith("Current step context"));
const lastUser = (request) => typed(request).at(-1);
const history = (request) =>
	request.messages.map((m) => `${m.role}${m.tool_calls ? "+calls" : ""}`).join(",");

flow(
	"(a) a healthy conversation on Claude, with a tool call and reasoning, moves to gpt-6-luna and back with its history",
	{
		anthropicRules: [
			{
				match: /make a plan/i,
				steps: [
					{ thinking: "I will write the plan down first.", tool: "task_create", args: PLAN_ARGS },
					{ text: "Plan is ready." },
				],
			},
			{ match: /back to claude/i, steps: [{ text: "Claude again, with everything so far." }] },
		],
		rules: [{ match: /luna/i, steps: [{ text: "Luna here, with the plan in view." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "make a plan");
		await expect(w.page.getByText("Plan is ready.")).toBeVisible({ timeout: T });
		assert.equal(w.anthropic.requests.length, 2, "the plan took two requests on Claude");
		await shot(w, "a-1-claude-answered");

		await chooseModel(w, "OpenAI", "gpt-6-luna");
		await send(w, "now continue on luna");
		await expect(w.page.getByText("Luna here, with the plan in view.")).toBeVisible({ timeout: T });
		const luna = w.model.requests.at(-1);
		assert.equal(luna.model, "gpt-6-luna");
		assert.equal(lastUser(luna), "now continue on luna");
		assert.match(history(luna), /user.*assistant\+calls,tool.*assistant.*user/, "the whole history went along, calls paired");
		assert.doesNotMatch(JSON.stringify(luna.messages), /signature|thinking|redacted/, "Claude's signed reasoning stayed behind");
		await shot(w, "a-2-luna-answered");

		await chooseModel(w, "Anthropic (Claude)", "claude-sonnet-5-5");
		await send(w, "and back to claude");
		await expect(w.page.getByText("Claude again, with everything so far.")).toBeVisible({ timeout: T });
		const claude = w.anthropic.requests.at(-1);
		assert.equal(claude.model, "claude-sonnet-5-5");
		assert.equal(lastUser(claude), "and back to claude");
		await shot(w, "a-3-back-on-claude");
	},
);

flow(
	"(b) a reply that stopped on a rate limit: switch to gpt-6-luna, send a new message, it is answered",
	{
		anthropicRules: [{ match: /hello/i, steps: [THROTTLED] }],
		rules: [{ match: /again/i, steps: [{ text: "Luna answers." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: T });
		await chooseModel(w, "OpenAI", "gpt-6-luna");
		await expect(region.getByRole("button", { name: "Try again with gpt-6-luna" })).toBeVisible({
			timeout: T,
		});
		await shot(w, "b-1-stopped-then-switched");
		await send(w, "hello again");
		await expect(w.page.getByText("Luna answers.")).toBeVisible({ timeout: T });
		await expect(w.page.getByText("You continued without this reply.")).toBeVisible({ timeout: T });
		await expect(w.page.locator(".turn-recovery")).toHaveCount(0);
		assert.equal(lastUser(w.model.requests.at(-1)), "hello again");
		assert.equal(w.model.requests.at(-1).model, "gpt-6-luna");
		await shot(w, "b-2-luna-answered");
		// The conversation goes on after that.
		w.model.rules[0].steps = [{ text: "Luna keeps going." }];
		await send(w, "and once more, again");
		await expect(w.page.getByText("Luna keeps going.")).toBeVisible({ timeout: T });
	},
);

flow(
	"(c) a reply that stopped on a rate limit: switch to gpt-6-luna and press Try again, it runs on luna",
	{
		anthropicRules: [{ match: /hello/i, steps: [THROTTLED] }],
		rules: [{ match: /hello/i, steps: [{ text: "Luna took it from here." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: T });
		const claudeRequests = w.anthropic.requests.length;
		await chooseModel(w, "OpenAI", "gpt-6-luna");
		await expect(region.getByRole("button", { name: "Try again with gpt-6-luna" })).toBeVisible({
			timeout: T,
		});
		await region.getByRole("button", { name: "Try again with gpt-6-luna" }).click();
		await expect(w.page.getByText("Luna took it from here.")).toBeVisible({ timeout: T });
		assert.equal(w.anthropic.requests.length, claudeRequests, "Claude was not asked again");
		assert.equal(w.model.requests.at(-1).model, "gpt-6-luna");
		assert.equal(lastUser(w.model.requests.at(-1)), "hello there", "the same message, now on luna");
		await expect(w.page.locator(".turn-recovery")).toHaveCount(0);
		await shot(w, "c-1-retried-on-luna");
	},
);

flow(
	"(d) the reverse: a conversation on gpt-6-luna, with a tool call, moves to Claude with its history",
	{
		providers: [{ id: "openai", model: "gpt-6-luna" }],
		rules: [
			{
				match: /make a plan/i,
				steps: [{ tool: "task_create", args: PLAN_ARGS }, { text: "Plan is ready." }],
			},
		],
		anthropicRules: [{ match: /claude/i, steps: [{ text: "Claude picks it up." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "make a plan");
		await expect(w.page.getByText("Plan is ready.")).toBeVisible({ timeout: T });
		await chooseModel(w, "Anthropic (Claude)", "claude-sonnet-5-5");
		await send(w, "continue on claude");
		await expect(w.page.getByText("Claude picks it up.")).toBeVisible({ timeout: T });
		const claude = w.anthropic.requests.at(-1);
		assert.equal(claude.model, "claude-sonnet-5-5");
		assert.equal(lastUser(claude), "continue on claude");
		assert.deepEqual(typed(claude).slice(0, 2), ["make a plan", "continue on claude"]);
		assert.ok(
			JSON.stringify(claude.messages).includes("tool_use") &&
				JSON.stringify(claude.messages).includes("tool_result"),
			"the earlier tool call and its result went along",
		);
		await shot(w, "d-1-claude-picked-up");
	},
);

flow(
	"(d) the reverse after a stop: gpt-6-luna is rate limited, switch to Claude, send, it is answered",
	{
		providers: [{ id: "openai", model: "gpt-6-luna" }],
		rules: [{ match: /hello/i, steps: [THROTTLED_OPENAI] }],
		anthropicRules: [{ match: /again/i, steps: [{ text: "Claude answers." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: T });
		await chooseModel(w, "Anthropic (Claude)", "claude-sonnet-5-5");
		await send(w, "hello again");
		await expect(w.page.getByText("Claude answers.")).toBeVisible({ timeout: T });
		assert.equal(w.anthropic.requests.at(-1).model, "claude-sonnet-5-5");
		await shot(w, "d-2-claude-answered-after-stop");
	},
);
