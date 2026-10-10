// Layout geometry against the real Electron app, the real CLI host and a scripted model: a
// conversation's notice takes its own row instead of covering the transcript, and split panes never
// push the page sideways past the window.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-layout-geometry.test.mjs
// Pictures go to research/ux-20261010/layout-geometry/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWorld, dispose, enableTerminalDebug, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/ux-20261010/layout-geometry");

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld({ ...options, env: { SHELL: "/bin/sh", ...(options.env ?? {}) } });
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

const box = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });
async function resize(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, size) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(size.width, size.height);
		},
		{ width, height },
	);
	await expect.poll(() => w.page.evaluate(() => window.innerWidth), { timeout: T }).toBe(width);
}
async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "light") await expect(w.page.locator("html")).not.toHaveClass(/dark/);
	else await expect(w.page.locator("html")).toHaveClass(/dark/);
}
/** Dark and light, at 1280 and 900 px. */
async function shots(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	for (const [width, height] of [
		[1280, 820],
		[900, 720],
	]) {
		await resize(w, width, height);
		for (const mode of ["dark", "light"]) {
			await theme(w, mode);
			await settled(w);
			await w.page.screenshot({ path: join(SHOTS, `${name}-${width}-${mode}.png`) });
		}
	}
	await theme(w, "dark");
	await resize(w, 1280, 820);
}
const intersects = (a, b) =>
	a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

flow(
	"a notice above a conversation takes its own row and never covers the transcript",
	{ rules: [{ match: /hello/i, steps: [{ text: "Scripted hello back." }] }] },
	async (w) => {
		await openProject(w);
		await expect(box(w)).toBeVisible({ timeout: T });
		await box(w).fill("hello there");
		await w.page.getByRole("button", { name: "Send message" }).click();
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({ timeout: T });
		// A folder that does not exist: the notice appears above this conversation.
		await w.app.evaluate((_e, folder) => {
			globalThis.__e2eDialog.open = [folder];
		}, join(w.root, "no-such-folder"));
		await w.page.getByRole("button", { name: "Add new project", exact: true }).last().click();
		await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
		const banner = w.page.locator(".connection-error > *").first();
		await expect(banner).toBeVisible({ timeout: T });
		await expect(banner).toContainText("That folder no longer exists");
		const measure = async (label) => {
			await settled(w);
			// One read, so the rectangles are of the same layout.
			const { notice, stage, strip, first } = await w.page.evaluate(() => {
				const rect = (element) => {
					const box = element?.getBoundingClientRect();
					return box && { x: box.x, y: box.y, width: box.width, height: box.height };
				};
				const reply = [...document.querySelectorAll(".chat-stage *")].find(
					(node) => !node.children.length && node.textContent?.trim() === "Scripted hello back.",
				);
				return {
					notice: rect(document.querySelector(".connection-error > *")),
					stage: rect(document.querySelector(".chat-stage")),
					strip: rect(document.querySelector(".topbar")),
					first: rect(reply),
				};
			});
			assert.ok(notice && stage && strip && first, `${label}: the notice, the page, the tab strip and the reply are drawn`);
			assert.ok(!intersects(notice, stage), `${label}: the notice (${notice.y}+${notice.height}) does not overlap the conversation (top ${stage.y})`);
			assert.ok(notice.y >= strip.y + strip.height - 1, `${label}: the notice is below the tab strip`);
			assert.ok(!intersects(notice, first), `${label}: the notice does not overlap the first reply`);
			// Neither the date line at the top of the transcript, nor anything else in it.
			const covered = await w.page.evaluate((rect) => {
				const hits = [];
				for (const node of document.querySelectorAll(".chat-stage *")) {
					if (node.children.length || !node.textContent?.trim()) continue;
					const r = node.getBoundingClientRect();
					if (r.width && r.left < rect.x + rect.width && rect.x < r.right && r.top < rect.y + rect.height && rect.y < r.bottom)
						hits.push(node.textContent.trim());
				}
				return hits;
			}, notice);
			assert.deepEqual(covered, [], `${label}: no transcript text sits under the notice`);
		};
		for (const width of [1280, 960, 900, 760]) {
			await resize(w, width, 720);
			await measure(`${width}px`);
		}
		await shots(w, "notice");
		// Closing it hands its row back: the conversation starts where the tab strip ends.
		await w.page.getByRole("button", { name: "Dismiss error" }).click();
		await expect(w.page.locator(".connection-error")).toHaveCount(0, { timeout: T });
		const strip = await w.page.locator(".topbar").first().boundingBox();
		const stage = await w.page.locator(".chat-stage").first().boundingBox();
		assert.ok(strip && stage && Math.abs(stage.y - (strip.y + strip.height)) <= 1, "the conversation starts under the tab strip once the notice is gone");
	},
);

