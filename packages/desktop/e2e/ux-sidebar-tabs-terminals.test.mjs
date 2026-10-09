// Sidebar, tabs, terminals, palette and keyboard, against the real Electron app, the real CLI host
// and the scripted model. Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-sidebar-tabs-terminals.test.mjs
// Pictures go to research/ux-20261009/sidebar-tabs-terminals/.
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
	relaunch,
	repoRoot,
	send,
} from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/ux-20261009/sidebar-tabs-terminals");

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

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function resize(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, size) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(size.width, size.height);
		},
		{ width, height },
	);
	await expect
		.poll(() => w.page.evaluate(() => window.innerWidth))
		.toBeLessThanOrEqual(width);
}

async function zoom(w, factor) {
	await w.app.evaluate(({ BrowserWindow }, value) => {
		for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(value);
	}, factor);
}

async function setAppearance(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}

const CHATS = [
	{ match: /alpha/, steps: [{ text: "Reply alpha." }] },
	{ match: /beta/, steps: [{ text: "Reply beta." }] },
];

const sidebar = (w) => w.page.locator("aside.sidebar");
const rows = (w) => w.page.locator("li[data-thread-item]:visible");
const tabs = (w) => w.page.locator(".conversation-tab");
const terminalTabs = (w) => w.page.locator("[data-terminal-tab-id]");
const activeTab = (w) => w.page.locator('.conversation-tab[data-active="true"]');

async function newConversationTab(w) {
	await w.page.getByRole("button", { name: "New conversation tab" }).click();
}
async function newTerminal(w) {
	await w.page.getByRole("button", { name: "New terminal tab" }).click();
}
async function chat(w, text, reply) {
	await send(w, text);
	await expect(w.page.getByText(reply, { exact: true }).first()).toBeVisible({ timeout: T });
}
async function twoChats(w) {
	await openProject(w);
	await chat(w, "alpha chat", "Reply alpha.");
	await newConversationTab(w);
	await chat(w, "beta chat", "Reply beta.");
}

/** How far a control's centre is from the centre of its row, in pixels. */
async function centreOffsets(w, rowSelector, controlSelector) {
	return w.page.evaluate(
		([rowSel, controlSel]) => {
			const out = [];
			for (const row of document.querySelectorAll(rowSel)) {
				const rect = row.getBoundingClientRect();
				for (const control of row.querySelectorAll(controlSel)) {
					const box = control.getBoundingClientRect();
					if (box.width === 0) continue;
					out.push({
						control: control.getAttribute("aria-label") ?? control.className,
						offset: Math.abs(box.top + box.height / 2 - (rect.top + rect.height / 2)),
					});
				}
			}
			return out;
		},
		[rowSelector, controlSelector],
	);
}

flow(
	"the trailing controls of a row are centred on it, at every zoom, dark and light",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		await newTerminal(w);
		await expect(terminalTabs(w)).toHaveCount(1, { timeout: T });
		for (const appearance of ["dark", "light"]) {
			await setAppearance(w, appearance);
			for (const factor of [1, 1.25, 1.5]) {
				await zoom(w, factor);
				for (const row of await rows(w).all()) {
					await row.hover();
					const offsets = await centreOffsets(
						w,
						"li[data-thread-item]:hover",
						".sidebar-thread-action, .conversation-row-state > *",
					);
					assert.ok(offsets.length >= 2, "the pin and archive buttons were measured");
					for (const item of offsets)
						assert.ok(
							item.offset <= 0.5,
							`${item.control} sits ${item.offset}px off centre at ${factor}x ${appearance}`,
						);
				}
				const terminalRow = w.page.locator("li[data-terminal-row]").first();
				await terminalRow.hover();
				const closeOffsets = await centreOffsets(
					w,
					"li[data-terminal-row]:hover",
					".sidebar-thread-action",
				);
				assert.equal(closeOffsets.length, 1, "the terminal row's close button was measured");
				for (const item of closeOffsets)
					assert.ok(item.offset <= 0.5, `${item.control} sits ${item.offset}px off centre`);
			}
		}
		await zoom(w, 1);
		// An ended terminal carries a status dot: it is centred on its row too, and says what it is.
		await w.page.locator("section.terminal-pane .xterm-helper-textarea").focus();
		await w.page.keyboard.type("exit");
		await w.page.keyboard.press("Enter");
		await expect(w.page.locator("li[data-terminal-row] .terminal-badge")).toHaveAttribute(
			"title",
			"Session ended",
			{ timeout: T },
		);
		await w.page.mouse.move(700, 500);
		for (const [row, dot] of [
			["li[data-terminal-row]", ".terminal-badge"],
			[".terminal-strip-tab", ".terminal-badge"],
		]) {
			const offsets = await centreOffsets(w, row, dot);
			assert.equal(offsets.length, 1, `${dot} in ${row} was measured`);
			assert.ok(offsets[0].offset <= 0.5, `${row} dot is ${offsets[0].offset}px off centre`);
		}
		const project = sidebar(w).locator(".sidebar-project-heading").first();
		await project.hover();
		const more = await centreOffsets(w, ".sidebar-project-heading:hover", ".sidebar-project-more");
		assert.equal(more.length, 1);
		assert.ok(more[0].offset <= 0.5, `the project's menu button is ${more[0].offset}px off centre`);
		await rows(w).first().hover();
		await shot(w, "row-controls-centred-light");
		await setAppearance(w, "dark");
		await rows(w).first().hover();
		await shot(w, "row-controls-centred-dark");
	},
);

