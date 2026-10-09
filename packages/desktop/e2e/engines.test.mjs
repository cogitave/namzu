// Opening an external engine against the real Electron app and the real CLI host, with a stand-in
// `codex` that speaks the app-server protocol and records every process it is started as.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/engines.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/engines-20261009");

/**
 * A `codex` that answers `app-server` the way the real one does: initialize, account/read,
 * model/list, thread/start and a turn that completes at once. Every start and every request is
 * appended to `$FAKE_CODEX_DIR/log.ndjson`. While `$FAKE_CODEX_DIR/hold` exists, `initialize`
 * waits: that is the stall (a first run, an antivirus scan) the person would otherwise sit through.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const dir = process.env.FAKE_CODEX_DIR;
const log = (event) => fs.appendFileSync(dir + "/log.ndjson", JSON.stringify({ pid: process.pid, event }) + "\\n");
if (process.argv[2] === "--version") { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
if (process.argv[2] !== "app-server") process.exit(2);
log("start");
process.on("exit", () => log("exit"));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const wait = async () => { while (fs.existsSync(dir + "/hold")) await new Promise((r) => setTimeout(r, 25)); };
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
	const frame = JSON.parse(line);
	if (frame.id === undefined) return;
	log(frame.method);
	if (frame.method === "initialize") { await wait(); send({ id: frame.id, result: { userAgent: "fake", codexHome: dir } }); }
	else if (frame.method === "account/read") send({ id: frame.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
	else if (frame.method === "model/list") send({ id: frame.id, result: { data: JSON.parse(fs.readFileSync(dir + "/models.json", "utf8")), nextCursor: null } });
	else if (frame.method === "thread/start") send({ id: frame.id, result: { model: frame.params.model, thread: { id: "fake-thread-1", cwd: frame.params.cwd, status: { type: "idle" } } } });
	else if (frame.method === "turn/start") {
		const turn = { id: "fake-turn-1", status: "completed" };
		send({ method: "item/completed", params: { threadId: frame.params.threadId, turnId: turn.id, item: { type: "agentMessage", id: "fake-answer-1", text: "The stand-in engine answered.", phase: "final_answer" } } });
		send({ method: "turn/completed", params: { threadId: frame.params.threadId, turn } });
		send({ id: frame.id, result: { turn } });
	} else send({ id: frame.id, result: {} });
}).on("close", () => process.exit(0));
`;

const EFFORTS = [{ reasoningEffort: "medium" }];
const MODELS = [
	{ id: "fake-sol", model: "fake-sol", displayName: "Fake Sol", isDefault: true, supportedReasoningEfforts: EFFORTS, defaultReasoningEffort: "medium" },
	{ id: "fake-luna", model: "fake-luna", displayName: "Fake Luna", supportedReasoningEfforts: EFFORTS, defaultReasoningEffort: "medium" },
];

function flow(name, hold, body) {
	test(name, { timeout: 240000 }, async () => {
		const control = mkdtempSync(join(tmpdir(), "namzu-e2e-codex-"));
		writeFileSync(join(control, "models.json"), JSON.stringify(MODELS));
		writeFileSync(join(control, "log.ndjson"), "");
		if (hold) writeFileSync(join(control, "hold"), "");
		const pathPrefix = mkdtempSync(join(tmpdir(), "namzu-e2e-bin-"));
		writeFileSync(join(pathPrefix, "codex"), FAKE_CODEX);
		chmodSync(join(pathPrefix, "codex"), 0o755);
		const world = await createWorld({ pathPrefix, env: { FAKE_CODEX_DIR: control } });
		world.control = control;
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
			rmSync(control, { recursive: true, force: true });
			rmSync(pathPrefix, { recursive: true, force: true });
		}
	});
}

const events = (w) =>
	readFileSync(join(w.control, "log.ndjson"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const started = (w) => events(w).filter((row) => row.event === "start");
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The model trigger is the composer's button that names the model (or, while one starts, says so). */
const trigger = (w) => w.page.getByRole("button", { name: /^Model[:,]/ }).first();