const pane = (w) => w.page.locator("section.terminal-pane");

async function openSplit(w) {
	await expect(box(w)).toBeVisible({ timeout: T });
	await w.page.getByRole("button", { name: "New conversation tab" }).click({ button: "right" });
	const menu = w.page.getByRole("menu", { name: "New tab" });
	await expect(menu).toBeVisible();
	await menu.getByRole("menuitem", { name: "New terminal to the right" }).click();
	await expect(pane(w)).toBeVisible({ timeout: T });
	await expect(w.page.locator(".workspace-canvas-pane")).toHaveCount(2, { timeout: T });
}
async function sidebar(w, open) {
	// Below 768 px the sidebar is a drawer that the toggle opens over the page.
	const wide = await w.page.evaluate(() => window.innerWidth >= 768);
	if (!wide) return;
	await w.page.evaluate((collapsed) => {
		localStorage.setItem("namzu.sidebar-collapsed", String(collapsed));
		window.dispatchEvent(
			new StorageEvent("storage", { key: "namzu.sidebar-collapsed", newValue: String(collapsed) }),
		);
	}, !open);
	await expect(w.page.locator(".workspace-host")).toHaveAttribute(
		"data-sidebar-collapsed",
		String(!open),
		{ timeout: T },
	);
}
/** The canvas has stopped moving: the sidebar's slide and the panes' re-measure are done. */
const settled = (w) =>
	expect
		.poll(
			() =>
				w.page.evaluate(async () => {
					const read = () => {
						const canvas = document.querySelector(".workspace-canvas");
						const box = (canvas ?? document.querySelector(".workspace"))?.getBoundingClientRect();
						return `${box?.x}|${box?.width}|${[...document.querySelectorAll(".workspace-canvas-pane")]
							.map((pane) => pane.getBoundingClientRect().width)
							.join(",")}`;
					};
					const before = read();
					await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
					return before === read();
				}),
			{ timeout: T },
		)
		.toBe(true);
/** No sideways scrollbar, and every pane inside the window. */
async function assertContained(w, label) {
	await settled(w);
	await expect
		.poll(
			() =>
				w.page.evaluate(() => {
					const canvas = document.querySelector(".workspace-canvas");
					return {
						canvasOver: canvas ? canvas.scrollWidth - canvas.clientWidth : 0,
						pageOver: document.documentElement.scrollWidth - window.innerWidth,
						bodyOver: document.body.scrollWidth - window.innerWidth,
					};
				}),
			{ timeout: T, message: `${label}: no horizontal overflow` },
		)
		.toEqual({ canvasOver: 0, pageOver: 0, bodyOver: 0 });
	const { panes, width } = await w.page.evaluate(() => ({
		width: window.innerWidth,
		panes: [...document.querySelectorAll(".workspace-canvas-pane")].map((el) => {
			const rect = el.getBoundingClientRect();
			return { left: rect.left, right: rect.right };
		}),
	}));
	assert.equal(panes.length, 2, `${label}: both panes are drawn`);
	for (const item of panes)
		assert.ok(item.left >= -0.5 && item.right <= width + 0.5, `${label}: a pane (${item.left} to ${item.right}) is inside the ${width}px window`);
	const [first, second] = await w.page.locator(".workspace-canvas-pane").evaluateAll((all) =>
		all.map((el) => {
			const rect = el.getBoundingClientRect();
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		}),
	);
	assert.ok(!intersects(first, second), `${label}: the panes do not overlap`);
}

