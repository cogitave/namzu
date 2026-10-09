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
	await expect(w.page.getByRole("heading", { level: 2, name: "Models", exact: true })).toBeVisible({
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
		await expect(w.page.getByRole("button", { name: "Send message" })).toBeDisabled();
		await expect(w.page.getByText("Ideas to get started")).toHaveCount(0);
		await shots(w, "01-no-provider-empty-state");

		await w.page.getByRole("button", { name: "Connect a provider" }).click();
		await expect(w.page.getByRole("heading", { level: 2, name: "Models", exact: true })).toBeVisible({
			timeout: T,
		});
		await expect(w.page.getByText("Not connected").first()).toBeVisible({ timeout: T });
		await expect(w.page.getByText("Free models, no key. Limits may apply.")).toBeVisible();
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

failureFlow(
	"a provider fault (502) says what happened in plain words and keeps the original behind Details",
	502,
	{
		contentType: "text/html",
		body: "<html><body>502 Bad Gateway</body></html>",
	},
	{
		main: ["OpenAI had a problem on its side. Your message is saved."],
		buttons: [/Start a new conversation|Try again/],
	},
	"10-fault-502",
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
	rmSync(w.project, { recursive: true, force: true });
	await sendText(w, "anyone there?");
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
