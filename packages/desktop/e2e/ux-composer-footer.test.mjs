// Beside the mode the composer footer says, quietly, how many background shells run and which pull request the
// conversation's branch has, coloured by review state. Both stay silent when there is nothing to say, and the
// pull request lookup stays silent when gh fails. gh is a stand-in program on PATH; nothing reaches GitHub.
// Real Electron app, real CLI host, scripted provider. No paid model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-composer-footer.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
/** Every finite animation and transition has run to its end: the real final state, never a fixed wait. */
const settled = (w) =>
	w.page.evaluate(() =>
		Promise.all(
			document
				.getAnimations()
				.filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
				.map((a) => a.finished.catch(() => undefined)),
		),
	);
const shot = async (w, name) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await settled(w);
	// The composer wherever it stands (centred in an empty conversation, docked once there are messages).
	const box = await w.page.locator("[data-chat-composer-stack]").boundingBox();
	assert.ok(box, "the composer is on screen");
	const pad = 16;
	const x = Math.max(0, box.x - pad);
	const y = Math.max(0, box.y - pad);
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x, y, width: box.width + 2 * pad, height: box.height + 2 * pad } });
};

test("the footer shows background shells and the branch pull request", { timeout: 280000 }, async () => {
	const bin = mkdtempSync(join(tmpdir(), "namzu-gh-stub-"));
	const answer = join(bin, "answer");
	// `gh pr view` prints the file; a file starting with FAIL: fails with the rest as its message.
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/sh\nfirst=$(head -c 5 "${answer}")\nif [ "$first" = "FAIL:" ]; then tail -c +6 "${answer}" >&2; exit 1; fi\ncat "${answer}"\n`,
	);
	chmodSync(join(bin, "gh"), 0o755);
	const pr = (extra) =>
		JSON.stringify({ number: 607, url: "https://github.com/o/r/pull/607", state: "OPEN", ...extra });
	writeFileSync(answer, pr({ reviewDecision: "APPROVED" }));
	const world = await createWorld({
		pathPrefix: bin,
		rules: [
			{
				match: /^arka/,
				steps: [{ tool: "bash", args: { command: "sleep 300", run_in_background: true } }, { text: "Arka planda." }],
			},
			{ match: /^tamam/, steps: [{ text: "Tamam." }] },
		],
		seed: (w) => {
			execFileSync("git", ["init", "-q", "-b", "feat/footer"], { cwd: w.project });
		},
	});
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		const chip = w.page.locator("[data-composer-pr]");
		// The pull request is read when the project opens.
		await expect(chip).toHaveText("PR #607", { timeout: T });
		await expect(chip).toHaveAttribute("data-review", "approved");
		await shot(w, "footer-pr-approved");
		const seen = new Map();
		const sendAndWait = async (text, reply) => {
			await send(w, text);
			const n = (seen.get(reply) ?? 0) + 1;
			seen.set(reply, n);
			// Each reply is one more of the same words, so wait for the count, then for the turn to be over.
			await expect(w.page.getByText(reply, { exact: true })).toHaveCount(n, { timeout: T });
			await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		};
		writeFileSync(answer, pr({ reviewDecision: "CHANGES_REQUESTED" }));
		await sendAndWait("tamam bir", "Tamam.");
		await expect(chip).toHaveAttribute("data-review", "changes", { timeout: T });
		await shot(w, "footer-pr-changes");
		writeFileSync(answer, pr({}));
		await sendAndWait("tamam iki", "Tamam.");
		await expect(chip).toHaveAttribute("data-review", "pending", { timeout: T });
		await shot(w, "footer-pr-pending");
		writeFileSync(answer, pr({ isDraft: true }));
		await sendAndWait("tamam uc", "Tamam.");
		await expect(chip).toHaveAttribute("data-review", "draft", { timeout: T });
		await shot(w, "footer-pr-draft");
		writeFileSync(answer, pr({ state: "MERGED" }));
		await sendAndWait("tamam uc buçuk", "Tamam.");
		await expect(chip).toHaveAttribute("data-review", "merged", { timeout: T });
		await shot(w, "footer-pr-merged");
		// gh failing, or no pull request: nothing at all, not a hint.
		writeFileSync(answer, "FAIL:To get started with GitHub CLI, please run:  gh auth login");
		await sendAndWait("tamam dort", "Tamam.");
		await expect(chip).toHaveCount(0, { timeout: T });
		writeFileSync(answer, "FAIL:no pull requests found for branch feat/footer");
		await sendAndWait("tamam bes", "Tamam.");
		await expect(chip).toHaveCount(0);
		await shot(w, "footer-pr-none");
		// Clicking opens the pull request in the browser.
		writeFileSync(answer, pr({ reviewDecision: "APPROVED" }));
		await w.app.evaluate(({ shell }) => {
			globalThis.__opened = [];
			shell.openExternal = async (url) => {
				globalThis.__opened.push(url);
			};
		});
		await sendAndWait("tamam alti", "Tamam.");
		await expect(chip).toHaveText("PR #607", { timeout: T });
		await chip.click();
		await expect.poll(() => w.app.evaluate(() => globalThis.__opened)).toEqual(["https://github.com/o/r/pull/607"]);

		// Background shells: none, then one after a command is handed to a job; the chip opens the list.
		await w.page.getByRole("button", { name: /^Permissions/ }).click();
		await w.page.getByRole("menuitemradio", { name: /Full access/ }).click();
		await w.page.getByRole("alertdialog", { name: "Allow Namzu full access?" }).getByRole("button", { name: "Enable full access" }).click();
		await expect(w.page.locator("[data-composer-shells]")).toHaveCount(0);
		await sendAndWait("arka plan", "Arka planda.");
		const shells = w.page.locator("[data-composer-shells]");
		await expect(shells).toHaveText("1 shell", { timeout: T });
		await shot(w, "footer-shells");
		await shells.click();
		await expect(w.page.locator(".jobs-panel[data-open=true]")).toBeVisible();
		assert.ok((await w.page.locator(".jobs-panel").innerText()).includes("sleep 300"));
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
