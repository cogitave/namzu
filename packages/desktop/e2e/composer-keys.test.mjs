// The message box's keyboard and send hygiene, in the real app: up/down walks the messages sent in
// this conversation and gives the unsent draft back, Ctrl+Enter holds a message for after the reply
// without ever answering an approval card, an input method that is composing never sends, Stop says
// "Stopping" until the reply ends, a paste longer than the box says what it left out, and closing a
// draft pane that holds words asks first. Real Electron app, real CLI host, scripted provider.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/composer-keys.test.mjs
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
const flat = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "");
/** The messages a request carried that this flow typed. */
const typed = (request) =>
	(request.messages ?? [])
		.filter((m) => m.role === "user")
		.map((m) => flat(m.content))
		.filter((t) => /^(ilk|ikinci|ucuncu|dorduncu|yarim|ime|onay)/.test(t));
/** How many model requests carried this message as their newest user message. */
const startedWith = (w, text) => w.model.requests.filter((r) => typed(r).at(-1) === text).length;

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const RULES = [
	{ match: /^ilk/, steps: [{ tool: "bash", args: { command: "echo birinci" }, hold: "h" }, { text: "Ilk cevap." }] },
	{ match: /^ikinci/, steps: [{ text: "Ikinci cevap." }] },
	{ match: /^ucuncu/, steps: [{ text: "Ucuncu cevap." }] },
	{ match: /^dorduncu/, steps: [{ text: "Dorduncu cevap." }] },
	{ match: /^onay/, steps: [{ tool: "write", args: { path: "out.txt", content: "merhaba\n" } }, { text: "Onay cevap." }] },
	{ match: /^ime/, steps: [{ text: "Ime cevap." }] },
];

const box = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });
const rows = (w) => w.page.locator("[data-composer-tray] [data-pending-message-id]");
const counter = (w) => w.page.locator("[data-history-counter]");

async function fullAccess(w) {
	await w.page.getByRole("button", { name: /^Permissions/ }).click();
	await w.page.getByRole("menuitemradio", { name: /Full access/ }).click();
	await w.page.getByRole("alertdialog", { name: "Allow Namzu full access?" }).getByRole("button", { name: "Enable full access" }).click();
	await expect(w.page.getByRole("button", { name: /Permissions: Full access/ })).toBeVisible({ timeout: T });
}