async function chooseCodex(w) {
	await w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click();
	await w.page.getByRole("button", { name: /^Engine:/ }).click();
	await w.page.getByRole("radio", { name: /Codex CLI/ }).click();
}

flow("choosing Codex says it is starting, then one process serves the list and the first message", true, async (w) => {
	await openProject(w);
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	await chooseCodex(w);
	// The engine is held in its first start. The choice has not waited for it: the trigger says what
	// is happening instead of showing a blank or the previous model.
	await expect(trigger(w)).toHaveAccessibleName(/Starting Codex/, { timeout: T });
	await expect(w.page.getByText(/^Starting Codex/)).toBeVisible();
	// The engine popup has finished closing, so the picture shows the composer as it stays.
	await expect(w.page.getByRole("radiogroup", { name: "Available engines" })).toBeHidden({ timeout: T });
	await shot(w, "starting-codex");
	assert.equal(started(w).length, 1, "the choice started the engine once");
	rmSync(join(w.control, "hold"));
	await expect(trigger(w)).toHaveAccessibleName(/Fake Sol/, { timeout: T });
	// Opening the picker again is not another start.
	await trigger(w).click();
	await expect(w.page.getByRole("radio", { name: /Fake Luna/ })).toBeVisible({ timeout: T });
	await shot(w, "codex-list");
	await w.page.keyboard.press("Escape");
	assert.equal(started(w).length, 1, "the picker read the list from the process it had");
	// The first message opens the conversation on the process that discovery started.
	const box = w.page.getByRole("textbox", { name: "Message Namzu" });
	await box.fill("hello engine");
	await w.page.getByRole("button", { name: "Send message" }).click();
	await expect(w.page.getByText("The stand-in engine answered.")).toBeVisible({ timeout: T });
	const log = events(w);
	assert.equal(started(w).length, 1, "opening did not start the engine again");
	assert.equal(log.filter((row) => row.event === "initialize").length, 1, "and did not initialise it again");
	assert.ok(log.some((row) => row.event === "thread/start"));
	// Closing the app ends the engine.
	const pids = [...new Set(log.map((row) => row.pid))];
	await w.app.close().catch(() => undefined);
	await expect.poll(() => pids.some(alive), { timeout: T }).toBe(false);
	assert.ok(existsSync(w.control));
});

flow("an engine that answers at once shows no starting state, and no process outlives the app", false, async (w) => {
	await openProject(w);
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	await chooseCodex(w);
	await expect(trigger(w)).toHaveAccessibleName(/Fake Sol/, { timeout: T });
	assert.equal(started(w).length, 1);
	const pids = [...new Set(events(w).map((row) => row.pid))];
	// Nothing was sent, so the server discovery started is still waiting for a conversation to claim it.
	assert.ok(pids.some(alive), "the waiting server is running");
	await w.app.close().catch(() => undefined);
	await expect.poll(() => pids.some(alive), { timeout: T }).toBe(false);
});

/* ------------------------------------------------------------------------------------------------
 * Updates available: both external engines behind a local stand-in registry. The stand-in
 * programs report old versions; the stand-in `npm` and the second engine's `update` really change them, so the
 * flow ends with the version re-read and the model list asked of the "new" build.
 * ---------------------------------------------------------------------------------------------- */
import { createServer } from "node:http";
import { symlinkSync } from "node:fs";

const CODEX_SCRIPT = (version) => `#!/usr/bin/env node
const VERSION = "${version}";
${FAKE_CODEX.split("\n").slice(1).join("\n").replace('console.log("codex-cli 0.0.0-fake")', 'console.log("codex-cli " + VERSION)').replace('if (process.argv[2] !== "app-server") process.exit(2);', 'if (process.argv[2] !== "app-server") { console.log("fake codex terminal app"); setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0)); return; }')}
`;

