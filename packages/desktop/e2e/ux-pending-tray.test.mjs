// Messages typed while a reply runs sit in a tray fused to the composer: one row each in the order they
// will be used, Send now / Edit / Remove on every row, an inline editor, and a message leaves the tray the
// moment the model receives it. Real Electron app, real CLI host, scripted provider. No paid model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-pending-tray.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
const flat = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "");
/** The messages a request carried that this flow typed. */
const typed = (request) =>
	(request.messages ?? [])
		.filter((m) => m.role === "user")
		.map((m) => flat(m.content))
		.filter((t) => /^(ilk|ikinci|ucuncu|dorduncu|besinci|altinci)/.test(t));

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function flow(name, body) {
	test(name, { timeout: 280000 }, async () => {
		const world = await createWorld({
			rules: [
				{ match: /^ilk/, steps: [{ tool: "bash", args: { command: "echo birinci" }, hold: "h" }, { text: "Ilk cevap." }] },
				{ match: /^ikinci/, steps: [{ text: "Ikinci cevap." }] },
				{ match: /^ucuncu/, steps: [{ text: "Ucuncu cevap." }] },
				{ match: /^dorduncu/, steps: [{ text: "Dorduncu cevap." }] },
				{ match: /^besinci/, steps: [{ text: "Besinci cevap." }] },
				{ match: /^altinci/, steps: [{ text: "Altinci cevap." }] },
			],
		});
		let failed = true;
		try {
			await launch(world);
			await openProject(world);
			await world.page.getByRole("button", { name: /^Permissions/ }).click();
			await world.page.getByRole("menuitemradio", { name: /Full access/ }).click();
			await world.page.getByRole("alertdialog", { name: "Allow Namzu full access?" }).getByRole("button", { name: "Enable full access" }).click();
			await expect(world.page.getByRole("button", { name: /Permissions: Full access/ })).toBeVisible({ timeout: T });
			await send(world, "ilk-mesaj");
			await expect.poll(() => world.model.requests.length, { timeout: T }).toBeGreaterThanOrEqual(1);
			await body(world);
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

const rows = (w) => w.page.locator("[data-composer-tray] [data-pending-message-id]");
const box = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });

async function steer(w, text) {
	await box(w).fill(text);
	await box(w).press("Enter");
}
async function hold(w, text) {
	await box(w).fill(text);
	await box(w).press("Tab");
}

flow("a message typed while working waits in the tray joined to the composer", async (w) => {
	await expect(w.page.locator("[data-composer-tray]")).toHaveCount(0);
	await steer(w, "ikinci-mesaj");
	await expect(rows(w)).toHaveCount(1);
	await expect(rows(w).first()).toContainText("Sending to this reply");
	// The tray is part of the composer's shell: same width, nothing in the transcript.
	const geometry = await w.page.evaluate(() => {
		const tray = document.querySelector("[data-composer-tray]").getBoundingClientRect();
		const shell = document.querySelector("[data-slot=composer-shell]").getBoundingClientRect();
		const host = document.querySelector("[data-slot=composer-host]").getBoundingClientRect();
		return { trayLeft: tray.left, trayRight: tray.right, shellLeft: shell.left, shellRight: shell.right, trayBottom: tray.bottom, hostTop: host.top };
	});
	assert.ok(Math.abs(geometry.trayLeft - geometry.shellLeft) < 1.5 && Math.abs(geometry.trayRight - geometry.shellRight) < 1.5, "the tray is as wide as the composer");
	assert.ok(Math.abs(geometry.trayBottom - geometry.hostTop) < 1.5, "the tray sits directly on the composer");
	await expect(w.page.locator(".conversation-body [data-pending-message-id]")).toHaveCount(0);
	await shot(w, "tray-1-message");
	await hold(w, "ucuncu-mesaj");
	await expect(rows(w)).toHaveCount(2);
	await expect(rows(w).nth(1)).toContainText("After this reply");
	await expect(w.page.locator("[data-composer-tray]")).toContainText("2 waiting");
	await rows(w).nth(1).hover();
	await shot(w, "tray-2-messages");
	for (const text of ["dorduncu-mesaj", "besinci-mesaj", "altinci-mesaj"]) await hold(w, text);
	await expect(rows(w)).toHaveCount(5);
	await expect(w.page.locator("[data-composer-tray]")).toContainText("5 waiting");
	// Past four rows the tray scrolls instead of growing.
	const scrolls = await w.page.locator(".composer-tray-list").evaluate((el) => el.scrollHeight > el.clientHeight);
	assert.equal(scrolls, true);
	await shot(w, "tray-5-messages");
	// A message sent into the reply cannot be taken back; only Send now is offered on it.
	await expect(rows(w).first().getByRole("button", { name: /^Edit/ })).toHaveCount(0);
	await expect(rows(w).first().getByRole("button", { name: /^Remove/ })).toHaveCount(0);
	await expect(rows(w).first().getByRole("button", { name: /^Send now/ })).toHaveCount(1);
});

flow("up in an empty composer edits the newest waiting message in place, keeping its order", async (w) => {
	await hold(w, "ucuncu-mesaj");
	await hold(w, "dorduncu-mesaj");
	await expect(rows(w)).toHaveCount(2);
	await box(w).press("ArrowUp");
	const editor = w.page.getByRole("textbox", { name: "Edit waiting message" });
	await expect(editor).toBeVisible();
	await expect(editor).toHaveValue("dorduncu-mesaj");
	await shot(w, "tray-editing");
	await editor.fill("dorduncu-mesaj duzenlendi");
	// Shift+Enter adds a line and does not save.
	await editor.press("Shift+Enter");
	await expect(editor).toBeVisible();
	await editor.press("Backspace");
	await editor.press("Enter");
	await expect(editor).toHaveCount(0);
	await expect(rows(w)).toHaveCount(2);
	await expect(rows(w).nth(0)).toContainText("ucuncu-mesaj");
	await expect(rows(w).nth(1)).toContainText("dorduncu-mesaj duzenlendi");
	// Esc cancels an edit.
	await rows(w).nth(0).getByRole("button", { name: /^Edit/ }).click();
	await w.page.getByRole("textbox", { name: "Edit waiting message" }).fill("vazgec");
	await w.page.getByRole("textbox", { name: "Edit waiting message" }).press("Escape");
	await expect(rows(w).nth(0)).toContainText("ucuncu-mesaj");
	// Remove takes a row out.
	await rows(w).nth(0).getByRole("button", { name: /^Remove/ }).click();
	await expect(rows(w)).toHaveCount(1);
	await shot(w, "tray-after-edit-and-remove");
	// What ran afterwards is the edited text, once.
	w.model.release("h");
	await expect.poll(() => w.model.requests.some((r) => typed(r).includes("dorduncu-mesaj duzenlendi")), { timeout: T }).toBe(true);
	assert.equal(w.model.requests.some((r) => typed(r).includes("ucuncu-mesaj")), false);
	await expect(rows(w)).toHaveCount(0);
});

flow("a message leaves the tray when the model receives it, and then is a normal message", async (w) => {
	await steer(w, "ikinci-mesaj");
	await hold(w, "ucuncu-mesaj");
	await expect(rows(w)).toHaveCount(2);
	await shot(w, "tray-before-delivery");
	w.model.release("h");
	// The steered message is part of the next request of the running reply; the held one waits for the reply.
	await expect.poll(() => w.model.requests.findIndex((r) => typed(r).includes("ikinci-mesaj")), { timeout: T }).toBeGreaterThan(0);
	const firstWith = w.model.requests.findIndex((r) => typed(r).includes("ikinci-mesaj"));
	assert.equal(typed(w.model.requests[firstWith]).includes("ucuncu-mesaj"), false, "the held message did not ride along");
	await expect(w.page.locator('[data-pending-kind="steer"]')).toHaveCount(0, { timeout: T });
	await expect(w.page.locator("[data-message-role=user]", { hasText: "ikinci-mesaj" })).toHaveCount(1);
	await shot(w, "tray-after-delivery");
	// Eventually the held one runs as its own turn and the tray empties.
	await expect(rows(w)).toHaveCount(0, { timeout: T });
	await expect(w.page.locator("[data-message-role=user]", { hasText: "ucuncu-mesaj" })).toHaveCount(1);
	const order = w.model.requests.map((r) => typed(r)).filter((t) => t.length).map((t) => t.join("|"));
	console.log("REQUESTS", JSON.stringify(order));
});

flow("send now stops the reply and runs that message at once", async (w) => {
	await hold(w, "ucuncu-mesaj");
	await hold(w, "dorduncu-mesaj");
	await expect(rows(w)).toHaveCount(2);
	await rows(w).nth(1).getByRole("button", { name: /^Send now/ }).click();
	await expect.poll(() => w.model.requests.some((r) => typed(r).at(-1) === "dorduncu-mesaj"), { timeout: T }).toBe(true);
	await expect(w.page.locator("[data-message-role=user]", { hasText: "dorduncu-mesaj" })).toHaveCount(1);
	// The one that did not jump the line still follows.
	await expect(rows(w)).toHaveCount(0, { timeout: T });
	await expect(w.page.locator("[data-message-role=user]", { hasText: "ucuncu-mesaj" })).toHaveCount(1);
	await shot(w, "tray-after-send-now");
});
