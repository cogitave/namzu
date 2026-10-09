// Setting up an outside engine from the model popup, against the real Electron app and CLI host:
// a missing engine says how to install it and can be checked again, a signed-out one says how to
// sign in and never leaves the model pill grey, and the popup keeps one shape across its steps.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-engines-setup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/ux-20261009/engines-setup");

/** A `codex` that answers `app-server`; `signedOut` makes account/read say an account is needed. */
const fakeCodex = (signedOut) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv[2] === "--version") { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
if (process.argv[2] !== "app-server") { console.log("fake codex terminal app"); setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0)); return; }
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const models = ${JSON.stringify([
	{
		id: "fake-sol",
		model: "fake-sol",
		displayName: "Fake Sol",
		isDefault: true,
		supportedReasoningEfforts: [
			{ reasoningEffort: "low" },
			{ reasoningEffort: "medium" },
			{ reasoningEffort: "high" },
		],
		defaultReasoningEffort: "medium",
	},
])};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line);
	if (frame.id === undefined) return;
	if (frame.method === "initialize") send({ id: frame.id, result: { userAgent: "fake", codexHome: "/tmp" } });
	else if (frame.method === "account/read") send({ id: frame.id, result: ${
		signedOut
			? '{ account: null, requiresOpenaiAuth: true }'
			: '{ account: { type: "chatgpt" }, requiresOpenaiAuth: true }'
	} });
	else if (frame.method === "model/list") send({ id: frame.id, result: { data: models, nextCursor: null } });
	else send({ id: frame.id, result: {} });
}).on("close", () => process.exit(0));
`;

function flow(name, setup, body) {
	test(name, { timeout: 240000 }, async () => {
		const bin = mkdtempSync(join(tmpdir(), "namzu-e2e-ux-bin-"));
		setup(bin);
		// A PATH of its own, so the owner's real engines are never found.
		const world = await createWorld({ env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
		world.bin = bin;
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
			rmSync(bin, { recursive: true, force: true });
		}
	});
}

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	// Let the popup's 150ms height transition finish; only the picture depends on it, never an assertion.
	await w.page.waitForTimeout(400);
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const install = (dir, name, source) => {
	writeFileSync(join(dir, name), source);
	chmodSync(join(dir, name), 0o755);
};

const picker = (w) => w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first();
const popup = (w) => w.page.locator(".model-picker-popup");
const width = async (w) => Math.round((await popup(w).boundingBox()).width);

flow(
	"a missing engine explains how to install it and can be checked again",
	() => {},
	async (w) => {
		await openProject(w);
		await picker(w).click();
		await w.page.getByRole("button", { name: /^Engine:/ }).click();
		const second = w.page.getByRole("button", { name: "Claude Code Not installed" });
		await expect(second).toBeVisible({ timeout: T });
		await expect(second).toHaveAttribute("aria-expanded", "false");
		await shot(w, "01-missing-engines");
		await second.click();
		const help = w.page.locator(".engine-install-help");
		await expect(help).toContainText("Claude Code is not installed on this computer");
		await expect(help).toContainText("curl -fsSL https://claude.ai/install.sh | bash");
		await expect(help).toContainText("npm install -g @anthropic-ai/claude-code");
		await expect(w.page.getByRole("button", { name: /^Copy: curl/ })).toBeVisible();
		await shot(w, "02-install-steps");
		// It is still missing: checking says so.
		await w.page.getByRole("button", { name: "Check again" }).click();
		await expect(help).toContainText("Still not found", { timeout: T });
		// Install it (a stand-in), and check again: the row becomes a choice.
		install(w.bin, "claude", fakeCodex(false));
		await w.page.getByRole("button", { name: "Check again" }).click();
		await expect(w.page.getByRole("radio", { name: "Claude Code" })).toBeVisible({ timeout: T });
		await expect(w.page.locator(".engine-install-help")).toHaveCount(0);
		await shot(w, "03-after-check-again");
	},
);

flow(
	"a signed-out engine says how to sign in, opens a terminal, and the model pill is never a grey bar",
	(bin) => install(bin, "codex", fakeCodex(true)),
	async (w) => {
		await openProject(w);
		await picker(w).click();
		await w.page.getByRole("button", { name: /^Engine:/ }).click();
		await w.page.getByRole("radio", { name: /Codex CLI/ }).click();
		const banner = w.page.getByRole("alert").filter({ hasText: "signed-in account" });
		await expect(banner).toBeVisible({ timeout: T });
		await expect(banner).toContainText("Sign in to Codex CLI in a terminal first");
		await expect(banner.locator("code")).toHaveText("codex login");
		await expect(banner.getByRole("button", { name: "Retry setup" })).toBeVisible();
		// The pill says so in words, and nothing of it is a placeholder bar.
		const pill = w.page.getByRole("button", { name: /^Model, (not available|.+ unavailable)/ });
		await expect(pill).toContainText(/Not available| unavailable/);
		await expect(w.page.locator(".model-picker-trigger-skeleton")).toHaveCount(0);
		await shot(w, "04-signed-out");
		await banner.getByRole("button", { name: "Open terminal" }).click();
		await expect(w.page.locator(".xterm").first()).toBeVisible({ timeout: T });
		await shot(w, "05-terminal-opened");
	},
);

flow(
	"the popup keeps one width across its steps, explains Desktop | CLI, and the effort slider names its levels",
	(bin) => install(bin, "codex", fakeCodex(false)),
	async (w) => {
		await openProject(w);
		await picker(w).click();
		await w.page.getByRole("button", { name: /^Engine:/ }).click();
		await w.page.getByRole("radio", { name: /Codex CLI/ }).click();
		await w.page.getByRole("button", { name: /^Model: Fake Sol/ }).click({ timeout: T });
		// The effort step: every stop is named, the one in force is marked, the switch is explained.
		const scale = w.page.locator(".composer-effort-scale");
		await expect(scale).toBeVisible({ timeout: T });
		for (const level of ["Low", "Medium", "High"]) await expect(scale).toContainText(level);
		await expect(scale.locator("[data-current]")).toHaveText("Medium");
		await expect(w.page.locator(".surface-caption")).toHaveText(
			"Desktop: you chat with this engine in this window.",
		);
		const effortWidth = await width(w);
		await shot(w, "06-effort-step");
		// The models step is as wide, its heading is whole, and the engine mark is clear of it.
		await w.page.getByRole("button", { name: /change model/ }).click();
		await expect(w.page.getByRole("radio", { name: /Fake Sol/ })).toBeVisible({ timeout: T });
		const title = w.page.getByRole("heading", { name: "Choose a model" });
		await expect(title).toBeVisible();
		await expect(w.page.locator(".surface-caption")).toBeVisible();
		assert.ok(Math.abs((await width(w)) - effortWidth) <= 4, "the models step is as wide as the effort step");
		const heading = await title.boundingBox();
		const chip = await w.page.getByRole("button", { name: /^Engine:/ }).boundingBox();
		const clear =
			heading.x + heading.width <= chip.x + 0.5 || heading.y + heading.height <= chip.y + 0.5;
		assert.ok(clear, "the engine mark does not sit over the heading");
		await w.page.getByRole("radio", { name: "CLI", exact: true }).click();
		await expect(w.page.locator(".surface-caption")).toContainText("terminal tab");
		await shot(w, "07-models-step-cli");
		await w.page.getByRole("radio", { name: "Desktop", exact: true }).click();
		// The engine step is as wide too.
		await w.page.getByRole("button", { name: /^Engine:/ }).click();
		await expect(w.page.getByRole("radiogroup", { name: "Available engines" })).toBeVisible();
		assert.ok(Math.abs((await width(w)) - effortWidth) <= 4, "the engine step is as wide as the effort step");
		await shot(w, "08-engine-step");
	},
);