const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_CODEX_DIR;
const all = process.argv.slice(2);
const args = all.filter((arg) => !arg.startsWith("--registry="));
console.log("fake npm " + all.join(" "));
if (fs.existsSync(dir + "/npm-fail")) { console.error("npm error code EBUSY"); process.exit(1); }
while (fs.existsSync(dir + "/update-hold")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
if (args[0] === "install" && args[1] === "-g" && args[2] === "@openai/codex@latest") {
	const latest = fs.readFileSync(dir + "/latest-codex", "utf8").trim();
	const file = dir + "/lib/node_modules/@openai/codex/bin/codex.js";
	const source = fs.readFileSync(file, "utf8").replace(/const VERSION = "[^"]*";/, 'const VERSION = "' + latest + '";');
	fs.writeFileSync(file, source + "\\n// installed " + Date.now() + "\\n");
	if (fs.existsSync(dir + "/models.next.json")) fs.copyFileSync(dir + "/models.next.json", dir + "/models.json");
	console.log("added 1 package, changed 1 package");
	process.exit(0);
}
process.exit(3);
`;

const FAKE_SECOND = (version) => `#!/usr/bin/env node
const VERSION = "${version}";
const fs = require("node:fs");
const dir = process.env.FAKE_CODEX_DIR;
if (process.argv[2] === "--version") { console.log(VERSION + " (Claude Code)"); process.exit(0); }
if (process.argv[2] === "update") {
	console.log("Checking for updates...");
while (fs.existsSync(dir + "/update-hold")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
	const latest = fs.readFileSync(dir + "/latest-claude", "utf8").trim();
	const file = __filename;
	fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/const VERSION = "[^"]*";/, 'const VERSION = "' + latest + '";') + "\\n// updated " + Date.now() + "\\n");
	console.log("Successfully updated from " + VERSION + " to " + latest);
	process.exit(0);
}
process.exit(2);
`;

async function startRegistry() {
	const state = {
		versions: {
			"@openai/codex": "0.162.0",
			"@anthropic-ai/claude-code": "2.1.295",
			// Never newer than a `namzu` the machine may have on PATH: this flow is about the other two.
			"@namzu/cli": "1.0.0",
		},
		status: 200,
		requests: [],
	};
	const server = createServer((req, res) => {
		state.requests.push(req.url);
		const match = /^\/(.+)\/latest$/.exec(req.url ?? "");
		const version = match ? state.versions[decodeURIComponent(match[1])] : undefined;
		if (state.status !== 200 || !version) {
			res.writeHead(state.status === 200 ? 404 : state.status).end("{}");
			return;
		}
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version }));
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	state.url = `http://127.0.0.1:${server.address().port}`;
	state.close = () => new Promise((done) => server.close(done));
	return state;
}

/**
 * The second engine is where its own installer puts it (`~/.local/bin`) unless the flow says it lives elsewhere.
 * `codex` is an Installed with npm: PATH holds a symlink into its package folder under node_modules.
 */