flow(
	"two terminals are told apart, and a dot says what it means",
	{ rules: CHATS },
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await newTerminal(w);
		await expect(terminalTabs(w)).toHaveCount(1, { timeout: T });
		await newTerminal(w);
		await expect(terminalTabs(w)).toHaveCount(2, { timeout: T });
		const titles = await terminalTabs(w).locator(".conversation-tab-label .truncate").allTextContents();
		assert.equal(new Set(titles).size, 2, `two different names, got ${titles}`);
		assert.match(titles[0], /^sh · project$/);
		assert.match(titles[1], /^sh 2 · project$/);
		const side = await sidebar(w)
			.locator("li[data-terminal-row] > button")
			.evaluateAll((items) => items.map((item) => item.getAttribute("title")));
		assert.deepEqual(side, ["sh · project", "sh 2 · project"]);
		await shot(w, "terminal-names-light");
		await setAppearance(w, "dark");
		await shot(w, "terminal-names-dark");
	},
);

flow(
	"the Projects heading is the one place to add a project, and removal is not one click",
	{ rules: CHATS },
	async (w) => {
		const page = w.page;
		await expect(page.getByRole("button", { name: "Add new project", exact: true }).first()).toBeVisible({
			timeout: 30000,
		});
		// On the empty welcome the sidebar offers one entry; the other is the welcome's own button.
		assert.equal(
			await sidebar(w).getByRole("button", { name: "Add new project", exact: true }).count(),
			1,
		);
		assert.equal(await sidebar(w).getByRole("menuitem", { name: "New conversation" }).count(), 0);
		await shot(w, "welcome-one-add-entry");
		await openProject(w);
		await chat(w, "alpha chat", "Reply alpha.");
		const project = sidebar(w).locator(".sidebar-project-heading").first();
		await project.hover();
		assert.equal(await sidebar(w).getByRole("button", { name: /^Remove / }).count(), 0, "no remove button");
		await project.getByRole("button", { name: /^Actions for / }).click();
		await expect(page.getByRole("menuitem", { name: "Remove project…" })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Open folder" })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Archived conversations" })).toBeVisible();
		await shot(w, "project-row-menu");
		await page.keyboard.press("Escape");
		// Nothing was started by hovering or opening the menu.
		await expect(page.getByRole("dialog")).toHaveCount(0);
	},
);

flow(
	"each conversation is listed once, with its project's name where it is in Recents",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		// Open project: its rows are in the project list, and Recents holds none of them.
		const ids = await rows(w).evaluateAll((items) => items.map((item) => item.dataset.sessionId));
		assert.equal(new Set(ids).size, ids.length, `each row once: ${ids}`);
		await shot(w, "each-conversation-once");
		// Collapse the project: its conversations now appear in Recents, with the project's name.
		await sidebar(w).getByRole("button", { name: /^Collapse .* conversations$/ }).click();
		await expect(sidebar(w).locator(".sidebar-recent-list li[data-thread-item]")).toHaveCount(2, {
			timeout: T,
		});
		await expect(sidebar(w).locator(".conversation-row-project").first()).toHaveText("project");
		// Wait for the project's own list to finish closing before counting what is left.
		await expect(sidebar(w).locator(".sidebar-project-list li[data-thread-item]:visible")).toHaveCount(
			0,
			{ timeout: T },
		);
		const afterIds = await rows(w).evaluateAll((items) => items.map((item) => item.dataset.sessionId));
		assert.equal(new Set(afterIds).size, afterIds.length, `each row once: ${afterIds}`);
		await shot(w, "recents-with-project-name");
	},
);

