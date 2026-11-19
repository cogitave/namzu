// The usage limits popover from the indicator beside the model: what the account behind each provider says,
// in three row shapes (a window with its reset and percent, a spend estimate or credit, and one quiet "not
// reported" line), a ring that turns at 75 and 90 percent, and one quiet line under the box when a window is
// nearly used. The first answer is the real host's (a key the vendor reports nothing about); the rows with data
// are sent to the window as the host's notification would, because no real account is used here.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-usage-limits.test.mjs
// Pictures: research/sess-panel-20261117/<name>.png.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 90000;
const SHOTS = resolve(repoRoot, "research/sess-panel-20261117");
mkdirSync(SHOTS, { recursive: true });
const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}.png`) });

/** Says a host notification to the window the way the app's own main process does. */
const say = (w, limits) =>
	w.app.evaluate(({ BrowserWindow }, value) => {
		for (const win of BrowserWindow.getAllWindows()) win.webContents.send("namzu:event", { kind: "limits", limits: value });
	}, limits);

/** The popup fades in; a picture waits until it is fully drawn. */
const settled = (w) => expect.poll(() => popup(w).evaluate((el) => getComputedStyle(el.closest("[data-open]") ?? el).opacity), { timeout: T }).toBe("1");
const indicator = (w) => w.page.locator("[data-usage-indicator]").last();
const popup = (w) => w.page.getByTestId("usage-limits");

test("the usage limits popover shows each row shape, turns the ring, and never draws a zero for what is not known", { timeout: 280000 }, async () => {
	const world = await createWorld({ answerHistory: true, tabs: "hidden", rules: [{ match: /hello/i, steps: [{ text: "Hello." }] }] });
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.setSize(1280, 820)));
		await send(w, "hello");
		await expect(w.page.getByText("Hello.")).toBeVisible({ timeout: T });
		await expect(indicator(w)).toBeVisible({ timeout: T });
		// The real host answers first: a key the vendor reports nothing about is one quiet line, no bar.
		await indicator(w).click();
		await expect(popup(w)).toBeVisible({ timeout: T });
		await expect(popup(w).locator('[data-row="none"]')).toContainText("usage limits are not reported", { timeout: T });
		await expect(popup(w).locator(".limits-bar")).toHaveCount(1); // the context bar only
		await settled(w);
		await shot(w, "limits-not-reported");
		await w.page.keyboard.press("Escape");
		await expect(popup(w)).toHaveCount(0, { timeout: T });

		// A subscription with its plan: two windows with reset words and percent.
		const now = Date.now();
		await say(w, {
			providers: [
				{
					provider: "anthropic",
					label: "Anthropic",
					kind: "sign-in",
					plan: "Team",
					asOf: now,
					windows: [
						{ label: "5-hour limit", usedFraction: 0.27, resetsAt: now + 2 * 3600 * 1000 },
						{ label: "Weekly · all models", usedFraction: 0.05, resetsAt: now + 4 * 24 * 3600 * 1000 },
					],
				},
				{ provider: "openrouter", label: "OpenRouter", kind: "key", credit: { currency: "USD", used: 3.1, limit: 10 }, asOf: now },
				{ provider: "openai", label: "OpenAI", kind: "key", spend: { usd: 3.1, days: 30, partial: false } },
				{ provider: "google", label: "Google", kind: "key" },
			],
		});
		await indicator(w).click();
		await expect(popup(w)).toBeVisible({ timeout: T });
		const windows = popup(w).locator('[data-row="window"]');
		await expect(windows).toHaveCount(2);
		await expect(windows.nth(0)).toContainText("5-hour limit");
		await expect(windows.nth(0)).toContainText("27%");
		await expect(windows.nth(0)).toContainText(/Resets at \d{1,2}:\d{2} (AM|PM)/);
		await expect(windows.nth(1)).toContainText("Weekly · all models");
		await expect(windows.nth(1)).toContainText("5%");
		await expect(windows.nth(1)).toContainText(/Resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2} (AM|PM)/);
		await expect(popup(w).getByRole("heading", { name: "Anthropic · Team" })).toBeVisible();
		await expect(popup(w).locator('[data-row="credit"]')).toContainText("Credit used $3.10 of $10.00");
		await expect(popup(w).locator('[data-row="spend"]')).toContainText("Spent about $3.10 in the last 30 days (list prices)");
		await expect(popup(w).locator('[data-row="none"]')).toContainText("Google: usage limits are not reported");
		await settled(w);
		await shot(w, "limits-row-shapes");
		// A budget turns the spend row into "of $X" with a bar.
		await popup(w).getByRole("button", { name: "Set a budget" }).click();
		await popup(w).getByRole("textbox", { name: "Budget in US dollars" }).fill("4");
		await popup(w).getByRole("button", { name: "Save" }).click();
		await expect(popup(w).locator('[data-row="spend"]')).toContainText("of $4.00 budget");
		await shot(w, "limits-budget");
		await w.page.keyboard.press("Escape");
		await expect(popup(w)).toHaveCount(0, { timeout: T });
		await expect(indicator(w)).toHaveAttribute("data-context-ring", "high", { timeout: T }); // 3.10 of 4.00 is 78%

		// The ring follows the worst window: 75 percent is amber, 90 is red, and a rejected window reads full.
		const only = (used, extra = {}) => ({
			providers: [{ provider: "anthropic", label: "Anthropic", kind: "sign-in", asOf: Date.now(), windows: [{ label: "5-hour limit", usedFraction: used, resetsAt: Date.now() + 3600 * 1000, ...extra }] }],
		});
		await say(w, only(0.5));
		await expect(indicator(w)).toHaveAttribute("data-context-ring", "normal", { timeout: T });
		await expect(w.page.locator("[data-usage-critical]")).toHaveCount(0);
		await say(w, only(0.8));
		await expect(indicator(w)).toHaveAttribute("data-context-ring", "high", { timeout: T });
		await say(w, only(0.96));
		await expect(indicator(w)).toHaveAttribute("data-context-ring", "full", { timeout: T });
		await expect(w.page.locator("[data-usage-critical]")).toContainText(/5-hour limit is at 96%, resets at/);
		await expect(indicator(w)).toContainText("96%");
		await shot(w, "limits-critical-note");
		await say(w, only(0.1, { rejected: true }));
		await expect(indicator(w)).toHaveAttribute("data-context-ring", "full", { timeout: T });
		await indicator(w).click();
		await expect(popup(w).locator('[data-row="window"]')).toContainText("100%");
		await expect(popup(w).locator('[data-row="window"]')).toContainText("Limit reached");
		await shot(w, "limits-rejected");
		await w.page.keyboard.press("Escape");
		await expect(popup(w)).toHaveCount(0, { timeout: T });

		// Nothing is blocked: the box still takes a message while a window is full.
		await send(w, "hello again");
		await expect(w.page.getByText("Hello.")).toHaveCount(2, { timeout: T });
		assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
