// Commit changes from the session panel, narrowly: only the files this conversation changed, in a trusted
// folder, through a dialog with an editable message that the small model suggests (a plain one when it
// cannot), never pushing and never skipping a hook. Real Electron, real CLI host, real git in a throwaway
// repository with its own identity; the model is scripted.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-commit.test.mjs
// Pictures: research/sess-panel-20261117/<name>.png.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 90000;
const SHOTS = resolve(repoRoot, "research/sess-panel-20261117");
mkdirSync(SHOTS, { recursive: true });
const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
const AUDIT = "I did not run a check: it is a plain text file.";

const git = (cwd, ...args) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});

function repoWorld(options = {}) {
	return createWorld({
		answerHistory: true,
		answerAudit: AUDIT,
		tabs: "hidden",
		files: { "b.txt": "one\n", "notes.txt": "one\n" },
		rules: [{ match: /make the file/i, steps: [{ tool: "write", args: { path: "added.txt", content: "one\ntwo\n" } }, { text: "Made the file." }] }],
		seed: (w) => {
			git(w.project, "init", "-q", "-b", "trunk");
			git(w.project, "config", "user.name", "Fixture");
			git(w.project, "config", "user.email", "fixture@example.invalid");
			git(w.project, "config", "commit.gpgsign", "false");
			git(w.project, "add", "-A");
			git(w.project, "commit", "-q", "-m", "Start");
		},
		...options,
	});
}

const panel = (w) => w.page.getByTestId("session-panel");
const dialog = (w) => w.page.locator("[data-commit-dialog]");

async function makeTheFile(w) {
	await send(w, "make the file");
	const accept = w.page.getByRole("region", { name: "Tool approval" }).getByRole("button", { name: "Accept", exact: true });
	await accept.click({ timeout: T }).catch(() => {});
	await expect(w.page.getByText(AUDIT).first()).toBeVisible({ timeout: T });
	await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
}

test("Commit changes commits only this conversation's files with the edited message, and never pushes", { timeout: 280000 }, async () => {
	const world = await repoWorld({ commitMessage: "Add a two-line file for the notes" });
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.setSize(1280, 820)));
		await send(w, "hello");
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		await w.page.getByTestId("session-panel-toggle").click();
		const button = w.page.getByTestId("session-commit");
		// No edits yet: off, with the reason.
		await expect(button).toBeDisabled({ timeout: T });
		await expect(button).toHaveAttribute("title", "Nothing to commit");
		await makeTheFile(w);
		writeFileSync(join(w.project, "b.txt"), "changed by hand\n");
		await expect(button).toBeEnabled({ timeout: T });
		const configBefore = git(w.project, "config", "--list", "--local");
		await button.click();
		await expect(dialog(w)).toBeVisible({ timeout: T });
		const files = dialog(w).getByRole("list", { name: "Files to commit" }).locator("li");
		await expect(files).toHaveCount(1, { timeout: T });
		await expect(files.first()).toContainText("added.txt");
		await expect(dialog(w)).toContainText("1 other change will not be included.");
		await expect(dialog(w)).toContainText("Namzu will not push.");
		await expect(dialog(w).locator("[data-commit-branch]")).toHaveText("On trunk");
		const box = dialog(w).getByRole("textbox", { name: "Commit message" });
		await expect(box).toHaveValue("Add a two-line file for the notes");
		await expect(dialog(w)).toContainText("Suggested by the small model");
		// The model was asked once, with this file's change and not the hand edit.
		const asked = w.model.sideRequests.filter((r) => r.kind === "commit");
		assert.equal(asked.length, 1);
		const sent = JSON.stringify(asked[0].request);
		assert.ok(sent.includes("added.txt"), "the conversation's file is named");
		assert.ok(!sent.includes("changed by hand"), "a change made by hand is never sent");
		await shot(w, "commit-dialog");
		await box.fill("Add the notes file");
		await dialog(w).getByRole("button", { name: "Commit", exact: true }).click();
		await expect(dialog(w).locator("[data-commit-result]")).toContainText("Add the notes file", { timeout: T });
		await shot(w, "commit-done");
		assert.equal(git(w.project, "log", "-1", "--format=%s").trim(), "Add the notes file");
		assert.deepEqual(git(w.project, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean), ["added.txt"]);
		assert.equal(git(w.project, "status", "--porcelain").trim(), "M b.txt", "the hand edit is still dirty");
		assert.equal(git(w.project, "remote"), "", "there was nowhere to push, and nothing tried");
		assert.equal(git(w.project, "config", "--list", "--local"), configBefore, "no setting changed");
		await dialog(w).getByRole("button", { name: "Close" }).click();
		await expect(dialog(w)).toHaveCount(0);
		assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});

test("a failing hook is shown as it said it and nothing is committed; a missing small model gives the plain message", { timeout: 280000 }, async () => {
	const world = await repoWorld();
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.setSize(1280, 820)));
		await send(w, "hello");
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		const hook = join(world.project, ".git", "hooks", "pre-commit");
		mkdirSync(join(world.project, ".git", "hooks"), { recursive: true });
		writeFileSync(hook, '#!/bin/sh\necho "the hook says no" >&2\nexit 1\n');
		chmodSync(hook, 0o755);
		await w.page.getByTestId("session-panel-toggle").click();
		await makeTheFile(w);
		await w.page.getByTestId("session-commit").click();
		await expect(dialog(w)).toBeVisible({ timeout: T });
		// The scripted model refuses the request: the plain, deterministic message stands.
		await expect(dialog(w).getByRole("textbox", { name: "Commit message" })).toHaveValue("Add added.txt", { timeout: T });
		await expect(dialog(w)).not.toContainText("Suggested by the small model");
		await dialog(w).getByRole("button", { name: "Commit", exact: true }).click();
		await expect(dialog(w).getByRole("alert")).toContainText("the hook says no", { timeout: T });
		await shot(w, "commit-hook-failed");
		assert.equal(git(world.project, "log", "--format=%s").trim(), "Start", "nothing was committed");
		// The dialog is still open and usable.
		await expect(dialog(w).getByRole("button", { name: "Commit", exact: true })).toBeEnabled();
		await dialog(w).getByRole("button", { name: "Cancel" }).click();
		await expect(dialog(w)).toHaveCount(0);
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
