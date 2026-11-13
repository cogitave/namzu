// What runs by itself: the Settings view, its one switch, and the trust dialog's list, against the
// real Electron app and the real CLI host. Pictures go to HOOKS_SHOTS when it is set.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-hooks-view.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, relaunch, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.HOOKS_SHOTS;

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.evaluate(async () => {
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

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
		}
	});
}

const SECRETS = ["SECRET-ENV-VALUE", "SECRET-HEADER", "SECRET-QUERY", "SECRET-USER-ENV"];

const PROJECT_FILES = {
	"namzu.config.json": JSON.stringify({
		sandbox: { enabled: false },
		hooks: {
			pre_tool_use: [
				{ matcher: "Bash", command: "./bin/guard.sh", env: { API_TOKEN: SECRETS[0] } },
			],
			session_start: [
				{
					type: "http",
					url: `https://hooks.example.test/start?token=${SECRETS[2]}`,
					headers: { Authorization: `Bearer ${SECRETS[1]}` },
				},
			],
			PostToolUse: ["broken: a string, not a hook"],
		},
	}),
	".namzu/plugins/review-bot/plugin.json": JSON.stringify({
		name: "review-bot",
		version: "1.0.0",
		description: "Guards shell calls",
		hookEntries: { pre_tool_use: [{ command: "plugin-guard.sh" }] },
	}),
	".namzu/skills/careful/SKILL.md": [
		"---",
		"name: careful",
		"description: Runs shell commands under a guard",
		"hooks:",
		"  PreToolUse:",
		"    - matcher: Bash",
		"      hooks:",
		"        - type: command",
		"          command: skill-guard.sh",
		"---",
		"Be careful.",
		"",
	].join("\n"),
	".namzu/agents/runner.md": [
		"---",
		"name: runner",
		"description: Runs things",
		"hooks:",
		"  Stop:",
		"    - hooks:",
		"        - type: command",
		"          command: agent-done.sh",
		"---",
		"You run things.",
		"",
	].join("\n"),
};

const USER_CONFIG = [
	"plugins:",
	"  enabled: true",
	"hooks:",
	"  UserPromptSubmit:",
	"    - hooks:",
	"        - type: command",
	"          command: ~/bin/log-prompt.sh",
	"          env:",
	`            SECRET_TOKEN: ${SECRETS[3]}`,
	"",
].join("\n");

async function openSettings(w, section) {
	const sections = w.page.getByRole("navigation", { name: "Settings sections" });
	if ((await sections.count()) === 0)
		await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(sections).toBeVisible({ timeout: T });
	await sections.getByRole("button", { name: section, exact: true }).click();
	await expect(w.page.getByRole("heading", { level: 1, name: section, exact: true })).toBeVisible({
		timeout: T,
	});
}

async function addExistingFolder(w) {
	const welcome = w.page.getByRole("button", { name: "Add new project", exact: true });
	await expect(welcome.first()).toBeVisible({ timeout: T });
	await welcome.last().click();
	await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
}

async function trustAndOpen(w) {
	const dialog = w.page.getByRole("dialog", { name: "Trust this folder?" });
	await expect(dialog).toBeVisible({ timeout: T });
	await dialog.getByRole("button", { name: "Trust and open" }).click();
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({
		timeout: T,
	});
}

