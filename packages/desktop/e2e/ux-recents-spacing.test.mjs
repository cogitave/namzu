// The Recents list is one compact list: a day heading is a 22 high band, 8 under the last row of the
// group above and 2 above its first row; a conversation row is 28 high with 1 between rows, in Recents
// and in a project's own list alike; the project label sits at the row's right and never takes the
// title's room. Measured in the real app with five days of conversations (today, yesterday, two dated
// days and Older), in both themes, at 1280 and 900 wide.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-recents-spacing.test.mjs
// NAMZU_E2E_SHOTS names a folder for the pictures and the numbers. NAMZU_E2E_DIST names another built
// dist/ to measure instead of this checkout's (the numbers are then written down and not asserted).
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createWorld, desktopRoot, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const RULES = [{ match: /chat/, steps: [{ text: "Noted." }] }];
const SHOTS = process.env.NAMZU_E2E_SHOTS;
const OTHER_DIST = process.env.NAMZU_E2E_DIST;
const DAY = 24 * 60 * 60 * 1000;
/** How many days back each conversation was last touched. */
const UI_MADE = 3;
/** The project that is open keeps three conversations; a second, folded project holds the rest, so Recents has seven. */
const OPEN_ROWS = 3;
const AGES = [0, 0, 0, 0, 1, 1, 3, 5, 5, 20];
const RECENTS = AGES.length - OPEN_ROWS;

function find(root, name) {
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		if (entry === "node_modules" || entry === "app") continue;
		if (entry === name) return path;
		if (statSync(path).isDirectory()) {
			const found = find(path, name);
			if (found) return found;
		}
	}
	return null;
}

/** Put another build's dist where the harness looks for its frozen copy. */
function useOtherDist(w) {
	const app = join(w.root, "app");
	mkdirSync(app, { recursive: true });
	cpSync(OTHER_DIST, join(app, "dist"), { recursive: true });
	cpSync(join(desktopRoot, "package.json"), join(app, "package.json"));
	symlinkSync(join(desktopRoot, "node_modules"), join(app, "node_modules"), "dir");
}

async function size(w, width) {
	await w.app.evaluate(({ BrowserWindow }, wide) => {
		for (const win of BrowserWindow.getAllWindows()) win.setSize(wide, 820);
	}, width);
	await expect.poll(() => w.page.evaluate((x) => Math.abs(window.innerWidth - x), width), { timeout: T }).toBeLessThanOrEqual(2);
	await w.page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
}

async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "dark") await expect(w.page.locator("html")).toHaveClass(/dark/);
	else await expect(w.page.locator("html")).not.toHaveClass(/dark/);
}

const MEASURE = () => {
	const rect = (el) => {
		const b = el.getBoundingClientRect();
		return { x: b.left, y: b.top, w: b.width, h: b.height, top: b.top, bottom: b.bottom, right: b.right };
	};
	const recents = document.querySelector(".sidebar-recents");
	const list = recents.querySelector(".sidebar-recent-list");
	const items = [...list.children].filter((el) => el.getBoundingClientRect().height > 0);
	const kinds = items.map((el) => {
		if (el.classList.contains("sidebar-day-heading")) return { kind: "day", text: el.textContent.trim(), ...rect(el) };
		const row = el.querySelector(".conversation-row");
		const title = el.querySelector(".conversation-row-title");
		const label = el.querySelector(".conversation-row-project");
		return {
			kind: "row",
			...rect(row ?? el),
			titleRight: title ? title.getBoundingClientRect().right : null,
			titleClipped: title ? title.scrollWidth > title.clientWidth : null,
			labelLeft: label ? label.getBoundingClientRect().left : null,
			labelRight: label ? label.getBoundingClientRect().right : null,
		};
	});
	const gaps = [];
	for (let i = 1; i < kinds.length; i++) gaps.push({ from: kinds[i - 1].kind, to: kinds[i].kind, gap: kinds[i].top - kinds[i - 1].bottom });
	const projectRows = [...document.querySelectorAll(".sidebar-project-list .conversation-row")].map(rect);
	const projectHeading = document.querySelector(".sidebar-project-heading");
	return {
		head: rect(recents.querySelector(".sidebar-recents-head")),
		items: kinds,
		gaps,
		projectRows,
		projectRowGaps: projectRows.slice(1).map((r, i) => r.top - projectRows[i].bottom),
		projectToFirst: projectRows.length && projectHeading ? projectRows[0].top - projectHeading.getBoundingClientRect().bottom : null,
	};
};