function updateFlow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const control = mkdtempSync(join(tmpdir(), "namzu-e2e-codex-"));
		writeFileSync(join(control, "models.json"), JSON.stringify(MODELS));
		writeFileSync(join(control, "log.ndjson"), "");
		writeFileSync(join(control, "latest-codex"), "0.162.0");
		writeFileSync(join(control, "latest-claude"), "2.1.295");
		const lib = join(control, "lib/node_modules/@openai/codex/bin");
		mkdirSync(lib, { recursive: true });
		writeFileSync(join(lib, "codex.js"), CODEX_SCRIPT("0.154.0"));
		chmodSync(join(lib, "codex.js"), 0o755);
		const bin = mkdtempSync(join(tmpdir(), "namzu-e2e-bin-"));
		symlinkSync(join(lib, "codex.js"), join(bin, "codex"));
		writeFileSync(join(bin, "npm"), FAKE_NPM);
		chmodSync(join(bin, "npm"), 0o755);
		const registry = await startRegistry();
		if (options.registryDown) registry.status = 503;
		const world = await createWorld({
			pathPrefix: bin,
			env: {
				FAKE_CODEX_DIR: control,
				NAMZU_ENGINE_REGISTRY: registry.url,
				NAMZU_ENGINE_FIRST_CHECK_MS: "300",
				SHELL: "/bin/sh",
			},
			seed: (w) => {
				// Where its own installer puts it. A real one earlier on the machine's PATH would shadow it,
				// so PATH holds a link to it; the install method is read from where the link leads.
				const where = options.secondAt ? join(bin, "claude") : join(w.osHome, ".local/bin/claude");
				mkdirSync(join(where, ".."), { recursive: true });
				writeFileSync(where, FAKE_SECOND("2.1.290"));
				chmodSync(where, 0o755);
				if (!options.secondAt) symlinkSync(where, join(bin, "claude"));
			},
		});
		Object.assign(world, { control, registry, bin });
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
			await registry.close();
			rmSync(control, { recursive: true, force: true });
			rmSync(bin, { recursive: true, force: true });
		}
	});
}

const termTabs = (w) => w.page.locator("[data-terminal-tab-id]");
const termScreen = (w) =>
	w.page.evaluate(() => {
		const id = document.querySelector("section.terminal-pane")?.getAttribute("data-terminal-tab");
		return id ? (window.__namzuTerminals?.text(id) ?? "") : "";
	});
const row = (w, id) => w.page.locator(`#setting-engine-${id}`);
const railBadge = (w) => w.page.getByRole("button", { name: /^Updates available\. Open Settings to update/ });
const openUpdates = async (w) => {
	await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	await w.page.getByRole("button", { name: "Updates", exact: true }).click();
	await expect(w.page.getByRole("heading", { name: "Programs Namzu works with" })).toBeVisible({
		timeout: T,
	});
};
async function enableTerminalScreens(w) {
	await w.page.evaluate(() => localStorage.setItem("namzu.terminal.debug", "1"));
	await w.page.reload();
	await w.page.waitForLoadState("domcontentloaded");
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
}
const installedCodex = (w) => {
	const source = readFileSync(join(w.control, "lib/node_modules/@openai/codex/bin/codex.js"), "utf8");
	return /const VERSION = "([^"]*)"/.exec(source)?.[1];
};

