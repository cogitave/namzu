// What the person sees when Namzu works in a tab of the Browser pane, in the real app. The tab is opened and
// driven through the agent-tab relay directly (the engine's own wiring is not under test here), against
// a fixture page on 127.0.0.1: the pane shows by itself the first time, without taking the focus from the
// message box; the tab says Namzu is using it and shows when a call is on the page; Take over pauses the
// agent and Hand back gives the tab back; and the sign-in card for a page in the pane says so, with no
// terminal command and a button that shows the tab.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-agent-pane.test.mjs
// The sign-in flow needs the browser engine the agent drives: set PLAYWRIGHT_BROWSERS_PATH.
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 120000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
const PAGE =
	"<title>Fixture shop</title><body style=\"font-family:sans-serif;margin:24px\"><h1>Fixture shop</h1><p>A page Namzu is reading.</p><button>Add to basket</button></body>";
const FORM =
	'<title>Sign in</title><form style="font-family:sans-serif;margin:24px"><h1>Sign in</h1><input name="u"><input type="password" name="p"></form>';

async function site() {
	const server = createServer((request, response) => {
		response.statusCode = request.url?.startsWith("/login") ? 401 : 200;
		response.setHeader("content-type", "text/html");
		response.end(request.url?.startsWith("/login") ? FORM : PAGE);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	return { server, base, host: `127.0.0.1:${server.address().port}` };
}

async function shot(w, name) {
	if (!SHOTS) return;
	await settled(w);
	mkdirSync(SHOTS, { recursive: true });
	const file = join(SHOTS, `${name}.png`);
	// The page is a native view above the app's own page, so the app's own screenshot leaves it out: the picture
	// is taken of the display, cropped to the window.
	const box = await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
	await w.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	try {
		execFileSync("import", ["-window", "root", "-crop", `${box.width}x${box.height}+${box.x}+${box.y}`, "+repage", file], {
			env: process.env,
			stdio: "ignore",
		});
	} catch {
		await w.page.screenshot({ path: file });
	}
}

async function appearance(w, next) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, next);
	await expect(w.page.locator("html")).toHaveClass(next === "dark" ? /dark/ : /^(?!.*dark)/);
}

async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [x, y]) => {
			for (const b of BrowserWindow.getAllWindows()) b.setContentSize(x, y);
		},
		[width, height],
	);
	await w.page.waitForFunction(([x]) => Math.abs(window.innerWidth - x) < 2, [width]);
	await settled(w);
}

/** Waits until the window's layout stops moving: the same boxes for ten frames running (frames, not time). */
async function settled(w) {
	await w.page.evaluate(
		() =>
			new Promise((resolve) => {
				const read = () =>
					[".chat-stage", ".jobs-panel", "[data-browser-pane]", ".handoff-card", "aside"]
						.flatMap((q) => [...document.querySelectorAll(q)])
						.map((el) => {
							const b = el.getBoundingClientRect();
							return `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}`;
						})
						.join("|");
				let last = read();
				let still = 0;
				const tick = () => {
					const now = read();
					still = now === last ? still + 1 : 0;
					last = now;
					if (still >= 10) resolve();
					else requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			}),
	);
}

/** The layout audit of the pane: inside the window, nothing sideways, the strip and its button whole. */
async function audit(w, label) {
	await settled(w);
	const found = await w.page.evaluate(() => {
		const bad = [];
		const pane = document.querySelector("[data-browser-pane]");
		if (!pane) return { missing: true };
		const box = pane.getBoundingClientRect();
		if (box.width < 120) bad.push(`the pane is only ${Math.round(box.width)} wide`);
		if (box.left < 0 || box.right > window.innerWidth + 0.5) bad.push("the pane leaves the window");
		const bar = document.querySelector(".browser-agent-bar");
		if (bar) {
			const b = bar.getBoundingClientRect();
			if (b.right > box.right + 0.5 || b.left < box.left - 0.5) bad.push("the agent strip sticks out");
			if (bar.scrollWidth > bar.clientWidth + 1) bad.push("the agent strip scrolls sideways");
			for (const el of bar.querySelectorAll("button, .browser-agent-words")) {
				const r = el.getBoundingClientRect();
				if (r.width < 4 || r.right > b.right + 0.5) bad.push(`${el.className || el.tagName} is cut off`);
			}
			const button = bar.querySelector("button")?.getBoundingClientRect();
			const words = bar.querySelector(".browser-agent-words")?.getBoundingClientRect();
			if (button && words && words.right > button.left + 0.5) bad.push("the words run under the button");
		}
		const tabs = document.querySelector(".pane-tabs")?.getBoundingClientRect();
		const marks = [...document.querySelectorAll(".pane-tabs [aria-selected=true] .agent-mark")];
		for (const mark of marks) {
			const r = mark.getBoundingClientRect();
			if (tabs && (r.right > tabs.right + 0.5 || r.left < tabs.left - 0.5)) bad.push("the dot is outside the strip");
		}
		if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push("the window scrolls sideways");
		return { bad };
	});
	assert.ok(!found.missing, `${label}: the pane is open`);
	assert.deepEqual(found.bad, [], `${label}: layout audit`);
}

const relay = (w, name, input) =>
	w.app.evaluate(async (_, [n, i]) => {
		const hook = globalThis.__namzuAgentPane;
		try {
			return { ok: true, value: await hook[n](i) };
		} catch (error) {
			return { ok: false, code: error?.code ?? "other", message: String(error?.message ?? error) };
		}
	}, [name, input]);

async function conversationId(w) {
	return w.page.evaluate(async () => {
		const project = (await window.namzu.projects())[0];
		return (await window.namzu.conversations(project.id))[0].id;
	});
}

const pane = (w) => w.page.locator("[data-browser-pane]");
const composer = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });

test("the pane shows by itself for Namzu's tab, marks it, shows a call, and hands control back and forth", { timeout: 360000 }, async () => {
	const fixture = await site();
	const world = await createWorld({
		answerHistory: true,
		tabs: "hidden",
		env: { NAMZU_E2E_AGENT_PANE: "1" },
		rules: [{ match: /hello/i, steps: [{ text: "Hello. I will look at a page for you." }] }],
	});
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		await send(world, "hello");
		await expect(world.page.getByText("Hello. I will look at a page for you.").first()).toBeVisible({ timeout: T });
		const id = await conversationId(world);
		await size(world, 1280, 833);
		await appearance(world, "dark");

		// Before: today's pane, opened by hand, holds no tab of Namzu's and says nothing about it.
		await world.page.keyboard.press("Control+Shift+B");
		await expect(pane(world)).toBeVisible({ timeout: T });
		assert.equal(await world.page.locator(".agent-mark, .browser-agent-bar").count(), 0);
		await shot(world, "before-pane-today");
		await size(world, 700, 700);
		await shot(world, "before-pane-today-700");
		await size(world, 1280, 833);
		await world.page.keyboard.press("Control+Shift+B");
		await expect(pane(world)).toHaveCount(0, { timeout: T });

		// Namzu opens its first tab: the pane shows by itself and the message box keeps the focus.
		await composer(world).click();
		const opened = await relay(world, "open", { conversationId: id });
		assert.equal(opened.ok, true, JSON.stringify(opened));
		const tabId = opened.value.tabId;
		await expect(pane(world)).toBeVisible({ timeout: T });
		assert.equal(
			await world.page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
			"Message Namzu",
			"the message box keeps the focus",
		);
		await expect(world.page.locator(".pane-tabs .agent-mark")).toHaveCount(1);
		await expect(world.page.getByTestId("agent-tab-bar")).toContainText("Namzu is using this tab");

		// It reads a page: the person sees it beside the conversation.
		const loaded = await world.app.evaluate(
			async (_, [conversation, tab, url]) => {
				const hook = globalThis.__namzuAgentPane;
				const done = new Promise((resolve) =>
					hook.onEvent((event) => {
						if (event.kind === "cdp" && event.tabId === tab && event.method === "Page.loadEventFired") resolve(true);
					}),
				);
				await hook.cdp({ conversationId: conversation, tabId: tab, method: "Page.enable" });
				await hook.cdp({ conversationId: conversation, tabId: tab, method: "Page.navigate", params: { url } });
				return done;
			},
			[id, tabId, `${fixture.base}/`],
		);
		assert.equal(loaded, true);
		await expect(world.page.locator(".pane-tabs")).toContainText("Fixture shop");
		// The mark settles a moment after the last call; the picture is of the tab at rest.
		await expect(world.page.getByTestId("agent-tab-bar")).not.toHaveAttribute("data-working", "true", { timeout: T });
		await shot(world, "agent-tab-dark");

		// A call is on the page: the tab says so, and the mark settles when the calls end.
		await relay(world, "cdp", { conversationId: id, tabId, method: "Runtime.enable" });
		await world.app.evaluate(
			(_, [conversation, tab]) => {
				const hook = globalThis.__namzuAgentPane;
				globalThis.__held = hook.cdp({
					conversationId: conversation,
					tabId: tab,
					method: "Runtime.evaluate",
					params: { expression: "new Promise((r) => { window.__release = r })", awaitPromise: true },
				});
			},
			[id, tabId],
		);
		await expect(world.page.getByTestId("agent-tab-bar")).toHaveAttribute("data-working", "true", { timeout: T });
		await expect(world.page.getByTestId("agent-tab-bar")).toContainText("working");
		await shot(world, "agent-tab-working");
		// A second call on the same tab while the first waits goes through, and the page lets the first go.
		const released = await relay(world, "cdp", {
			conversationId: id,
			tabId,
			method: "Runtime.evaluate",
			params: { expression: "window.__release(1), 1" },
		});
		assert.equal(released.ok, true, JSON.stringify(released));
		await world.app.evaluate(() => globalThis.__held);
		await expect(world.page.getByTestId("agent-tab-bar")).not.toHaveAttribute("data-working", "true", { timeout: T });

		// The person takes the tab: the agent's calls are refused, and the strip says who has it.
		await world.page.getByRole("button", { name: "Take over" }).click();
		await expect(world.page.getByTestId("agent-tab-bar")).toContainText("You have control");
		const refused = await relay(world, "cdp", {
			conversationId: id,
			tabId,
			method: "Runtime.evaluate",
			params: { expression: "1" },
		});
		assert.equal(refused.ok, false);
		assert.equal(refused.code, "human-in-control");
		await shot(world, "agent-tab-take-over");
		await world.page.getByRole("button", { name: "Hand back" }).click();
		await expect(world.page.getByTestId("agent-tab-bar")).toContainText("Namzu is using this tab");
		const again = await relay(world, "cdp", {
			conversationId: id,
			tabId,
			method: "Runtime.evaluate",
			params: { expression: "1" },
		});
		assert.equal(again.ok, true, JSON.stringify(again));

		await expect(world.page.getByTestId("agent-tab-bar")).not.toHaveAttribute("data-working", "true", { timeout: T });
		// Layout: both looks, a normal window and a narrow one, the strip in each state.
		for (const [width, height, name] of [
			[1280, 833, "1280"],
			[900, 700, "900"],
			[700, 700, "700"],
		]) {
			await size(world, width, height);
			for (const mode of ["dark", "light"]) {
				await appearance(world, mode);
				await shot(world, `agent-tab-${name}-${mode}`);
				await audit(world, `${mode} ${width} agent`);
			}
		}
		await size(world, 700, 700);
		await world.page.getByRole("button", { name: "Take over" }).click();
		await audit(world, "700 take over");
		await shot(world, "agent-tab-take-over-700-light");
		await world.page.getByRole("button", { name: "Hand back" }).click();

		// The person's own tabs are counted apart from Namzu's: Namzu's tab does not use one of the eight.
		await size(world, 1280, 833);
		const counts = await world.page.evaluate(
			async ([c, url]) => {
				let state;
				for (let i = 0; i < 9; i++) state = await window.namzu.browserPane(c, { kind: "new", address: url });
				return { person: state.tabs.filter((t) => t.owner === "person").length, agent: state.tabs.filter((t) => t.owner === "agent").length };
			},
			[id, `${fixture.base}/`],
		);
		assert.equal(counts.person, 8, "the person's own tabs stop at eight");
		assert.equal(counts.agent, 1, "Namzu's tab is still there beside them");
		const more = await relay(world, "open", { conversationId: id });
		assert.equal(more.ok, true, "Namzu can still open a tab of its own with the person's eight open");
		await size(world, 700, 700);
		await shot(world, "agent-tab-many-tabs-700-light");
		await audit(world, "700 many tabs");
		assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		fixture.server.close();
		await dispose(world, { failed });
	}
});

