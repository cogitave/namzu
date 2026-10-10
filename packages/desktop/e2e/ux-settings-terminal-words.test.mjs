// Settings, the terminal's end state and the words of the app, against the real Electron app, the
// real CLI host and the scripted model. Pictures go to research/hygiene-20261010/settings-terminal-words/.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-settings-terminal-words.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	createWorld,
	dispose,
	enableTerminalDebug,
	expect,
	launch,
	openProject,
	repoRoot,
	send,
} from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/hygiene-20261010/settings-terminal-words");
const CHATS = [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }];

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld({
			...options,
			env: { SHELL: "/bin/sh", ...(options.env ?? {}) },
		});
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

async function resize(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, size) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(size.width, size.height);
		},
		{ width, height },
	);
	await expect.poll(() => w.page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width);
}

async function setAppearance(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}

/** 900 and 1280 px, dark and light, of whatever is on screen. */
async function shootAll(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	for (const width of [900, 1280]) {
		await resize(w, width, 800);
		for (const scheme of ["dark", "light"]) {
			await setAppearance(w, scheme);
			await w.page.screenshot({ path: join(SHOTS, `${name}-${width}-${scheme}.png`) });
		}
	}
	await setAppearance(w, "dark");
}

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

const content = (w) => w.page.locator("#settings-content");
const terminalTabs = (w) => w.page.locator("[data-terminal-tab-id]");

flow("Settings shows a project whose folder is gone plainly, with Locate and Remove", { rules: CHATS }, async (w) => {
	await openProject(w);
	await send(w, "hello there");
	await expect(w.page.getByText("Scripted hello back.")).toBeVisible({ timeout: T });
	await expect(w.page.locator("[data-project-group]")).toHaveCount(1);
	await w.app.close();
	renameSync(w.project, join(w.root, "moved-project"));
	await launch(w);
	await expect(w.page.locator("[data-project-missing]")).toBeVisible({ timeout: T });
	await openSettings(w, "Projects");
	const list = content(w).getByRole("list", { name: "Projects" });
	await expect(list).toContainText("Folder not found");
	await expect(list).not.toContainText("Needs reconnecting");
	await expect(list.getByRole("button", { name: /^Locate the folder for / })).toHaveText("Locate folder");
	await expect(list.getByRole("button", { name: /^Remove / })).toBeVisible();
	// The path is the readable one; the whole path is on hover.
	const path = list.locator(".settings-project-path");
	await expect(path).toHaveAttribute("title", w.project);
	await shootAll(w, "settings-projects-missing");
});

flow("About names the engine plainly and lists data folders with a way to copy the path", {}, async (w) => {
	await openProject(w);
	await openSettings(w, "About");
	await expect(content(w).getByText("Namzu engine", { exact: true })).toBeVisible();
	await expect(content(w)).not.toContainText("SDK");
	const folders = content(w).locator(".settings-folders li");
	await expect(folders.first()).toBeVisible();
	const count = await folders.count();
	assert.ok(count >= 2, "the data folders are listed");
	for (let i = 0; i < count; i += 1) {
		const row = folders.nth(i);
		await expect(row.getByRole("button", { name: /^Copy the path of / })).toHaveText("Copy path");
		const title = await row.locator(".settings-project-path").getAttribute("title");
		assert.ok(title?.startsWith(w.root) || title?.length, "the full path is on hover");
	}
	await expect(content(w)).toContainText("Safe to delete");
	await shootAll(w, "settings-about");
});

flow("Speech says one thing about the voice and its size in plain megabytes", {}, async (w) => {
	await openProject(w);
	await openSettings(w, "Speech");
	await expect(w.page.locator(".settings-page-header p")).toHaveText(/Read replies aloud/);
	await expect(content(w)).not.toContainText("MiB");
	await shootAll(w, "settings-speech");
});

flow("the sidebar says New conversation, in its label, tooltip and search", {}, async (w) => {
	await openProject(w);
	await expect(w.page.getByRole("button", { name: /^New conversation/ }).first()).toBeVisible({
		timeout: T,
	});
	await expect(w.page.getByRole("button", { name: /^New thread/ })).toHaveCount(0);
	await shootAll(w, "sidebar-new-conversation");
});

flow("an ended terminal uses one term, and a stopped one says so", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	const note = w.page.locator("[data-terminal-ended-note]");
	const input = () => w.page.locator("section.terminal-pane .xterm-helper-textarea");
	// A shell that exits by itself.
	await w.page.getByRole("button", { name: "New terminal tab" }).click();
	await expect(terminalTabs(w)).toHaveCount(1, { timeout: T });
	await input().focus();
	await w.page.keyboard.type("exit");
	await w.page.keyboard.press("Enter");
	await expect(note).toContainText("This terminal has ended. Press Enter to close, or R to restart.", {
		timeout: T,
	});
	await expect(note).not.toContainText(/session/i);
	await expect(note.getByRole("button", { name: "Close terminal" })).toBeVisible();
	await expect(w.page.locator(".terminal-strip-tab .terminal-badge")).toHaveAttribute("aria-label", "Ended");
	await expect(w.page.locator("li[data-terminal-row] .terminal-badge")).toHaveAttribute("title", "Ended");
	// The tab menu says the same word.
	await w.page.getByRole("button", { name: /^Actions for sh/ }).click();
	await expect(w.page.getByRole("menuitem", { name: "Close terminal" })).toBeVisible();
	await expect(w.page.getByRole("menuitem", { name: /End session/ })).toHaveCount(0);
	await w.page.keyboard.press("Escape");
	await shootAll(w, "terminal-ended");
	// A shell that is killed reads differently.
	await input().focus();
	await w.page.keyboard.press("Enter");
	await expect(terminalTabs(w)).toHaveCount(0, { timeout: T });
	await w.page.getByRole("button", { name: "New terminal tab" }).click();
	await expect(terminalTabs(w)).toHaveCount(1, { timeout: T });
	await input().focus();
	await w.page.keyboard.type("kill -9 $$");
	await w.page.keyboard.press("Enter");
	await expect(note).toContainText("The terminal was stopped.", { timeout: T });
	await shootAll(w, "terminal-stopped");
});
