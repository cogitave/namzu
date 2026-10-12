// Expanding or collapsing a project in a sidebar that overflows must not move any row sideways and
// must not flicker the list's scrollbar: every row that stays visible keeps its x and width on every
// painted frame of the open/close animation, and the scroll container's clientWidth never changes.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/sidebar-expand-stability.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(process.env.SHOTS ?? join(tmpdir(), "sidebar-expand-stability"));
const TOLERANCE = 0.5;
const FRAMES = 60;
const TOGGLE = ".sidebar-project-toggle";
// The project that holds the four conversations (the others are empty folders).
const BUSY = '[data-project-group] .sidebar-project-toggle[aria-label$="project conversations"]';

/** Edges of the list's visible parts when nothing overflows, for before/after comparison. */
async function dumpIdle(w, file) {
	const edges = await w.page.evaluate(() => {
		const out = {};
		const pick = (name, selector) => {
			const el = document.querySelector(selector);
			if (!el) return;
			const b = el.getBoundingClientRect();
			out[name] = { left: b.left, right: b.right };
		};
		pick("scroller", ".sidebar-scroll");
		pick("section heading", ".sidebar-section-heading");
		pick("add project", ".sidebar-add-project");
		pick("project heading", ".sidebar-project-heading");
		pick("project more", ".sidebar-project-more");
		pick("recents title", ".sidebar-recents .sidebar-section-title");
		pick("recent row", ".sidebar-recent-list li");
		pick("archive toggle", ".sidebar-archive-toggle");
		pick("pals create", ".sidebar-pal-create");
		return out;
	});
	writeFileSync(file, JSON.stringify(edges, null, 1));
}
const CHATS = [{ match: /chat/, steps: [{ text: "Reply." }] }];

async function addProject(w, name) {
	const dir = join(w.root, name);
	mkdirSync(join(dir, ".git"), { recursive: true });
	await w.app.evaluate((_e, path) => {
		globalThis.__e2eDialog.open = [path];
	}, dir);
	const add = w.page.getByRole("button", { name: "Add new project", exact: true });
	await add.last().click();
	await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	const group = w.page.locator("[data-project-group]").filter({ hasText: name });
	await expect(group).toHaveCount(1, { timeout: T });
	// The row appears when main announces the project; the app opens it (aria-expanded) when the
	// answer to the pick arrives, a moment later and on a loaded machine a long one. Wait for that,
	// or a test that folds everything first is overtaken by the opening: under load the failing
	// panel was a project nobody had clicked, opened by the app after the fold had been checked.
	await expect(group.locator(TOGGLE)).toHaveAttribute("aria-expanded", "true", { timeout: T });
}

/**
 * Tags every visible row of the sidebar list, clicks the busy project's toggle in the page, and
 * samples the tagged rows (and the scroller) on FRAMES painted frames. A row that is not rendered on
 * a frame is skipped on it.
 */
function sample(w) {
	return w.page.evaluate(
		async ({ toggle, frames }) => {
			const scroller = document.querySelector(".sidebar-scroll");
			const rows = [
				...scroller.querySelectorAll(
					"li, .sidebar-project-heading, .sidebar-section-heading, .sidebar-section-title, .sidebar-pal-row",
				),
			].filter((el) => el.getClientRects().length > 0);
			const read = () => ({
				clientWidth: scroller.clientWidth,
				overflowing: scroller.scrollHeight > scroller.clientHeight,
				rows: rows.map((el) => {
					const b = el.getBoundingClientRect();
					return el.getClientRects().length ? { x: b.x, width: b.width, y: b.y } : null;
				}),
			});
			const out = [read()];
			const limit = document.querySelector(toggle).getBoundingClientRect().bottom;
			document.querySelector(toggle).click();
			for (let i = 0; i < frames; i++) {
				await new Promise((resolve) => requestAnimationFrame(resolve));
				out.push(read());
			}
			return { frames: out, limit };
		},
		{ toggle: BUSY, frames: FRAMES },
	);
}

function analyse(label, result) {
	const base = result.frames[0];
	let dx = 0;
	let dy = 0;
	let dw = 0;
	let widthChange = 0;
	const overflowStates = new Set();
	for (const frame of result.frames) {
		widthChange = Math.max(widthChange, Math.abs(frame.clientWidth - base.clientWidth));
		overflowStates.add(frame.overflowing);
		frame.rows.forEach((row, i) => {
			if (!row || !base.rows[i]) return;
			dx = Math.max(dx, Math.abs(row.x - base.rows[i].x));
			// Rows above the project that opens or closes keep their place too.
			if (base.rows[i].y < result.limit) dy = Math.max(dy, Math.abs(row.y - base.rows[i].y));
			dw = Math.max(dw, Math.abs(row.width - base.rows[i].width));
		});
	}
	const summary = {
		label,
		rows: base.rows.length,
		baseClientWidth: base.clientWidth,
		maxDx: dx,
		maxDyAbove: dy,
		maxDwidth: dw,
		clientWidthChange: widthChange,
		overflowStates: [...overflowStates],
	};
	console.log(JSON.stringify(summary));
	assert.ok(base.rows.length >= 8, `${label}: enough rows were tracked (${base.rows.length})`);
	assert.ok(dx <= TOLERANCE, `${label}: a row moved ${dx}px sideways`);
	assert.ok(dy <= TOLERANCE, `${label}: a row above the project moved ${dy}px vertically`);
	assert.ok(dw <= TOLERANCE, `${label}: a row changed width by ${dw}px`);
	assert.equal(widthChange, 0, `${label}: the scroll container's clientWidth changed`);
}

