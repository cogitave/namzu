// The skill-save card and the saved card, in the real app: the model drafts a skill with save_skill, the card shows the
// file and the two places, a pick writes it, a saved card follows, and Settings > Skills lists it with a Create skill button.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/skill-save-card.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
const body = `# Morning mail summary\n\n${Array.from({ length: 24 }, (_, i) => `${i + 1}. Step ${i + 1}: read the unread mail from the last 24 hours and note what needs an answer.`).join("\n")}\n`;
const RULE = {
	match: /make a skill/i,
	steps: [
		{
			tool: "save_skill",
			args: {
				name: "morning-mail-summary",
				description: "Summarise the last day of unread mail each morning. Use when the user asks for a mail summary.",
				body,
			},
		},
		{ text: "The skill is saved." },
	],
};
async function resize(w, width, height) {
	await w.app.evaluate(({ BrowserWindow }, s) => { for (const win of BrowserWindow.getAllWindows()) win.setSize(s.width, s.height); }, { width, height });
	await expect.poll(() => w.page.evaluate(() => window.innerWidth), { timeout: T }).toBe(width);
}
async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.waitForTimeout(900); // a picture waits for the transitions to settle
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
const audit = (w) => w.page.evaluate(() => ({
	innerWidth: window.innerWidth,
	docScroll: document.documentElement.scrollWidth,
	wide: [...document.querySelectorAll("*")].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; }).map((n) => `${n.tagName}.${String(n.className).slice(0, 40)}`).slice(0, 8),
}));

test("the skill-save card, the saved card and the Skills list", { timeout: 300000 }, async () => {
	const world = await createWorld({
		rules: [RULE],
		files: { ".namzu/skills/release-notes/SKILL.md": "---\nname: release-notes\ndescription: Draft release notes from the merged changes.\n---\n\n# Release notes\n\nList the merged changes.\n" },
	});
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await send(w, "Please make a skill that summarises my mail");
		const card = w.page.getByRole("region", { name: "A skill to save" });
		await expect(card).toBeVisible({ timeout: T });
		const report = {};
		for (const [width, height] of [[1280, 820], [720, 760]]) {
			await resize(w, width, height);
			await expect(card).toBeVisible();
			await expect(card.getByRole("button", { name: "Save skill" })).toBeVisible();
			await expect(card.getByRole("button", { name: "Save to project" })).toBeVisible();
			await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
			await shot(w, `card-${width}`);
			report[`card-${width}`] = await audit(w);
		}
		assert.equal(existsSync(join(w.home ?? "/nonexistent", ".namzu/skills/morning-mail-summary/SKILL.md")), false);
		await card.getByRole("button", { name: "Save skill" }).click();
		await expect(card).toHaveCount(0, { timeout: T });
		await expect(w.page.getByText("The skill is saved.").first()).toBeVisible({ timeout: T });
		await shot(w, "after-save-collapsed");
		await expect(w.page.getByText(/usable from your next message/i).first()).toBeVisible({ timeout: T });
		report.savedCardVisibleWithoutOpeningGroup = true;
		for (const [width, height] of [[1280, 820], [720, 760]]) {
			await resize(w, width, height);
			await shot(w, `saved-${width}`);
			report[`saved-${width}`] = await audit(w);
		}
		await resize(w, 1280, 820);
		await w.page.getByRole("link", { name: /Skills in Settings|Open Skills/ }).or(w.page.getByRole("button", { name: /Skills in Settings|Open Skills/ })).first().click();
		await expect(w.page.getByText("morning-mail-summary").first()).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("button", { name: /Create skill/ })).toBeVisible();
		report.newSkillInViewportAfterLink = await w.page.getByRole("button", { name: /Create skill/ }).evaluate((n) => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
		await shot(w, "settings-after-link");
		for (const [width, height] of [[1280, 820], [720, 760]]) {
			await resize(w, width, height);
			await w.page.getByRole("button", { name: /Create skill/ }).scrollIntoViewIfNeeded();
			await shot(w, `settings-skills-${width}`);
			report[`settings-skills-${width}`] = await audit(w);
			// The rows name where each skill lives in plain words.
			const rows = w.page.getByRole("list", { name: /skills/i }).first();
			await rows.locator("li", { hasText: "morning-mail-summary" }).evaluate((n) => n.scrollIntoView({ block: "center" }));
			await expect(rows.locator("li", { hasText: "morning-mail-summary" }).getByText("user", { exact: true })).toBeVisible();
			await expect(rows.locator("li", { hasText: "release-notes" }).getByText("project", { exact: true })).toBeVisible();
			await shot(w, `settings-skills-rows-${width}`);
		}
		console.log("AUDIT " + JSON.stringify(report));
		assert.deepEqual(world.faults ?? [], []);
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
