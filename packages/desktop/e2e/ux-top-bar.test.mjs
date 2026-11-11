// The top of a conversation window is one 40 px bar, not a strip of tabs. With the strip hidden
// (the default) every way of moving between conversations still works; "Show conversation tabs"
// brings the strip back exactly as it was.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-top-bar.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const ONE = "Explain the first thing in the project";
const TWO = "Explain the second thing in the project with a title that is long enough to be cut off at a narrow width";
const rules = [
	{ match: /first thing/i, steps: [{ text: "First answer." }] },
	{ match: /second thing/i, steps: [{ text: "Second answer." }] },
];

async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [wide, high]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(wide, high);
		},
		[width, height],
	);
	await expect.poll(() => w.page.evaluate(() => window.innerWidth), { timeout: T }).toBe(width);
}
const idle = (w) => expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
async function converse(w, text) {
	await send(w, text);
	await idle(w);
}
const barHeight = (w) =>
	w.page.evaluate(() => document.querySelector(".workspace-conversation-header")?.getBoundingClientRect().height);
const bar = (w) => w.page.locator(".conversation-bar");
const frontTitle = (w) => bar(w).locator(".conversation-bar-title");
const rowFor = (w, text) => w.page.locator(".sidebar").getByRole("button", { name: new RegExp(text, "i") }).first();

test("hidden by default: one 40 px bar, sidebar and chords still move between conversations", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await converse(w, ONE);
		await w.page.getByRole("button", { name: "New conversation" }).first().click();
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await converse(w, TWO);

		// The strip is gone; the bar names the conversation in front and the project.
		await expect(w.page.locator(".conversation-tab-list")).toHaveCount(0);
		await expect(bar(w)).toBeVisible();
		await expect(frontTitle(w)).toContainText("Explain the second thing");
		await expect(bar(w).locator(".conversation-bar-project")).toBeVisible();
		assert.equal(await barHeight(w), 40);

		// Every button is 28 px and has a name; the sidebar header keeps its own height.
		const names = ["Changes", "New terminal", "Project files", "Conversation details", "Conversation actions"];
		for (const name of names) {
			const button = bar(w).getByRole("button", { name: new RegExp(`^${name}`) });
			await expect(button).toBeVisible();
			const box = await button.boundingBox();
			assert.ok(box && Math.abs(box.width - 28) < 1 && Math.abs(box.height - 28) < 1, `${name} is 28 px: ${JSON.stringify(box)}`);
		}

		// A click on a sidebar row shows that conversation in place of this one, with no second tab.
		await rowFor(w, "first thing").click();
		await expect(frontTitle(w)).toContainText("Explain the first thing");
		await expect(w.page.getByText("First answer.")).toBeVisible({ timeout: T });
		await expect(w.page.locator(".conversation-tab")).toHaveCount(0);

		// The keyboard still switches and closes: next goes to the other conversation or stays put,
		// never to a blank page, and closing leaves the person on a page with a way forward.
		await w.page.keyboard.press("Control+Tab");
		await expect(frontTitle(w)).toBeVisible();
		await rowFor(w, "second thing").click();
		await expect(frontTitle(w)).toContainText("Explain the second thing");
		await w.page.keyboard.press("Control+w");
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });

		// The palette offers the switch, and the other conversations by name.
		await w.page.keyboard.press("Control+k");
		await expect(w.page.getByRole("option", { name: /Show conversation tabs/ })).toBeVisible({ timeout: T });
		await w.page.keyboard.press("Escape");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("column is 720 px at most, and the bar holds at 960 px with a long title", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await converse(w, TWO);
		const column = () => w.page.evaluate(() => document.querySelector(".conversation-body")?.getBoundingClientRect().width);
		assert.ok((await column()) <= 720.5, `column ${await column()}`);
		for (const width of [1280, 960, 820]) {
			await size(w, width, 700);
			await expect(frontTitle(w)).toBeVisible();
			const fit = await w.page.evaluate(() => {
				const header = document.querySelector(".workspace-conversation-header");
				const inner = document.querySelector(".conversation-bar");
				const buttons = [...document.querySelectorAll(".conversation-bar-buttons button")];
				const limit = inner.getBoundingClientRect().right + 1;
				return {
					wrapped: header.getBoundingClientRect().height,
					clipped: header.scrollWidth > header.clientWidth + 1,
					outside: buttons.filter((b) => b.getBoundingClientRect().right > limit || b.getBoundingClientRect().left < 0).length,
					count: buttons.length,
					// The title ends before the first button begins: it is the one that gives way.
					titleEnd: document.querySelector(".conversation-bar-title").getBoundingClientRect().right,
					buttonsStart: buttons[0].getBoundingClientRect().left,
				};
			});
			assert.equal(fit.wrapped, 40, `bar stays 40 px at ${width}`);
			assert.equal(fit.clipped, false, `nothing clipped at ${width}`);
			assert.equal(fit.outside, 0, `buttons reachable at ${width}`);
			assert.ok(fit.count >= 5, `five buttons at ${width}`);
			assert.ok(fit.titleEnd <= fit.buttonsStart, `the title gives way to the buttons at ${width}`);
		}
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("Show conversation tabs brings the strip back as it was, and the choice is kept", { timeout: 280000 }, async () => {
	const w = await createWorld({ rules, tabs: "hidden" });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await converse(w, ONE);
		await expect(w.page.locator(".conversation-tab-list")).toHaveCount(0);
		await w.page.getByRole("button", { name: "Settings", exact: true }).click();
		const sections = w.page.getByRole("navigation", { name: "Settings sections" });
		await sections.getByRole("button", { name: "Appearance", exact: true }).click();
		await w.page.getByRole("switch", { name: "Show conversation tabs" }).check();
		await w.page.getByRole("button", { name: "Home", exact: true }).click();
		await expect(w.page.locator(".conversation-tab-list")).toBeVisible({ timeout: T });
		await expect(w.page.locator(".conversation-bar")).toHaveCount(0);
		assert.equal(await barHeight(w), 52);
		// It survives a restart.
		await w.app.close();
		await launch(w);
		await expect(w.page.locator(".conversation-tab-list")).toBeVisible({ timeout: T });
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
