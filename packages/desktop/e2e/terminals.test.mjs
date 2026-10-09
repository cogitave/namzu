// Terminal tabs against the real Electron app, the real CLI host (which owns the pseudo-terminals)
// and the scripted model. Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/terminals.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createWorld,
	desktopRoot,
	dispose,
	enableTerminalDebug,
	expect,
	launch,
	openProject,
	relaunch,
	repoRoot,
} from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/terminal-20261008");

/**
 * `fakes` are stand-ins for an installed engine CLI: scripts put first on PATH, which print the
 * argument list they were started with, so a flow can see exactly what the Desktop asked for.
 */
function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		let pathPrefix;
		if (options.fakes) {
			pathPrefix = mkdtempSync(join(tmpdir(), "namzu-e2e-bin-"));
			for (const [program, script] of Object.entries(options.fakes)) {
				writeFileSync(join(pathPrefix, program), script);
				chmodSync(join(pathPrefix, program), 0o755);
			}
		}
		const world = await createWorld({
			...options,
			pathPrefix,
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

/** The terminal tabs of the strip, in order. */
const tabs = (w) => w.page.locator("[data-terminal-tab-id]");
const pane = (w) => w.page.locator("section.terminal-pane");

/** The screen of the terminal in front, as text. */
async function screen(w) {
	return w.page.evaluate(() => {
		const id = document
			.querySelector("section.terminal-pane")
			?.getAttribute("data-terminal-tab");
		return id ? (window.__namzuTerminals?.text(id) ?? "") : "";
	});
}
const frontId = (w) =>
	w.page.evaluate(() =>
		document.querySelector("section.terminal-pane")?.getAttribute("data-terminal-tab"),
	);

/** Type into the terminal in front. The keys go through the real input, like a person's. */
async function type(w, text) {
	await w.page.locator("section.terminal-pane .xterm-helper-textarea").focus();
	await w.page.keyboard.type(text);
	await w.page.keyboard.press("Enter");
}

async function newTerminal(w) {
	await w.page.getByRole("button", { name: "New terminal tab" }).click();
}

async function setAppearance(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(
			new StorageEvent("storage", { key: "namzu.appearance", newValue: next }),
		);
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

flow("a plain terminal tab runs a command in the project folder", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({
		timeout: T,
	});
	await newTerminal(w);
	await expect(tabs(w)).toHaveCount(1, { timeout: T });
	await expect(pane(w)).toBeVisible();
	await type(w, "echo from-the-tab-$((6*7)); pwd");
	await expect.poll(() => screen(w), { timeout: T }).toContain("from-the-tab-42");
	await expect.poll(() => screen(w), { timeout: T }).toContain(w.project);
});

flow("the terminal follows the pane's size", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await newTerminal(w);
	await expect(pane(w)).toBeVisible({ timeout: T });
	await expect.poll(() => screen(w), { timeout: T }).not.toBe("");
	const size = () =>
		w.page.evaluate(() => {
			const id = document
				.querySelector("section.terminal-pane")
				?.getAttribute("data-terminal-tab");
			return id ? window.__namzuTerminals?.size(id) : undefined;
		});
	// What the program sees is what the view measured: ask the program.
	const asked = async () => {
		const before = (await screen(w)).split("\n").length;
		await type(w, "echo SIZE-$(stty size | tr ' ' x)");
		const wanted = await size();
		await expect
			.poll(async () => (await screen(w)).includes(`SIZE-${wanted.rows}x${wanted.cols}`), {
				timeout: T,
			})
			.toBe(true);
		return { wanted, before };
	};
	const first = (await asked()).wanted;
	await w.app.evaluate(({ BrowserWindow }) => {
		for (const win of BrowserWindow.getAllWindows()) win.setSize(1000, 700);
	});
	await expect.poll(async () => (await size()).cols, { timeout: T }).toBeLessThan(first.cols);
	const second = (await asked()).wanted;
	assert.notDeepEqual(second, first);
});

flow("the last row of the screen is whole and a reloaded window can type at once", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await newTerminal(w);
	await expect(pane(w)).toBeVisible({ timeout: T });
	// Fill the screen so the prompt sits on the last row.
	await type(w, "seq 1 300; echo FILLED-$((6*7))");
	await expect.poll(() => screen(w), { timeout: T }).toContain("FILLED-42");
	const edges = () =>
		w.page.evaluate(() => {
			const box = document.querySelector("section.terminal-pane .terminal-pane-screen").getBoundingClientRect();
			// The emulator's screen is exactly its rows tall, whichever renderer draws them.
			const rows = document.querySelector("section.terminal-pane .xterm-screen").getBoundingClientRect();
			return { paneBottom: box.bottom, lastBottom: rows.bottom };
		});
	await expect
		.poll(async () => {
			const { paneBottom, lastBottom } = await edges();
			return lastBottom <= paneBottom + 0.5;
		}, { timeout: T })
		.toBe(true);
	await shot(w, "review-last-row");
	// Reload: the old page's view is released, so the new one holds the keyboard without "Take over".
	await w.page.reload();
	await expect(pane(w)).toBeVisible({ timeout: T });
	await expect.poll(() => screen(w), { timeout: T }).toContain("FILLED-42");
	await expect(w.page.getByRole("button", { name: /take over/i })).toHaveCount(0);
	await type(w, "echo AFTER-RELOAD-$((5+5))");
	await expect.poll(() => screen(w), { timeout: T }).toContain("AFTER-RELOAD-10");
	await shot(w, "review-after-reload");
});

