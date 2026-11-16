// What a turn made: the Outputs pane beside the conversation, a quiet end for a turn that could not be
// checked, the live step with its own seconds, and the name the model gives a conversation. Real Electron,
// real CLI host, scripted model. The model answers the host's two small side requests (a history search
// query, a conversation title) apart from the person's own turn.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-desk-out.test.mjs
// DESK_OUT_SIDE=before runs the same flows on an older build only to take pictures of what it showed; its
// assertions are skipped. Pictures: research/desk-out-20261117/<flow>-<side>.png.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 90000;
const SIDE = process.env.DESK_OUT_SIDE === "before" ? "before" : "after";
const after = SIDE === "after";
const SHOTS = resolve(repoRoot, "research/desk-out-20261117");
mkdirSync(SHOTS, { recursive: true });
const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}-${SIDE}.png`) });
/** What only the new build promises. */
const only = (check) => (after ? check() : undefined);

const TITLE = "Ada Kahve web sayfası";
const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Ada Kahve</title>
<style>body{font-family:Georgia,serif;background:#fbf4ea;color:#2b1b10;margin:0}header{padding:48px 32px;background:#3b2314;color:#fbf4ea}
h1{margin:0;font-size:42px}main{padding:32px}li{margin:6px 0}</style></head>
<body><header><h1>Ada Kahve</h1><p>Small roasts, slow mornings.</p></header>
<main><h2>Menu</h2><ul><li>Espresso 85</li><li>Filter 70</li><li>Flat white 95</li></ul>
<h2>Visit</h2><p>Moda Cad. 12, Kadikoy. Open every day, 08:00 to 20:00.</p></main></body></html>
`;
const MENU = "# Menu\n\nSmall roasts, slow mornings.\n\n- Espresso 85\n- Filter 70\n- Flat white 95\n";

function flow(name, options, body) {
	test(name, { timeout: 300000 }, async () => {
		const world = await createWorld({ answerHistory: true, tabs: "hidden", ...options });
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

/** "3m 10s" and "12s" as a number of seconds. */
const seconds = (text) =>
	(/(\d+)h/.exec(text)?.[1] ?? 0) * 3600 + (/(\d+)m/.exec(text)?.[1] ?? 0) * 60 + Number(/(\d+)s/.exec(text)?.[1] ?? 0);
const card = (w) => w.page.getByRole("region", { name: "Tool approval" });
/** Answers every approval card that appears until `done` is on the screen. */
async function acceptUntil(w, done) {
	for (;;) {
		const seen = await Promise.race([
			card(w).waitFor({ timeout: T }).then(() => "card"),
			w.page.getByText(done).first().waitFor({ timeout: T }).then(() => "done"),
		]);
		if (seen === "done") return;
		const accept = card(w).getByRole("button", { name: "Accept", exact: true });
		const disabled = await accept.getAttribute("aria-disabled", { timeout: 5000 }).catch(() => null);
		if (disabled === "true")
			await card(w).evaluate((el) =>
				el.querySelectorAll("*").forEach((e) => {
					if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = e.scrollHeight;
				}),
			);
		await accept.click({ timeout: 5000 }).catch(() => {});
	}
}
async function ask(w, text) {
	const box = w.page.getByRole("textbox", { name: "Message Namzu" });
	await box.fill(text);
	await w.page.getByRole("button", { name: "Send message" }).click();
}
async function conversationId(w) {
	return w.page.evaluate(async () => {
		const project = (await window.namzu.projects())[0];
		const rows = await window.namzu.conversations(project.id);
		return rows[0].id;
	});
}
async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [wide, high]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(wide, high);
		},
		[width, height],
	);
	await expect.poll(() => w.page.evaluate(() => window.innerWidth), { timeout: T }).toBe(width);
}