function flow(name, { access = true } = {}, body) {
	test(name, { timeout: 280000 }, async () => {
		const world = await createWorld({ rules: RULES });
		let failed = true;
		try {
			await launch(world);
			await openProject(world);
			if (access) await fullAccess(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

/** Sends with the Send button and waits for the answer, so the message is part of the history. */
async function sendAndWait(w, text, answer) {
	await box(w).fill(text);
	await w.page.getByRole("button", { name: "Send message" }).click();
	await expect(w.page.locator("[data-message-role=assistant]", { hasText: answer })).toHaveCount(1, { timeout: T });
}

flow("up and down walk the messages sent here and give the unsent draft back", {}, async (w) => {
	await sendAndWait(w, "ikinci-mesaj", "Ikinci cevap.");
	await sendAndWait(w, "ucuncu-mesaj", "Ucuncu cevap.");
	const before = w.model.requests.length;
	await expect(box(w)).toHaveValue("");
	// Up in an empty box recalls the newest message, with a counter, and sends nothing.
	await box(w).press("ArrowUp");
	await expect(box(w)).toHaveValue("ucuncu-mesaj");
	await expect(counter(w)).toContainText("Earlier message 1 of 2");
	await shot(w, "history-1");
	await box(w).press("ArrowUp");
	await expect(box(w)).toHaveValue("ikinci-mesaj");
	await expect(counter(w)).toContainText("Earlier message 2 of 2");
	// At the oldest message the key does nothing more.
	await box(w).press("ArrowUp");
	await expect(box(w)).toHaveValue("ikinci-mesaj");
	// An older message is recalled with the caret at its start, so the first Down only moves the
	// caret to its end; the next one walks forward.
	await box(w).press("ArrowDown");
	await expect(box(w)).toHaveValue("ikinci-mesaj");
	await box(w).press("ArrowDown");
	await expect(box(w)).toHaveValue("ucuncu-mesaj");
	// Past the newest, the box is empty again and the counter is gone.
	await box(w).press("ArrowDown");
	await expect(box(w)).toHaveValue("");
	await expect(counter(w)).toHaveCount(0);

	// A draft being typed is kept: up from its end only moves the caret, up from its start recalls,
	// and coming back down restores it.
	await box(w).fill("yarim kalan");
	await box(w).press("ArrowUp");
	await expect(box(w)).toHaveValue("yarim kalan");
	await box(w).press("Home");
	await box(w).press("ArrowUp");
	await expect(box(w)).toHaveValue("ucuncu-mesaj");
	await box(w).press("End");
	await box(w).press("ArrowDown");
	await expect(box(w)).toHaveValue("yarim kalan");

	// A recalled message is only text in the box: editing it ends the walk, and nothing was sent.
	await box(w).fill("");
	await box(w).press("ArrowUp");
	await expect(counter(w)).toBeVisible();
	await box(w).press("End");
	await box(w).pressSequentially(" duzenlendi");
	await expect(counter(w)).toHaveCount(0);
	await expect(box(w)).toHaveValue("ucuncu-mesaj duzenlendi");
	assert.equal(w.model.requests.length, before, "recalling and editing sent nothing");
});

flow("Ctrl+Enter holds a message for after the reply and Enter steers it into the reply", {}, async (w) => {
	await box(w).fill("ilk-mesaj");
	await w.page.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => w.model.requests.length, { timeout: T }).toBeGreaterThanOrEqual(1);
	// The empty box teaches both keys while a reply runs.
	await expect(box(w)).toHaveAttribute("placeholder", /Enter sends now · (Ctrl|Cmd)\+Enter or Tab sends after this reply/);
	await shot(w, "keys-placeholder");
	await box(w).fill("ucuncu-mesaj");
	await box(w).press("Control+Enter");
	await expect(rows(w)).toHaveCount(1);
	await expect(rows(w).first()).toContainText("After this reply");
	await expect(box(w)).toHaveValue("");
	await box(w).fill("dorduncu-mesaj");
	await box(w).press("Enter");
	// The message sent into the reply is listed before the one held for after it.
	await expect(rows(w)).toHaveCount(2);
	await expect(rows(w).first()).toContainText("Sending to this reply");
	await expect(rows(w).nth(1)).toContainText("After this reply");
	w.model.release("h");
	// The held message ran once, as its own turn, after the reply.
	await expect(w.page.locator("[data-message-role=assistant]", { hasText: "Ucuncu cevap." })).toHaveCount(1, { timeout: T });
	assert.equal(startedWith(w, "ucuncu-mesaj"), 1, "the held message started exactly one turn");
	await expect(rows(w)).toHaveCount(0, { timeout: T });
});

flow("Ctrl+Enter in the message box never answers an approval card", { access: false }, async (w) => {
	await box(w).fill("onay-mesaj");
	await w.page.getByRole("button", { name: "Send message" }).click();
	const card = w.page.getByRole("region", { name: "Tool approval" });
	await expect(card).toBeVisible({ timeout: T });
	// The person goes back to the box and types; Ctrl+Enter there means "hold this", not "accept".
	await box(w).click();
	await box(w).fill("ucuncu-mesaj");
	await box(w).press("Control+Enter");
	await expect(rows(w)).toHaveCount(1);
	await expect(rows(w).first()).toContainText("After this reply");
	await expect(card).toBeVisible();
	assert.equal(existsSync(join(w.project, "out.txt")), false, "the file was not written: the card was not answered");
	assert.equal(startedWith(w, "ucuncu-mesaj"), 0, "the held message did not reach the model");
	await shot(w, "keys-approval-untouched");
	// Ctrl+Enter inside the card still accepts it, once the card's short click guard has ended (it says so on the button).
	await expect(card.getByRole("button", { name: "Accept", exact: true })).not.toHaveAttribute("aria-disabled", "true", { timeout: T });
	await card.getByRole("button", { name: "Accept", exact: true }).focus();
	await w.page.keyboard.press("Control+Enter");
	await expect(card).toHaveCount(0, { timeout: T });
	await expect(w.page.locator("[data-message-role=assistant]", { hasText: "Ucuncu cevap." })).toHaveCount(1, { timeout: T });
	assert.equal(existsSync(join(w.project, "out.txt")), true);
	assert.equal(startedWith(w, "ucuncu-mesaj"), 1, "the held message started exactly one turn");
});

flow("an input method that is composing never sends", {}, async (w) => {
	await box(w).fill("ime-mesaj");
	const enter = (init) =>
		box(w).evaluate((el, extra) => {
			const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...extra });
			el.dispatchEvent(event);
			return event.defaultPrevented;
		}, init);
	// Confirming a candidate: the browser flag, and the legacy key code on engines that drop the flag.
	assert.equal(await enter({ isComposing: true }), false);
	assert.equal(await enter({ keyCode: 229 }), false);
	await expect(box(w)).toHaveValue("ime-mesaj");
	assert.equal(w.model.requests.length, 0, "nothing was sent while composing");
	// The same key outside composition sends, exactly once.
	await box(w).press("Enter");
	await expect(w.page.locator("[data-message-role=assistant]", { hasText: "Ime cevap." })).toHaveCount(1, { timeout: T });
	assert.equal(startedWith(w, "ime-mesaj"), 1);
});

flow("Stop says Stopping until the reply ends, then the box is free again", {}, async (w) => {
	await box(w).fill("ilk-mesaj");
	await w.page.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => w.model.requests.length, { timeout: T }).toBeGreaterThanOrEqual(1);
	// Record every moment the stop button says it is stopping; the state may be short.
	await w.page.evaluate(() => {
		window.__stopping = { seen: false, label: "" };
		const look = () => {
			const button = document.querySelector("button[data-stopping=true]");
			if (button) {
				window.__stopping.seen = true;
				window.__stopping.label = button.getAttribute("aria-label");
			}
		};
		new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true });
	});
	await w.page.getByRole("button", { name: "Stop reply" }).click();
	await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
	const seen = await w.page.evaluate(() => window.__stopping);
	assert.equal(seen.seen, true, "the stop button said it was stopping");
	assert.equal(seen.label, "Stopping reply");
	// The reply ended: no stopping state remains, and the next message goes out normally.
	await expect(w.page.locator("button[data-stopping=true]")).toHaveCount(0);
	await box(w).fill("ikinci-mesaj");
	await w.page.getByRole("button", { name: "Send message" }).click();
	await expect(w.page.locator("[data-message-role=assistant]", { hasText: "Ikinci cevap." })).toHaveCount(1, { timeout: T });
	await expect(w.page.getByRole("button", { name: "Stopping reply" })).toHaveCount(0);
});