flow("a terminal tab keeps its screen across a switch to a conversation", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await newTerminal(w);
	await expect(pane(w)).toBeVisible({ timeout: T });
	await type(w, "echo kept-on-screen-$((20+22))");
	await expect.poll(() => screen(w), { timeout: T }).toContain("kept-on-screen-42");
	const id = await frontId(w);
	// Back to the conversation: its composer is in front and the terminal is behind.
	await w.page.getByRole("button", { name: "New conversation tab" }).click();
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	await expect(pane(w)).toHaveCount(0);
	// And forward again: the same terminal, with what it showed.
	await tabs(w).first().getByRole("tab").click();
	await expect(pane(w)).toBeVisible({ timeout: T });
	assert.equal(await frontId(w), id);
	await expect.poll(() => screen(w), { timeout: T }).toContain("kept-on-screen-42");
	// It still takes input.
	await type(w, "echo still-alive-$((1+1))");
	await expect.poll(() => screen(w), { timeout: T }).toContain("still-alive-2");
});

flow("closing the tab ends the shell and everything it started", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await newTerminal(w);
	await expect(pane(w)).toBeVisible({ timeout: T });
	// A background child of the shell: the whole tree has to go, not only the shell.
	await type(w, "sleep 4711 & echo PIDS=$$,$!");
	await expect.poll(() => screen(w), { timeout: T }).toMatch(/PIDS=\d+,\d+\n/);
	const [shell, child] = (await screen(w)).match(/PIDS=(\d+),(\d+)\n/).slice(1).map(Number);
	assert.equal(alive(shell) && alive(child), true);
	await tabs(w).first().getByRole("button", { name: /^Close tab / }).click();
	await expect(tabs(w)).toHaveCount(0, { timeout: T });
	await expect.poll(() => alive(shell) || alive(child), { timeout: T }).toBe(false);
});

/** Open the model popup of the composer in front. */
async function openPicker(w) {
	await w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click();
	await expect(w.page.getByRole("radiogroup", { name: "Where this engine runs" })).toBeVisible({
		timeout: T,
	});
}

flow(
	"the CLI side of the engine switch opens the Namzu terminal app with the composer's choices",
	{},
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		const saved = () => readFileSync(join(w.home, "preferences.json"), "utf8");
		const before = saved();
		await openPicker(w);
		await w.page.getByRole("radio", { name: "OpenAI gpt-e2e-0" }).click();
		await openPicker(w).catch(() => undefined);
		await w.page.getByRole("radio", { name: "CLI", exact: true }).click();
		await settled(w);
		await shot(w, "cli-surface-popup-dark");
		await w.page.keyboard.press("Escape");
		const send = w.page.getByRole("button", { name: "Open Namzu in a terminal" });
		await expect(send).toBeEnabled({ timeout: T });
		await send.click();
		await expect(pane(w)).toBeVisible({ timeout: T });
		await expect(tabs(w)).toHaveCount(1);
		await expect(tabs(w).first()).toContainText("Namzu · project");
		// The terminal app started on the model the composer showed, not the saved one.
		await expect.poll(() => screen(w), { timeout: T }).toContain("gpt-e2e-0");
		// Nothing the composer chose was written where the next plain `namzu` would read it.
		assert.equal(saved(), before);
		await shot(w, "namzu-cli-tab-dark");
	},
);