flow("split panes share the width, or stack, and never push the window sideways", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await resize(w, 1280, 820);
	await sidebar(w, false);
	await openSplit(w);
	await assertContained(w, "1280 split");
	for (const width of [960, 760]) {
		await resize(w, width, 700);
		for (const open of width < 768 ? [false] : [true, false]) {
			await sidebar(w, open);
			await assertContained(w, `${width}px, sidebar ${open ? "open" : "closed"}`);
			mkdirSync(SHOTS, { recursive: true });
			await w.page.screenshot({ path: join(SHOTS, `split-${width}-sidebar-${open ? "open" : "closed"}-dark.png`) });
		}
	}
	// Below 768 px the sidebar is a drawer over the page; opening it moves nothing underneath.
	await resize(w, 760, 700);
	await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
	await expect(w.page.locator("#namzu-sidebar.open")).toBeVisible({ timeout: T });
	await assertContained(w, "760px, drawer open");
	await w.page.screenshot({ path: join(SHOTS, "split-760-drawer-open-dark.png") });
	// Widening the window puts them side by side again.
	await resize(w, 1280, 820);
	await sidebar(w, false);
	await assertContained(w, "1280 again");
	const [a, b] = await w.page.locator(".workspace-canvas-pane").evaluateAll((all) => all.map((el) => el.getBoundingClientRect().y));
	assert.ok(Math.abs(a - b) < 1, "side by side again at 1280");
	await shots(w, "split");
});

flow("a split made in a narrow window stacks instead of overflowing", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await resize(w, 760, 700);
	await openSplit(w);
	await assertContained(w, "760 split made narrow");
	await resize(w, 960, 700);
	await sidebar(w, true);
	await assertContained(w, "960 sidebar open");
});

flow("a further split in stacked panes opens when the pane has room, and says so when it has not", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await resize(w, 1280, 1500);
	await openSplit(w);
	// Narrower, the two panes stack; each is tall enough for another below it.
	await resize(w, 960, 1500);
	await settled(w);
	await w.page.getByRole("button", { name: "New conversation tab" }).first().click({ button: "right" });
	await w.page.getByRole("menu", { name: "New tab" }).getByRole("menuitem", { name: "New terminal below" }).click();
	await expect(w.page.locator(".workspace-canvas-pane")).toHaveCount(3, { timeout: T });
	await expect(w.page.locator(".workspace-window-error")).toHaveCount(0);
	// A short window has no room for a fourth: it says so, in words about size.
	await resize(w, 760, 700);
	await w.page.getByRole("button", { name: "New conversation tab" }).first().click({ button: "right" });
	await w.page.getByRole("menu", { name: "New tab" }).getByRole("menuitem", { name: "New terminal to the right" }).click();
	await expect(w.page.locator(".workspace-window-error")).toContainText("too small to split", { timeout: T });
	await expect(w.page.locator(".workspace-canvas-pane")).toHaveCount(3);
	// The notice is a row of its own above the panes: it covers no tab strip and no button, offers
	// no retry for a size refusal, and gives its row back when dismissed.
	const alert = w.page.locator(".workspace-window-error");
	await settled(w);
	const { notice, canvas, plus } = await w.page.evaluate(() => {
		const rect = (element) => {
			const box = element.getBoundingClientRect();
			return { x: box.x, y: box.y, width: box.width, height: box.height };
		};
		return {
			notice: rect(document.querySelector(".workspace-window-error")),
			canvas: rect(document.querySelector(".workspace-canvas")),
			plus: [...document.querySelectorAll('button[aria-label="New conversation tab"]')].map(rect),
		};
	});
	// Every tab strip is inside the canvas, so a notice that shares no pixel with it covers none.
	assert.ok(!intersects(notice, canvas), "the notice shares no pixel with the panes and their tab strips");
	assert.ok(plus.length > 0 && plus.every((item) => !intersects(item, notice)), "the + button is not under the notice");
	await expect(alert.getByRole("button", { name: "Try again" })).toHaveCount(0);
	await w.page.screenshot({ path: join(SHOTS, "window-notice-760-dark.png") });
	const before = await w.page.locator(".workspace-canvas").boundingBox();
	await alert.getByRole("button", { name: "Dismiss error" }).click();
	await expect(alert).toHaveCount(0, { timeout: T });
	await settled(w);
	const after = await w.page.locator(".workspace-canvas").boundingBox();
	assert.ok(before && after && after.y < before.y && Math.abs(after.y + after.height - (before.y + before.height)) <= 1, "the canvas takes the notice's row back");
	await expect(w.page.getByRole("button", { name: "New conversation tab" }).first()).toBeEnabled();
});