updateFlow(
	"a registry that is down is quiet; when it answers, a behind Codex shows a badge, an engine note and a toast; Update runs in a terminal tab, re-reads the version and refreshes the models",
	{ registryDown: true },
	async (w) => {
		await openProject(w);
		await enableTerminalScreens(w);
		await chooseCodex(w);
		await expect(trigger(w)).toHaveAccessibleName(/Fake Sol/, { timeout: T });
		const discovery = [...new Set(events(w).map((row) => row.pid))];
		assert.ok(discovery.some(alive), "Namzu's own idle server for Codex is running");
		// The first check ran by itself against a registry that is down: nothing is said and nothing shows.
		await expect.poll(() => w.registry.requests.length, { timeout: T }).toBeGreaterThan(0);
		await openUpdates(w);
		await expect(row(w, "codex-cli")).toContainText("0.154.0");
		await expect(row(w, "codex-cli")).toContainText("Could not check");
		await expect(railBadge(w)).toHaveCount(0);
		await shot(w, "updates-registry-down");
		// The registry answers; the person asks to check.
		w.registry.status = 200;
		await w.page.getByRole("button", { name: /^Check (for updates|the programs)$/ }).click();
		await expect(railBadge(w)).toHaveAccessibleName(
			"Updates available. Open Settings to update Codex CLI and Claude Code",
			{ timeout: T },
		);
		// The launch toast names each new version once, with an action that opens Settings ▸ Updates.
		// Both found at once: one toast names both, so neither hides behind the other.
		await expect(w.page.getByText("Updates available for Codex CLI and Claude Code")).toBeVisible({
			timeout: T,
		});
		await expect(w.page.getByText("Codex CLI 0.162.0 is available")).toHaveCount(0);
		await shot(w, "updates-badge-and-toast");
		await expect(row(w, "codex-cli")).toContainText("0.154.0 → 0.162.0");
		await expect(row(w, "codex-cli")).toContainText("Installed with npm");
		await expect(row(w, "claude-code")).toContainText("2.1.290 → 2.1.295");
		await expect(row(w, "claude-code")).toContainText("Installed by its own installer");
		// A `namzu` the machine has on PATH is read like the others; without one the bundled command line says it updates with the app.
		await expect(row(w, "namzu-cli")).toContainText("Up to date");
		await shot(w, "updates-settings");
		// The engine view of the model popup carries a quiet note for the programs that are behind, and not for Namzu itself.
		await w.page.getByRole("button", { name: "Home", exact: true }).click();
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click();
		await w.page.getByRole("button", { name: /^Engine:/ }).click();
		await expect(w.page.getByRole("radio", { name: /Codex CLI/ })).toContainText("Update available (0.162.0)");
		await expect(w.page.getByRole("radio", { name: "Claude Code" })).toContainText("Update available (2.1.295)");
		await expect(w.page.getByRole("radio", { name: /^Namzu/ })).not.toContainText("Update available");
		await shot(w, "updates-engine-note");
		await w.page.keyboard.press("Escape");
		// The toast's own action opens Settings ▸ Updates.
		await w.page.getByRole("button", { name: "Update…" }).first().click();
		await expect(w.page.getByRole("heading", { name: "Programs Namzu works with" })).toBeVisible({ timeout: T });
		// The updated program lists one more model than the old one did.
		writeFileSync(
			join(w.control, "models.next.json"),
			JSON.stringify([
				...MODELS,
				{ id: "fake-nova", model: "fake-nova", displayName: "Fake Nova", supportedReasoningEfforts: EFFORTS, defaultReasoningEffort: "medium" },
			]),
		);
		// A click runs the command in a visible terminal tab (held until the flow has looked at it).
		writeFileSync(join(w.control, "update-hold"), "");
		await row(w, "codex-cli").getByRole("button", { name: "Update Codex CLI" }).click();
		// The person stays in Settings; the terminal tab is one click away.
		await expect(w.page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
		await showUpdateOutput(w);
		// The strip may show a shorter whole-word title in a narrow window; the full one is the label.
		await expect(termTabs(w).first().locator(".conversation-tab-label")).toHaveAttribute(
			"aria-label",
			/^Updating Codex CLI, terminal/,
		);
		await expect.poll(() => termScreen(w), { timeout: T }).toContain("--registry=");
		await expect.poll(() => termScreen(w), { timeout: T }).toContain("@openai/codex@latest");
		await shot(w, "updates-terminal");
		// Namzu's own idle server for Codex was ended before the command ran.
		await expect.poll(() => discovery.some(alive), { timeout: T }).toBe(false);
		rmSync(join(w.control, "update-hold"));
		await expect(w.page.getByText("Codex CLI updated to 0.162.0")).toBeVisible({ timeout: T });
		// A successful update has nothing left to read: its tab closes by itself.
		await expect(termTabs(w)).toHaveCount(0, { timeout: T });
		assert.equal(installedCodex(w), "0.162.0");
		// Settings reads the new version and the row says so; only the second engine is still behind.
		await openUpdates(w);
		await expect(row(w, "codex-cli")).toContainText("0.162.0");
		await expect(row(w, "codex-cli")).toContainText("Up to date");
		await expect(row(w, "codex-cli")).toContainText("Installed with npm · Open conversations use the new version after they restart.");
		await expect(row(w, "codex-cli").getByRole("button")).toHaveCount(0);
		await expect(railBadge(w)).toHaveAccessibleName(
			"Updates available. Open Settings to update Claude Code",
		);
		await shot(w, "updates-settings-after");
		// The same page in the light theme.
		await w.page.evaluate(() => {
			localStorage.setItem("namzu.appearance", "light");
			window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: "light" }));
		});
		await expect(w.page.locator("html")).not.toHaveClass(/dark/);
		await shot(w, "updates-settings-light");
		await w.page.evaluate(() => {
			localStorage.setItem("namzu.appearance", "dark");
			window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: "dark" }));
		});
		await expect(w.page.locator("html")).toHaveClass(/dark/);
		// The model list is asked of the new build: the old build's stored list is gone, so the picker
		// shows what the updated program lists.
		await w.page.getByRole("button", { name: "Home", exact: true }).click();
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await chooseCodex(w);
		await expect(trigger(w)).toHaveAccessibleName(/Fake Sol/, { timeout: T });
		await trigger(w).click();
		await expect(w.page.getByRole("radio", { name: /Fake Nova/ })).toBeVisible({ timeout: T });
		await shot(w, "updates-models-refreshed");
		await w.page.keyboard.press("Escape");
	},
);

