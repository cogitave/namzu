// The whole chain of the agent's browser in the Browser pane, in the real app: Desktop (Electron), the real
// engine process behind it, the scripted model, the engine's pane channel over ACP, the relay in the app's
// main process and a tab of the pane. Nothing is driven through a back door: the scripted model makes
// the browser tool calls, the engine chooses the pane, and the test reads the result off the pane's own
// state (the tab list the window shows) and off what the model was sent.
//
// Case 1: navigate and snapshot a fixture page on 127.0.0.1; the tab is Namzu's, marked, and holds the page;
//         no browser of the engine's own is running.
// Case 2: a sign-in page stops the turn; the card says "in the Browser pane", the tab shows the login page,
//         the person signs in there (the fixture moves on), Continue resumes and the engine reads the page again.
// Case 3: the setting "window": the app offers nothing, the engine opens its own browser, the card says so.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-agent-pane-chain.test.mjs
// Cases 1 and 2 need no browser engine; case 3 needs PLAYWRIGHT_BROWSERS_PATH to a folder that holds one.
// Pictures go to $NAMZU_E2E_SHOTS when set.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import {
	createWorld,
	dispose,
	expect,
	launch,
	openProject,
	send,
} from "./harness.mjs";

const T = 120000;
const SHOTS = process.env.NAMZU_E2E_SHOTS;
const SHOP =
	'<title>Fixture shop</title><body style="font-family:sans-serif;margin:24px"><h1>Fixture shop</h1><p>A page Namzu is reading.</p><button>Add to basket</button></body>';
const FORM =
	'<title>Sign in</title><body style="font-family:sans-serif;margin:24px"><h1>Sign in</h1><form><input name="u" aria-label="User"><input type="password" name="p" aria-label="Password"></form></body>';
const WELCOME =
	'<title>Welcome back</title><body style="font-family:sans-serif;margin:24px"><h1>Welcome back</h1><p>You are signed in to the fixture.</p></body>';

async function site() {
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		response.statusCode = path.startsWith("/login") ? 401 : 200;
		response.setHeader("content-type", "text/html");
		response.end(
			path.startsWith("/login")
				? FORM
				: path.startsWith("/welcome")
					? WELCOME
					: SHOP,
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	return { server, base, host: `127.0.0.1:${server.address().port}` };
}

const requestText = (request) => JSON.stringify(request.messages ?? []);
const SEARCH = {
	tool: "search_tools",
	args: { query: "browser navigate page" },
};

async function settled(w) {
	await w.page.evaluate(
		() =>
			new Promise((resolve) => {
				const read = () =>
					[".chat-stage", "[data-browser-pane]", ".handoff-card", "aside"]
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

/** The picture is of the display cropped to the window: the page is a native view the app's own screenshot leaves out. */
async function shot(w, name) {
	if (!SHOTS) return;
	await settled(w);
	mkdirSync(SHOTS, { recursive: true });
	const file = join(SHOTS, `${name}.png`);
	const box = await w.app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0].getContentBounds(),
	);
	await w.page.evaluate(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			),
	);
	try {
		execFileSync(
			"import",
			[
				"-window",
				"root",
				"-crop",
				`${box.width}x${box.height}+${box.x}+${box.y}`,
				"+repage",
				file,
			],
			{
				env: process.env,
				stdio: "ignore",
			},
		);
	} catch {
		await w.page.screenshot({ path: file });
	}
}

async function appearance(w, next) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(
			new StorageEvent("storage", { key: "namzu.appearance", newValue: value }),
		);
	}, next);
	await expect(w.page.locator("html")).toHaveClass(
		next === "dark" ? /dark/ : /^(?!.*dark)/,
	);
}

async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [x, y]) => {
			for (const b of BrowserWindow.getAllWindows()) b.setContentSize(x, y);
		},
		[width, height],
	);
	await w.page.waitForFunction(
		([x]) => Math.abs(window.innerWidth - x) < 2,
		[width],
	);
	await settled(w);
}

