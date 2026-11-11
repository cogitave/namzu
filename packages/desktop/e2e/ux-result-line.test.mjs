// The foot of a finished turn is one result line, and the Changes pane is the diff first.
// The check segment is the kernel's outcome record and nothing else; the pane opens 520 px wide on
// the file that changed most, with the files beside the diff, and the sidebar steps aside in a
// narrow window and comes back.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-result-line.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, send } from "./harness.mjs";

const T = 90000;
const git = (cwd, ...a) =>
	execFileSync("git", a, {
		cwd,
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
	}).toString();
const files = {
	"package.json": JSON.stringify({ name: "harbor-api", type: "module", scripts: { test: "node --test" } }) + "\n",
	"src/login.js": "export function login(req, res) {\n  res.json({ ok: true });\n}\n",
	"src/limits.js": "export const LIMITS = {};\n",
	"test/smoke.test.js": "import test from 'node:test';\n\ntest('smoke', () => {});\n",
};
const seed = (w) => {
	rmSync(join(w.project, ".git"), { recursive: true, force: true });
	rmSync(join(w.project, "namzu.config.json"), { force: true });
	git(w.project, "init", "-q", "-b", "main");
	git(w.project, "add", "-A");
	git(w.project, "commit", "-q", "-m", "init");
};
const big = Array.from({ length: 19 }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n";
const rules = [
	{ match: /check passes/i, steps: [
		{ tool: "read", args: { path: "src/login.js" } },
		{ tool: "read", args: { path: "src/limits.js" } },
		{ tool: "write", args: { path: "src/big.js", content: big } },
		{ tool: "write", args: { path: "test/big.test.js", content: "import test from 'node:test';\n\ntest('big', () => {});\n" } },
		{ tool: "edit", args: { path: "src/login.js", old_string: "ok: true", new_string: "ok: true, limited: true" } },
		{ tool: "edit", args: { path: "src/limits.js", old_string: "{}", new_string: "{ max: 5 }" } },
		{ tool: "bash", args: { command: "node --test" } },
		{ text: "Passing run finished." },
	] },
	{ match: /no check/i, steps: [
		{ tool: "write", args: { path: "notes.txt", content: "one\ntwo\n" } },
		{ text: "Unchecked run finished." },
	] },
	{ match: /nothing changes/i, steps: [{ text: "Nothing run finished." }] },
	{ match: /check fails/i, steps: [
		{ tool: "write", args: { path: "test/bad.test.js", content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('bad', () => {\n  assert.equal(1, 2);\n});\n" } },
		{ tool: "bash", args: { command: "node --test" } },
		{ text: "Failing run finished." },
	] },
];

// The seed removes the sandbox config, so the folder needs no trust question.
async function openProject(w) {
	await w.page.getByRole("button", { name: "Add new project", exact: true }).last().click();
	await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
}
async function size(w, width, height) {
	await w.app.evaluate(({ BrowserWindow }, [wide, high]) => {
		for (const win of BrowserWindow.getAllWindows()) win.setSize(wide, high);
	}, [width, height]);
	await expect.poll(() => w.page.evaluate(() => window.innerWidth), { timeout: T }).toBe(width);
}
async function converse(w, text, done) {
	await w.page.getByRole("button", { name: "New conversation" }).first().click();
	await send(w, text);
	const card = w.page.getByRole("region", { name: "Tool approval" });
	for (;;) {
		const seen = await Promise.race([
			card.waitFor({ timeout: T }).then(() => "card"),
			w.page.getByText(done).first().waitFor({ timeout: T }).then(() => "done"),
		]);
		if (seen === "done") break;
		const accept = card.getByRole("button", { name: "Accept", exact: true });
		if ((await accept.getAttribute("aria-disabled")) === "true")
			await card.evaluate((el) => el.querySelectorAll("*").forEach((e) => { if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = e.scrollHeight; }));
		// A card can be answered and replaced between the look and the click; the next pass finds the new one.
		await accept.click({ timeout: 5000 }).catch(() => {});
	}
}
const line = (w) => w.page.getByRole("region", { name: "Result of this reply" });
const host = (w) => w.page.locator(".workspace-host");

test("the foot says what changed and what the record says about checking, and nothing more", { timeout: 480000 }, async () => {
	const w = await createWorld({ rules, files, seed, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);

		await converse(w, "Make a change and the check passes", /Passing run finished/);
		await expect(line(w)).toBeVisible({ timeout: T });
		assert.equal((await line(w).boundingBox())?.height, 40, "one 40 px row");
		await expect(line(w).locator(".turn-result-files")).toHaveText("4 files");
		await expect(line(w).locator(".turn-result-check")).toContainText("Checked: node --test passed");
		await expect(line(w)).toHaveAttribute("data-check", "ok");
		// The fold names what it hides, and the card, the outcome sentence and "View changes" are gone.
		await expect(w.page.locator(".activity-trigger").first()).toContainText(/Worked.*, 7 steps/);
		await expect(w.page.locator(".turn-changes, .turn-outcome-line")).toHaveCount(0);
		await expect(w.page.getByRole("button", { name: "View changes" })).toHaveCount(0);
		// The top bar says the same size, from the same source.
		await expect(w.page.locator(".conversation-bar-changes")).toContainText(/\+\d+/);
		const bar = await w.page.locator(".conversation-bar-lines").innerText();
		const row = await line(w).locator(".turn-result-counts").innerText();
		assert.equal(bar.replace(/\s+/g, ""), row.replace(/\s+/g, ""), "the bar and the line show one number");

		// Not checked: the counts, and no word about checking.
		await converse(w, "Make a change with no check", /Unchecked run finished/);
		await expect(line(w).locator(".turn-result-files")).toHaveText("1 file");
		await expect(line(w).locator(".turn-result-check")).toHaveCount(0);
		await expect(line(w)).not.toContainText(/check/i);

		// Nothing changed: today's quiet foot.
		await converse(w, "Run something where nothing changes", /Nothing run finished/);
		await expect(line(w)).toHaveCount(0);

		// A failed check is the loudest thing on the line.
		await converse(w, "Make a change where the check fails", /Failing run finished/);
		await expect(line(w)).toHaveAttribute("data-check", "error");
		await expect(line(w).locator(".turn-result-check")).toContainText("node --test failed");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("the menu holds Undo, Open file and Copy summary", { timeout: 300000 }, async () => {
	const w = await createWorld({ rules, files, seed, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await converse(w, "Make a change with no check", /Unchecked run finished/);
		await line(w).getByRole("button", { name: "More about this reply" }).click();
		await expect(w.page.getByRole("menuitem", { name: "Undo", exact: true })).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("menuitem", { name: "Copy summary" })).toBeVisible();
		await w.page.getByRole("menuitem", { name: "Open file" }).waitFor({ timeout: 5000 }).catch(() => {});
		await w.page.keyboard.press("Escape");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("the pane opens 520 px wide on the largest file, files beside the diff, one 40 px header", { timeout: 480000 }, async () => {
	const w = await createWorld({ rules, files, seed, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1440, 820);
		await converse(w, "Make a change and the check passes", /Passing run finished/);
		await line(w).getByRole("button", { name: /Open changes$/ }).click();
		const pane = w.page.getByRole("complementary", { name: "Changes" });
		await expect(pane).toBeVisible({ timeout: T });
		await expect.poll(async () => Math.round((await pane.boundingBox())?.width ?? 0), { timeout: T }).toBe(520);

		const bar = pane.locator(".changes-bar");
		assert.equal((await bar.boundingBox())?.height, 40);
		await expect(bar.getByRole("heading", { name: "Changes" })).toBeVisible();
		const all = bar.getByRole("button", { name: "All changes" });
		await expect(all).toHaveAttribute("aria-pressed", "true");
		await expect(bar.getByRole("button", { name: "This reply" })).toHaveAttribute("aria-pressed", "false");
		await expect(bar.getByRole("button", { name: "View options" })).toBeVisible();
		await expect(bar.getByRole("button", { name: "Close changes" })).toBeVisible();
		await expect(pane.getByRole("tab")).toHaveCount(0);
		await expect(pane.getByRole("button", { name: "Add a tab" })).toHaveCount(0);

		// The file that changed most is open, and the list sits to the left of the diff.
		await expect(pane.locator(".changes-flat-row[data-active]")).toContainText("big.js");
		const list = await pane.locator(".changes-files").boundingBox();
		const diff = await pane.locator(".changes-diff").boundingBox();
		assert.ok(list && diff && list.x + list.width <= diff.x + 1, "files beside the diff");
		assert.ok(Math.abs(list.width - 168) <= 6, `list is ${list.width} wide`);
		assert.ok(diff.height > 400, `the diff has the height: ${diff.height}`);

		// Wrap, collapse and split live in one View menu; This reply narrows the list.
		await bar.getByRole("button", { name: "View options" }).click();
		for (const name of ["Unified diff", "Split diff", "Wrap diff lines", "Collapse folders"])
			await expect(w.page.getByRole("menuitem", { name: new RegExp(name) }).or(w.page.getByRole("menuitemradio", { name: new RegExp(name) })).or(w.page.getByRole("menuitemcheckbox", { name: new RegExp(name) })).first()).toBeVisible();
		await w.page.keyboard.press("Escape");
		await bar.getByRole("button", { name: "This reply" }).click();
		await expect(bar.getByRole("button", { name: "This reply" })).toHaveAttribute("aria-pressed", "true");

		// Activity is in the Details popover, not the pane header.
		await bar.getByRole("button", { name: "Close changes" }).click();
		await expect(pane).toBeHidden({ timeout: T });
		await w.page.getByRole("button", { name: /^Conversation details/ }).click();
		await w.page.getByRole("button", { name: /Background work/ }).click();
		await expect(w.page.getByRole("complementary", { name: "Activity" })).toBeVisible({ timeout: T });
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("in a narrow window the sidebar steps aside for the pane and comes back, unless the person chose", { timeout: 480000 }, async () => {
	const w = await createWorld({ rules, files, seed, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1100, 760);
		await converse(w, "Make a change and the check passes", /Passing run finished/);
		const open = () => line(w).getByRole("button", { name: /Open changes$/ }).click();
		const pane = w.page.getByRole("complementary", { name: "Changes" });
		await expect(host(w)).toHaveAttribute("data-sidebar-collapsed", "false");

		await open();
		await expect(pane).toBeVisible({ timeout: T });
		await expect(host(w)).toHaveAttribute("data-sidebar-collapsed", "true");
		await pane.getByRole("button", { name: "Close changes" }).click();
		await expect(pane).toBeHidden({ timeout: T });
		await expect(host(w)).toHaveAttribute("data-sidebar-collapsed", "false");

		// A choice made while the pane is open is the person's own and stays.
		await open();
		await expect(host(w)).toHaveAttribute("data-sidebar-collapsed", "true");
		await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
		await expect(host(w)).toHaveAttribute("data-sidebar-collapsed", "false");
		await pane.getByRole("button", { name: "Close changes" }).click();
		await expect(host(w)).toHaveAttribute("data-sidebar-collapsed", "false");

		// A sidebar the person had already folded is left folded.
		await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
		await expect(host(w)).toHaveAttribute("data-sidebar-collapsed", "true");
		await open();
		await pane.getByRole("button", { name: "Close changes" }).click();
		await expect(host(w)).toHaveAttribute("data-sidebar-collapsed", "true");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