/** An update runs in a terminal tab behind Settings; open the newest tab to read its output. */
async function showUpdateOutput(w) {
	await expect(termTabs(w).first()).toBeAttached({ timeout: T });
	await w.page.getByRole("button", { name: "Home", exact: true }).click();
	await termTabs(w).last().getByRole("tab").click();
}

/** The check the person asks for, once the registry is up. Returns when the rows have read the registry. */
async function checkNow(w) {
	await openUpdates(w);
	await w.page.getByRole("button", { name: /^Check (for updates|the programs)$/ }).click();
	await expect(railBadge(w)).toBeVisible({ timeout: T });
}

/** An engine's own terminal, as the composer's CLI switch opens it. */
async function openEngineTerminal(w, engine) {
	return w.page.evaluate(async (wanted) => {
		const projects = await window.namzu.projects();
		const view = await window.namzu.workspace();
		const group = view.layout.windows.find((item) => item.id === view.windowId)?.root;
		return window.namzu.openTerminal({
			kind: "engine",
			engine: wanted,
			projectId: projects.find((item) => !item.palId && !item.isChat).id,
			groupId: group?.id ?? view.homeGroupId,
			cols: 100,
			rows: 30,
			permissionMode: "plan",
		});
	}, engine);
}

updateFlow(
	"an update waits while the engine is open in a terminal, a failed command says so, and Try again runs it",
	{},
	async (w) => {
		await openProject(w);
		await enableTerminalScreens(w);
		await checkNow(w);
		const live = await openEngineTerminal(w, "codex-cli");
		await expect(termTabs(w)).toHaveCount(1, { timeout: T });
		// Settings is in front; the engine's own terminal is behind it in the strip.
		await w.page.getByRole("button", { name: "Home", exact: true }).click();
		await termTabs(w).first().getByRole("tab").click();
		await expect.poll(() => termScreen(w), { timeout: T }).toContain("fake codex terminal app");
		await openUpdates(w);
		await row(w, "codex-cli").getByRole("button", { name: "Update Codex CLI" }).click();
		// Nothing ran and nothing was stopped: the person is told what to close.
		await expect(row(w, "codex-cli").getByRole("alert")).toHaveText("Close the Codex CLI tab first.");
		await expect(row(w, "codex-cli")).toContainText("Update available");
		assert.equal(installedCodex(w), "0.154.0");
		await shot(w, "updates-refused-while-open");
		await w.page.evaluate((tab) => window.namzu.closeTerminal(tab), live.terminal.id);
		await expect(termTabs(w)).toHaveCount(0, { timeout: T });
		// The command fails the way a locked program does.
		writeFileSync(join(w.control, "npm-fail"), "");
		await openUpdates(w);
		await row(w, "codex-cli").getByRole("button", { name: "Update Codex CLI" }).click();
		await showUpdateOutput(w);
		await expect.poll(() => termScreen(w), { timeout: T }).toContain("npm error code EBUSY");
		await expect(w.page.getByText("Codex CLI update failed. The terminal tab shows why.", { exact: true }).first()).toBeVisible({ timeout: T });
		// The tab stays, so the output can be read.
		await expect(termTabs(w)).toHaveCount(1);
		await openUpdates(w);
		await expect(row(w, "codex-cli")).toContainText("Update failed");
		await expect(row(w, "codex-cli")).toContainText("Codex CLI update failed. The terminal tab shows why.");
		await shot(w, "updates-failed");
		assert.equal(installedCodex(w), "0.154.0");
		rmSync(join(w.control, "npm-fail"));
		await row(w, "codex-cli").getByRole("button", { name: "Try again Codex CLI" }).click();
		await expect(w.page.getByText("Codex CLI updated to 0.162.0")).toBeVisible({ timeout: T });
		assert.equal(installedCodex(w), "0.162.0");
		await openUpdates(w);
		await expect(row(w, "codex-cli")).toContainText("Up to date");
	},
);

