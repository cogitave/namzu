// A conversation row shows one status mark. A turn that finishes while no window shows that
// conversation leaves an unread mark in every window; showing the conversation clears it once,
// and main (not a window) is the only owner of the set. Recents groups rows by day, with the
// pinned ones apart.
// Real Electron, two real windows, real CLI host, scripted model. No paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-sidebar-unread.test.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS ?? join(repoRoot, "research/sidebar-unread-20261107");
mkdirSync(SHOTS, { recursive: true });

const RULES = [
	{ match: /alpha/, steps: [{ text: "Reply alpha." }] },
	{ match: /charlie/, steps: [{ text: "Reply charlie." }] },
	{ match: /beta/, steps: [{ text: "Reply beta." }] },
];

const row = (page, title) => page.locator("li[data-thread-item]", { hasText: title }).first();
const status = (page, title, kind) =>
	kind
		? expect(row(page, title)).toHaveAttribute("data-status", kind, { timeout: T })
		: expect(row(page, title)).not.toHaveAttribute("data-status", /.+/, { timeout: T });
/** What each window was told about unread, in the order it arrived. */
const told = (page) => page.evaluate(() => window.__unread);
const record = (page) =>
	page.evaluate(() => {
		window.__unread = [];
		window.namzu.onEvent((event) => {
			if (event.kind === "unread") window.__unread.push({ ids: event.ids, sequence: event.sequence });
		});
	});
const mainsView = (page) => page.evaluate(() => window.namzu.conversationUnread());