flow(
	"clicking the project row again opens no second empty conversation",
	{ rules: CHATS },
	async (w) => {
		await openProject(w);
		await chat(w, "alpha chat", "Reply alpha.");
		const project = sidebar(w).locator(".project-row").first();
		await project.click();
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible();
		const first = await tabs(w).count();
		await project.click();
		await project.click();
		await project.click();
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible();
		assert.equal(await tabs(w).count(), first, "no tab piled up");
		// Restarting does not make the empty conversation a duplicate either.
		await relaunch(w);
		await sidebar(w).locator(".project-row").first().click();
		const afterRestart = await tabs(w).count();
		await sidebar(w).locator(".project-row").first().click();
		await sidebar(w).locator(".project-row").first().click();
		assert.equal(await tabs(w).count(), afterRestart);
	},
);

flow(
	"archive says what it does, keeps Undo long, and Archived is in the sidebar",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		const row = sidebar(w).locator("li[data-thread-item]", { hasText: "alpha chat" });
		await row.click({ button: "right" });
		await expect(w.page.getByRole("menuitem", { name: "Archive", exact: true })).toBeVisible();
		assert.equal(await w.page.getByRole("menuitem", { name: /Archive…/ }).count(), 0);
		await w.page.getByRole("menuitem", { name: "Archive", exact: true }).click();
		const toast = w.page.getByText(/Conversation archived\. Find it under Archived conversations/);
		await expect(toast).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
		await shot(w, "archive-toast");
		await sidebar(w).getByRole("button", { name: "Archived conversations" }).click();
		const dialog = w.page.getByRole("dialog", { name: "Archived conversations" });
		await expect(dialog.getByText("alpha chat")).toBeVisible({ timeout: T });
		await expect(dialog.getByRole("heading", { name: "project" })).toBeVisible();
		await shot(w, "archived-from-sidebar");
		await dialog.getByRole("button", { name: "Restore alpha chat" }).click();
		await expect(dialog.getByText("Nothing is archived.")).toBeVisible({ timeout: T });
	},
);

flow(
	"the command palette uses the app's words, lists recents once, and shows whole chords",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		await newConversationTab(w);
		await w.page.keyboard.press("Control+k");
		const box = w.page.getByRole("combobox", { name: "Search conversations and actions" });
		await expect(box).toBeVisible();
		await expect(box).toHaveAttribute("placeholder", "Search conversations and actions");
		const popup = w.page.locator(".command-palette-popup");
		// The palette's own words (not the titles of the conversations it lists) say conversation, not chat.
		const own = await popup
			.locator(".command-palette-group", { hasNotText: /^Recent/ })
			.allInnerTexts();
		assert.ok(own.length >= 3, "the action groups were read");
		assert.doesNotMatch(own.join("\n"), /chat/i, "the palette says conversation, not chat");
		for (const heading of ["Recent", "Actions", "Tabs", "Projects"])
			await expect(popup.locator(".command-palette-group-label", { hasText: heading })).toBeVisible();
		// An empty draft is not listed as a conversation, and nothing is listed twice.
		const labels = await popup.locator(".command-palette-item .command-palette-label").allTextContents();
		assert.equal(new Set(labels).size, labels.length, `no duplicate entries: ${labels}`);
		assert.equal(labels.filter((label) => label === "New conversation").length, 1);
		for (const wanted of [
			"Archived conversations",
			"Close tab",
			"Next tab",
			"Previous tab",
			"Move tab left",
			"Move tab right",
			"New terminal to the right",
			"New terminal below",
			"New conversation to the right",
			"New conversation below",
			"Add project: start from scratch",
		])
			assert.ok(labels.includes(wanted), `${wanted} is in the palette`);
		const terminal = popup.locator(".command-palette-item", { hasText: "New terminal" }).first();
		await expect(terminal.locator("kbd")).toHaveText("Ctrl+Shift+`");
		await shot(w, "palette-dark");
		await w.page.keyboard.press("Escape");
		await setAppearance(w, "light");
		await w.page.keyboard.press("Control+k");
		await expect(popup).toBeVisible();
		await shot(w, "palette-light");
		await w.page.keyboard.press("Escape");
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeFocused();
	},
);

