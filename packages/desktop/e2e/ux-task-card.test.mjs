// The plan card in an ordinary project conversation (not a Pal's): the agent's steps in the flow under the
// message, each with its mark (done, running, not started), kept open while a step is left, and
// folded to "N of N" only once every step is done. Real Electron, real CLI host, scripted model.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-task-card.test.mjs
// Pictures: research/sess-panel-20261117/<name>.png.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 90000;
const SHOTS = resolve(repoRoot, "research/sess-panel-20261117");
mkdirSync(SHOTS, { recursive: true });
const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}.png`) });

/** The id the task tool named in its answer, found in the conversation so far, for the nth created task. */
const taskId = (messages, n) => {
	const ids = [];
	for (const m of messages) {
		const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
		const hit = /Task created: ([0-9a-f-]{36})/.exec(text);
		if (m.role === "tool" && hit) ids.push(hit[1]);
	}
	return ids[n];
};
const names = ["Read the folder", "Write the parser", "Add the tests", "Run the tests"];

test("a plan in a project conversation shows each state, stays open while a step is left, and folds when all are done", { timeout: 280000 }, async () => {
	const world = await createWorld({
		answerHistory: true,
		tabs: "hidden",
		rules: [
			{
				match: /plan the work/i,
				steps: [
					...names.map((subject) => ({ tool: "task_create", args: { subject, activeForm: `${subject}…` } })),
					{ tool: "task_update", args: (m) => ({ id: taskId(m, 0), status: "completed" }) },
					{ tool: "task_update", args: (m) => ({ id: taskId(m, 1), status: "in_progress" }) },
					{ hold: "mid", text: "Two steps are left." },
				],
			},
			{
				match: /finish the work/i,
				steps: [
					{ tool: "task_update", args: (m) => ({ id: taskId(m, 1), status: "completed" }) },
					{ tool: "task_update", args: (m) => ({ id: taskId(m, 2), status: "completed" }) },
					{ tool: "task_update", args: (m) => ({ id: taskId(m, 3), status: "completed" }) },
					{ text: "All four steps are done." },
				],
			},
		],
	});
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.setSize(1280, 820)));
		await send(w, "plan the work");
		const box = w.page.locator(".plan-box");
		await expect(box).toBeVisible({ timeout: T });
		// Every step is listed, each with its own mark.
		await expect(box.locator(".plan-box-steps > li")).toHaveCount(4, { timeout: T });
		await expect(box.locator(".plan-box-title")).toContainText("Write the parser", { timeout: T });
		await expect(box.locator(".plan-box-count")).toHaveText("1 of 4");
		const kinds = await box.locator(".plan-box-steps > li").evaluateAll((els) =>
			els.map((e) => (e.querySelector(".plan-box-ring") ? "pending" : e.querySelector(".plan-box-arc") ? "running" : e.querySelector("[data-failed]") ? "failed" : e.querySelector(".plan-box-disc") ? "done" : "?")),
		);
		assert.deepEqual(kinds, ["done", "running", "pending", "pending"]);
		await shot(w, "task-card-live");
		w.model.release("mid");
		await expect(w.page.getByText("Two steps are left.")).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		// The turn is over with steps left: the plan row in the work block stays open.
		const trigger = w.page.locator(".plan-trigger").first();
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
		await expect(trigger).toContainText("Plan · 1/4");
		await shot(w, "task-card-unfinished");
		// The plan is not a Pal's: the ordinary title and no "Progress" heading anywhere.
		await expect(w.page.getByRole("heading", { name: "Progress" })).toHaveCount(0);
		// Finish: the plan folds to its count once every step is done.
		await send(w, "finish the work");
		await expect(w.page.getByText("All four steps are done.")).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		await expect(w.page.locator(".plan-trigger").last()).toContainText("Plan · 4/4 done");
		await expect(w.page.locator(".plan-trigger").last()).toHaveAttribute("aria-expanded", "false");
		await shot(w, "task-card-done");
		assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
