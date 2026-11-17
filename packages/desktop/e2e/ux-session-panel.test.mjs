// The session panel beside a conversation: where it runs (host, folder, branch), how full the context is, the
// project's tool servers, what the conversation changed, and its background tasks with a running time and a
// finished count. It is off until asked for, remembers the choice, and gives way on a narrow window. Real
// Electron, real CLI host, scripted model.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-session-panel.test.mjs
// Pictures: research/sess-panel-20261117/<name>.png.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 90000;
/** What the model says when the kernel reminds it, once, that the files it wrote were not checked. */
const AUDIT = "I did not run a check: it is a plain text file.";
const SHOTS = resolve(repoRoot, "research/sess-panel-20261117");
mkdirSync(SHOTS, { recursive: true });
const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}.png`) });

const git = (cwd, ...args) =>
	execFileSync("git", args, {
		cwd,
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
		stdio: "pipe",
	});

async function size(w, width, height = 820) {
	await w.app.evaluate(
		({ BrowserWindow }, [wide, high]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(wide, high);
		},
		[width, height],
	);
	await expect.poll(() => w.page.evaluate((x) => Math.abs(window.innerWidth - x), width), { timeout: T }).toBeLessThanOrEqual(2);
}

const panel = (w) => w.page.getByTestId("session-panel");
const sections = (w) => w.page.locator(".session-section").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));

test("the session panel says where, how full, which servers, what changed and what runs", { timeout: 280000 }, async () => {
	const world = await createWorld({
		answerHistory: true,
		answerAudit: AUDIT,
		tabs: "hidden",
		files: { ".mcp.json": JSON.stringify({ mcpServers: { demo: { command: "node", args: ["-e", "0"] } } }), "notes.txt": "one\n" },
		rules: [
			{
				match: /edit the notes/i,
				steps: [{ tool: "write", args: { path: "added.txt", content: "one\ntwo\n" } }, { text: "Edited the notes." }],
			},
			{
				match: /start the job/i,
				steps: [{ tool: "bash", args: { command: "sleep 300", run_in_background: true } }, { text: "The job runs." }],
			},
		],
		seed: (w) => {
			git(w.project, "init", "-q", "-b", "trunk");
			git(w.project, "add", "notes.txt");
			git(w.project, "commit", "-q", "-m", "Start the notes");
		},
	});
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await size(w, 1280);
		await send(w, "tell me hello");
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		// Off until asked for.
		await expect(panel(w)).toHaveCount(0);
		const toggle = w.page.getByTestId("session-panel-toggle");
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await toggle.click();
		await expect(panel(w)).toBeVisible({ timeout: T });
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		assert.deepEqual(await sections(w), ["Environment", "Context", "Tool servers", "Changes", "Background tasks"]);
		// Environment: the host, the folder, the branch.
		const env = panel(w).locator('[aria-label="Environment"]');
		await expect(env).toContainText("This computer");
		await expect(env).toContainText("project");
		await expect(env).toContainText("trunk", { timeout: T });
		// Context is never a made-up zero.
		await expect(w.page.getByTestId("session-context")).toContainText(/Not measured yet|\d+%/);
		// Tool servers: the heading carries the word and a count line.
		await expect(panel(w).locator('[aria-label="Tool servers"]')).toContainText(/None|connected|Checking|Trust/, { timeout: T });
		// Changes: none yet.
		await expect(panel(w).locator('[aria-label="Changes"]')).toContainText("No file changes yet");
		// Background tasks: none.
		await expect(panel(w).locator('[aria-label="Background tasks"]')).toContainText("None", { timeout: T });
		await shot(w, "panel-open-empty");

		// A scripted edit shows in the totals.
		await send(w, "edit the notes");
		const accept = w.page.getByRole("region", { name: "Tool approval" }).getByRole("button", { name: "Accept", exact: true });
		await accept.click({ timeout: T }).catch(() => {});
		await expect(w.page.getByText(AUDIT).first()).toBeVisible({ timeout: T });
		await expect(panel(w).locator(".session-added")).toHaveText(/^\+(Added )?2$/, { timeout: T });
		await expect(panel(w).locator(".session-removed")).toContainText(/0/);

		// A background job: a running row with its own time and a stop square, then it finishes.
		await send(w, "start the job");
		await accept.click({ timeout: 20000 }).catch(() => {});
		await expect(w.page.getByText("The job runs.")).toBeVisible({ timeout: T });
		const row = panel(w).locator('[data-state="running"]');
		await expect(row).toHaveCount(1, { timeout: T });
		await expect(row.getByTestId("session-job-time")).toHaveText(/^\d+(s|m \d+s)$/);
		await shot(w, "panel-with-sections");
		await row.getByRole("button", { name: /^Stop/ }).click();
		await expect(panel(w).locator('[data-state="running"]')).toHaveCount(0, { timeout: T });
		await expect(panel(w).locator('[aria-label="Background tasks"]')).toContainText("1 finished", { timeout: T });
		await panel(w).getByRole("button", { name: /1 finished/ }).click();
		await expect(panel(w).locator('[data-state="finished"]')).toHaveCount(1);
		await expect(panel(w).locator('[data-state="finished"]')).toContainText("Stopped");
		await shot(w, "panel-finished-open");

		// Collapsed and remembered across a reload; narrow windows give the room back.
		await w.page.reload();
		await expect(panel(w)).toBeVisible({ timeout: T });
		await size(w, 820);
		await expect(panel(w)).toBeHidden();
		await shot(w, "panel-narrow-hidden");
		await size(w, 1280);
		await expect(panel(w)).toBeVisible();
		await panel(w).getByRole("button", { name: "Close the session panel" }).click();
		await expect(panel(w)).toHaveCount(0);
		await w.page.reload();
		await expect(w.page.getByTestId("session-panel-toggle")).toHaveAttribute("aria-pressed", "false", { timeout: T });
		assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});

test("the panel reads in the dark theme too", { timeout: 200000 }, async () => {
	const world = await createWorld({ answerHistory: true, tabs: "hidden", rules: [{ match: /hello/i, steps: [{ text: "Hello." }] }] });
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await size(w, 1280);
		await send(w, "hello");
		await expect(w.page.getByText("Hello.")).toBeVisible({ timeout: T });
		await w.page.getByTestId("session-panel-toggle").click();
		await expect(panel(w)).toBeVisible({ timeout: T });
		await w.page.evaluate(() => document.documentElement.classList.add("dark"));
		const colours = await w.page.evaluate(() => {
			const el = document.querySelector(".session-panel-aside");
			return { bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(document.querySelector(".session-panel")).color };
		});
		assert.notEqual(colours.bg, colours.fg, "text and surface differ in the dark theme");
		await shot(w, "panel-dark");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