flow("a notice on the computer page takes its own row and covers nothing", {}, async (w) => {
	await openProject(w);
	await expect(box(w)).toBeVisible({ timeout: T });
	await expect(async () => {
		await w.page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(w.page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 60000 });
	await expect(async () => {
		if (!(await w.page.getByRole("dialog", { name: "Customize your Pal" }).isVisible()))
			await w.page.getByRole("button", { name: "Customize your Pal" }).click({ timeout: 2000 });
		await expect(w.page.getByRole("dialog", { name: "Customize your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 60000 });
	const customize = w.page.getByRole("dialog", { name: "Customize your Pal" });
	await customize.getByRole("textbox", { name: "Pal name" }).fill("Isik");
	await customize.getByRole("textbox", { name: "Pal name" }).press("Enter");
	await expect(w.page.getByRole("tab", { name: "Isik" })).toBeVisible({ timeout: T });
	// A folder that does not exist raises the notice; then the computer page opens under it.
	await w.app.evaluate((_e, folder) => {
		globalThis.__e2eDialog.open = [folder];
	}, join(w.root, "no-such-folder"));
	await w.page.getByRole("button", { name: "Add new project", exact: true }).last().click();
	await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	await expect(w.page.locator(".connection-error > *").first()).toContainText("That folder no longer exists", { timeout: T });
	await w.page.getByRole("button", { name: /Open Isik’s computer/ }).click();
	await expect(w.page.locator(".workspace[data-page=computer]")).toBeVisible({ timeout: T });
	const measure = async (label) => {
		await settled(w);
		const { notice, view, header } = await w.page.evaluate(() => {
			const rect = (element) => {
				const box = element?.getBoundingClientRect();
				return box && { x: box.x, y: box.y, width: box.width, height: box.height };
			};
			return {
				notice: rect(document.querySelector(".workspace[data-page=computer] > .connection-error > *")),
				view: rect(document.querySelector(".workspace[data-page=computer] > .pal-computer-view")),
				header: rect(document.querySelector(".workspace[data-page=computer] > .workspace-conversation-header, .workspace[data-page=computer] > .topbar")),
			};
		});
		assert.ok(notice && view, `${label}: the notice and the computer page are drawn`);
		assert.ok(!intersects(notice, view), `${label}: the notice (${notice.y}+${notice.height}) does not overlap the computer page (top ${view.y})`);
		if (header) assert.ok(!intersects(notice, header), `${label}: the notice does not cover the header`);
	};
	for (const width of [1280, 960, 900, 760]) {
		await resize(w, width, 720);
		await measure(`${width}px`);
	}
	await shots(w, "computer-notice");
	const top = (await w.page.locator(".pal-computer-view").boundingBox())?.y ?? 0;
	await w.page.locator(".connection-error").getByRole("button", { name: "Dismiss error" }).click();
	await expect(w.page.locator(".connection-error")).toHaveCount(0, { timeout: T });
	await settled(w);
	const back = (await w.page.locator(".pal-computer-view").boundingBox())?.y ?? 0;
	assert.ok(back < top, "the computer page takes the notice's row back when it closes");
});

/**
 * What of a pane's body is drawn over a tab strip: every visible element of every pane that is not
 * part of a strip, clipped by the boxes that clip it (the pane, the scrolling canvas), against every
 * strip. Returns the first few offenders by name.
 */
async function bodyOverStrips(w) {
	return w.page.evaluate(() => {
		const strips = [...document.querySelectorAll(".workspace-canvas-pane .topbar, .workspace-canvas-pane .conversation-tabs")];
		const stripRects = strips.map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height);
		const clipped = (el) => {
			let r = el.getBoundingClientRect();
			for (let up = el.parentElement; up && r.width > 0 && r.height > 0; up = up.parentElement) {
				const s = getComputedStyle(up);
				if (s.overflowX === "visible" && s.overflowY === "visible") continue;
				const c = up.getBoundingClientRect();
				const left = Math.max(r.left, c.left);
				const top = Math.max(r.top, c.top);
				const right = Math.min(r.right, c.right);
				const bottom = Math.min(r.bottom, c.bottom);
				r = { left, top, right, bottom, width: right - left, height: bottom - top };
			}
			return r;
		};
		const hits = [];
		for (const pane of document.querySelectorAll(".workspace-canvas-pane")) {
			for (const el of pane.querySelectorAll("*")) {
				if (strips.some((strip) => strip.contains(el) || el.contains(strip))) continue;
				const style = getComputedStyle(el);
				if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
				if (el.closest("[hidden], [aria-hidden=true], .sr-only")) continue;
				const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
				const painted = own || ["INPUT", "TEXTAREA", "BUTTON", "SVG", "H1", "CANVAS"].includes(el.tagName.toUpperCase());
				if (!painted) continue;
				const r = clipped(el);
				if (r.width <= 0.5 || r.height <= 0.5) continue;
				for (const s of stripRects)
					if (r.left < s.right - 0.5 && s.left < r.right - 0.5 && r.top < s.bottom - 0.5 && s.top < r.bottom - 0.5)
						hits.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(r.top)}-${Math.round(r.bottom)} over a strip ${Math.round(s.top)}-${Math.round(s.bottom)}`);
			}
		}
		return hits.slice(0, 5);
	});
}

flow("a pane's body never draws over a tab strip, at one, two and three stacked panes, short or tall", {}, async (w) => {
	await openProject(w);
	await enableTerminalDebug(w);
	await sidebar(w, false);
	const check = async (panes, height) => {
		await resize(w, 760, height);
		await settled(w);
		await expect(w.page.locator(".workspace-canvas-pane")).toHaveCount(panes, { timeout: T });
		await expect
			.poll(() => bodyOverStrips(w), { timeout: T, message: `${panes} pane(s) at ${height}px: nothing in a pane is drawn over a tab strip` })
			.toEqual([]);
		// The welcome heading is either not drawn or drawn whole: never cut off at the pane's top.
		const heading = await w.page.evaluate(() => {
			const h = document.querySelector("[data-composer-heading]");
			if (!h || getComputedStyle(h).visibility === "hidden") return { drawn: false };
			const r = h.getBoundingClientRect();
			const body = h.closest(".composer-wrap")?.getBoundingClientRect();
			return { drawn: true, cutOff: !body || r.top < body.top - 0.5 || r.bottom > body.bottom + 0.5 };
		});
		assert.ok(!heading.drawn || !heading.cutOff, `${panes} pane(s) at ${height}px: the welcome heading is not cut off`);
		mkdirSync(SHOTS, { recursive: true });
		await w.page.screenshot({ path: join(SHOTS, `stacked-${panes}-${height}-dark.png`) });
	};
	for (const height of [700, 900]) await check(1, height);
	await resize(w, 960, 1500);
	await openSplit(w);
	for (const height of [700, 900]) await check(2, height);
	await resize(w, 960, 1500);
	await settled(w);
	await w.page.getByRole("button", { name: "New conversation tab" }).first().click({ button: "right" });
	await w.page.getByRole("menu", { name: "New tab" }).getByRole("menuitem", { name: "New terminal below" }).click();
	await expect(w.page.locator(".workspace-canvas-pane")).toHaveCount(3, { timeout: T });
	for (const height of [700, 900]) await check(3, height);
	// The big heading is dropped, not squeezed, where the pane has no room for it.
	await resize(w, 760, 700);
	await settled(w);
	await expect(w.page.locator("[data-chat-composer-overlay]")).toHaveAttribute("data-heading-fits", "false", { timeout: T });
	await resize(w, 760, 1500);
	await settled(w);
	await expect(w.page.locator("[data-chat-composer-overlay]")).toHaveAttribute("data-heading-fits", "true", { timeout: T });
});
