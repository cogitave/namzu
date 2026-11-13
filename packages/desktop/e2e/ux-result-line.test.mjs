// The foot of a finished turn is one 32 px result line of text, and the Changes pane is the diff first.
// The check segment is the kernel's outcome record and nothing else; the pane opens 520 px wide on
// the file that changed most, with the files beside the diff, and the sidebar steps aside in a
// narrow window and comes back.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-result-line.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
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
		// The card can be answered and replaced between waiting for it and looking at its button: then the next pass finds the new one.
		const disabled = await accept.getAttribute("aria-disabled", { timeout: 5000 }).catch(() => null);
		if (disabled === "true")
			await card.evaluate((el) => el.querySelectorAll("*").forEach((e) => { if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = e.scrollHeight; }));
		// A card can be answered and replaced between the look and the click; the next pass finds the new one.
		await accept.click({ timeout: 5000 }).catch(() => {});
	}
}
// Set NAMZU_RESULT_SHOTS to a folder to keep dark and light pictures at 1280x820 of each state.
const SHOTS = process.env.NAMZU_RESULT_SHOTS;
async function snap(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await size(w, 1280, 820);
	for (const mode of ["dark", "light"]) {
		await w.page.evaluate((value) => {
			localStorage.setItem("namzu.appearance", value);
			window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
		}, mode);
		await expect(w.page.locator("html")).toHaveClass(mode === "dark" ? /dark/ : /^((?!dark).)*$/);
		await w.page.screenshot({ path: join(SHOTS, `${name}-${mode}.png`) });
	}
}
const undoFully = async (w, expectText) => {
	await line(w).getByRole("button", { name: "More about this reply" }).click();
	await w.page.getByRole("menuitem", { name: "Undo", exact: true }).click();
	const dialog = w.page.getByRole("dialog");
	await dialog.getByRole("button", { name: /^Undo/ }).last().click();
	await expect(dialog.getByText(expectText)).toBeVisible({ timeout: T });
	await w.page.keyboard.press("Escape");
};
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
		assert.equal((await line(w).boundingBox())?.height, 32, "one 32 px row");
		await expect(line(w).locator(".turn-result-files")).toHaveText("4 files");
		await expect(line(w).locator(".turn-result-check")).toContainText("Checked: node --test passed");
		await expect(line(w)).toHaveAttribute("data-check", "ok");
		// The fold names what it hides, and the card, the outcome sentence and "View changes" are gone.
		// The fold says what the work was, in the words a group of steps uses, and the time after it.
		await expect(w.page.locator(".activity-trigger").first()).toContainText(/^Read 2 files, created 2 files, and 2 more\s*· \d+s/);
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
		// The turn finished; the record did not call it done.
		await expect(line(w).locator(".turn-result-lead")).toHaveText(/^Finished/);
		await expect(line(w).locator(".turn-result-lead")).not.toContainText("Done");
		await snap(w, "failing-check");
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
		// The pane may still be settling when it first shows: both boxes are read together until the
		// list sits left of the diff, and the geometry below uses that same reading.
		let list;
		let diff;
		await expect.poll(async () => {
			const both = await pane.evaluate((el) => {
				const box = (selector) => {
					const r = el.querySelector(selector)?.getBoundingClientRect();
					return r && { x: r.x, width: r.width, height: r.height };
				};
				return { list: box(".changes-files"), diff: box(".changes-diff") };
			});
			({ list, diff } = both);
			return Boolean(list && diff && list.x + list.width <= diff.x + 1 && Math.abs(list.width - 168) <= 6 && diff.height > 400);
		}, { timeout: T }).toBe(true);
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

