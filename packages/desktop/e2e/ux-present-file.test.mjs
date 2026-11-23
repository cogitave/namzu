// A file the agent hands over with present_file shows as a card in the conversation: its name, its
// kind and size, the caption the agent gave, and Show in folder / Save a copy / Open beside the
// conversation. The file lives in a scratch folder outside the project, which is the case the tool
// is for. Real Electron, real CLI host, scripted model.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-present-file.test.mjs
// Pictures: PRESENT_SHOTS=<dir> (default research/present-file).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 90000;
const SHOTS = process.env.PRESENT_SHOTS ?? resolve(repoRoot, "research/present-file");
mkdirSync(SHOTS, { recursive: true });
const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}.png`) });

test("a file handed over from a scratch folder shows as a card with its actions", { timeout: 280000 }, async () => {
	let world;
	const scratch = (name) => join(world.root, "scratch", name);
	world = await createWorld({
		answerHistory: true,
		tabs: "hidden",
		seed: (w) => {
			mkdirSync(join(w.root, "scratch"), { recursive: true });
			writeFileSync(join(w.root, "scratch", "quarterly-report.md"), `# Quarterly report\n\n${"Revenue grew. ".repeat(200)}\n`);
			writeFileSync(join(w.root, "scratch", "numbers.csv"), "month,total\njan,10\nfeb,12\n");
			writeFileSync(join(w.project, "notes.md"), "# Notes\n\nRevenue grew in every region.\n");
		},
		rules: [
			{
				match: /hand me the files/i,
				steps: [
					{ tool: "search_tools", args: { query: "present_file" } },
					{
						tool: "present_file",
						args: () => ({
							paths: [scratch("quarterly-report.md"), scratch("numbers.csv")],
							caption: "The report and the numbers behind it",
						}),
					},
					{ text: "Both files are ready for you." },
				],
			},
			{
				match: /hand me the notes/i,
				steps: [
					{ tool: "search_tools", args: { query: "select:present_file" } },
					{ tool: "present_file", args: { paths: ["notes.md"] } },
					{ text: "The notes are in your folder." },
				],
			},
			{
				match: /hand me a folder/i,
				steps: [
					{ tool: "search_tools", args: { query: "present_file hand over" } },
					{ tool: "present_file", args: () => ({ paths: [join(world.root, "scratch")] }) },
					{ text: "That was a folder, so nothing was shared." },
				],
			},
		],
	});
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.setSize(1280, 820)));
		await w.app.evaluate(({ shell }) => {
			globalThis.__opened = [];
			shell.openPath = async (path) => {
				globalThis.__opened.push(["open", path]);
				return "";
			};
			shell.showItemInFolder = (path) => globalThis.__opened.push(["folder", path]);
		});
		await send(w, "hand me the files");
		await expect(w.page.getByText("Both files are ready for you.")).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		const cards = w.page.locator("[data-output-card]");
		await expect(cards).toHaveCount(2, { timeout: T });
		await expect(cards.nth(0)).toContainText("quarterly-report.md");
		await expect(cards.nth(0)).toContainText("Shared");
		await expect(cards.nth(1)).toContainText("numbers.csv");
		await expect(w.page.getByText("The report and the numbers behind it").first()).toBeVisible();
		await expect(cards.nth(0).getByRole("button", { name: "Show quarterly-report.md in its folder" })).toBeVisible();
		await expect(cards.nth(0).getByRole("button", { name: "Save a copy of quarterly-report.md" })).toBeVisible();
		// Show in folder and Open go through the host, for the file outside the project.
		await cards.nth(0).hover();
		await w.page.waitForTimeout(600);
		await cards.nth(0).getByRole("button", { name: "Show quarterly-report.md in its folder" }).click();
		await cards.nth(0).getByRole("button", { name: "Open quarterly-report.md with the app for this kind of file" }).click();
		await expect.poll(() => w.app.evaluate(() => globalThis.__opened.length), { timeout: T }).toBe(2);
		const opened = await w.app.evaluate(() => globalThis.__opened);
		assert.deepEqual(opened.map((entry) => entry[0]).sort(), ["folder", "open"]);
		for (const entry of opened) assert.match(entry[1], /scratch[\\/]quarterly-report\.md$/);
		await cards.nth(0).hover();
		// Only the picture waits for the fade of the finished turn's status row; no assertion depends on it.
		await w.page.waitForTimeout(1500);
		await shot(w, "cards-wide-hover");
		// A file inside the project opens beside the conversation.
		await send(w, "hand me the notes");
		await expect(w.page.getByText("The notes are in your folder.")).toBeVisible({ timeout: T });
		await expect(cards).toHaveCount(3, { timeout: T });
		await cards.nth(2).locator(".output-card-main").click();
		await expect(w.page.getByText("Revenue grew in every region.").first()).toBeVisible({ timeout: T });
		// The pane slides in and the column narrows; the picture waits for both to settle.
		await w.page.waitForTimeout(1500);
		const column = await w.page.evaluate(() => {
			const main = document.querySelector("main")?.getBoundingClientRect();
			const bubble = [...document.querySelectorAll("main *")].filter((el) => el.textContent === "hand me the notes").pop()?.getBoundingClientRect();
			const pane = document.querySelector('[aria-label="Files"]')?.getBoundingClientRect();
			return { mainRight: main?.right, bubbleRight: bubble?.right, paneLeft: pane?.left };
		});
		console.log("column", JSON.stringify(column));
		await shot(w, "cards-open");
		// A folder is refused: no card, and the row says so.
		await send(w, "hand me a folder");
		await expect(w.page.getByText("That was a folder, so nothing was shared.")).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		await expect(cards).toHaveCount(3);
		// Layout audit: no card is wider than the column, none overlaps the next, no page scroll.
		const audit = await w.page.evaluate(() => {
			const rows = [...document.querySelectorAll("[data-output-card]")].map((el) => el.getBoundingClientRect());
			const group = document.querySelector("[data-output-group]")?.getBoundingClientRect();
			const overlap = rows.some((a, i) => rows.some((b, j) => j > i && a.bottom > b.top + 1 && a.top < b.bottom - 1));
			const overflow = rows.some((r) => group && (r.left < group.left - 1 || r.right > group.right + 1));
			return { overlap, overflow, pageScroll: document.documentElement.scrollWidth > window.innerWidth, groupWidth: group?.width };
		});
		assert.equal(audit.overlap, false);
		assert.equal(audit.overflow, false);
		assert.equal(audit.pageScroll, false);
		// Narrow window, with the Files pane closed so the column is judged on its own.
		await w.page.getByRole("button", { name: "Close Files" }).click();
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.setSize(720, 820)));
		await expect(cards.first()).toBeVisible();
		const narrow = await w.page.evaluate(() => ({
			pageScroll: document.documentElement.scrollWidth > window.innerWidth,
			cardOver: [...document.querySelectorAll("[data-output-card]")].some((el) => el.getBoundingClientRect().right > window.innerWidth + 1),
		}));
		assert.equal(narrow.pageScroll, false);
		assert.equal(narrow.cardOver, false);
		await cards.first().scrollIntoViewIfNeeded();
		await cards.first().hover();
		// The state word fades out as the actions fade in; the picture waits for the steady state.
		await w.page.waitForTimeout(600);
		await shot(w, "cards-narrow");
		assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
