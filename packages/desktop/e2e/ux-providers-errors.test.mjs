// Onboarding and error wording, against the real Electron app, the real CLI host and a scripted model.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-providers-errors.test.mjs
// Pictures go to research/ux-20261009/providers-errors/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createWorld,
	dispose,
	expect,
	launch,
	openProject,
	repoRoot,
} from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/ux-20261009/providers-errors");
const KEY = "sk-e2e-pasted-key-1234567890";
const ENGINE = "Claude Code";
const PROVIDER = "openai";
const PROVIDER_NAME = "OpenAI";

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
			if (options.cleanup) options.cleanup();
		}
	});
}

async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "light") await expect(w.page.locator("html")).not.toHaveClass(/dark/);
	else await expect(w.page.locator("html")).toHaveClass(/dark/);
}
async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
/** The picture in the dark theme and again in the light one. */
async function shots(w, name) {
	await theme(w, "dark");
	await shot(w, `${name}-dark`);
	await theme(w, "light");
	await shot(w, `${name}-light`);
	await theme(w, "dark");
}
const box = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });
async function sendText(w, text) {
	await box(w).fill(text);
	await w.page.getByRole("button", { name: "Send message" }).click();
}
async function openModels(w) {
	await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	await w.page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: "Models", exact: true })
		.click();
	await expect(w.page.getByRole("heading", { level: 1, name: "Models", exact: true })).toBeVisible({
		timeout: T,
	});
}
const JARGON = /HTTP|\b[45]\d\d\b|receipt|retained|usage receipt|<html|\{"error"/i;

flow(
	"a first-timer is told to connect a provider, pastes a key in Settings and can then send",
	{ noKey: true, rules: [{ match: /hello/i, steps: [{ text: "Scripted hello back." }] }] },
	async (w) => {
		await openProject(w);
		// Before anything is typed or sent: one clear sentence and one primary action.
		await expect(
			w.page.getByRole("heading", { name: "Add an API key or sign in to start" }),
		).toBeVisible({ timeout: T });
		await box(w).fill("make me a small website");
		// Send looks and acts disabled, says why, and both it and Enter lead to the card that fixes it.
		const send = w.page.getByRole("button", { name: "Send message" });
		await expect(send).toHaveAttribute("aria-disabled", "true");
		await send.hover();
		await expect(w.page.getByText("Connect a provider to send")).toBeVisible({ timeout: T });
		await shot(w, "01-send-tooltip-dark");
		await box(w).press("Enter");
		await expect(w.page.getByRole("button", { name: "Connect a provider" })).toBeFocused();
		await box(w).focus();
		await send.click({ force: true });
		await expect(w.page.getByRole("button", { name: "Connect a provider" })).toBeFocused();
		assert.equal(w.model.requests.length, 0, "nothing was sent to a model");
		assert.equal(await box(w).inputValue(), "make me a small website", "the text is kept");
		await expect(w.page.getByText("Ideas to get started")).toHaveCount(0);
		await shots(w, "01-no-provider-empty-state");

		await w.page.getByRole("button", { name: "Connect a provider" }).click();
		await expect(w.page.getByRole("heading", { level: 1, name: "Models", exact: true })).toBeVisible({
			timeout: T,
		});
		await expect(w.page.getByText("Not connected").first()).toBeVisible({ timeout: T });
		await expect(w.page.getByText("Free models. Needs a free Zen key.")).toBeVisible();
		await shots(w, "02-models-section-before");

		const add = w.page.getByRole("button", { name: "Add an API key for OpenAI", exact: true });
		await add.click();
		const field = w.page.getByLabel("OpenAI API key");
		await expect(field).toBeFocused();
		await expect(field).toHaveAttribute("type", "password");
		await field.fill(KEY);
		await shots(w, "03-models-pasting-key");
		await w.page.getByRole("button", { name: "Save key" }).click();
		// Saved and checked with a cheap authenticated call, not a message.
		await expect(w.page.getByText("OpenAI accepted the key.")).toBeVisible({ timeout: T });
		await expect(w.page.getByText("Connected with the key you saved")).toBeVisible();
		await expect(w.page.getByLabel("OpenAI API key")).toHaveCount(0);
		await shots(w, "04-models-connected");

		// The key reached the CLI's private store and nowhere the window can read.
		const stored = join(w.home, "api-keys.json");
		assert.equal(existsSync(stored), true, "the key is in the CLI's own store");
		assert.equal(JSON.parse(readFileSync(stored, "utf8")).keys[PROVIDER], KEY);
		assert.equal(statSync(stored).mode & 0o077, 0, "the store is private to the person");
		const leaks = await w.page.evaluate((key) => {
			const where = [];
			if (document.documentElement.outerHTML.includes(key)) where.push("dom");
			for (const field of document.querySelectorAll("input,textarea"))
				if (field.value.includes(key)) where.push("field");
			if (JSON.stringify({ ...localStorage }).includes(key)) where.push("localStorage");
			if (JSON.stringify({ ...sessionStorage }).includes(key)) where.push("sessionStorage");
			return where;
		}, KEY);
		assert.deepEqual(leaks, [], "the pasted key is not left anywhere in the window");

		// Back at the project the empty state is gone and a message is answered.
		await w.page.getByRole("button", { name: "Home", exact: true }).click();
		await expect(box(w)).toBeVisible({ timeout: T });
		await expect(
			w.page.getByRole("heading", { name: "Add an API key or sign in to start" }),
		).toHaveCount(0, { timeout: T });
		await sendText(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({ timeout: T });
		assert.equal(
			JSON.stringify(w.model.requests).includes(KEY),
			false,
			"the key travels in a header, never in a request body",
		);

		// Removing the key returns the empty state; nothing is left on disk.
		await openModels(w);
		await w.page.getByRole("button", { name: "Remove the saved API key for OpenAI" }).click();
		await expect(w.page.getByText("The saved key was removed.")).toBeVisible({ timeout: T });
		assert.equal(existsSync(stored), false, "the last key leaves no file behind");
		await w.page.getByRole("button", { name: "Home", exact: true }).click();
		await expect(
			w.page.getByRole("heading", { name: "Add an API key or sign in to start" }),
		).toBeVisible({ timeout: T });
	},
);

flow(
	"a malformed paste is caught before it is sent, and Escape puts focus back on the button",
	{ noKey: true, rules: [] },
	async (w) => {
		await openProject(w);
		await w.page.getByRole("button", { name: "Connect a provider" }).click();
		await w.page.getByRole("button", { name: "Add an API key for OpenAI", exact: true }).click();
		const field = w.page.getByLabel("OpenAI API key");
		await field.fill("two words");
		await w.page.getByRole("button", { name: "Save key" }).click();
		await expect(w.page.getByText("An API key has no spaces or line breaks.")).toBeVisible();
		await field.press("Escape");
		await expect(w.page.getByLabel("OpenAI API key")).toHaveCount(0);
		await expect(w.page.getByRole("button", { name: "Add an API key for OpenAI", exact: true })).toBeFocused();
		assert.equal(existsSync(join(w.home, "api-keys.json")), false);
	},
);

function failureFlow(name, status, extra, expected, shotName) {
	flow(
		name,
		{
			rules: [
				{
					match: /go wrong/i,
					steps: [{ status, ...extra }],
				},
			],
		},
		async (w) => {
			await openProject(w);
			await sendText(w, "please go wrong");
			for (const text of expected.main)
				await expect(w.page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: T });
			for (const label of expected.buttons)
				await expect(w.page.getByRole("button", { name: label })).toBeVisible();
			const region = w.page.locator(".turn-recovery");
			await expect(region).toBeVisible();
			const shown = await region.innerText();
			const visible = shown.replace(/Details[\s\S]*$/, "");
			assert.doesNotMatch(visible, JARGON, "the main text carries no code, markup or receipt wording");
			await expect(region.getByText("Details")).toBeVisible();
			await shots(w, shotName);
			await region.getByText("Details").click();
			await shot(w, `${shotName}-details-dark`);
			// Paused and budget lines never contradict the cause.
			await expect(w.page.getByText("Paused.", { exact: true })).toHaveCount(0);
			await expect(w.page.getByText(/size limit set/)).toHaveCount(0);
			// The way out is real: it opens a fresh conversation (or, where Try again is offered, that button exists).
			const fresh = w.page.getByRole("button", { name: "Start a new conversation" });
			if (await fresh.count()) {
				await fresh.click();
				await expect(
					w.page.getByRole("heading", { name: /What should we work on/ }),
				).toBeVisible({ timeout: T });
			}
		},
	);
}

const BAD_GATEWAY = {
	status: 502,
	contentType: "text/html",
	body: "<html><body>502 Bad Gateway</body></html>",
};

flow(
	"a provider fault (502) in a conversation with no limit is tried again in place, with the unknown usage kept in Details",
	{ rules: [{ match: /go wrong/i, steps: [BAD_GATEWAY] }] },
	async (w) => {
		await openProject(w);
		await sendText(w, "please go wrong");
		await expect(
			w.page.getByText(`${PROVIDER_NAME} had a problem on its side. Your message is saved.`).first(),
		).toBeVisible({ timeout: T });
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("button", { name: "Start a new conversation" })).toHaveCount(0);
		await expect(w.page.getByRole("button", { name: "Continue without this reply" })).toHaveCount(0);
		const visible = (await region.innerText()).replace(/Details[\s\S]*$/, "");
		assert.doesNotMatch(visible, JARGON, "the main text carries no code, markup or receipt wording");
		await shots(w, "10-fault-502");
		await region.getByText("Details").click();
		const details = await region.locator("details").innerText();
		assert.match(details, /Usage for (one request|\d+ requests) is unknown\./);
		assert.doesNotMatch(details, /502 502|receipt|retained|unresolved/i, "no doubled status or receipt wording");
		assert.match(
			details,
			new RegExp(`${PROVIDER_NAME}: the provider failed to complete the request \\(502 Bad Gateway\\)`),
		);
		await shot(w, "10-fault-502-details-dark");
		// The retry is a new request in the same conversation, and it is answered.
		const before = w.model.requests.length;
		w.model.rules[0].steps = [{ text: "The provider is back." }];
		await region.getByRole("button", { name: "Try again" }).click();
		await expect(w.page.getByText("The provider is back.")).toBeVisible({ timeout: T });
		assert.ok(w.model.requests.length > before, "the retry reached the model as a new request");
		await expect(w.page.locator(".turn-recovery")).toHaveCount(0);
		await expect(w.page.getByText("Working").locator("visible=true")).toHaveCount(0, { timeout: T });
		await shot(w, "10-fault-502-retried-dark");
	},
);