test("expanding and collapsing a project in an overflowing sidebar moves no row sideways", {
	timeout: 600000,
}, async () => {
	const w = await createWorld({ rules: CHATS });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		await send(w, "chat 0");
		await expect(w.page.getByText("Reply.", { exact: true }).first()).toBeVisible({ timeout: T });
		// Terminals are listed only under their own project's open panel, never in Recents, so opening
		// the panel adds rows to the list.
		for (let i = 1; i <= 5; i++) {
			await w.page.getByRole("button", { name: "New terminal tab" }).click();
			await expect(w.page.locator("[data-terminal-tab-id]")).toHaveCount(i, { timeout: T });
		}
		const expanded = w.page.locator(`${TOGGLE}[aria-expanded='true']`);
		const collapseAll = async () => {
			for (let guard = 0; guard < 40 && (await expanded.count()) > 0; guard++)
				await expanded.first().click();
			await expect(expanded).toHaveCount(0);
			await expect(w.page.locator(".sidebar-project-panel:visible")).toHaveCount(0);
		};
		await collapseAll();
		const spare = () =>
			w.page.evaluate(() => {
				const s = document.querySelector(".sidebar-scroll");
				const top = s.getBoundingClientRect().top;
				const content = Math.max(...[...s.children].map((c) => c.getBoundingClientRect().bottom));
				return Math.round(s.clientHeight - (content - top));
			});
		// Add empty projects until the collapsed list fills the sidebar to within two rows.
		for (let n = 0; (await spare()) >= 60; n++) {
			assert.ok(n < 30, "the sidebar fills up");
			await addProject(w, `folder${n}`);
			await collapseAll();
		}
		const room = await spare();
		assert.ok(room >= 0 && room < 60, `collapsed, the list fits with ${room}px to spare`);
		mkdirSync(SHOTS, { recursive: true });
		for (const appearance of ["dark", "light"]) {
			await w.page.evaluate((next) => {
				localStorage.setItem("namzu.appearance", next);
				window.dispatchEvent(
					new StorageEvent("storage", { key: "namzu.appearance", newValue: next }),
				);
			}, appearance);
			await expect(w.page.locator("html")).toHaveClass(
				appearance === "dark" ? /dark/ : /^(?!.*dark)/,
			);
			await w.page.screenshot({ path: join(SHOTS, `1-collapsed-${appearance}.png`) });
			if (process.env.GEOMETRY) await dumpIdle(w, `${process.env.GEOMETRY}-${appearance}.json`);
			analyse(`expand ${appearance}`, await sample(w));
			await w.page.screenshot({ path: join(SHOTS, `2-expanded-${appearance}.png`) });
			const overflowing = await w.page.evaluate(() => {
				const s = document.querySelector(".sidebar-scroll");
				return s.scrollHeight > s.clientHeight;
			});
			assert.ok(overflowing, `${appearance}: expanded, the list overflows`);
			analyse(`collapse ${appearance}`, await sample(w));
		}
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

test("a project that opened by itself folds on the very next click, however fast the click comes", {
	timeout: 600000,
}, async () => {
	const w = await createWorld({ rules: CHATS });
	let failed = true;
	try {
		await launch(w);
		await openProject(w);
		for (let n = 0; n < 6; n++) {
			const name = `quick${n}`;
			const dir = join(w.root, name);
			mkdirSync(join(dir, ".git"), { recursive: true });
			await w.app.evaluate((_e, path) => {
				globalThis.__e2eDialog.open = [path];
			}, dir);
			await w.page.getByRole("button", { name: "Add new project", exact: true }).last().click();
			await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
			const toggle = w.page
				.locator("[data-project-group]")
				.filter({ hasText: name })
				.locator(TOGGLE);
			// The project opens by itself a moment after its row appears. Fold it the instant it reports
			// open, then open and fold it again without waiting for any animation to end.
			await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: T });
			await toggle.click();
			await toggle.click();
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "false", { timeout: T });
			const panel = w.page
				.locator("[data-project-group]")
				.filter({ hasText: name })
				.locator(".sidebar-project-panel");
			await expect(panel).toHaveCount(0);
		}
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