flow(
	"search folds Turkish I and ı the same way everywhere",
	{
	},
	async (w) => {
		await openProject(w);
		await chat(w, "Işık raporu", "Scripted default reply.");
		await newConversationTab(w);
		await chat(w, "ışık ölçümü", "Scripted default reply.");
		for (const query of ["ışık", "Işık", "IŞIK", "isik", "ISIK"]) {
			await w.page.keyboard.press("Control+k");
			await w.page.getByRole("combobox", { name: "Search conversations and actions" }).fill(query);
			const found = w.page.locator(".command-palette-item");
			await expect(found.filter({ hasText: "Işık raporu" })).toHaveCount(1);
			await expect(found.filter({ hasText: "ışık ölçümü" })).toHaveCount(1);
			if (query === "IŞIK") await shot(w, "search-turkish-IŞIK");
			await w.page.keyboard.press("Escape");
		}
	},
);

flow(
	"search keeps matching English words in capitals under a Turkish locale",
	{
		env: { LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8", LANGUAGE: "tr" },
	},
	async (w) => {
		await openProject(w);
		await chat(w, "İpek yolu", "Scripted default reply.");
		const lang = await w.page.evaluate(() => navigator.language);
		console.log(`navigator.language is ${lang}`);
		for (const [query, label] of [
			["TERMINAL", "New terminal"],
			["SETTINGS", "Settings"],
			["IPEK", "İpek yolu"],
		]) {
			await w.page.keyboard.press("Control+k");
			await w.page.getByRole("combobox", { name: "Search conversations and actions" }).fill(query);
			await expect(w.page.locator(".command-palette-item", { hasText: label }).first()).toBeVisible();
			await w.page.keyboard.press("Escape");
		}
		await shot(w, "search-turkish-locale");
	},
);

flow(
	"keyboard: switch, reorder and close tabs, and Ctrl+, from a terminal",
	{ rules: CHATS },
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await chat(w, "alpha chat", "Reply alpha.");
		await newTerminal(w);
		await newTerminal(w);
		await expect(terminalTabs(w)).toHaveCount(2, { timeout: T });
		const names = async () => w.page.locator(".conversation-tab-label .truncate").allTextContents();
		assert.equal((await names()).length, 3);
		const front = async () => (await activeTab(w).locator(".conversation-tab-label .truncate").textContent()) ?? "";
		// The second terminal is in front. Ctrl+Tab wraps to the first tab; Ctrl+Shift+Tab goes back.
		await w.page.locator("section.terminal-pane .xterm-helper-textarea").focus();
		await w.page.keyboard.press("Control+Tab");
		await expect.poll(front).toBe("alpha chat");
		await w.page.keyboard.press("Control+Shift+Tab");
		await expect.poll(front).toBe("sh 2 · project");
		await w.page.keyboard.press("Control+1");
		await expect.poll(front).toBe("alpha chat");
		await w.page.keyboard.press("Control+9");
		await expect.poll(front).toBe("sh 2 · project");
		// Reorder the front tab one place to the left.
		const before = await names();
		await w.page.keyboard.press("Control+Shift+PageUp");
		await expect.poll(names).toEqual([before[0], before[2], before[1]]);
		// Ctrl+F4 closes the terminal in front, even inside the terminal; Ctrl+W closes a conversation tab.
		await w.page.locator("section.terminal-pane .xterm-helper-textarea").focus();
		await w.page.keyboard.press("Control+F4");
		await expect(terminalTabs(w)).toHaveCount(1, { timeout: T });
		await w.page.getByRole("tab", { name: /alpha chat/ }).click();
		await expect.poll(front).toBe("alpha chat");
		await w.page.keyboard.press("Control+w");
		await expect.poll(async () => (await names()).includes("alpha chat")).toBe(false);
		await expect(terminalTabs(w)).toHaveCount(1);
		await shot(w, "keyboard-tabs");
		// Ctrl+, reaches the app from the terminal, where Ctrl+W stays the shell's.
		await w.page.locator("[data-terminal-tab-id]").first().click();
		await w.page.locator("section.terminal-pane .xterm-helper-textarea").focus();
		await w.page.keyboard.press("Control+w");
		await expect(terminalTabs(w)).toHaveCount(1);
		await w.page.keyboard.press("Control+,");
		await expect(w.page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({ timeout: T });
	},
);

flow(
	"split a terminal from the caret, the tab menu and the palette, at 900 px, without the page scrolling sideways",
	{ rules: CHATS },
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await resize(w, 900, 720);
		await newTerminal(w);
		await expect(terminalTabs(w)).toHaveCount(1, { timeout: T });
		await w.page.getByRole("button", { name: "More ways to add a tab" }).click();
		await w.page.getByRole("menuitem", { name: "New terminal to the right" }).click();
		await expect(w.page.locator("section.terminal-pane")).toHaveCount(2, { timeout: T });
		// The sidebar steps aside as the second pane opens; once it has, nothing scrolls sideways.
		await expect
			.poll(() =>
				w.page.evaluate(() => ({
					page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					body: document.body.scrollWidth - document.body.clientWidth,
					canvas: (() => {
						const c = document.querySelector(".workspace-canvas");
						return c ? c.scrollWidth - c.clientWidth : 0;
					})(),
				})),
			)
			.toEqual({ page: 0, body: 0, canvas: 0 });
		const panes = await w.page.locator(".workspace-canvas-pane").evaluateAll((items) =>
			items.map((item) => {
				const box = item.getBoundingClientRect();
				return { left: box.left, right: box.right };
			}),
		);
		for (const pane of panes) assert.ok(pane.right <= 900 + 0.5, "every pane is inside the window");
		await setAppearance(w, "light");
		await shot(w, "split-900-light");
		await setAppearance(w, "dark");
		await shot(w, "split-900-dark");
		// The tab menu offers the split too.
		await w.page.getByRole("button", { name: /^Actions for sh · project/ }).first().click();
		await expect(w.page.getByRole("menuitem", { name: "New terminal below" })).toBeVisible();
		await w.page.keyboard.press("Escape");
	},
);