test("the Recents list is compact: day headings close to their rows, rows 28 high", { timeout: 400000 }, async () => {
	const w = await createWorld({ rules: RULES, env: { SHELL: "/bin/sh" } });
	let failed = true;
	try {
		if (OTHER_DIST) useOtherDist(w);
		await launch(w);
		await openProject(w);
		for (let i = 0; i < UI_MADE; i++) {
			if (i > 0) await w.page.getByRole("button", { name: "New conversation tab" }).click();
			await send(w, `chat number ${i + 1}`);
			await expect(w.page.getByText("Noted.", { exact: true }).first()).toBeVisible({ timeout: T });
			await expect(w.page.locator("li[data-thread-item]")).toHaveCount(i + 1, { timeout: T });
		}
		// A second project, added the way a person adds one, so the app knows it; its conversations are made below.
		const other = join(w.root, "other");
		mkdirSync(join(other, ".git"), { recursive: true });
		await w.app.evaluate((_e, path) => {
			globalThis.__e2eDialog.open = [path];
		}, other);
		await w.page.getByRole("button", { name: "Add new project", exact: true }).last().click();
		await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
		const consent = w.page.getByRole("dialog", { name: "Trust this folder?" });
		if (await consent.isVisible({ timeout: 5000 }).catch(() => false)) await consent.getByRole("button", { name: "Trust and open" }).click();
		await expect(w.page.locator("[data-project-group]").filter({ hasText: "other" })).toHaveCount(1, { timeout: T });
		await w.app.close();
		// Move each conversation to its own day, then start again: the list groups by the saved date.
		const file = find(w.root, "desktop-conversations.json");
		assert.ok(file, "the conversations are saved on disk");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		// Adding the project also opened an empty conversation in it; only the three that were talked in stay.
		const conversations = saved.conversations.filter((c) => /^chat number \d$/.test(c.view.title));
		assert.equal(conversations.length, UI_MADE, "every conversation was saved");
		saved.conversations = conversations.slice(0, OPEN_ROWS);
		const folded = saved.projects.find((p) => p.path === other);
		assert.ok(folded, "the second project is saved");
		while (saved.conversations.length < AGES.length) {
			const copy = structuredClone(conversations[0]);
			copy.view.id = randomUUID();
			copy.runtimeSessionId = randomUUID();
			copy.view.projectId = folded.id;
			copy.view.title = `chat number ${saved.conversations.length + 1}`;
			saved.conversations.push(copy);
		}
		const now = Date.now();
		saved.conversations.forEach((c, i) => {
			c.view.updatedAt = new Date(now - AGES[i] * DAY - i * 60000).toISOString();
		});
		writeFileSync(file, JSON.stringify(saved));
		await launch(w);
		// Fold the second project: its conversations are all Recents, each with its project's name.
		await w.page.getByRole("button", { name: "Collapse other conversations" }).click();
		await expect(w.page.locator(".sidebar-project-list li[data-thread-item]:visible")).toHaveCount(OPEN_ROWS, { timeout: T });
		const recents = w.page.locator(".sidebar-recents");
		await expect(recents.locator("li[data-thread-item]")).toHaveCount(RECENTS, { timeout: T });
		await expect(recents.locator(".sidebar-day-heading")).toHaveCount(5, { timeout: T });

		const all = {};
		for (const width of [1280, 900]) {
			await size(w, width);
			if (width < 768) await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
			for (const mode of ["light", "dark"]) {
				await theme(w, mode);
				const m = await w.page.evaluate(MEASURE);
				all[`${mode}-${width}`] = m;
				if (SHOTS) {
					mkdirSync(SHOTS, { recursive: true });
					await w.page.screenshot({ path: join(SHOTS, `recents-${mode}-${width}.png`) });
					await w.page.locator("aside.sidebar").screenshot({ path: join(SHOTS, `sidebar-${mode}-${width}.png`) });
				}
				if (OTHER_DIST) continue;
				const tag = `${mode} at ${width}`;
				const rows = m.items.filter((i) => i.kind === "row");
				const days = m.items.filter((i) => i.kind === "day");
				assert.ok(days.length === 5 && rows.length === RECENTS, `${tag}: five day groups and every row`);
				for (const d of days) assert.equal(d.h, 22, `${tag}: a day heading is 22 high`);
				for (const r of rows) assert.equal(r.h, 28, `${tag}: a conversation row is 28 high`);
				for (const g of m.gaps) {
					if (g.from === "row" && g.to === "row") assert.equal(g.gap, 1, `${tag}: rows are 1 apart`);
					if (g.from === "row" && g.to === "day") assert.equal(g.gap, 8, `${tag}: a heading is 8 under the group above`);
					if (g.from === "day" && g.to === "row") assert.equal(g.gap, 2, `${tag}: a heading is 2 above its first row`);
				}
				// The first heading sits right under the section title: the title's own 4 below it.
				assert.equal(days[0].top - m.head.bottom, 4, `${tag}: the first heading is 4 under the Recents title`);
				assert.equal(m.projectRows.length, OPEN_ROWS, `${tag}: the open project lists its conversations`);
				for (const r of m.projectRows) assert.equal(r.h, 28, `${tag}: a conversation row of a project is 28 high too`);
				for (const g of m.projectRowGaps) assert.equal(g, 1, `${tag}: a project's rows are 1 apart too`);
				assert.equal(m.projectToFirst, 1, `${tag}: a project's first row is 1 under the project row`);
				for (const r of rows) {
					assert.ok(r.labelLeft === null || r.titleRight <= r.labelLeft, `${tag}: the project label never overlaps the title`);
				}
			}
		}
		if (SHOTS) writeFileSync(join(SHOTS, "numbers.json"), JSON.stringify(all, null, 1));
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
