// The tab strip fills from its start: tabs share the width and shrink to a minimum, then move to
// "Show all tabs"; spare width is never left in front of the first tab.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/tab-strip-fill.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, dispose, enableTerminalDebug, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const MIN_TAB = 136;
const WRITE = {
	match: /write the file/i,
	steps: [{ tool: "write", args: { path: "out.txt", content: "hello\n" } }, { text: "Wrote out.txt." }],
};

async function resize(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, size) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(size.width, size.height);
		},
		{ width, height },
	);
	await expect.poll(() => w.page.evaluate(() => window.innerWidth), { timeout: T }).toBe(width);
}

/** One read of the strip, so every rectangle is of the same layout. */
const measure = (w) =>
	w.page.evaluate(() => {
		const list = document.querySelector(".conversation-tab-list");
		const rect = (node) => {
			const box = node.getBoundingClientRect();
			return { left: box.left, right: box.right, width: box.width };
		};
		const tabs = [...document.querySelectorAll(".conversation-tab")];
		const shown = tabs.filter((tab) => getComputedStyle(tab).display !== "none" && getComputedStyle(tab).visibility !== "hidden");
		const active = document.querySelector('.conversation-tab[data-active="true"]');
		const overflow = document.querySelector(".conversation-tab-overflow");
		const cut = shown
			.map((tab) => tab.querySelector(".fitted-title"))
			.filter((title) => title && title.scrollWidth > title.clientWidth + 1)
			.map((title) => {
				const style = getComputedStyle(title);
				return style.textOverflow === "ellipsis" || title.textContent.endsWith("…") ? null : title.textContent;
			})
			.filter(Boolean);
		return {
			list: rect(list),
			shown: shown.map(rect),
			total: tabs.length,
			activeShown: Boolean(active && shown.includes(active)),
			overflow: overflow ? rect(overflow) : null,
			cut,
		};
	});

	test("the tab strip fills from its start at every width, panel state and front tab", { timeout: 480000 }, async () => {
		const w = await createWorld({ rules: [WRITE], env: { SHELL: "/bin/sh" } });
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			await enableTerminalDebug(w);
			await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
			await resize(w, 1440, 800);
			// A change to review gives the right-hand Changes panel something to show.
			await send(w, "Please write the file");
			const card = w.page.getByRole("region", { name: "Tool approval" });
			await expect(card).toBeVisible({ timeout: T });
			await card.getByRole("button", { name: "Accept", exact: true }).click();
			await expect(w.page.getByText("Wrote out.txt.")).toBeVisible({ timeout: T });
			await w.page.getByRole("button", { name: "View changes" }).last().click();
			await expect(w.page.getByRole("complementary", { name: "Changes" })).toBeVisible({ timeout: T });
			const count = 7;
			for (let index = 0; index < count; index++) {
				await w.page.getByRole("button", { name: "New terminal tab" }).click();
				await expect(w.page.locator("[data-terminal-tab-id]")).toHaveCount(index + 1, { timeout: T });
			}
			const toggle = (name) => w.page.getByRole("button", { name, exact: true });
			const check = async (label) => {
				// Layout settles in the frame after a resize; poll the invariants rather than a clock.
				await expect
					.poll(async () => {
						const m = await measure(w);
						const problems = [];
						if (m.shown.length === 0) return ["no tab shown"];
						if (!m.activeShown) problems.push("the front tab is hidden");
						const first = m.shown[0];
						if (first.left - m.list.left > 16) problems.push(`gap before first tab ${first.left - m.list.left}`);
						const last = m.shown[m.shown.length - 1];
						const end = m.overflow ? m.overflow.left : m.list.right;
						if (m.shown.length < m.total && end - last.right >= MIN_TAB)
							problems.push(`spare ${end - last.right} after last tab`);
						if (m.shown.length < m.total && !m.overflow) problems.push("tabs left out with no menu");
						for (const tab of m.shown) if (tab.width < MIN_TAB - 1) problems.push(`tab ${tab.width} narrower than the minimum`);
						if (m.cut.length) problems.push(`cut mid-letter: ${m.cut.join(", ")}`);
						return problems.map((p) => `${label}: ${p}`);
					}, { timeout: T })
					.toEqual([]);
			};
			const side = w.page.getByRole("complementary", { name: "Changes" });
			// The Changes panel closes by itself when the window gets narrow, so each combination sets it.
			const setPanel = async (wanted) => {
				if (wanted && !(await side.isVisible())) {
					await w.page.keyboard.press("Control+1");
					await w.page.getByRole("button", { name: "View changes" }).last().click();
					await expect(side).toBeVisible({ timeout: T });
				}
				if (!wanted && (await side.isVisible())) {
					await side.getByRole("button", { name: /^(Hide panel|Back to conversation)/ }).first().click();
					await expect(side).toBeHidden({ timeout: T });
				}
			};
			for (const width of [900, 1180, 1440]) {
				await resize(w, width, 800);
				for (const sidebarOpen of [true, false]) {
					const sidebar = w.page.locator("aside.sidebar");
					const open = (await sidebar.count()) > 0 && (await sidebar.isVisible());
					if (open !== sidebarOpen) await toggle("Toggle sidebar").click();
					for (const panel of [true, false]) {
						for (const which of ["first", "middle", "last"]) {
							await setPanel(panel);
							const label = `${width}px sidebar=${sidebarOpen} panel=${panel} front=${which}`;
							// The shortcuts work however the panel covers the strip.
							await w.page.keyboard.press(which === "first" ? "Control+1" : which === "last" ? "Control+9" : "Control+4");
							await check(label);
						}
					}
				}
			}
			assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});