flow(
	"a message typed in the Namzu CLI tab is sent and the scripted reply reaches the screen",
	{ rules: [{ match: /hello there/, steps: [{ text: "Scripted terminal reply." }] }] },
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		await openPicker(w);
		await w.page.getByRole("radio", { name: "OpenAI gpt-e2e-0" }).click();
		await openPicker(w).catch(() => undefined);
		await w.page.getByRole("radio", { name: "CLI", exact: true }).click();
		await w.page.keyboard.press("Escape");
		const send = w.page.getByRole("button", { name: "Open Namzu in a terminal" });
		await expect(send).toBeEnabled({ timeout: T });
		await send.click();
		await expect(pane(w)).toBeVisible({ timeout: T });
		// The tab carries the title and status: the pane has no bar of its own, and is still named.
		await expect(w.page.locator(".terminal-pane-bar")).toHaveCount(0);
		await expect(w.page.getByRole("region", { name: "Namzu · project terminal" })).toBeVisible();
		await expect.poll(() => screen(w), { timeout: T }).toContain("gpt-e2e-0");
		// A click on the pane's dead space must not take the keyboard from the program.
		await pane(w).click({ position: { x: 2, y: 2 } });
		await type(w, "hello there");
		await expect.poll(() => screen(w), { timeout: T }).toContain("Scripted terminal reply.");
		// Ctrl+F opens a find overlay inside the terminal; Escape closes it and returns the keyboard.
		await w.page.keyboard.press("Control+f");
		const find = pane(w).getByRole("searchbox", { name: "Find in terminal" });
		await expect(find).toBeVisible();
		await w.page.keyboard.press("Escape");
		await expect(find).toHaveCount(0);
	},
);

flow(
	"the composer's text is the first message of the Namzu CLI tab, sent without typing in the terminal",
	{ rules: [{ match: /test message/, steps: [{ text: "Scripted first reply." }] }] },
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		await openPicker(w);
		await w.page.getByRole("radio", { name: "OpenAI gpt-e2e-0" }).click();
		await openPicker(w).catch(() => undefined);
		await w.page.getByRole("radio", { name: "CLI", exact: true }).click();
		await w.page.keyboard.press("Escape");
		const composer = w.page.getByRole("textbox", { name: "Message Namzu" });
		await composer.fill("test message");
		const send = w.page.getByRole("button", { name: "Open Namzu in a terminal" });
		await expect(send).toBeEnabled({ timeout: T });
		await send.click();
		await expect(pane(w)).toBeVisible({ timeout: T });
		// Nothing is typed into the terminal: the message went in with the launch.
		await expect.poll(() => screen(w), { timeout: T }).toContain("Scripted first reply.");
		const shown = await screen(w);
		assert.match(shown, /test message/, "the first message is the first user row");
		assert.equal(shown.split("Scripted first reply.").length, 2, "it was sent exactly once");
		// The composer was cleared once the tab opened and the message was handed over.
		await w.page.locator("[data-tab-id]").first().getByRole("tab").click();
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toHaveValue("", {
			timeout: T,
		});
	},
);

