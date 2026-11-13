// The conversation screen's composer, in the real app: the box holds the text, the "+", and Send once there is something to send; the
// settings of the conversation (project on the home screen, permission mode, model, context) sit in one
// quiet row under the box, outside it, as wide as it; the context leaves the top bar; an approval is one
// card directly above the box. Real Electron, real CLI host, scripted model. No paid model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-composer-row.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
const shot = async (w, name) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const size = (w, width, height) =>
	w.app.evaluate(
		({ BrowserWindow }, [x, y]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(x, y);
		},
		[width, height],
	);
const rect = (locator) => locator.evaluate((el) => {
	const r = el.getBoundingClientRect();
	return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
});
/** The popup is wholly inside the window, whatever the window size is. */
const insideWindow = async (w, locator, label) => {
	const box = await rect(locator);
	const win = await w.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	assert.ok(box.left >= 0 && box.top >= 0, `${label}: starts inside the window (${box.left}, ${box.top})`);
	assert.ok(box.right <= win.width + 0.5 && box.bottom <= win.height + 0.5, `${label}: ends inside the window`);
};
const THIRTEEN = Array.from({ length: 14 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n");

async function inWorld(options, body) {
	const world = await createWorld({ tabs: "hidden", ...options });
	let failed = true;
	try {
		if (options.longProject) {
			const named = join(dirname(world.project), options.longProject);
			renameSync(world.project, named);
			world.project = named;
		}
		await launch(world);
		await openProject(world);
		await body(world);
		assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
}

test("the box holds the text, the plus, and Send once there is something to send; the settings are one quiet row under it, and their popups open inside the window", { timeout: 280000 }, async () => {
	await inWorld({ models: ["gpt-e2e-1", "gpt-e2e-0"] }, async (w) => {
		const page = w.page;
		const box = page.locator("[data-chat-composer-main-surface]");
		const row = page.locator("[data-composer-row]");
		await expect(row).toBeVisible({ timeout: T });

		// The box: corners of 14px, and only the text and the plus inside it: Send comes with something to send.
		assert.equal(await page.locator('[data-slot="composer-host"]').evaluate((el) => getComputedStyle(el).borderTopLeftRadius), "14px");
		await expect(box.getByRole("textbox", { name: "Message Namzu" })).toBeVisible();
		const inside = await box.getByRole("button").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
		assert.deepEqual(inside, ["Attachments and message settings"]);
		await expect(box.getByRole("button", { name: /^Permissions:/ })).toHaveCount(0);
		await expect(box.getByRole("button", { name: /^Model:/ })).toHaveCount(0);
		await expect(box.getByText("This computer")).toHaveCount(0);

		// The row: under the box, outside it, as wide as it, 8px below.
		const b = await rect(box);
		const r = await rect(row);
		assert.ok(Math.abs(r.left - b.left) <= 1.5 && Math.abs(r.width - b.width) <= 2, `the row is as wide as the box (${r.left}/${r.width} against ${b.left}/${b.width})`);
		assert.ok(Math.abs(r.top - b.bottom - 8) <= 1, `the row is 8px under the box (${r.top - b.bottom})`);

		// On the home screen the project and the computer are the row's first words, then the mode, then the model.
		const project = row.locator(".composer-project-control");
		const permission = row.getByRole("button", { name: /^Permissions:/ });
		const model = row.getByRole("button", { name: /^Model:/ });
		await expect(project).toContainText("This computer");
		const [p, m, d] = [await rect(project), await rect(permission), await rect(model)];
		assert.ok(p.right <= m.left + 1 && m.right <= d.left + 1, "project, then mode, then model, left to right");
		assert.ok(d.right <= r.right + 0.5 && r.right - d.right < 24, "the model is at the right end of the row");

		// Quiet: 13px words, 28px tall, no fill and no border at rest; the soft fill comes with the pointer.
		for (const button of [project, permission, model]) {
			const look = await button.evaluate((el) => {
				const css = getComputedStyle(el);
				return { size: css.fontSize, height: el.getBoundingClientRect().height, fill: css.backgroundColor, ring: css.borderTopColor };
			});
			assert.equal(look.size, "13px");
			assert.equal(look.height, 28);
			assert.equal(look.fill, "rgba(0, 0, 0, 0)", "no fill at rest");
			assert.equal(look.ring, "rgba(0, 0, 0, 0)", "no border at rest");
		}
		// The project shares the row with the mode: the mode does not move when the pointer reaches the project.
		const modeLeft = (await rect(permission)).left;
		await project.hover();
		await expect.poll(() => project.locator("[data-composer-control-chevron]").evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: T }).toBeGreaterThan(0.5);
		assert.equal((await rect(permission)).left, modeLeft, "the mode does not shift when the project is hovered");
		await permission.hover();
		await expect.poll(() => permission.evaluate((el) => getComputedStyle(el).backgroundColor), { timeout: T }).not.toBe("rgba(0, 0, 0, 0)");
		await page.mouse.move(5, 5);
		await shot(w, "row-home");

		// The project menu, the permission menu and the model popup open from the row and stay inside the window.
		await project.click();
		const places = page.getByRole("group", { name: "Runs on" });
		await expect(places).toBeVisible({ timeout: T });
		await insideWindow(w, page.locator(".composer-project-popup"), "project menu");
		await page.keyboard.press("Escape");
		await expect(places).toHaveCount(0);

		await permission.click();
		const modes = page.getByRole("menu", { name: /check with you/ });
		await expect(modes).toBeVisible({ timeout: T });
		await expect(modes.getByRole("menuitemradio", { name: /^Ask first/ })).toHaveAttribute("aria-checked", "true");
		await insideWindow(w, page.locator(".composer-permission-menu"), "permission menu");
		await shot(w, "row-permission-menu");
		await page.keyboard.press("Escape");
		await expect(modes).toHaveCount(0);

		await model.click();
		const popup = page.locator(".model-picker-popup");
		await expect(popup.getByRole("radio", { name: /gpt-e2e-1/ })).toBeVisible({ timeout: T });
		await insideWindow(w, popup, "model popup");
		await shot(w, "row-model-popup");
		await page.keyboard.press("Escape");
		await expect(popup).toHaveCount(0, { timeout: T });
		// The same menus in a small window.
		await size(w, 960, 700);
		await permission.click();
		await expect(modes).toBeVisible({ timeout: T });
		await insideWindow(w, page.locator(".composer-permission-menu"), "permission menu at 960");
		await page.keyboard.press("Escape");
		await model.click();
		await expect(popup.getByRole("radio", { name: /gpt-e2e-1/ })).toBeVisible({ timeout: T });
		await insideWindow(w, popup, "model popup at 960");
		await page.keyboard.press("Escape");
	});
});

test("after the first message the project line is gone from the row, the context sits at its end and not in the top bar, and the keyboard reaches the row in order", { timeout: 280000 }, async () => {
	await inWorld({}, async (w) => {
		const page = w.page;
		await send(w, "hello there");
		await expect(page.getByText("Scripted default reply.").first()).toBeVisible({ timeout: T });
		const row = page.locator("[data-composer-row]");
		await expect(row.locator(".composer-project-control")).toHaveCount(0, { timeout: T });
		const permission = row.getByRole("button", { name: /^Permissions:/ });
		const model = row.getByRole("button", { name: /^Model:/ });
		const context = row.getByRole("button", { name: /^Context \d+% full/ });
		await expect(context).toBeVisible({ timeout: T });
		await expect(context.locator(".context-readout-text")).toHaveText(/^\d+%/);
		// Not in the top bar any more; the bar keeps its other buttons.
		await expect(page.locator(".conversation-bar [data-context-ring]")).toHaveCount(0);
		await expect(page.locator(".conversation-bar").getByRole("button", { name: /changes|Files|Conversation details|More/i }).first()).toBeVisible();
		const [m, c, r] = [await rect(model), await rect(context), await rect(row)];
		assert.ok(m.right <= c.left + 1 && r.right - c.right < 16, "the context is the last thing in the row, after the model");
		assert.equal(await context.evaluate((el) => getComputedStyle(el).fontSize), "13px");
		assert.equal((await rect(context)).height, 28);
		// The keyboard: mode, then model, then context, each with a focus ring.
		await permission.focus();
		await page.keyboard.press("Tab");
		await expect(model).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(context).toBeFocused();
		assert.notEqual(await context.evaluate((el) => getComputedStyle(el).boxShadow), "none", "the focus ring is drawn");
		await shot(w, "row-idle");
	});
});

test("sending the first message slides the permission mode to its place; it never jumps", { timeout: 280000 }, async () => {
	await inWorld({}, async (w) => {
		const page = w.page;
		await page.evaluate(() => {
			window.__lefts = [];
			const sample = () => {
				const mode = document.querySelector('[data-composer-row] [aria-label^="Permissions"]');
				if (mode) window.__lefts.push(Math.round(mode.getBoundingClientRect().left));
				requestAnimationFrame(sample);
			};
			sample();
		});
		await send(w, "hello there");
		await expect(page.getByText("Scripted default reply.").first()).toBeVisible({ timeout: T });
		await expect(page.locator("[data-composer-row] .composer-project-control")).toHaveCount(0, { timeout: T });
		const lefts = await page.evaluate(() => window.__lefts);
		const biggest = lefts.slice(1).reduce((most, left, i) => Math.max(most, Math.abs(left - lefts[i])), 0);
		assert.ok(biggest < 120, `the mode moved ${biggest}px in one frame`);
	});
});

test("in a narrow window the percentage goes first, the model name is cut, and the permission mode is never cut", { timeout: 280000 }, async () => {
	const longModel = "claude-sonnet-5-5-20261105-extended-context-preview-with-a-very-long-name";
	await inWorld(
		{
			models: [longModel, "gpt-e2e-1"],
			model: longModel,
			longProject: "a-very-long-project-name-that-keeps-going-on-and-on-and-on-x",
		},
		async (w) => {
			const page = w.page;
			await size(w, 960, 700);
			const row = page.locator("[data-composer-row]");
			const permission = row.getByRole("button", { name: /^Permissions:/ });
			const model = row.getByRole("button", { name: /^Model:/ });
			await expect(model).toBeVisible({ timeout: T });
			const uncut = (locator) => locator.locator("span.truncate").first().evaluate((el) => el.scrollWidth <= el.clientWidth);
			const cut = (locator) => locator.locator("span.truncate").first().evaluate((el) => el.scrollWidth > el.clientWidth);
			// Home, 960px: the long project and the long model both give way; the mode stays whole.
			await expect.poll(() => cut(model), { timeout: T }).toBe(true);
			assert.equal(await uncut(permission), true, "the permission mode is not cut");
			await expect.poll(() => row.locator(".composer-project-title").evaluate((el) => el.scrollWidth > el.clientWidth), { timeout: T }).toBe(true);
			await expect(row.locator(".composer-project-place")).toContainText("This computer");
			await insideWindow(w, row, "row at 960");
			await shot(w, "row-long-960");
			// Zoomed in until the row is very narrow: it may wrap to two lines, but the mode is still whole and reachable.
			await w.app.evaluate(({ BrowserWindow }) => {
				for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(2);
			});
			await expect.poll(async () => (await rect(row)).width, { timeout: T }).toBeLessThan(420);
			// Measured in one go and re-read until the zoom has settled, so no two readings straddle a reflow.
			const whole = () =>
				page.evaluate(() => {
					const row = document.querySelector("[data-composer-row]").getBoundingClientRect();
					const button = document.querySelector('[data-composer-row] button[aria-label^="Permissions:"]');
					const word = button.querySelector("span.truncate");
					const box = button.getBoundingClientRect();
					return word.scrollWidth <= word.clientWidth && box.left >= row.left - 0.5 && box.right <= row.right + 0.5;
				});
			await expect.poll(whole, { timeout: T }).toBe(true);
			await permission.click();
			await expect(page.getByRole("menu", { name: /check with you/ })).toBeVisible({ timeout: T });
			await insideWindow(w, page.locator(".composer-permission-menu"), "permission menu when narrow");
			await page.keyboard.press("Escape");
			await shot(w, "row-long-narrow");
			// Narrower still: the row wraps to two lines, the model and the context under the mode, and nothing is cut but the names.
			await w.app.evaluate(({ BrowserWindow }) => {
				for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(2.4);
			});
			await expect.poll(async () => (await rect(row)).width, { timeout: T }).toBeLessThan(360);
			const wrapped = () =>
				page.evaluate(() => {
					const start = document.querySelector(".composer-row-start").getBoundingClientRect();
					const end = document.querySelector(".composer-row-end").getBoundingClientRect();
					const row = document.querySelector("[data-composer-row]").getBoundingClientRect();
					return end.top >= start.bottom - 1 && end.right <= row.right + 0.5;
				});
			await expect.poll(wrapped, { timeout: T }).toBe(true);
			await expect.poll(whole, { timeout: T }).toBe(true);
			await w.app.evaluate(({ BrowserWindow }) => {
				for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(1);
			});
		},
	);
});

test("an approval is one card directly above the box: one ring, the preview a band edge to edge, the row of settings still under the box", { timeout: 280000 }, async () => {
	const WRITE = {
		match: /write the file/i,
		steps: [{ tool: "write", args: { path: "limits.ts", content: `${THIRTEEN}\n` } }, { text: "Wrote it." }],
	};
	await inWorld({ rules: [WRITE] }, async (w) => {
		const page = w.page;
		await send(w, "Please write the file");
		const card = page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		await expect(card.getByRole("button", { name: /^Show all 14 lines/ })).toBeVisible({ timeout: T });
		const surface = card.locator(".approval-card");
		const band = card.locator(".approval-box");
		const look = await surface.evaluate((el) => {
			const css = getComputedStyle(el);
			return { ring: css.borderTopWidth, radius: css.borderTopLeftRadius, shadow: css.boxShadow, fill: css.backgroundColor };
		});
		assert.equal(look.ring, "1px");
		assert.equal(look.radius, "12px");
		assert.equal(look.shadow, "none", "the card has no shadow of its own");
		const inner = await band.evaluate((el) => {
			const css = getComputedStyle(el);
			return { ring: css.borderTopWidth, radius: css.borderTopLeftRadius, fill: css.backgroundColor };
		});
		assert.equal(inner.ring, "0px", "the preview has no border");
		assert.equal(inner.radius, "0px", "the preview has no corners");
		assert.notEqual(inner.fill, look.fill, "the preview has its own, code fill");
		const [c, b] = [await rect(surface), await rect(band)];
		assert.ok(Math.abs(b.left - (c.left + 1)) <= 1 && Math.abs(c.right - 1 - b.right) <= 1, "the preview runs from edge to edge of the card");
		// No surface behind both: the card is not inside the composer's backdrop, and nothing draws a banner.
		assert.equal(await surface.evaluate((el) => el.closest('[data-slot="composer-shell"]') === null), true);
		await expect(page.locator('[data-slot="composer-banner"]')).toHaveCount(0);
		// The ordinary box under it, one row tall, then the row of settings, about 8px apart.
		const bar = page.locator(".composer-waiting");
		const bb = await rect(bar);
		assert.ok(bb.height >= 38 && bb.height <= 46, `the waiting box is one row (${bb.height})`);
		assert.ok(bb.top - c.bottom >= 6 && bb.top - c.bottom <= 10, `the box is about 8px under the card (${bb.top - c.bottom})`);
		await expect(bar.getByRole("button", { name: "Stop reply" })).toBeVisible();
		await expect(bar.getByRole("button", { name: "Attachments and message settings" })).toBeVisible();
		const row = page.locator("[data-composer-row]");
		await expect(row.getByRole("button", { name: /^Permissions: Ask first/ })).toBeVisible();
		assert.ok((await rect(row)).top >= bb.bottom, "the row is under the box");
		// The footer, in its order, with Accept the one filled button.
		const names = await card.locator("footer button").evaluateAll((els) => els.map((el) => el.textContent?.trim()));
		assert.deepEqual(names, ["Reject", "Allow for this conversation", "Accept"]);
		await shot(w, "row-approval");
		await expect(card.getByRole("button", { name: "Accept", exact: true })).not.toHaveAttribute("aria-disabled", "true", { timeout: T });
		await card.getByRole("button", { name: "Reject", exact: true }).click();
		await expect(card).toHaveCount(0, { timeout: T });
	});
});