const noSecrets = async (w) => {
	const text = await w.page.locator("body").textContent();
	for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${secret} on screen`);
};

flow(
	"the trust dialog lists the hooks of project files, plugins, skills and agent files, each with its source",
	{ files: PROJECT_FILES },
	async (w) => {
		await addExistingFolder(w);
		const dialog = w.page.getByRole("dialog", { name: "Trust this folder?" });
		await expect(dialog).toBeVisible({ timeout: T });
		await expect(dialog).toContainText("2 hooks from");
		await expect(dialog).toContainText("1 hook from the plugin review-bot");
		await expect(dialog).toContainText("1 hook from the skill careful (when it is used)");
		await expect(dialog).toContainText("1 hook from the agent file runner (when it runs)");
		await expect(dialog).not.toContainText("may be incomplete");
		await dialog.getByRole("button", { name: "Details" }).click();
		await expect(dialog.getByText("pre tool use: ./bin/guard.sh · matches Bash")).toBeVisible();
		await expect(dialog.getByText("pre tool use: plugin-guard.sh")).toBeVisible();
		await expect(dialog.getByText("pre tool use: skill-guard.sh · matches Bash")).toBeVisible();
		await expect(dialog.getByText("subagent stop: agent-done.sh")).toBeVisible();
		await expect(dialog.getByText("session start: POST https://hooks.example.test/start")).toBeVisible();
		await noSecrets(w);
		await shot(w, "trust-dialog");
		// Nothing is added behind the dialog until it is answered.
		await expect(w.page.locator("[data-project-group]")).toHaveCount(0);
		await trustAndOpen(w);
	},
);

flow(
	"the trust dialog says its list may be incomplete when the engine cannot answer the question",
	{ files: PROJECT_FILES, env: { NAMZU_E2E_NO_HOOKS_COMMAND: "1" } },
	async (w) => {
		await addExistingFolder(w);
		const dialog = w.page.getByRole("dialog", { name: "Trust this folder?" });
		await expect(dialog).toBeVisible({ timeout: T });
		await expect(dialog).toContainText("This list may be incomplete");
		// Its own reading still names the config file's hooks, and cannot name the rest.
		await expect(dialog).toContainText("commands that run by themselves at set moments (hooks)");
		await expect(dialog).not.toContainText("the plugin review-bot");
		await shot(w, "trust-dialog-old-engine");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toHaveCount(0);
	},
);

flow(
	"Settings lists what runs by itself, and one switch turns the user's hooks off and on",
	{
		files: PROJECT_FILES,
		seed: (w) => writeFileSync(join(w.home, "config.yaml"), USER_CONFIG),
	},
	async (w) => {
		await addExistingFolder(w);
		await trustAndOpen(w);
		const page = w.page.locator("#settings-content");
		await openSettings(w, "Tools");
		const list = page.locator("#setting-hooks");
		await expect(list).toContainText("What runs by itself in", { timeout: T });
		await expect(list).toContainText("Before a tool runs");
		await expect(list).toContainText("When you send a message");
		await expect(list).toContainText("When a conversation starts");
		await expect(list).toContainText("./bin/guard.sh");
		await expect(list).toContainText("Plugin review-bot");
		await expect(list).toContainText("Skill careful");
		await expect(list).toContainText("Agent file runner");
		await expect(list).toContainText("Your own settings");
		await expect(list).toContainText("log-prompt.sh");
		await expect(list).toContainText("entry 1 is not a mapping");
		await noSecrets(w);
		await shot(w, "settings-hooks");

		const run = page.getByRole("switch", { name: "Run hooks" });
		await expect(run).toBeChecked();
		await run.click();
		await expect(run).not.toBeChecked({ timeout: T });
		assert.match(readFileSync(join(w.home, "config.yaml"), "utf8"), /disableHooks: true/);
		// The list is read again and says what the switch holds back.
		await expect(list.getByText("disableHooks (or NAMZU_DISABLE_HOOKS) is on").first()).toBeVisible({
			timeout: T,
		});
		await expect(list.getByText("Off", { exact: true }).first()).toBeVisible();
		await shot(w, "settings-hooks-off");
		await run.click();
		await expect(run).toBeChecked({ timeout: T });
		assert.doesNotMatch(readFileSync(join(w.home, "config.yaml"), "utf8"), /disableHooks/);
		await expect(list.getByText("Runs", { exact: true }).first()).toBeVisible({ timeout: T });
	},
);

flow(
	"the switch cannot be changed while the environment decides, and says why",
	{
		files: PROJECT_FILES,
		env: { NAMZU_DISABLE_HOOKS: "1" },
		seed: (w) => writeFileSync(join(w.home, "config.yaml"), USER_CONFIG),
	},
	async (w) => {
		await addExistingFolder(w);
		await trustAndOpen(w);
		await openSettings(w, "Tools");
		const page = w.page.locator("#settings-content");
		const run = page.getByRole("switch", { name: "Run hooks" });
		await expect(page.getByText("Hooks are switched off by the environment variable NAMZU_DISABLE_HOOKS")).toBeVisible({
			timeout: T,
		});
		await expect(run).toBeDisabled();
		await expect(run).not.toBeChecked();
		await shot(w, "settings-hooks-locked-env");
		assert.equal(existsSync(join(w.home, "config.yaml")) && /disableHooks/.test(readFileSync(join(w.home, "config.yaml"), "utf8")), false);
	},
);

flow(
	"a folder with no hooks says so in one sentence",
	{},
	async (w) => {
		await addExistingFolder(w);
		await trustAndOpen(w);
		await openSettings(w, "Tools");
		const page = w.page.locator("#settings-content");
		await expect(page.getByText("No hooks are set up here:")).toBeVisible({ timeout: T });
		await expect(page.getByRole("switch", { name: "Run hooks" })).toBeChecked();
		await shot(w, "settings-hooks-empty");
	},
);

// The switch is not only a picture: with a hook that leaves a mark each time it runs, a message sent
// with hooks on leaves one, and once the switch is off and the app has connected to the project again
// a message leaves none. (A project that is already connected keeps the settings it started with, so
// the page says the change reaches a project when it next connects.)
flow(
	"Run hooks decides whether a hook really starts, once the project connects again",
	{
		rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }],
		seed: (w) => {
			const mark = join(w.root, "marks.txt");
			w.mark = mark;
			writeFileSync(
				join(w.home, "config.yaml"),
				[
					"hooks:",
					"  UserPromptSubmit:",
					"    - hooks:",
					"        - type: command",
					"          command: sh",
					`          args: ["-c", "echo ran >> ${mark}"]`,
					"",
				].join("\n"),
			);
		},
	},
	async (w) => {
		const marks = () =>
			existsSync(w.mark) ? readFileSync(w.mark, "utf8").split("\n").filter(Boolean).length : 0;
		await addExistingFolder(w);
		await trustAndOpen(w);
		await send(w, "hello one");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({ timeout: T });
		assert.equal(marks(), 1, "the hook ran for the first message");
		await openSettings(w, "Tools");
		const run = w.page.locator("#settings-content").getByRole("switch", { name: "Run hooks" });
		await expect(run).toBeChecked({ timeout: T });
		await run.click();
		await expect(run).not.toBeChecked({ timeout: T });
		assert.match(readFileSync(join(w.home, "config.yaml"), "utf8"), /disableHooks: true/);
		await relaunch(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await send(w, "hello two");
		// The hook fires before the model is asked, so once the second request is in it has had its chance.
		await expect.poll(() => w.model.requests.length, { timeout: T }).toBeGreaterThanOrEqual(2);
		await expect(w.page.getByText("Scripted hello back.")).toHaveCount(2, { timeout: T });
		assert.equal(marks(), 1, "no hook ran after the switch was off and the project connected again");
		console.log(`fake model requests: ${w.model.requests.length}`);
	},
);
