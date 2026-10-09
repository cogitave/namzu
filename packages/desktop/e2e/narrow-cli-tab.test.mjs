// A Namzu CLI tab in a narrow pane, against the real Electron app, the real CLI and the scripted model.
// The window is narrowed (as a split does to a pane) and what the program drew is read back: no screen
// line is longer than the terminal is wide, the message box is closed at the new width, and the footer
// keeps the model name. Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/narrow-cli-tab.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createWorld,
	dispose,
	enableTerminalDebug,
	expect,
	launch,
	openProject,
	repoRoot,
} from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/narrow-20261009");
const REPLY = "SCRIPTED-ANTHROPIC-OK to: hello from the first message";

const pane = (w) => w.page.locator("section.terminal-pane");

const frontId = (w) =>
	w.page.evaluate(() =>
		document.querySelector("section.terminal-pane")?.getAttribute("data-terminal-tab"),
	);

/** What the terminal in front shows and how wide it is, read together so they agree. */
async function terminal(w) {
	return w.page.evaluate(() => {
		const id = document
			.querySelector("section.terminal-pane")
			?.getAttribute("data-terminal-tab");
		if (!id || !window.__namzuTerminals) return { cols: 0, lines: [] };
		const size = window.__namzuTerminals.size(id);
		const text = window.__namzuTerminals.text(id) ?? "";
		return { cols: size?.cols ?? 0, lines: text.split("\n").map((line) => line.trimEnd()) };
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

/** Was the frame drawn for this width: closed on the right, and the footer names the model? */
function drawnFor({ cols, lines }) {
	if (cols === 0) return false;
	const bottom = lines.findLast((line) => line.trimStart().startsWith("└"));
	const footer = lines.findLast((line) => line.includes("shift+tab"));
	const top = lines.findLast((line) => line.trimStart().startsWith("┌"));
	// The transcript is on screen once, whole: neither a stale copy of it nor half of it.
	const once = (needle) => lines.filter((line) => line.includes(needle)).length === 1;
	return (
		once("› hello from") &&
		once("SCRIPTED-ANTHROPIC-OK") &&
		bottom !== undefined &&
		top !== undefined &&
		top.endsWith("┐") &&
		bottom.endsWith("┘") &&
		[...top].length === [...bottom].length &&
		[...bottom].length >= cols - 4 &&
		footer !== undefined &&
		footer.includes("gpt-e2e-0")
	);
}

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test(
	"a Namzu CLI tab redraws to each narrower pane: no line wider than the terminal, the model kept in the footer",
	{ timeout: 300000 },
	async () => {
		const world = await createWorld({
			rules: [{ match: /first message/, steps: [{ text: REPLY }] }],
			env: { SHELL: "/bin/sh" },
		});
		let failed = true;
		try {
			await launch(world);
			const w = world;
			await openProject(w);
			await enableTerminalDebug(w);
			await resize(w, 1400, 800);
			await w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click();
			await w.page.getByRole("radio", { name: "OpenAI gpt-e2e-0" }).click();
			await w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click().catch(() => undefined);
			await w.page.getByRole("radio", { name: "CLI", exact: true }).click();
			await w.page.keyboard.press("Escape");
			await w.page
				.getByRole("textbox", { name: "Message Namzu" })
				.fill("hello from the first message");
			const send = w.page.getByRole("button", { name: "Open Namzu in a terminal" });
			await expect(send).toBeEnabled({ timeout: T });
			await send.click();
			await expect(pane(w)).toBeVisible({ timeout: T });
			await expect
				.poll(async () => (await terminal(w)).lines.join("\n"), { timeout: T })
				.toContain(REPLY);
			await expect.poll(async () => drawnFor(await terminal(w)), { timeout: T }).toBe(true);
			const seen = [];
			for (const width of [1400, 1000, 760, 620, 560, 1000]) {
				await resize(w, width, 800);
				// The program has answered the new size once its frame is closed at that width.
				// One snapshot is polled for and then judged, so the judgement is of a screen that was complete.
				let snapshot;
				await expect
					.poll(
						async () => {
							const now = await terminal(w);
							if (!drawnFor(now)) return false;
							snapshot = now;
							return true;
						},
						{ timeout: T },
					)
					.toBe(true);
				const { cols, lines } = snapshot;
				const longest = Math.max(...lines.map((line) => [...line].length));
				assert.ok(longest <= cols, `${width}px window, ${cols} columns: a line is ${longest} wide`);
				const top = lines.findLast((line) => line.trimStart().startsWith("┌"));
				const bottom = lines.findLast((line) => line.trimStart().startsWith("└"));
				assert.ok(top?.endsWith("┐"), `${cols} columns: the top-right corner is in place\n${lines.join("\n")}`);
				assert.equal([...top].length, [...bottom].length, `${cols} columns: the box is a rectangle`);
				// A reply is one block however narrow the pane: its words are wrapped, never cut.
				const joined = lines.join(" ").replace(/\s+/g, " ");
				assert.ok(joined.includes("hello from the first message"), `${cols} columns: the reply reads whole`);
				seen.push(cols);
				await shot(w, `cli-tab-${cols}-columns`);
			}
			// A split narrows the pane further than the window can: the Namzu tab keeps the left half.
			await resize(w, 1000, 800);
			await w.page.getByRole("button", { name: "More ways to add a tab" }).click();
			await w.page.getByRole("menuitem", { name: "New terminal to the right" }).click();
			await expect(pane(w)).toHaveCount(1, { timeout: T });
			const namzuTab = () =>
				w.page.evaluate((marker) => {
					const t = window.__namzuTerminals;
					for (const id of t?.ids() ?? []) {
						const text = t.text(id) ?? "";
						if (text.includes(marker)) {
							const size = t.size(id);
							return { cols: size?.cols ?? 0, lines: text.split("\n").map((line) => line.trimEnd()) };
						}
					}
					return { cols: 0, lines: [] };
				}, "SCRIPTED-ANTHROPIC-OK");
			const narrowest = Math.min(...seen);
			let split;
			await expect
				.poll(
					async () => {
						const now = await namzuTab();
						if (!(now.cols > 0 && now.cols < narrowest && drawnFor(now))) return false;
						split = now;
						return true;
					},
					{ timeout: T },
				)
				.toBe(true);
			{
				const { cols, lines } = split;
				const longest = Math.max(...lines.map((line) => [...line].length));
				assert.ok(longest <= cols, `split, ${cols} columns: a line is ${longest} wide`);
				assert.ok(cols < Math.min(...seen), `the split pane is narrower than any whole-window width: ${cols}`);
				seen.push(cols);
				await shot(w, `cli-tab-split-${cols}-columns`);
			}
			assert.ok(Math.min(...seen) < Math.max(...seen) - 20, `the terminal really narrowed: ${seen}`);
			assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);