test("one mark per row, unread in every window, cleared once", { timeout: 360000 }, async () => {
	const w = await createWorld({ rules: RULES, env: { SHELL: "/bin/sh" } });
	let failed = true;
	try {
		await launch(w);
		const one = w.page;
		await openProject(w);

		// Three conversations, all finished. Charlie then goes to a second window.
		await send(w, "alpha chat");
		await expect(one.getByText("Reply alpha.", { exact: true }).first()).toBeVisible({ timeout: T });
		await one.getByRole("button", { name: "New conversation tab" }).click();
		await send(w, "beta chat");
		await expect(one.getByText("Reply beta.", { exact: true }).first()).toBeVisible({ timeout: T });
		await one.getByRole("button", { name: "New conversation tab" }).click();
		await send(w, "charlie chat");
		await expect(one.getByText("Reply charlie.", { exact: true }).first()).toBeVisible({ timeout: T });
		await row(one, "charlie chat").click({ button: "right" });
		await one.getByRole("menuitem", { name: "Move to new window" }).click();
		await expect.poll(() => w.app.windows().length, { timeout: T }).toBe(2);
		const two = w.app.windows().find((page) => page !== one);
		await two.waitForLoadState("domcontentloaded");
		await w.app.evaluate(({ BrowserWindow }) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(1280, 820);
		});
		await expect(two.getByText("Reply charlie.", { exact: true }).first()).toBeVisible({ timeout: T });

		// Beta gets a second turn in the first window, held there. Then the first window goes back
		// to alpha: beta is open in it but in front of nobody.
		await row(one, "beta chat").click();
		// Beta's next reply is parked at the model until released (the scripted rule is live).
		w.model.rules.find((rule) => rule.match.test("beta")).steps = [
			{ hold: "beta", text: "Reply beta again." },
		];
		await send(w, "beta again");
		await expect(one.getByRole("button", { name: "Stop" }).first()).toBeVisible({ timeout: T });
		await row(one, "alpha chat").click();
		await expect(one.getByText("Reply alpha.", { exact: true }).first()).toBeVisible({ timeout: T });
		await record(one);
		await record(two);

		// Beta is working, and both windows say so with the same mark, in words.
		await status(one, "beta chat", "running");
		await status(two, "beta chat", "running");
		// The mark carries its name; the row's button hides inner roles, so it is found by label.
		await expect(row(two, "beta chat").locator('[aria-label="Running"]')).toBeVisible();
		// Conversations someone is looking at, or that are quiet, carry no mark.
		await status(one, "alpha chat");
		await status(two, "charlie chat");

		await one.screenshot({ path: join(SHOTS, "running-mark.png") });

		// The turn ends while neither window shows beta.
		w.model.release("beta");
		await status(one, "beta chat", "unread");
		await status(two, "beta chat", "unread");
		await expect(row(one, "beta chat").locator('[aria-label="New reply"]')).toBeVisible();
		await expect(row(two, "beta chat").locator('[aria-label="New reply"]')).toBeVisible();
		// Other rows stay quiet, and main holds exactly that one id.
		await status(one, "alpha chat");
		await status(two, "charlie chat");
		const set = await mainsView(one);
		assert.equal(set.ids.length, 1);
		assert.deepEqual(await told(one), [{ ids: set.ids, sequence: 1 }]);
		assert.deepEqual(await told(two), [{ ids: set.ids, sequence: 1 }], "both windows heard the same change");
		await one.screenshot({ path: join(SHOTS, "two-windows-first.png") });
		await two.screenshot({ path: join(SHOTS, "two-windows-second.png") });

		// Showing beta reads it, once, in both windows.
		await row(one, "beta chat").click();
		await expect(one.getByText("Reply beta again.", { exact: true }).first()).toBeVisible({ timeout: T });
		await status(one, "beta chat");
		await status(two, "beta chat");
		const cleared = [{ ids: set.ids, sequence: 1 }, { ids: [], sequence: 2 }];
		assert.deepEqual(await told(one), cleared);
		assert.deepEqual(await told(two), cleared, "one clear, heard by both windows");

		// Leaving and coming back does not clear (or set) anything again.
		await row(one, "alpha chat").click();
		await row(one, "beta chat").click();
		await row(one, "alpha chat").click();
		assert.deepEqual(await mainsView(two), { ids: [], sequence: 2 });
		assert.deepEqual(await told(one), cleared);

		// The menu can mark a conversation unread and read again; both windows follow main.
		await row(two, "alpha chat").click({ button: "right" });
		await two.getByRole("menuitem", { name: "Mark as unread" }).click();
		await status(one, "alpha chat", "unread");
		await status(two, "alpha chat", "unread");
		await row(one, "alpha chat").click({ button: "right" });
		await one.getByRole("menuitem", { name: "Mark as read" }).click();
		await status(one, "alpha chat");
		await status(two, "alpha chat");

		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("Recents groups by day with pinned conversations apart, and shows no mark on a quiet row", {
	timeout: 240000,
}, async () => {
	const w = await createWorld({ rules: RULES, env: { SHELL: "/bin/sh" } });
	let failed = true;
	try {
		await launch(w);
		const page = w.page;
		await openProject(w);
		await send(w, "alpha chat");
		await expect(page.getByText("Reply alpha.", { exact: true }).first()).toBeVisible({ timeout: T });
		await page.getByRole("button", { name: "New conversation tab" }).click();
		await send(w, "charlie chat");
		await expect(page.getByText("Reply charlie.", { exact: true }).first()).toBeVisible({ timeout: T });

		// Folding the project puts every conversation in Recents. The folded panel keeps its rows
		// for the length of the fold, so the flow works on Recents' own rows.
		await page.getByRole("button", { name: /^Collapse .* conversations$/ }).click();
		const recents = page.locator(".sidebar-recents");
		const inRecents = (title) => recents.locator("li[data-thread-item]", { hasText: title });
		await expect(recents.getByRole("heading", { name: "Today" })).toBeVisible({ timeout: T });
		await expect(recents.locator("li[data-thread-item]")).toHaveCount(2);
		await expect(recents.getByRole("heading", { name: "Pinned" })).toHaveCount(0);

		// Pinning moves a conversation under its own heading above the days.
		await inRecents("alpha chat").click({ button: "right" });
		await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
		await expect(recents.getByRole("heading", { name: "Pinned" })).toBeVisible({ timeout: T });
		await expect(recents.getByRole("heading", { name: "Today" })).toHaveCount(1);
		const order = await recents
			.locator("h3, li[data-thread-item]")
			.evaluateAll((nodes) =>
				nodes
					.filter((node) => node.closest('[aria-hidden="true"]') === null)
					.map((node) => (node.tagName === "H3" ? `#${node.textContent}` : node.getAttribute("data-session-id"))),
			);
		assert.equal(order.length, 4, "two headings and two rows");
		assert.deepEqual([order[0], order[2]], ["#Pinned", "#Today"]);
		await expect(inRecents("alpha chat")).not.toHaveAttribute("data-status", /.+/);
		await expect(inRecents("charlie chat")).not.toHaveAttribute("data-status", /.+/);

		// Widths: the headings, the marks and the rows hold their shape. Under 768 px the
		// sidebar is a drawer.
		const settled = () =>
			expect
				.poll(() => page.evaluate(() => document.getAnimations().length), { timeout: T })
				.toBe(0);
		for (const width of [1280, 1000, 900, 640]) {
			await w.app.evaluate(({ BrowserWindow }, size) => {
				for (const win of BrowserWindow.getAllWindows()) win.setSize(size, 820);
			}, width);
			await page.waitForFunction((size) => Math.abs(window.innerWidth - size) < 24, width);
			const sidebar = page.locator("#namzu-sidebar");
			// Under 768 px the sidebar is a drawer: the toggle slides it over the page.
			if (width < 768) {
				await page.getByRole("button", { name: "Toggle sidebar" }).click();
				await expect(sidebar).toHaveClass(/\bopen\b/);
			}
			await settled();
			await page.screenshot({ path: join(SHOTS, `recents-days-${width}.png`) });
		}
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("a conversation waiting for approval shows its own mark in the list", { timeout: 240000 }, async () => {
	const w = await createWorld({
		rules: [
			...RULES,
			{
				match: /write the file/i,
				steps: [
					{ tool: "write", args: { path: "out.txt", content: "hello from the model\n" } },
					{ text: "Wrote out.txt." },
				],
			},
		],
		env: { SHELL: "/bin/sh" },
	});
	let failed = true;
	try {
		await launch(w);
		const page = w.page;
		await openProject(w);
		await send(w, "alpha chat");
		await expect(page.getByText("Reply alpha.", { exact: true }).first()).toBeVisible({ timeout: T });
		await page.getByRole("button", { name: "New conversation tab" }).click();
		await send(w, "write the file please");
		await expect(page.getByRole("button", { name: "Accept", exact: true }).first()).toBeVisible({ timeout: T });
		await row(page, "alpha chat").click();
		await status(page, "write the file please", "permission");
		await expect(row(page, "write the file please").locator('[aria-label="Approval needed"]')).toBeVisible();
		await status(page, "alpha chat");
		await page.screenshot({ path: join(SHOTS, "approval-mark.png") });
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