/** Every token-budget ledger under the profile (`<session>/budgets/<turn>.json`). */
function budgetFiles(home) {
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".json") && dir.endsWith("budgets")) found.push(path);
		}
	};
	walk(home);
	return found;
}

flow(
	"a provider fault (502) in a conversation that has a limit offers to continue here, and puts the message back in the box",
	{ rules: [{ match: /go wrong/i, steps: [BAD_GATEWAY] }] },
	async (w) => {
		await openProject(w);
		await sendText(w, "please go wrong");
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: T });
		// A Desktop conversation has no limit of its own. Give this turn's ledger one, the way a turn
		// begun under a configured limit would carry it, and open the conversation again.
		const ledgers = budgetFiles(w.home);
		assert.equal(ledgers.length, 1, "the turn has one durable ledger");
		const ledger = JSON.parse(readFileSync(ledgers[0], "utf8"));
		ledger.limit = 1000000;
		ledger.accounts.find((account) => account.id === ledger.rootAccountId).limit = 1000000;
		writeFileSync(ledgers[0], JSON.stringify(ledger));
		await w.page.reload();
		await expect(region.getByRole("button", { name: "Continue without this reply" })).toBeVisible({
			timeout: T,
		});
		await expect(region.getByRole("button", { name: "Try again" })).toHaveCount(0);
		await expect(w.page.getByRole("button", { name: "Start a new conversation" })).toHaveCount(0);
		const visible = (await region.innerText()).replace(/Details[\s\S]*$/, "");
		assert.doesNotMatch(visible, JARGON, "the main text carries no code, markup or receipt wording");
		assert.doesNotMatch(visible, /receipt|unresolved|retained|token/i);
		await shots(w, "10-fault-502-limited");
		await region.getByText("Details").click();
		assert.match(await region.locator("details").innerText(), /Usage for (one request|\d+ requests) is unknown\./);
		await shot(w, "10-fault-502-limited-details-dark");
		const tabs = await w.page.getByRole("tab").count();
		await region.getByRole("button", { name: "Continue without this reply" }).click();
		await expect(w.page.locator(".turn-recovery")).toHaveCount(0, { timeout: T });
		await expect(box(w)).toHaveValue("please go wrong");
		assert.equal(await w.page.getByRole("tab").count(), tabs, "no new conversation was opened");
		await shot(w, "10-fault-502-limited-continued-dark");
		// The unknown usage of the stopped request is still on the ledger, never zero.
		const after = JSON.parse(readFileSync(budgetFiles(w.home)[0], "utf8"));
		assert.ok(
			[...after.requests, ...after.completedRequests].filter((request) => request.unresolved).length >= 1,
			"the stopped requests are still recorded as unknown",
		);
		// Not sent: the same conversation takes it as a new turn.
		const sent = w.model.requests.length;
		w.model.rules[0].steps = [{ text: "The provider is back." }];
		await w.page.getByRole("button", { name: "Send message" }).click();
		await expect(w.page.getByText("The provider is back.")).toBeVisible({ timeout: T });
		assert.ok(w.model.requests.length > sent);
		assert.equal(await w.page.getByRole("tab").count(), tabs, "the same conversation took it");
	},
);