flow(
	"the tab strip keeps the front tab in view and lists every tab in an overflow menu",
	{ rules: CHATS },
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await resize(w, 900, 720);
		for (let index = 0; index < 8; index++) {
			await newTerminal(w);
			await expect(terminalTabs(w)).toHaveCount(index + 1, { timeout: T });
		}
		const inView = () =>
			w.page.evaluate(() => {
				const list = document.querySelector(".conversation-tab-list");
				const tab = document.querySelector('.conversation-tab[data-active="true"]');
				if (!list || !tab) return false;
				const a = list.getBoundingClientRect();
				const b = tab.getBoundingClientRect();
				return b.left >= a.left - 1 && b.right <= a.right + 1;
			});
		await expect.poll(inView).toBe(true);
		const overflow = w.page.getByRole("button", { name: "Show all tabs" });
		await expect(overflow).toBeVisible();
		await setAppearance(w, "light");
		await shot(w, "tab-overflow-light");
		await overflow.click();
		const first = w.page.locator("[data-overflow-tab]").first();
		const name = ((await first.textContent()) ?? "").trim();
		await first.click();
		await expect(activeTab(w).first()).toContainText(name);
		await expect.poll(inView).toBe(true);
		await w.page.keyboard.press("Control+9");
		await expect.poll(inView).toBe(true);
		await setAppearance(w, "dark");
		await shot(w, "tab-overflow-dark");
	},
);

flow(
	"a long title is cut between words, and the full title is the tooltip",
	{ rules: CHATS },
	async (w) => {
		await openProject(w);
		const title = "Bu eki ekledim, lütfen dosya oluştur ve kaydet yarın sabah";
		await chat(w, title, "Scripted default reply.");
		const label = w.page.locator(".conversation-tab-label .truncate", { hasText: "Bu eki" }).first();
		const shown = (await label.textContent()) ?? "";
		assert.ok(shown.endsWith("…"), `shortened: ${shown}`);
		const kept = shown.slice(0, -1);
		assert.ok(title.startsWith(kept), "a prefix of the title");
		assert.equal(title[kept.length], " ", "the cut falls on a space, not inside a word");
		assert.equal(await label.getAttribute("title"), title);
		const row = sidebar(w).locator("li[data-thread-item] .conversation-row-title").first();
		assert.equal(await row.getAttribute("title"), title);
		await shot(w, "long-title");
	},
);