/** Every picture of a moment, at both widths and both looks, each one through the layout audit. */
async function pictures(w, moment) {
	for (const [width, height] of [
		[1280, 833],
		[900, 700],
	]) {
		await size(w, width, height);
		for (const mode of ["light", "dark"]) {
			await appearance(w, mode);
			await settled(w);
			const found = await w.page.evaluate(() => {
				const bad = [];
				if (document.documentElement.scrollWidth > window.innerWidth + 1)
					bad.push("the window scrolls sideways");
				const pane = document.querySelector("[data-browser-pane]");
				if (pane) {
					const b = pane.getBoundingClientRect();
					if (b.width < 120)
						bad.push(`the pane is only ${Math.round(b.width)} wide`);
					if (b.left < 0 || b.right > window.innerWidth + 0.5)
						bad.push("the pane leaves the window");
					const bar = document.querySelector(".browser-agent-bar");
					if (bar) {
						const r = bar.getBoundingClientRect();
						if (r.right > b.right + 0.5 || r.left < b.left - 0.5)
							bad.push("the agent strip sticks out");
						if (bar.scrollWidth > bar.clientWidth + 1)
							bad.push("the agent strip scrolls sideways");
						const button = bar.querySelector("button")?.getBoundingClientRect();
						const words = bar
							.querySelector(".browser-agent-words")
							?.getBoundingClientRect();
						if (button && words && words.right > button.left + 0.5)
							bad.push("the words run under the button");
					}
				}
				const card = document.querySelector(".handoff-card");
				if (card) {
					const b = card.getBoundingClientRect();
					if (b.left < 0 || b.right > window.innerWidth + 0.5)
						bad.push("the card leaves the window");
					if (card.scrollWidth > card.clientWidth + 1)
						bad.push("the card scrolls sideways");
					for (const el of card.querySelectorAll(
						".handoff-text, .approval-button",
					)) {
						const r = el.getBoundingClientRect();
						if (r.right > b.right + 0.5 || r.left < b.left - 0.5)
							bad.push(`${el.className} sticks out`);
					}
					const buttons = [
						...card.querySelectorAll(".approval-button, .handoff-link"),
					].map((el) => Math.round(el.getBoundingClientRect().top));
					if (new Set(buttons).size > 1)
						bad.push("the card's actions are on more than one row");
					const link = card
						.querySelector(".handoff-link")
						?.getBoundingClientRect();
					const stop = card
						.querySelector("[data-action=stop]")
						?.getBoundingClientRect();
					const go = card
						.querySelector("[data-action=continue]")
						?.getBoundingClientRect();
					if (link && stop && link.right > stop.left)
						bad.push("Show the tab is not left of Stop");
					if (
						stop &&
						go &&
						(stop.right > go.left || Math.abs(go.right - b.right) > 40)
					)
						bad.push("Stop and Continue are not together on the right");
					const composer = document
						.querySelector("[data-chat-composer-body]")
						?.getBoundingClientRect();
					if (composer && b.bottom > composer.top + 24)
						bad.push("the card covers the message box");
				}
				return bad;
			});
			assert.deepEqual(found, [], `${moment} ${mode} ${width}: layout audit`);
			await shot(w, `${moment}-${width}-${mode}`);
		}
	}
	await size(w, 1280, 833);
	await appearance(w, "dark");
}

/** The tabs of the window's Browser pane for a conversation, as the window itself holds them. */
const paneTabs = (w, id) =>
	w.page.evaluate(
		async (c) => (await window.namzu.browserPane(c, { kind: "state" })).tabs,
		id,
	);
const conversationId = (w) =>
	w.page.evaluate(async () => {
		const project = (await window.namzu.projects())[0];
		return (await window.namzu.conversations(project.id))[0].id;
	});

/** Every process below the app, as its arguments say. */
async function descendants(w) {
	const root = await w.app.evaluate(() => process.pid);
	const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
		encoding: "utf8",
	})
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
		.filter(Boolean)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
	const found = new Set([root]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const row of rows)
			if (found.has(row.ppid) && !found.has(row.pid))
				found.add(row.pid), (grew = true);
	}
	return rows.filter((row) => found.has(row.pid) && row.pid !== root);
}

/** A browser of its own would be a Chromium of the engine's, never one of Electron's own helpers. */
const ownBrowsers = (rows) =>
	rows.filter(
		(row) =>
			/ms-playwright|chrome-linux|headless_shell/.test(row.args) &&
			!/electron@/.test(row.args),
	);