failureFlow(
	"a rejected key (401) names the provider and opens Settings",
	401,
	{
		body: JSON.stringify({
			error: { message: "Incorrect API key provided: sk-e2e***.", type: "invalid_request_error" },
		}),
	},
	{
		main: ["OpenAI didn’t accept your key. Check it in Settings, then send again."],
		buttons: ["Open model settings"],
	},
	"11-rejected-key",
);

flow(
	"a rate limit shows a countdown instead of a silent Working",
	{
		rules: [
			{
				match: /busy/i,
				steps: [
					{
						status: 429,
						headers: { "retry-after": "8" },
						body: JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }),
					},
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await sendText(w, "the provider is busy");
		const line = w.page.locator(".working-wait");
		await expect(line).toBeVisible({ timeout: T });
		await expect(line).toContainText(
			new RegExp(`Waiting for ${PROVIDER_NAME} to accept more requests… retrying in \\d+s`),
		);
		// The announced text does not change every second.
		const announced = await line.locator(".transcript-visually-hidden").innerText();
		assert.equal(
			announced,
			`Waiting for ${PROVIDER_NAME} to accept more requests. Retrying soon.`,
		);
		await shots(w, "12-rate-limit-wait");
	},
);

flow("a project folder deleted while open says so, with the two ways forward", {}, async (w) => {
	await openProject(w);
	await expect(box(w)).toBeVisible({ timeout: T });
	// The text is typed before the folder goes, and sent with the key the box already has focus
	// for: no actionability wait can lose the box to the page that replaces it.
	await box(w).fill("anyone there?");
	rmSync(w.project, { recursive: true, force: true });
	await w.page.keyboard.press("Enter");
	await expect(w.page.getByRole("heading", { name: /can’t be found/ })).toBeVisible({ timeout: T });
	await expect(w.page.getByText("This folder no longer exists.")).toBeVisible();
	await expect(w.page.getByRole("button", { name: "Locate folder…" })).toBeVisible();
	await expect(w.page.getByRole("button", { name: "Remove project…" })).toBeVisible();
	assert.equal(await w.page.getByText(/trust/i).count(), 0, "no trust wording for a missing folder");
	await shots(w, "20-folder-deleted");
});

/** The process id of the CLI host serving this project's folder. */
function projectHostPid(w) {
	const want = realpathSync(w.project);
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8");
			if (!cmd.includes("--desktop")) continue;
			if (readlinkSync(`/proc/${entry}/cwd`) === want) return Number(entry);
		} catch {}
	}
	throw new Error("no host for the project");
}