const FAKE = (name, code) => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${name} 0.0.0-fake"; exit 0; fi
echo "FAKE-${name} argv:"
for a in "$@"; do echo "  [$a]"; done
echo "ready"
read line
echo "got:$line"
exit ${code}
`;

/** Ask the app for an engine's terminal the way the composer does, without its engine picker. */
async function openEngine(w, request) {
	return w.page.evaluate(async (wanted) => {
		const projects = await window.namzu.projects();
		const view = await window.namzu.workspace();
		const group = view.layout.windows.find((item) => item.id === view.windowId)?.root;
		return window.namzu.openTerminal({
			kind: "engine",
			projectId: projects.find((item) => !item.palId && !item.isChat).id,
			groupId: group?.id ?? view.homeGroupId,
			cols: 100,
			rows: 30,
			...wanted,
		});
	}, request);
}

flow(
	"an installed engine's terminal starts with the composer's choices as its own flags",
	{
		fakes: { codex: FAKE("codex", 3), "claude": FAKE("claude", 0) },
		rules: [],
	},
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		const result = await openEngine(w, {
			engine: "codex-cli",
			model: "gpt-5-codex",
			effort: "high",
			permissionMode: "accept-edits",
			prompt: "fix the build",
		});
		assert.deepEqual(result.omitted, []);
		await expect(pane(w)).toBeVisible({ timeout: T });
		// The strip may show a shorter whole-word title in a narrow window; the full one is the label.
		await expect(tabs(w).first().locator(".conversation-tab-label")).toHaveAttribute(
			"aria-label",
			/^Codex CLI · project, terminal/,
		);
		await expect.poll(() => screen(w), { timeout: T }).toContain("ready");
		const codex = await screen(w);
		for (const line of [
			"[-m]",
			"[gpt-5-codex]",
			"[model_reasoning_effort=high]",
			"[-a]",
			"[on-request]",
			"[workspace-write]",
			"[--]",
			"[fix the build]",
		])
			assert.match(codex, new RegExp(line.replace(/[\[\]]/g, "\\$&")), line);
		await openEngine(w, {
			engine: "claude-code",
			model: "opus",
			effort: "max",
			permissionMode: "plan",
		});
		await expect(tabs(w)).toHaveCount(2, { timeout: T });
		await expect(tabs(w).nth(1).locator(".conversation-tab-label")).toHaveAttribute(
			"aria-label",
			/^Claude Code · project, terminal/,
		);
		await expect.poll(() => screen(w), { timeout: T }).toContain("ready");
		const second = await screen(w);
		for (const line of ["[--model]", "[opus]", "[--effort]", "[max]", "[--permission-mode]", "[plan]"])
			assert.match(second, new RegExp(line.replace(/[\[\]]/g, "\\$&")), line);
	},
);

flow(
	"an engine tab shows what its program is doing, and a bad exit is told quietly",
	{ fakes: { codex: FAKE("codex", 3) } },
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		await openEngine(w, { engine: "codex-cli", permissionMode: "plan" });
		const tab = tabs(w).first();
		await expect(pane(w)).toBeVisible({ timeout: T });
		// It printed and then stopped: it is waiting for the person.
		await expect(tab.getByRole("img", { name: "Waiting for input" })).toBeVisible({ timeout: T });
		await shot(w, "engine-tab-waiting-dark");
		// Answering it ends the program with a failure code.
		await type(w, "go");
		await expect(tab.getByRole("img", { name: "Exited with code 3" })).toBeVisible({ timeout: T });
		await expect(w.page.getByText("Codex CLI · project exited with code 3.")).toBeVisible({
			timeout: T,
		});
		await expect(pane(w).getByText("This session ended with code 3.")).toBeVisible();
		// The screen it left is still there to read.
		assert.match(await screen(w), /got:go/);
		await shot(w, "engine-tab-exited-dark");
	},
);

flow("a restart brings a terminal tab back as an ended session with its last screen", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await newTerminal(w);
	await expect(pane(w)).toBeVisible({ timeout: T });
	await type(w, "echo before-the-restart-$((6*7))");
	await expect.poll(() => screen(w), { timeout: T }).toContain("before-the-restart-42");
	const id = await frontId(w);
	await relaunch(w);
	// Same tab, no process: what it showed is there to read, and it says why it is quiet.
	await expect(tabs(w)).toHaveCount(1, { timeout: T });
	await expect(pane(w)).toBeVisible({ timeout: T });
	assert.equal(await frontId(w), id);
	await expect.poll(() => screen(w), { timeout: T }).toContain("before-the-restart-42");
	await expect(
		pane(w).getByText("Namzu was closed, so this session ended."),
	).toBeVisible();
	await shot(w, "terminal-restored-dark");
	// An ended tab closes like any other.
	await tabs(w).first().getByRole("button", { name: /^Close tab / }).click();
	await expect(tabs(w)).toHaveCount(0, { timeout: T });
});

/** Everything that animates has settled, so a screenshot shows the resting state. */
async function settled(w) {
	await w.page.evaluate(async () => {
		// Only animations that end: a blinking cursor or a pulsing badge never finishes.
		const ending = document
			.getAnimations()
			.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
		await Promise.all(ending.map((a) => a.finished.catch(() => undefined)));
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
}

flow(
	"terminal tabs, the strip and the CLI switch read well in dark and light",
	{ fakes: { codex: FAKE("codex", 0), "claude": FAKE("claude", 0) } },
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		await newTerminal(w);
		await expect(pane(w)).toBeVisible({ timeout: T });
		await type(w, "ls -la --color=always /; echo colour-check-$((6*7))");
		await expect.poll(() => screen(w), { timeout: T }).toContain("colour-check-42");
		await openEngine(w, { engine: "codex-cli", model: "gpt-5-codex", permissionMode: "plan" });
		await expect(tabs(w)).toHaveCount(2, { timeout: T });
		await expect.poll(() => screen(w), { timeout: T }).toContain("ready");
		await openEngine(w, { engine: "claude-code", model: "opus", permissionMode: "plan" });
		await expect(tabs(w)).toHaveCount(3, { timeout: T });
		await expect.poll(() => screen(w), { timeout: T }).toContain("ready");
		await expect(
			tabs(w).nth(2).getByRole("img", { name: "Waiting for input" }),
		).toBeVisible({ timeout: T });
		// Back to the shell, in front of the other two.
		await tabs(w).first().getByRole("tab").click();
		await expect.poll(() => screen(w), { timeout: T }).toContain("colour-check-42");
		for (const mode of ["dark", "light"]) {
			await setAppearance(w, mode);
			await settled(w);
			await shot(w, `terminal-tabs-${mode}`);
		}
		// The composer's engine popup, with the switch on each side.
		await w.page.getByRole("button", { name: "New conversation tab" }).click();
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({
			timeout: T,
		});
		await openPicker(w);
		await w.page.getByRole("radio", { name: "CLI", exact: true }).click();
		for (const mode of ["light", "dark"]) {
			await setAppearance(w, mode);
			await settled(w);
			await shot(w, `cli-switch-${mode}`);
		}
	},
);

flow("right-click on + opens a terminal in a new pane to the right, and it takes input", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({
		timeout: T,
	});
	await w.page.getByRole("button", { name: "New conversation tab" }).click({ button: "right" });
	const menu = w.page.getByRole("menu", { name: "New tab" });
	await expect(menu).toBeVisible();
	assert.deepEqual(
		await menu.getByRole("menuitem").allInnerTexts(),
		[
			"New conversation",
			"New terminal",
			"New conversation to the right",
			"New conversation below",
			"New terminal to the right",
			"New terminal below",
			"New window",
		],
	);
	await menu.getByRole("menuitem", { name: "New terminal to the right" }).click();
	await expect(tabs(w)).toHaveCount(1, { timeout: T });
	await expect(pane(w)).toBeVisible({ timeout: T });
	await expect(w.page.locator(".conversation-tab-list")).toHaveCount(2);
	// The terminal is in its own pane, to the right of the conversation, which kept the left.
	const [composer, terminal] = await Promise.all([
		w.page.getByRole("textbox", { name: "Message Namzu" }).boundingBox(),
		pane(w).boundingBox(),
	]);
	assert.ok(composer && terminal && terminal.x > composer.x + composer.width / 2 - 1);
	await type(w, "echo split-right-$((6*7))");
	await expect.poll(() => screen(w), { timeout: T }).toContain("split-right-42");
});

flow("Shift+F10 on + opens the same menu, and a conversation can open below", {}, async (w) => {
	await openProject(w);
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({
		timeout: T,
	});
	await w.page.getByRole("button", { name: "New conversation tab" }).focus();
	await w.page.keyboard.press("Shift+F10");
	const menu = w.page.getByRole("menu", { name: "New tab" });
	await expect(menu).toBeVisible();
	await menu.getByRole("menuitem", { name: "New conversation below" }).click();
	await expect(w.page.locator(".conversation-tab-list")).toHaveCount(2, { timeout: T });
	const strips = await w.page.locator(".conversation-tab-list").evaluateAll((all) =>
		all.map((el) => el.getBoundingClientRect().top),
	);
	assert.ok(Math.abs(strips[0] - strips[1]) > 40, "the second pane is below the first");
});