const card = (w) =>
	w.page.getByRole("region", { name: "Namzu is waiting for you" });
const accept = async (w) => {
	await w.page
		.getByRole("button", { name: /Accept/ })
		.first()
		.click({ timeout: T });
};

function chain(name, options, body) {
	test(name, { timeout: 480000 }, async () => {
		const fixture = await site();
		const world = await createWorld({
			answerHistory: true,
			tabs: "hidden",
			...options(fixture),
		});
		let failed = true;
		try {
			await launch(world);
			await openProject(world);
			await body(world, fixture);
			assert.deepEqual(
				world.faults ?? [],
				[],
				"the renderer raised no uncaught errors",
			);
			failed = false;
		} finally {
			fixture.server.close();
			await dispose(world, { failed });
		}
	});
}

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
	? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
	: {};

chain(
	"the agent reads a page in a tab of the Browser pane, the whole way from the model's call to the model's result",
	(fixture) => ({
		rules: [
			{
				match: /read the shop/i,
				steps: [
					SEARCH,
					{
						tool: "browser",
						args: { action: "navigate", url: `${fixture.base}/` },
					},
					{ tool: "browser", args: { action: "snapshot" } },
					{ text: "I read the shop page in the pane.", hold: "finish" },
				],
			},
		],
	}),
	async (w, fixture) => {
		await send(w, "read the shop page");
		await accept(w);
		// Held before the last answer: the tool calls are done and the tab is at rest.
		await expect
			.poll(() => w.model.requests.length, { timeout: T })
			.toBeGreaterThanOrEqual(4);
		const id = await conversationId(w);
		await expect(w.page.locator("[data-browser-pane]")).toBeVisible({
			timeout: T,
		});
		await expect(w.page.locator(".pane-tabs .agent-mark")).toHaveCount(1);
		await expect(w.page.getByTestId("agent-tab-bar")).toContainText(
			"Namzu is using this tab",
		);
		await expect(w.page.getByTestId("agent-tab-bar")).not.toHaveAttribute(
			"data-working",
			"true",
			{ timeout: T },
		);

		// The page in Namzu's tab is the fixture's, read through the pane and not through the engine.
		const tabs = await paneTabs(w, id);
		const mine = tabs.filter((t) => t.owner === "agent");
		assert.equal(mine.length, 1, "one tab is Namzu's");
		assert.equal(mine[0].address, `${fixture.base}/`);
		assert.equal(mine[0].title, "Fixture shop");
		assert.equal(
			tabs.filter((t) => t.owner === "person").length,
			0,
			"no tab of the person's was used",
		);

		// The tool results reached the model, and say what the page holds.
		const seen = w.model.requests.map(requestText).join("\n");
		assert.match(seen, /Fixture shop/);
		assert.match(seen, /Add to basket/);
		assert.match(seen, /Fixture shop/);

		// No browser of the engine's own is running under the app.
		assert.deepEqual(
			ownBrowsers(await descendants(w)).map((r) => r.args.slice(0, 120)),
			[],
			"the engine started no Chromium of its own",
		);

		await pictures(w, "chain-working");
		w.model.release("finish");
		await expect(
			w.page.getByText("I read the shop page in the pane.").first(),
		).toBeVisible({ timeout: T });
		await shot(w, "chain-done-1280-dark");
	},
);