flow(
	"a crashed host keeps the conversation on screen, reconnects by itself and clears the error",
	{ rules: [{ match: /hello/i, steps: [{ text: "Scripted hello back." }] }] },
	async (w) => {
		await openProject(w);
		await sendText(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({ timeout: T });
		const before = projectHostPid(w);
		process.kill(before, "SIGKILL");
		// The reconnect is a new host process for the same folder; its arrival is what is awaited.
		await expect
			.poll(() => {
				try {
					return projectHostPid(w) !== before;
				} catch {
					return false;
				}
			}, { timeout: T })
			.toBe(true);
		await expect(w.page.locator(".connection-error")).toHaveCount(0, { timeout: T });
		// Never a second recovery surface, and never the word "folder" for a connection.
		assert.equal(await w.page.getByRole("heading", { name: /open this folder/i }).count(), 0);
		await expect(w.page.getByText("Conversation could not be loaded.")).toHaveCount(0);
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible();
		await expect(box(w)).toBeEnabled({ timeout: T });
		await expect(w.page.locator(".inline-error, .turn-recovery")).toHaveCount(0);
		await shots(w, "30-host-crash-recovered");
		// The conversation works again.
		await sendText(w, "hello again");
		await expect(w.page.getByText("Scripted hello back.")).toHaveCount(2, { timeout: T });
	},
);

const FAKE_CLAUDE = `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.0.0-fake (Claude Code)"); process.exit(0); }
process.exit(1);
`;
{
	const bin = mkdtempSync(join(tmpdir(), "namzu-e2e-claude-"));
	writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
	chmodSync(join(bin, "claude"), 0o755);
	flow(
		"an engine that cannot start is named, says what to do, and its button does not stay a skeleton",
		{ pathPrefix: bin, cleanup: () => rmSync(bin, { recursive: true, force: true }) },
		async (w) => {
			await openProject(w);
			await expect(box(w)).toBeVisible({ timeout: T });
			await w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click();
			await w.page.getByRole("button", { name: /^Engine:/ }).click();
			await w.page.getByRole("radio", { name: new RegExp(ENGINE) }).click();
			await expect(
				w.page.getByText(`${ENGINE} could not start.`),
			).toBeVisible({ timeout: T });
			await expect(
				w.page.getByRole("button", { name: new RegExp(`^Model, ${ENGINE} unavailable`) }),
			).toBeVisible({ timeout: T });
			await expect(w.page.getByText(/native engine connection/i)).toHaveCount(0);
			// The notice sits below the tab strip: the tabs and + stay visible and reachable.
			const strip = await w.page.locator(".topbar").first().boundingBox();
			const notice = await w.page.locator(".connection-error > *").first().boundingBox();
			assert.ok(strip && notice, "both the tab strip and the notice are drawn");
			assert.ok(
				notice.y >= strip.y + strip.height - 1,
				`the notice (top ${notice.y}) starts below the tab strip (bottom ${strip.y + strip.height})`,
			);
			await expect(w.page.getByRole("button", { name: /new tab|new conversation/i }).first()).toBeVisible();
			await shots(w, "40-engine-cannot-start");
		},
	);
}

flow(
	"an approval that replaces a file names the file and speaks plainly",
	{
		files: { "out.txt": "old contents\n" },
		rules: [
			{
				match: /write the file/i,
				steps: [
					{ tool: "write", args: { path: "out.txt", content: "new contents\n" } },
					{ text: "Wrote out.txt." },
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await sendText(w, "write the file");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		await expect(card.getByText("This replaces out.txt, which already exists.")).toBeVisible();
		assert.equal(await card.getByText("This action changes or removes data.").count(), 0);
		await shots(w, "50-approval-replace");
	},
);
