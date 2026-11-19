// The transcript follows a reply after a turn that had a tool call, and a reader who scrolled up
// keeps their place. After a finished turn re-lays-out, Chromium's scroll anchoring moves the
// scroller by itself; that scroll is not the reader's and must not end following.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/transcript-follow.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const NEAR = 48;
const long = (tag, n) =>
	Array.from(
		{ length: n },
		(_, i) =>
			`${tag} paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
	).join("\n\n");

const rules = [
	{ match: /fill/i, steps: [{ text: long("Fill", 8) }] },
	{
		match: /first/i,
		steps: [
			{ tool: "bash", args: { command: "echo one" } },
			{ tool: "bash", args: { command: "echo two" } },
			{ text: long("First final", 10) },
		],
	},
	{
		match: /hold/i,
		// The command waits for a file the test writes, so the step lasts exactly as long as the test
		// lets it, with no clock involved.
		steps: [{ tool: "bash", args: { command: "__GATE__" } }, { text: long("Held final", 6) }],
	},
];

/** Sends the held request and answers its approval, so the step is live. */
async function sendHeld(world) {
	await send(world, "hold go");
	// A command's card has no region name; Accept ignores a click for its first 400 ms.
	const accept = world.page.getByRole("button", { name: "Accept", exact: true });
	await expect(accept).toBeVisible({ timeout: T });
	await expect(accept).not.toHaveAttribute("aria-disabled", "true", { timeout: T });
	await accept.click();
	await expect(world.page.locator(".activity-trigger[data-live]").first()).toContainText(/Running/, { timeout: T });
}
const release = (world) => writeFileSync(world.gate, "go\n");

const gap = (page) =>
	page.evaluate(() => {
		const t = document.querySelector(".transcript");
		return t.scrollHeight - t.clientHeight - t.scrollTop;
	});

async function start() {
	const world = await createWorld({ answerHistory: true, tabs: "hidden", rules });
	world.gate = join(world.root, "gate");
	world.model.rules.find((rule) => rule.match.test("hold")).steps[0].args.command =
		`while [ ! -f ${world.gate} ]; do sleep 0.1; done`;
	await launch(world);
	await openProject(world);
	await world.app.evaluate(({ BrowserWindow }) => {
		for (const w of BrowserWindow.getAllWindows()) {
			w.setContentSize(1280, 833);
			w.center();
		}
	});
	for (let i = 0; i < 3; i++) {
		await send(world, `fill ${i}`);
		await expect(world.page.getByText(`Fill paragraph 8.`).nth(i)).toBeVisible({ timeout: T });
	}
	return world;
}

test("a message sent after a turn with tool calls is followed to the end", async () => {
	const world = await start();
	try {
		const { page } = world;
		await send(world, "first go");
		await expect(page.getByText("First final paragraph 10.")).toBeAttached({ timeout: T });
		await page.evaluate(() => {
			const t = document.querySelector(".transcript");
			t.scrollTop = t.scrollHeight;
		});
		await expect.poll(() => gap(page), { timeout: T }).toBeLessThanOrEqual(NEAR);

		// The held step is live: the finished turn above has re-laid-out by now.
		await sendHeld(world);
		const held = await gap(page);
		assert.ok(held <= NEAR, `pinned while the step is held, ${held}px from the end`);
		await expect(page.locator(".transcript-latest")).toHaveCount(0);

		release(world);
		await expect(page.getByText("Held final paragraph 6.")).toBeAttached({ timeout: T });
		await expect.poll(() => gap(page), { timeout: T }).toBeLessThanOrEqual(NEAR);
		await expect(page.locator(".transcript-latest")).toHaveCount(0);
	} finally {
		await dispose(world);
	}
});

test("a reader who scrolls up during a reply stays where they are", async () => {
	const world = await start();
	try {
		const { page } = world;
		await sendHeld(world);
		const wheelAt = await page.locator(".transcript").boundingBox();
		await page.mouse.move(wheelAt.x + wheelAt.width / 2, wheelAt.y + wheelAt.height / 2);
		await page.mouse.wheel(0, -900);
		await expect(page.locator(".transcript-latest")).toBeVisible({ timeout: T });
		// The wheel scrolls smoothly; read the place once it has stopped moving for a few frames.
		const top = await page.evaluate(
			() =>
				new Promise((resolve) => {
					const el = document.querySelector(".transcript");
					let last = el.scrollTop;
					let still = 0;
					const frame = () => {
						still = el.scrollTop === last ? still + 1 : 0;
						last = el.scrollTop;
						if (still >= 10) resolve(last);
						else requestAnimationFrame(frame);
					};
					requestAnimationFrame(frame);
				}),
		);
		release(world);
		await expect(page.getByText("Held final paragraph 6.")).toBeAttached({ timeout: T });
		assert.equal(
			await page.evaluate(() => document.querySelector(".transcript").scrollTop),
			top,
			"the view did not move",
		);
		await expect(page.locator(".transcript-latest")).toBeVisible();
	} finally {
		await dispose(world);
	}
});