chain(
	"a sign-in page in the pane stops the turn, the person signs in there, and Continue makes the engine read the page again",
	(fixture) => ({
		rules: [
			{
				match: /open the login/i,
				steps: [
					SEARCH,
					{
						tool: "browser",
						args: { action: "navigate", url: `${fixture.base}/login` },
					},
					{ tool: "browser", args: { action: "snapshot" } },
					{ text: "The sign-in worked and I am carrying on." },
				],
			},
		],
	}),
	async (w, fixture) => {
		await send(w, "open the login page");
		await accept(w);
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(card(w)).toContainText(
			`Sign in to ${fixture.host} in the Browser pane, then choose Continue.`,
		);
		assert.equal(
			await card(w)
				.getByText(/namzu browser login|terminal|browser window Namzu opened/i)
				.count(),
			0,
			"no terminal command, no window",
		);
		const id = await conversationId(w);
		// The tab is Namzu's and holds the login page.
		await expect(w.page.locator("[data-browser-pane]")).toBeVisible({
			timeout: T,
		});
		const tabs = await paneTabs(w, id);
		const mine = tabs.filter((t) => t.owner === "agent");
		assert.equal(mine.length, 1);
		assert.equal(mine[0].address, `${fixture.base}/login`);
		assert.equal(mine[0].title, "Sign in");
		assert.deepEqual(
			ownBrowsers(await descendants(w)).map((r) => r.args.slice(0, 120)),
			[],
		);
		// The pane shows Namzu's tab, so the card has nothing to show: Stop and Continue are all it offers.
		assert.equal(
			await card(w).getByRole("button", { name: "Show the tab" }).count(),
			0,
		);
		await pictures(w, "chain-signin");
		// The person closed the pane: the card offers to show the tab, left of Stop and Continue, on one row.
		await w.page.keyboard.press("Control+Shift+B");
		await expect(w.page.locator("[data-browser-pane]")).toHaveCount(0, {
			timeout: T,
		});
		await expect(
			card(w).getByRole("button", { name: "Show the tab" }),
		).toBeVisible();
		await pictures(w, "chain-signin-pane-closed");
		await card(w).getByRole("button", { name: "Show the tab" }).click();
		await expect(w.page.locator("[data-browser-pane]")).toBeVisible({
			timeout: T,
		});
		await expect(
			card(w).getByRole("button", { name: "Show the tab" }),
		).toHaveCount(0);

		// The person signs in in the tab: here the page moves on, as a real sign-in would.
		await w.page.evaluate(
			async ([c, tab, url]) => {
				await window.namzu.browserPane(c, { kind: "select", tabId: tab });
				await window.namzu.browserPane(c, { kind: "go", address: url });
			},
			[id, mine[0].id, `${fixture.base}/welcome`],
		);
		await expect
			.poll(
				async () =>
					(await paneTabs(w, id)).find((t) => t.owner === "agent")?.title,
				{ timeout: T },
			)
			.toBe("Welcome back");
		const before = w.model.requests.length;
		await card(w)
			.getByRole("button", { name: /^Continue/ })
			.click();
		await expect(card(w)).toHaveCount(0, { timeout: T });
		await expect(
			w.page.getByText("The sign-in worked and I am carrying on.").first(),
		).toBeVisible({ timeout: T });
		const asked = w.model.requests.slice(before).map(requestText).join("\n");
		assert.match(asked, /The person chose to continue/);
		assert.match(
			asked,
			/Welcome back/,
			"the engine read the page again, and the model got what it holds",
		);
		await pictures(w, "chain-continued");
	},
);

chain(
	"with the setting on a window of its own the app offers no pane, and the engine says so on the card",
	(fixture) => {
		return {
			env: browsers,
			seed: (world) => {
				writeFileSync(
					join(world.userData, "desktop-settings.json"),
					JSON.stringify({ version: 1, agentBrowser: "window" }),
				);
			},
			rules: [
				{
					match: /open the login/i,
					steps: [
						SEARCH,
						{
							tool: "browser",
							args: { action: "navigate", url: `${fixture.base}/login` },
						},
						{ text: "Should not be reached." },
					],
				},
			],
		};
	},
	async (w, fixture) => {
		await send(w, "open the login page");
		await accept(w);
		await expect(card(w)).toBeVisible({ timeout: T });
		await expect(card(w)).toContainText(
			`Sign in to ${fixture.host} in the browser window Namzu opened`,
		);
		assert.equal(
			await card(w)
				.getByText(/Browser pane/)
				.count(),
			0,
			"the card does not name the pane",
		);
		const id = await conversationId(w);
		assert.equal(
			(await paneTabs(w, id)).filter((t) => t.owner === "agent").length,
			0,
			"no tab of Namzu's in the pane",
		);
		assert.equal(
			await w.page.locator(".agent-mark, .browser-agent-bar").count(),
			0,
		);
		await shot(w, "chain-window-setting-1280-dark");
		await card(w).getByRole("button", { name: /^Stop/ }).click();
		await expect(card(w)).toHaveCount(0, { timeout: T });
	},
);
