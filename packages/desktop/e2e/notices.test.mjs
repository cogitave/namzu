// The system notification for a conversation that needs an answer, a reply that stopped with an
// error and a reply that finished, in the real Electron app with the real CLI host and a scripted
// model. Electron's Notification is not drawn here: with NAMZU_E2E_NOTICES=1 main records what it
// would have shown in globalThis.__namzuNotices and lets a test click one, so the test asserts on the
// payload fields, never on a screen capture. A window's focus is set with BrowserWindow.blur/focus.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/notices.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
// A refused key is not retried, so the turn stops with an error at once.
const REFUSED = {
	status: 401,
	body: JSON.stringify({
		error: { message: "Incorrect API key provided: sk-e2e***.", type: "invalid_request_error" },
	}),
};

async function shot(w, name) {
	if (!SHOTS) return;
	// Only a picture waits for the tab and card transitions; no assertion depends on it.
	await w.page.mouse.move(700, 300);
	await w.page.waitForTimeout(700);
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const setFocus = (w, focused) =>
	w.app.evaluate(({ BrowserWindow }, value) => {
		for (const win of BrowserWindow.getAllWindows()) value ? win.focus() : win.blur();
	}, focused);
const notices = (w) => w.app.evaluate(() => [...(globalThis.__namzuNotices ?? [])]);
const click = (w, index) => w.app.evaluate((_e, i) => globalThis.__namzuNoticeClick(i), index);
const card = (w) => w.page.getByRole("region", { name: "Tool approval" });

test(
	"each event shows one payload with the project name and a fixed sentence, only while unfocused, and a click opens the conversation",
	{ timeout: 240000 },
	async () => {
		const world = await createWorld({
			env: { NAMZU_E2E_NOTICES: "1" },
			rules: [
				{
					match: /write the secret file/i,
					steps: [
						{ tool: "write", args: { path: "secret-plans.txt", content: "launch codes\n" } },
						{ text: "Wrote the secret file." },
					],
				},
				{ match: /go wrong/i, steps: [REFUSED] },
				{ match: /take a while/i, steps: [{ hold: "slow", text: "That took a while." }] },
			],
		});
		let failed = true;
		try {
			await launch(world);
			await openProject(world);
			const project = basename(world.project);
			const sentences = ["A conversation needs your answer", "Finished", "Stopped with an error"];
			const settled = async (count) => {
				await expect.poll(async () => (await notices(world)).length, { timeout: T }).toBe(count);
				return notices(world);
			};

			// 1. Needs an answer, window not focused.
			await setFocus(world, false);
			await send(world, "Please write the secret file");
			await expect(card(world)).toBeVisible({ timeout: T });
			let seen = await settled(1);
			assert.deepEqual(seen[0], { title: project, body: sentences[0], silent: true });
			await shot(world, "needs-you-waiting");

			// 2. A click focuses the window and opens that conversation, even from another tab.
			await world.page.getByRole("button", { name: "New conversation tab" }).click();
			await expect(card(world)).toHaveCount(0);
			await click(world, 0);
			await expect(card(world)).toBeVisible({ timeout: T });
			assert.equal(
				await world.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
				true,
				"the click focused the window",
			);
			// The tab strip follows: the conversation's own tab is the selected one again.
			await expect(world.page.getByRole("tab", { name: /Please write/ })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await shot(world, "click-through");

			// 3. Nothing is shown while the window is focused: the finished turn leaves no record.
			await card(world).getByRole("button", { name: "Accept", exact: true }).click();
			await expect(world.page.getByText("Wrote the secret file.").first()).toBeVisible({ timeout: T });

			// The turn has ended (no Stop button) before the window loses focus again.
			await expect(world.page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: T });

			// 4. A failure while unfocused. The earlier finished turn must not appear before it.
			await setFocus(world, false);
			await send(world, "please go wrong");
			seen = await settled(2);
			assert.deepEqual(seen[1], { title: project, body: sentences[2], silent: true });

			// 5. A turn that ran for a while and finished.
			await send(world, "this will take a while");
			await expect(world.page.getByText("this will take a while").first()).toBeVisible({ timeout: T });
			world.model.release("slow");
			seen = await settled(3);
			assert.deepEqual(seen[2], { title: project, body: sentences[1], silent: true });

			// Whatever the payloads hold, none of it came from the conversation.
			const text = JSON.stringify(seen);
			for (const word of ["secret", "plans", "launch", "write", "Incorrect API key", "while"])
				assert.ok(!text.includes(word), `no "${word}" in any payload`);
			for (const item of seen) assert.deepEqual(Object.keys(item).sort(), ["body", "silent", "title"]);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	},
);