flow("a paste longer than the box says what it left out", {}, async (w) => {
	await box(w).fill("a".repeat(49990));
	await w.app.evaluate(({ clipboard }) => clipboard.writeText("b".repeat(100)));
	await box(w).focus();
	await box(w).press("Control+End");
	await box(w).press("Control+V");
	await expect(w.page.getByText("The box holds 50,000 characters, so the last 90 of that paste were left out.")).toBeVisible({ timeout: T });
	const length = await box(w).evaluate((el) => el.value.length);
	assert.equal(length, 50000);
	await shot(w, "paste-too-long");
	// Typing goes on as usual and clears the notice.
	await box(w).press("Backspace");
	await expect(w.page.getByText(/were left out/)).toHaveCount(0);
});

flow("closing a draft pane that holds words asks first, and an empty one just closes", {}, async (w) => {
	const page = w.page;
	const tabs = page.locator(".conversation-tab");
	await page.getByRole("button", { name: "New conversation" }).first().click();
	await expect(box(w)).toBeVisible({ timeout: T });
	// Nothing typed: the tab closes without a question.
	const open = await tabs.count();
	await page.locator('.conversation-tab[data-active="true"]').getByRole("button", { name: /^Close tab/ }).click();
	await expect(tabs).toHaveCount(open - 1);
	await expect(page.getByRole("alertdialog", { name: "Discard draft?" })).toHaveCount(0);

	await page.getByRole("button", { name: "New conversation" }).first().click();
	await expect(box(w)).toBeVisible({ timeout: T });
	const count = await tabs.count();
	await box(w).fill("yarim kalan mesaj");
	await page.locator('.conversation-tab[data-active="true"]').getByRole("button", { name: /^Close tab/ }).click();
	const dialog = page.getByRole("alertdialog", { name: "Discard draft?" });
	await expect(dialog).toBeVisible({ timeout: T });
	await shot(w, "discard-draft");
	// Cancel keeps the pane and the words.
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(tabs).toHaveCount(count);
	await expect(box(w)).toHaveValue("yarim kalan mesaj");
	// The close chord asks the same question; Discard closes the pane and deletes the draft.
	await box(w).press("Control+W");
	await expect(dialog).toBeVisible({ timeout: T });
	await dialog.getByRole("button", { name: "Discard" }).click();
	await expect(tabs).toHaveCount(count - 1, { timeout: T });
	await expect(dialog).toHaveCount(0);
	assert.equal(w.model.requests.length, 0, "no message was sent");
});