updateFlow(
	"Claude Code updates through its own command, and the version is read again",
	{},
	async (w) => {
		await openProject(w);
		await enableTerminalScreens(w);
		await checkNow(w);
		await openUpdates(w);
		await expect(row(w, "claude-code")).toContainText("The update runs in a terminal tab you can watch.");
		writeFileSync(join(w.control, "update-hold"), "");
		await row(w, "claude-code").getByRole("button", { name: "Update Claude Code" }).click();
		await showUpdateOutput(w);
		await expect(termTabs(w).first().locator(".conversation-tab-label")).toHaveAttribute(
			"aria-label",
			/^Updating Claude Code, terminal/,
		);
		await expect.poll(() => termScreen(w), { timeout: T }).toContain("Checking for updates...");
		rmSync(join(w.control, "update-hold"));
		await expect(w.page.getByText("Claude Code updated to 2.1.295")).toBeVisible({ timeout: T });
		await expect(termTabs(w)).toHaveCount(0, { timeout: T });
		await openUpdates(w);
		await expect(row(w, "claude-code")).toContainText("2.1.295");
		await expect(row(w, "claude-code")).toContainText("Up to date");
		await expect(row(w, "claude-code").getByRole("button")).toHaveCount(0);
	},
);

updateFlow(
	"an install Namzu cannot name is never run: the command is shown with a Copy button",
	{ secondAt: true },
	async (w) => {
		await openProject(w);
		await enableTerminalScreens(w);
		await checkNow(w);
		await openUpdates(w);
		const second = row(w, "claude-code");
		await expect(w.page.getByRole("button", { name: /^Check (for updates|the programs)$/ })).toBeVisible({ timeout: T });
		await expect(second).toContainText("2.1.290 → 2.1.295");
		await expect(second).toContainText("Namzu can’t tell how this was installed, so it won’t run the update.");
		await expect(second).toContainText("Run: claude update");
		await expect(second.getByRole("button", { name: "Update Claude Code" })).toHaveCount(0);
		await second.getByRole("button", { name: "Copy the Claude Code update command" }).click();
		await expect(second.getByRole("button", { name: "Copy the Claude Code update command" })).toHaveText("Copied");
		assert.equal(await w.app.evaluate(({ clipboard }) => clipboard.readText()), "claude update");
		await shot(w, "updates-unknown-install");
		// Nothing was started.
		await expect(termTabs(w)).toHaveCount(0);
		assert.match(readFileSync(join(w.control, "latest-claude"), "utf8"), /2\.1\.295/);
	},
);