flow(
	"the hover card does not repeat the row or cover the transcript",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		const row = sidebar(w).locator("li[data-thread-item]", { hasText: "alpha chat" });
		await row.hover();
		const card = w.page.locator('[data-slot="thread-hover-card"]');
		await expect(card).toBeVisible({ timeout: T });
		assert.doesNotMatch(await card.innerText(), /alpha chat/i, "the title is not repeated");
		await expect(card).toContainText("Reply alpha.");
		const covered = await w.page.evaluate(() => {
			const card = document.querySelector('[data-slot="thread-hover-card"]')?.getBoundingClientRect();
			const transcript = document.querySelector(".transcript, [data-transcript]")?.getBoundingClientRect();
			if (!card || !transcript) return "missing";
			return card.right > transcript.left && card.left < transcript.right && card.bottom > transcript.top
				? "overlaps"
				: "clear";
		});
		assert.equal(covered, "clear");
		await shot(w, "hover-card");
	},
);

flow(
	"terminal find and a multi-line paste are announced in the pane",
	{ rules: CHATS },
	async (w) => {
		await openProject(w);
		await enableTerminalDebug(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await newTerminal(w);
		await expect(terminalTabs(w)).toHaveCount(1, { timeout: T });
		const input = w.page.locator("section.terminal-pane .xterm-helper-textarea");
		await input.focus();
		await w.page.keyboard.press("Control+f");
		await expect(w.page.locator("section.terminal-pane output[aria-live='polite']")).toContainText(
			"Find in terminal",
		);
		await w.page.keyboard.press("Escape");
		await input.focus();
		// A program that did not ask for bracketed paste (the shell is told to stop asking, and kept busy).
		await input.fill("");
		await w.page.keyboard.type("printf '\\033[?2004l'; sleep 600");
		await w.page.keyboard.press("Enter");
		const note = w.page.getByRole("alert").filter({ hasText: "Paste 2 lines?" });
		await expect(async () => {
			await input.evaluate((element) => {
				const data = new DataTransfer();
				data.setData("text/plain", "echo one\necho two\n");
				element.dispatchEvent(
					new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
				);
			});
			await expect(note).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: T });
		await shot(w, "terminal-paste-confirm");
		await note.getByRole("button", { name: "Cancel" }).click();
		await expect(note).toHaveCount(0);
	},
);

flow(
	"a conversation reopens where it was left after a restart",
	{
		rules: [
			{
				match: /long/,
				steps: [{ text: Array.from({ length: 160 }, (_, n) => `Line ${n + 1} of a long answer.`).join("\n\n") }],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await send(w, "long answer please");
		await expect(w.page.getByText("Line 160 of a long answer.")).toBeVisible({ timeout: T });
		const scroller = () => w.page.locator(".transcript, [data-transcript]").first();
		await scroller().evaluate((node) => {
			node.scrollTop = 1200;
		});
		await expect.poll(() => scroller().evaluate((node) => Math.round(node.scrollTop))).toBe(1200);
		// The position is kept with the conversation's view as soon as the reader stops.
		await expect
			.poll(() =>
				w.page.evaluate(() =>
					Object.values(localStorage).some((value) => /"scrollTop":1200\b/.test(value)),
				),
			)
			.toBe(true);
		await relaunch(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		try {
			await expect
				.poll(() => scroller().evaluate((node) => Math.round(node.scrollTop)), { timeout: 15000 })
				.toBeGreaterThan(1000);
		} catch (error) {
			console.log(
				"DEBUG",
				await w.page.evaluate(() =>
					JSON.stringify({
						ls: Object.entries(localStorage).filter(([k]) => k.includes("presentation")),
						top: document.querySelector(".transcript")?.scrollTop,
						h: document.querySelector(".transcript")?.scrollHeight,
						state: document.querySelector(".transcript")?.getAttribute("data-history-state"),
						tabs: [...document.querySelectorAll(".conversation-tab")].map((t) => t.textContent),
					}),
				),
			);
			throw error;
		}
		await shot(w, "scroll-restored");
	},
);