test("a sign-in in the Browser pane says so, shows no terminal command, and Show the tab reveals Namzu's tab", { timeout: 360000 }, async () => {
	const fixture = await site();
	const world = await createWorld({
		answerHistory: true,
		tabs: "hidden",
		env: {
			NAMZU_E2E_AGENT_PANE: "1",
			NAMZU_E2E_HANDOFF_WINDOW: "pane",
			...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
		},
		rules: [
			{
				match: /open the login/i,
				steps: [
					{ tool: "search_tools", args: { query: "browser navigate page" } },
					{ tool: "browser", args: { action: "navigate", url: `${fixture.base}/login` } },
					{ text: "The sign-in page is open and I am carrying on." },
				],
			},
		],
	});
	let failed = true;
	try {
		await launch(world);
		await openProject(world);
		await send(world, "open the login page");
		await world.page.getByRole("button", { name: /Accept/ }).first().click({ timeout: T });
		const card = world.page.getByRole("region", { name: "Namzu is waiting for you" });
		await expect(card).toBeVisible({ timeout: T });
		await expect(card).toContainText(`Sign in to ${fixture.host} in the Browser pane, then choose Continue.`);
		assert.equal(await card.getByText(/namzu browser login|terminal/i).count(), 0, "no terminal command");
		await expect(card.getByRole("button", { name: /^Continue/ })).toBeEnabled();
		await expect(card.getByRole("button", { name: /^Stop/ })).toBeEnabled();
		// Namzu's tab (opened here through the relay, as the engine's wiring will) is behind the button.
		const id = await conversationId(world);
		const opened = await relay(world, "open", { conversationId: id });
		assert.equal(opened.ok, true, JSON.stringify(opened));
		await expect(pane(world)).toBeVisible({ timeout: T });
		await world.page.keyboard.press("Control+Shift+B");
		await expect(pane(world)).toHaveCount(0, { timeout: T });
		await size(world, 1280, 833);
		await appearance(world, "dark");
		await shot(world, "signin-card-pane-dark");
		for (const [width, height] of [[900, 700], [700, 700]]) {
			await size(world, width, height);
			for (const mode of ["dark", "light"]) {
				await appearance(world, mode);
				await settled(world);
				const found = await world.page.evaluate(() => {
					const c = document.querySelector(".handoff-card");
					const b = c.getBoundingClientRect();
					const bad = [];
					if (b.left < 0 || b.right > window.innerWidth + 0.5) bad.push("card leaves the window");
					if (c.scrollWidth > c.clientWidth + 1) bad.push("card scrolls sideways");
					for (const el of c.querySelectorAll(".handoff-text, .approval-button")) {
						const r = el.getBoundingClientRect();
						if (r.right > b.right + 0.5 || r.left < b.left - 0.5) bad.push(`${el.className} sticks out`);
					}
					const actions = c.querySelector(".approval-actions")?.getBoundingClientRect();
					if (actions && actions.right > b.right + 0.5) bad.push("buttons stick out");
					return bad;
				});
				assert.deepEqual(found, [], `${mode} ${width}: the card passes the layout audit`);
				await shot(world, `signin-card-pane-${width}-${mode}`);
			}
		}
		await size(world, 1280, 833);
		await appearance(world, "dark");
		await card.getByRole("button", { name: "Show the tab" }).click();
		await expect(pane(world)).toBeVisible({ timeout: T });
		await expect(world.page.getByTestId("agent-tab-bar")).toBeVisible();
		await shot(world, "signin-card-pane-tab-shown");
		await card.getByRole("button", { name: /^Stop/ }).click();
		await expect(card).toHaveCount(0, { timeout: T });
		assert.deepEqual(world.faults ?? [], [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		fixture.server.close();
		await dispose(world, { failed });
	}
});