const more = [
	{ match: /fail and part undo/i, steps: [
		{ tool: "write", args: { path: "src/keep.js", content: "export const keep = 1;\n" } },
		{ tool: "write", args: { path: "test/bad2.test.js", content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('bad', () => {\n  assert.equal(1, 2);\n});\n" } },
		{ tool: "bash", args: { command: "node --test" } },
		{ text: "Partly run finished." },
	] },
	{ match: /unknown command/i, steps: [
		{ tool: "write", args: { path: "notes.txt", content: "one\ntwo\n" } },
		{ text: "Unknown run finished." },
	] },
	{ match: /undo everything/i, steps: [
		{ tool: "read", args: { path: "src/login.js" } },
		{ tool: "write", args: { path: "src/fresh.js", content: "export const fresh = 1;\n" } },
		{ tool: "edit", args: { path: "src/login.js", old_string: "ok: true", new_string: "ok: true, again: true" } },
		{ text: "Undo run finished." },
	] },
	{ match: /long names/i, steps: [
		{ tool: "write", args: { path: "src/components/settings-panel-for-the-whole-workspace-a.ts", content: "export const a = 1;\n" } },
		{ tool: "write", args: { path: "src/components/settings-panel-for-the-whole-workspace-b.ts", content: "export const b = 2;\nexport const c = 3;\n" } },
		{ text: "Names run finished." },
	] },
];

test("a failing check stays on the row through a partial undo, and the undo is said beside it", { timeout: 480000 }, async () => {
	const w = await createWorld({ rules: more, files, seed, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await converse(w, "Make it fail and part undo", /Partly run finished/);
		await expect(line(w).locator(".turn-result-check")).toContainText("node --test failed");
		// A file edited by hand since the reply is left alone by the undo, so the undo is partial.
		appendFileSync(join(w.project, "test/bad2.test.js"), "// mine\n");
		await undoFully(w, /Partly undone/);
		await expect(line(w)).toHaveAttribute("data-undo", "partial", { timeout: T });
		await expect(line(w).locator(".turn-result-check")).toContainText("node --test failed");
		await expect(line(w)).toHaveAttribute("data-check", "error");
		await expect(line(w).locator(".turn-result-undo")).toHaveText(/^Partly undone, 1 file kept$/);
		await expect(line(w).locator(".turn-result-lead")).toHaveText(/^Finished/);
		await snap(w, "failing-partly-undone");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("an unknown record with counted edits shows the counts alone, and the caveat is reachable", { timeout: 480000 }, async () => {
	const w = await createWorld({ rules: more, files, seed, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		// The kernel never says "unknown" after a counted edit, so this one state is shaped at the
		// boundary: the host's outcome event for the turn is rewritten on its way to the renderer, and
		// everything after it (the model, the row, the menu) is the real app.
		await w.app.evaluate(({ BrowserWindow }) => {
			const record = { verdict: "unknown", line: "A command ran that may have changed files · cannot tell here · not repeated in this conversation", changed: 0 };
			const rewrite = (value) => Array.isArray(value) ? value.map(rewrite) : value && typeof value === "object" && value.kind === "outcome" ? { ...value, ...record } : value;
			for (const win of BrowserWindow.getAllWindows()) {
				const send = win.webContents.send.bind(win.webContents);
				win.webContents.send = (channel, ...args) => send(channel, ...args.map(rewrite));
			}
		});
		await converse(w, "Run an unknown command", /Unknown run finished/);
		await expect(line(w).locator(".turn-result-files")).toHaveText("1 file");
		await expect(line(w).locator(".turn-result-check")).toHaveCount(0);
		const tip = await line(w).locator(".turn-result-size").getAttribute("title");
		const said = await line(w).getByRole("button", { name: /Open changes$/ }).getAttribute("aria-label");
		assert.match(tip ?? "", /^These are the edits made with the edit tools\. A command ran that may have changed files/, said ?? "");
		const name = (await line(w).getByRole("button", { name: /Open changes$/ }).getAttribute("aria-label")) ?? "";
		assert.ok(name.includes("A command ran that may have changed files"), name);
		await line(w).locator(".turn-result-size").hover();
		await snap(w, "unknown-with-counts");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("after a full undo the menu offers Open only for files that still exist, largest first", { timeout: 480000 }, async () => {
	const w = await createWorld({ rules: more, files, seed, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await converse(w, "Please undo everything after", /Undo run finished/);
		const items = async () => {
			await line(w).getByRole("button", { name: "More about this reply" }).click();
			await expect(w.page.getByRole("menuitem", { name: "Copy summary" })).toBeVisible({ timeout: T });
			const names = (await w.page.getByRole("menuitem").allInnerTexts()).map((t) => t.trim());
			await w.page.keyboard.press("Escape");
			return names;
		};
		const before = await items();
		assert.ok(before.indexOf("Open fresh.js") >= 0 && before.indexOf("Open login.js") >= 0, before.join("|"));
		assert.ok(before.indexOf("Open login.js") < before.indexOf("Open fresh.js"), `largest first: ${before.join("|")}`);
		await undoFully(w, /Undo finished/);
		await expect(line(w)).toHaveAttribute("data-undo", "undone", { timeout: T });
		const after = await items();
		// One file is left, so the item reads "Open file" and names login.js in its tooltip.
		assert.deepEqual(after, ["Open file", "Copy summary"]);
		await line(w).getByRole("button", { name: "More about this reply" }).click();
		await expect(w.page.getByRole("menuitem", { name: "Open file" })).toHaveAttribute("title", "src/login.js");
		await w.page.keyboard.press("Escape");
		await line(w).getByRole("button", { name: "More about this reply" }).click();
		await snap(w, "menu-after-full-undo");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("two long names that differ at the end stay told apart in the flat list", { timeout: 480000 }, async () => {
	const w = await createWorld({ rules: more, files, seed, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await converse(w, "Write the long names", /Names run finished/);
		await line(w).getByRole("button", { name: /Open changes$/ }).click();
		const pane = w.page.getByRole("complementary", { name: "Changes" });
		await expect(pane.locator(".changes-flat-name")).toHaveCount(2, { timeout: T });
		const cut = await pane.locator(".changes-flat-name").evaluateAll((els) => els.map((el) => ({ over: el.scrollWidth > el.clientWidth, dir: getComputedStyle(el).direction })));
		assert.ok(cut.every((c) => c.over && c.dir === "rtl"), JSON.stringify(cut));
		await snap(w, "flat-list-long-names");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("a finished turn has no edge but the person's message: the line, the fold and the code are plain until touched", { timeout: 480000 }, async () => {
	const w = await createWorld({ rules, files, seed, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await size(w, 1280, 820);
		await converse(w, "Make a change where the check fails", /Failing run finished/);
		const main = line(w).locator(".turn-result-main");
		const more = line(w).getByRole("button", { name: "More about this reply" });
		const look = (locator) => locator.evaluate((el) => {
			const s = getComputedStyle(el);
			return { radius: s.borderTopLeftRadius, fill: s.backgroundColor, border: s.borderTopWidth + s.borderBottomWidth + s.borderLeftWidth + s.borderRightWidth, opacity: s.opacity };
		});
		await w.page.mouse.move(2, 2);
		// At rest: no border, no fill, no radius, even when the check failed. The meaning is the dot and the words.
		const rest = await look(line(w));
		assert.deepEqual([rest.fill, rest.border, rest.radius], ["rgba(0, 0, 0, 0)", "0px0px0px0px", "0px"], JSON.stringify(rest));
		assert.equal((await look(main)).fill, "rgba(0, 0, 0, 0)");
		await expect(line(w).locator(".turn-result-mark")).toHaveCSS("background-color", /^rgb\(/);
		assert.equal((await look(more)).opacity, "0", "the menu button is not drawn at rest");
		// The line starts at the reply's own left edge.
		const textLeft = (await w.page.locator(".message.assistant .message-text").last().boundingBox()).x;
		const markLeft = (await line(w).locator(".turn-result-mark").boundingBox()).x;
		assert.ok(Math.abs(markLeft - textLeft) <= 4, `mark ${markLeft} against text ${textLeft}`);
		// Hover draws the soft fill with 8 px corners and the menu button.
		await line(w).hover();
		await expect.poll(async () => (await look(more)).opacity, { timeout: T }).toBe("1");
		const hover = await look(line(w));
		assert.equal(hover.radius, "8px");
		assert.notEqual(hover.fill, "rgba(0, 0, 0, 0)");
		await w.page.mouse.move(2, 2);
		// Keyboard focus draws both too, and so does the open menu.
		await main.focus();
		await w.page.keyboard.press("Tab");
		await expect(more).toBeFocused();
		await expect.poll(async () => (await look(more)).opacity, { timeout: T }).toBe("1");
		await w.page.keyboard.press("Enter");
		await expect(w.page.getByRole("menuitem", { name: "Copy summary" })).toBeVisible({ timeout: T });
		await w.page.keyboard.press("Escape");
		// The closed fold has no rule under it; the open one is a block with a hairline edge round the work.
		const trigger = w.page.locator(".activity-trigger").first();
		assert.equal((await trigger.evaluate((el) => getComputedStyle(el).borderBottomWidth)), "0px");
		await trigger.click();
		const rule = await w.page.locator(".activity-block").first().evaluate((el) => getComputedStyle(el).borderBottomWidth);
		assert.equal(rule, "1px");
		// The person's own message: 10 px corners, up to 80% of the column.
		const bubble = w.page.locator(".message.user > div").first();
		assert.equal(await bubble.evaluate((el) => getComputedStyle(el).borderTopLeftRadius), "10px");
		assert.equal(await bubble.evaluate((el) => getComputedStyle(el).maxWidth.endsWith("%") ? getComputedStyle(el).maxWidth : "px"), "80%");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