flow(
	"a page the turn writes opens beside the conversation, drawn, and the model names the conversation",
	{
		title: TITLE,
		rules: [
			{
				match: /coffee shop/i,
				steps: [
					{ tool: "write", args: { path: "ada-kahve/index.html", content: PAGE } },
					{ text: "I wrote ada-kahve/index.html: a small page with the menu and the opening hours." },
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await w.app.evaluate(({ shell }) => {
			globalThis.__opened = [];
			shell.openPath = async (path) => {
				globalThis.__opened.push(["open", path]);
				return "";
			};
			shell.showItemInFolder = (path) => globalThis.__opened.push(["folder", path]);
		});
		await ask(w, "make a one-page web page for my coffee shop and show me how it looks");
		await acceptUntil(w, /I wrote ada-kahve\/index\.html/);
		await expect(w.page.getByText(/I wrote ada-kahve\/index\.html/).first()).toBeVisible({ timeout: T });
		if (after) await expect(w.page.locator('iframe[data-output-preview="html"]')).toBeVisible({ timeout: T });
		else await new Promise((resolve) => setTimeout(resolve, 1500));
		await shot(w, "page");

		await only(async () => {
			const frame = w.page.locator('iframe[data-output-preview="html"]');
			// The pane is the Outputs tab, open by itself, with the page in it.
			await expect(w.page.getByRole("tab", { name: "Outputs", selected: true })).toBeVisible();
			await expect(w.page.frameLocator('iframe[data-output-preview="html"]').getByRole("heading", { name: "Ada Kahve" })).toBeVisible({ timeout: T });
			// The frame has no permission at all: no same-origin, no top navigation, no scripts, no network.
			assert.equal(await frame.getAttribute("sandbox"), "", "an empty sandbox switches every permission off");
			const sandbox = (await frame.getAttribute("sandbox")) ?? "";
			assert.ok(!sandbox.includes("allow-same-origin") && !sandbox.includes("allow-top-navigation"));
			assert.equal(await frame.getAttribute("referrerpolicy"), "no-referrer");
			const policy = await frame.evaluate((el) => el.srcdoc.match(/Content-Security-Policy" content="([^"]+)"/)?.[1]);
			assert.match(policy ?? "", /default-src 'none'/);
			assert.doesNotMatch(policy ?? "", /https?:|connect-src/);
			assert.equal(await frame.evaluate((el) => el.src || ""), "", "no address is ever given to the frame");
			// The page could not be reached by a raw file: address from the renderer.
			assert.doesNotMatch(await frame.evaluate((el) => el.outerHTML), /file:/);

			// Open in browser and Show in folder go through the host, for this file.
			await w.page.getByRole("button", { name: "Open in browser" }).click();
			await w.page.getByRole("button", { name: "Show in folder" }).click();
			await expect.poll(() => w.app.evaluate(() => globalThis.__opened.length), { timeout: T }).toBe(2);
			const opened = await w.app.evaluate(() => globalThis.__opened);
			assert.equal(opened[0][0], "open");
			assert.match(opened[0][1], /ada-kahve[\\/]index\.html$/);
			assert.equal(opened[1][0], "folder");

			// The list is the files of the conversation, and a row opens the same preview.
			await w.page.getByRole("button", { name: "All outputs" }).click();
			await expect(w.page.locator("[data-output-row]")).toHaveCount(1);
			await w.page.locator("[data-output-row]").first().click();
			await expect(frame).toBeVisible();

			// The host's own note of what Desktop shows reached the model, once, in its environment facts.
			const first = w.model.requests.find((request) => !JSON.stringify(request.messages).includes("Resolve a conversation-history"));
			const system = JSON.stringify(first.messages);
			assert.match(system, /Desktop shows the \.html, \.md and image files you write in its preview pane/);
			assert.match(system, /never start a server or open a file: address/);
			assert.equal((system.match(/preview pane/g) ?? []).length, 1, "said once");

			// The conversation is named by the model: the sidebar row and the header say it.
			await expect(w.page.getByText(TITLE, { exact: true }).first()).toBeVisible({ timeout: T });
			await expect(w.page.locator("[data-conversation-title]")).toHaveText(TITLE, { timeout: T });
			const titleRequests = w.model.sideRequests.filter((entry) => entry.kind === "title");
			assert.equal(titleRequests.length, 1, "one title request for the conversation");
			assert.ok(TITLE.length <= 60);
			// The host keeps it too: a later list of the conversations says the same name.
			const names = await w.page.evaluate(async () => {
				const project = (await window.namzu.projects())[0];
				return (await window.namzu.conversations(project.id)).map((row) => row.title);
			});
			assert.ok(names.includes(TITLE), `the conversation list says ${JSON.stringify(names)}`);
			// The same pane at two widths: beside the conversation, then over it with a way back.
			await size(w, 760, 820);
			await expect(w.page.getByRole("button", { name: "Back to conversation" })).toBeVisible({ timeout: T });
			await shot(w, "page-narrow");
			await w.page.getByRole("button", { name: "Back to conversation" }).click();
			await expect(frame).not.toBeVisible();
			await size(w, 1280, 820);
		});
		if (!after) await shot(w, "page-narrow");
	},
);

flow(
	"a document the turn writes is shown formatted",
	{
		title: "Menu document",
		rules: [
			{
				match: /menu document/i,
				steps: [
					{ tool: "write", args: { path: "docs/menu.md", content: MENU } },
					{ text: "I wrote docs/menu.md with the three drinks." },
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await ask(w, "write a short menu document for the coffee shop");
		await acceptUntil(w, /I wrote docs\/menu\.md/);
		if (after) await expect(w.page.locator('[data-output-preview="markdown"]')).toBeVisible({ timeout: T });
		else await new Promise((resolve) => setTimeout(resolve, 1500));
		await shot(w, "document");
		await only(async () => {
			const doc = w.page.locator('[data-output-preview="markdown"]');
			await expect(doc.getByRole("heading", { name: "Menu" })).toBeVisible();
			await expect(doc.locator("li")).toHaveCount(3);
			// Formatted, not source: no pound sign of the heading and no dash of the list on screen.
			const text = await doc.innerText();
			assert.doesNotMatch(text, /^# /m);
			assert.doesNotMatch(text, /^- /m);
		});
	},
);

flow(
	"code shows with line numbers and copy, and an outside file is never read",
	{
		title: "Script notes",
		files: { "secret-note.txt": "private\n" },
		rules: [
			{
				match: /small script/i,
				steps: [
					{ tool: "write", args: { path: "tools/count.js", content: "let n = 0\nfor (const x of [1, 2, 3]) n += x\nconsole.log(n)\n" } },
					{ text: "I wrote tools/count.js." },
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await ask(w, "write a small script that adds three numbers");
		await acceptUntil(w, /I wrote tools\/count\.js/);
		await only(async () => {
			// A script does not open by itself; the Outputs button in the header does.
			await expect(w.page.locator('[data-output-preview]')).toHaveCount(0);
			await w.page.getByRole("button", { name: /^Outputs, 1 file$/ }).click();
			await w.page.locator("[data-output-row]").first().click();
			const code = w.page.locator('[data-output-preview="code"]');
			await expect(code).toBeVisible({ timeout: T });
			await expect(code.getByRole("button", { name: "Copy file contents" })).toBeVisible();
			await expect(code).toContainText("console.log(n)");
			await shot(w, "code");

			// The host decides what may be read: the folder, and what this conversation wrote.
			const id = await conversationId(w);
			const read = (path) =>
				w.page.evaluate(
					async ([session, target]) => {
						try {
							const content = await window.namzu.readSessionOutput(session, target);
							return { ok: true, kind: content.kind, text: content.text };
						} catch (failure) {
							return { ok: false, message: String(failure?.message ?? failure) };
						}
					},
					[id, path],
				);
			assert.equal((await read("tools/count.js")).ok, true, "a file the conversation wrote reads");
			assert.equal((await read("secret-note.txt")).ok, true, "a file in the work folder reads");
			for (const outside of [
				"../outside.txt",
				`${w.root}/os-home/.bashrc`,
				`${w.home}/preferences.json`,
				"/etc/hostname",
				"C:\\Windows\\win.ini",
				"tools/../../escape.txt",
				"",
			]) {
				const result = await read(outside);
				assert.equal(result.ok, false, `${outside} is refused`);
				assert.doesNotMatch(result.message, /preferences|os-home|\/etc|Windows/, "the refusal names no path");
			}
		});
		await shot(w, "code-list");
	},
);

flow(
	"a turn that only ran a command says nothing about not being able to tell, and an edit turn still says its files",
	{
		title: "Two files",
		rules: [
			{ match: /touch a file/i, steps: [{ tool: "bash", args: { command: "touch made-by-shell.txt" } }, { text: "The command ran." }] },
			{
				match: /two notes/i,
				steps: [
					{ tool: "write", args: { path: "notes/one.txt", content: "one\ntwo\nthree\n" } },
					{ tool: "write", args: { path: "notes/two.txt", content: "alpha\nbeta\n" } },
					{ text: "Both notes are written." },
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await ask(w, "touch a file with the shell");
		await acceptUntil(w, /The command ran\./);
		await expect(w.page.getByText("The command ran.")).toBeVisible({ timeout: T });
		// The turn has ended and its foot is drawn before the picture is taken.
		await expect(w.page.getByRole("button", { name: "Copy message" }).first()).toBeAttached({ timeout: T }).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 2000));
		await shot(w, "shell-only");
		const shellOnly = await w.page.locator(".normal-transcript").innerText();
		writeFileSync(join(SHOTS, `shell-only-${SIDE}.txt`), shellOnly);
		await only(async () => {
			assert.doesNotMatch(shellOnly, /cannot tell/i);
			assert.doesNotMatch(shellOnly, /may have changed files/i);
			assert.doesNotMatch(shellOnly, /not checked/i);
			await expect(w.page.locator(".turn-outcome-line")).toHaveCount(0);
		});

		await w.page.getByRole("button", { name: "New conversation" }).first().click();
		await ask(w, "write two notes please");
		await acceptUntil(w, /Both notes are written\./);
		const line = w.page.getByRole("region", { name: "Result of this reply" });
		await expect(line).toBeVisible({ timeout: T });
		await expect(line.locator(".turn-result-files")).toHaveText("2 files");
		await expect(line.locator(".turn-result-added")).toContainText("+5");
		await expect(line.locator(".turn-result-removed")).toContainText("0");
		await shot(w, "edit-turn");
		await only(async () => {
			// Both files are outputs, and the same two files the line counts.
			await w.page.getByRole("button", { name: /^Outputs, 2 files$/ }).click();
			await expect(w.page.locator("[data-output-row]")).toHaveCount(2);
		});
	},
);

flow(
	"the live status names the step with its own seconds, and the wait for the person is not counted",
	{
		title: "Waiting",
		files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n" },
		rules: [
			{
				match: /wait for approval/i,
				steps: [
					{ tool: "write", args: { path: "held.txt", content: "held\n" } },
					{ text: "The held file is written." },
				],
			},
			{
				match: /five steps/i,
				steps: [
					{ tool: "read", args: { path: "a.txt" } },
					{ tool: "read", args: { path: "b.txt" } },
					{ tool: "read", args: { path: "c.txt" } },
					{ tool: "read", args: { path: "d.txt" } },
					{
						tool: "bash",
						args: { command: "while [ ! -f ../__GATE__ ]; do sleep 0.1; done" },
					},
					{ text: "All five steps are done." },
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		const gate = join(w.root, "gate");
		// The gate is outside the project folder; the command waits for it to appear, so the step
		// lasts exactly as long as the test lets it, with no clock involved.
		w.model.rules[1].steps[4].args.command = `while [ ! -f ${gate} ]; do sleep 0.1; done`;

		// 1. A wait for the person: the status says so and the total stops.
		await w.page.clock.install({ time: Date.now() });
		await ask(w, "please wait for approval before writing");
		await card(w).waitFor({ timeout: T });
		await shot(w, "waiting");
		await only(async () => {
			const status = w.page.locator(".normal-transcript");
			await expect(status.getByText("Waiting for you").first()).toBeVisible({ timeout: T });
			// The total sits in the work header when there is one, else beside the status line.
			const readTotal = async () =>
				(
					await w.page
						.locator(".activity-trigger[data-live] .turn-activity-elapsed, .working-elapsed")
						.first()
						.textContent({ timeout: 5000 })
						.catch(() => "")
				)?.trim();
			const before = await readTotal();
			await w.page.clock.fastForward(90_000);
			await new Promise((resolve) => setTimeout(resolve, 600));
			const later = await readTotal();
			assert.equal(later, before, `the total holds still during the wait: ${before} then ${later}`);
			assert.doesNotMatch(await status.innerText(), /1m 3\d|1m [4-9]\d|2m/, "a minute and a half of waiting is not counted");
		});
		await acceptUntil(w, /The held file is written\./);

		// 2. A running step has its own seconds beside the total, and the last two steps stay in view.
		await w.page.getByRole("button", { name: "New conversation" }).first().click();
		await ask(w, "do the five steps now");
		await card(w).waitFor({ timeout: T });
		await card(w).getByRole("button", { name: "Accept", exact: true }).click();
		await only(async () => {
			const stepClock = w.page.locator("[data-live-step-clock]").first();
			await expect(stepClock).toBeVisible({ timeout: T });
			await w.page.clock.fastForward(12_000);
			await expect
				.poll(async () => seconds((await stepClock.textContent()) ?? ""), { timeout: T })
				.toBeGreaterThanOrEqual(12);
			const header = await w.page.locator(".activity-trigger[data-live]").first().innerText();
			assert.match(header, /Running/, "the step is named in words");
			assert.match(header, /\d+s/, "with its own seconds");
			const steps = w.page.locator(".live-steps");
			await expect(steps).toBeVisible();
			await expect(steps.getByRole("button", { name: "3 more steps" })).toBeVisible();
			assert.equal(await steps.locator('[data-transcript-entry-key], .tool, .tool-row').count() > 0, true);
			await shot(w, "live-steps");
			await steps.getByRole("button", { name: "3 more steps" }).click();
			await expect(w.page.locator(".live-steps")).toHaveCount(0);
		});
		if (!after) await shot(w, "live-steps");
		writeFileSync(gate, "go\n");
		await acceptUntil(w, /All five steps are done\./);
		await only(async () => {
			await expect(w.page.locator(".live-steps")).toHaveCount(0);
			await expect(w.page.locator(".activity-trigger").first()).toContainText(/^Read 4 files/, { timeout: T });
			await shot(w, "live-steps-done");
		});
	},
);
