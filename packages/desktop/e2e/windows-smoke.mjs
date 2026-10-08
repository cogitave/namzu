// Windows smoke for terminal tabs: an unpacked build (the staged app project), launched with a temp
// --user-data-dir, NAMZU_HOME and USERPROFILE, a scripted model, no owner data.
// Run with Windows node from the folder that holds this file: node win-smoke.mjs
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeModel } from "./e2e/fake-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "package.json"));
const { _electron, expect } = require("@playwright/test");
const SHOTS = join(here, "shots");
mkdirSync(SHOTS, { recursive: true });
const T = 90000;

// Everything lives under a folder whose name has a space: the launch has to survive that.
const run = mkdtempSync(join(process.env.TEMP, "namzu-terminal-run "));
const dirs = {
	project: join(run, "my project"),
	home: join(run, "namzu home"),
	osHome: join(run, "os home"),
	userData: join(run, "user data"),
	bin: join(run, "bin"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
mkdirSync(join(dirs.project, ".git"), { recursive: true });
writeFileSync(join(dirs.project, "namzu.config.json"), JSON.stringify({ sandbox: { enabled: false } }));
writeFileSync(
	join(dirs.home, "preferences.json"),
	JSON.stringify({ version: 3, providers: [{ id: "openai", model: "gpt-e2e-1" }], subagents: { active: [] } }),
);
// An installed engine CLI that is an npm shim (.cmd), which prints what it was started with.
writeFileSync(
	join(dirs.bin, "codex.cmd"),
	[
		"@echo off",
		"echo FAKE-codex ARGS: %*",
		"echo ready",
		"pause >nul",
		"exit /b 3",
		"",
	].join("\r\n"),
);

const model = await startFakeModel([], { models: ["gpt-e2e-1", "gpt-e2e-0"] });
const env = {};
for (const [k, v] of Object.entries(process.env))
	if (/^(PATH|Path|SystemRoot|SYSTEMROOT|ComSpec|COMSPEC|PATHEXT|windir|TEMP|TMP|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|ProgramFiles|ProgramFiles\(x86\)|ProgramData|ProgramW6432|OS|SystemDrive|HOMEDRIVE|COMPUTERNAME|USERNAME|USERDOMAIN)$/.test(k) && v !== undefined)
		env[k] = v;
env.PATH = `${dirs.bin};${env.PATH ?? env.Path ?? ""}`;
Object.assign(env, {
	USERPROFILE: dirs.osHome,
	HOME: dirs.osHome,
	HOMEPATH: "\\",
	APPDATA: join(dirs.osHome, "AppData", "Roaming"),
	LOCALAPPDATA: join(dirs.osHome, "AppData", "Local"),
	NAMZU_HOME: dirs.home,
	NAMZU_DESKTOP_CLI: join(here, "e2e", "cli-entry.mjs"),
	OPENAI_API_KEY: "e2e-not-a-secret",
	NAMZU_E2E_MODEL_URL: model.url,
});

const electron = join(here, "elec tron", "electron.exe");
const app = await _electron.launch({
	executablePath: electron,
	args: [join(here, "app"), `--user-data-dir=${dirs.userData}`],
	env,
});
let failed = true;
const results = [];
const note = (name) => {
	results.push(name);
	console.log("PASS", name);
};
try {
	await app.evaluate(({ dialog }, project) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
	}, dirs.project);
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => {
		for (const w of BrowserWindow.getAllWindows()) w.setSize(1280, 820);
	});
	await page.waitForLoadState("domcontentloaded");
	const faults = [];
	page.on("pageerror", (e) => faults.push(e.message));

	const welcome = page.getByRole("button", { name: "Add new project", exact: true });
	await expect(welcome.first()).toBeVisible({ timeout: T });
	await welcome.last().click();
	await page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	const consent = page.getByRole("dialog", { name: "Trust this folder?" });
	await expect(consent).toBeVisible({ timeout: T });
	await consent.getByRole("button", { name: "Trust folder" }).click();
	await expect(page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	await page.evaluate(() => localStorage.setItem("namzu.terminal.debug", "1"));
	await page.reload();
	await expect(page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	note("project opened from an unpacked build under a path with spaces");

	const tabs = page.locator("[data-terminal-tab-id]");
	const pane = page.locator("section.terminal-pane");
	const screen = () =>
		page.evaluate(() => {
			const id = document.querySelector("section.terminal-pane")?.getAttribute("data-terminal-tab");
			return id ? (window.__namzuTerminals?.text(id) ?? "") : "";
		});
	const type = async (text) => {
		await page.locator("section.terminal-pane .xterm-helper-textarea").focus();
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
	};

	// 1. A plain terminal: node-pty loads from the CLI runtime, the shell is Command Prompt on UTF-8.
	await page.getByRole("button", { name: "New terminal tab" }).click();
	await expect(pane).toBeVisible({ timeout: T });
	await expect.poll(screen, { timeout: T }).toContain(">");
	await type("echo ğüşöçı İ-ok");
	await expect.poll(screen, { timeout: T }).toMatch(/\nğüşöçı İ-ok/);
	note("a plain terminal tab echoes ğüşöçı İ intact");
	const title = await tabs.first().innerText();
	console.log("shell tab title:", JSON.stringify(title));
	// The terminal follows the pane's size.
	await type("mode con");
	await expect.poll(screen, { timeout: T }).toMatch(/Columns:\s+\d+/);
	const columns = Number((await screen()).match(/Columns:\s+(\d+)/g).at(-1).match(/(\d+)/)[1]);
	const measured = await page.evaluate(() => {
		const id = document.querySelector("section.terminal-pane")?.getAttribute("data-terminal-tab");
		return window.__namzuTerminals.size(id);
	});
	if (columns !== measured.cols) throw new Error(`program ${columns} columns, view ${measured.cols}`);
	note(`the program sees the view's width (${columns} columns)`);
	await page.screenshot({ path: join(SHOTS, "windows-shell-tab.png") });

	// 2. The Namzu engine: the bundled CLI as Electron-as-Node through cmd.exe /d /c call.
	await page.getByRole("button", { name: "New conversation tab" }).click();
	await expect(page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	await page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click();
	await page.getByRole("radio", { name: "OpenAI gpt-e2e-0" }).click();
	await page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click();
	await page.getByRole("radio", { name: "CLI", exact: true }).click();
	await page.evaluate(async () => {
		await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)));
	});
	await page.screenshot({ path: join(SHOTS, "windows-cli-switch.png") });
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Open Namzu in a terminal" }).click();
	await expect(tabs).toHaveCount(2, { timeout: T });
	await expect.poll(screen, { timeout: T }).toContain("gpt-e2e-0");
	const tui = await screen();
	console.log("TUI screen:\n" + tui.split("\n").slice(0, 12).join("\n"));
	note("the Namzu terminal app started on the composer's model");
	await page.screenshot({ path: join(SHOTS, "windows-namzu-cli-tab.png") });

	// 3. An installed engine that is an npm shim.
	const argv = await page.evaluate(async () => {
		const projects = await window.namzu.projects();
		const view = await window.namzu.workspace();
		const group = view.layout.windows.find((item) => item.id === view.windowId)?.root;
		return window.namzu.openTerminal({
			kind: "engine",
			engine: "codex-cli",
			projectId: projects.find((item) => !item.palId && !item.isChat).id,
			groupId: group.id,
			cols: 100,
			rows: 30,
			model: "gpt-5-codex",
			effort: "high",
			permissionMode: "accept-edits",
			prompt: "fix the build",
		});
	});
	console.log("open result:", JSON.stringify(argv));
	await expect(tabs).toHaveCount(3, { timeout: T });
	await expect.poll(screen, { timeout: T }).toContain("ready");
	const codex = await screen();
	for (const part of ["-m gpt-5-codex", "-c model_reasoning_effort=high", "-a on-request", "-s workspace-write", '-- "fix the build"'])
		if (!codex.includes(part)) throw new Error(`argv lacks ${part}:\n${codex}`);
	note("an npm shim runs through cmd.exe /d /c call with its arguments intact");
	await expect(tabs.nth(2).getByRole("img", { name: "Waiting for input" })).toBeVisible({ timeout: T });
	await page.screenshot({ path: join(SHOTS, "windows-codex-shim-tab.png") });
	await type("go");
	await expect(tabs.nth(2).getByRole("img", { name: "Exited with code 3" })).toBeVisible({ timeout: T });
	note("a failing exit code shows on the tab");

	if (faults.length) throw new Error(`renderer faults: ${faults.join("; ")}`);
	const preferences = JSON.parse(readFileSync(join(dirs.home, "preferences.json"), "utf8"));
	if (preferences.providers[0].model !== "gpt-e2e-1") throw new Error("the saved model changed");
	note("preferences.json is unchanged");
	failed = false;
} finally {
	await app.close().catch(() => undefined);
	await model.close().catch(() => undefined);
	console.log(failed ? "FAILED, kept " + run : "ALL PASS: " + results.length);
}
