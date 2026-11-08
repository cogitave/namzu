// A window that crashes, hangs or fails to load, and saved files that cannot be read, against the
// real Electron app. Pictures go to research/desktop-recovery-20261108/.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/recovery.test.mjs
// Nothing here waits on the wall clock: each step awaits the state it needs (the Playwright
// auto-waiting `expect`, or `expect.poll` on a fact read from the main process).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	createWorld,
	dispose,
	expect,
	freezeApp,
	launch,
	relaunch,
	repoRoot,
} from "./harness.mjs";

const T = 60000;

const SHOTS = resolve(repoRoot, "research/desktop-recovery-20261108");

function flow(name, options, body) {
	test(name, { timeout: 300000 }, async () => {
		const world = await createWorld(options);
		let failed = true;
		try {
			await body(world);
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

/** Count what the main process hears from the first window, from now on. */
async function watchWindow(w) {
	await w.app.evaluate(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows()[0];
		const seen = (globalThis.__recovery = { gone: [], unresponsive: 0, loads: [] });
		win.webContents.on("render-process-gone", (_e, d) => seen.gone.push(d.reason));
		win.on("unresponsive", () => seen.unresponsive++);
		win.webContents.on("did-finish-load", () => seen.loads.push(win.webContents.getURL().startsWith("file:") ? "app" : "other"));
	});
}
const seen = (w) => w.app.evaluate(() => globalThis.__recovery);
const crash = (w) =>
	w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
const currentUrl = (w) =>
	w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
const onCard = async (w) => (await currentUrl(w)).startsWith("data:text/html");
const onApp = async (w) => (await currentUrl(w)).startsWith("file:");

// Playwright's page is dead after a renderer crash ("Target crashed") and does not come back with
// the reloaded document, so everything after a crash reads and drives the window from main.
const evalIn = (w, code) =>
	w.app.evaluate(
		({ BrowserWindow }, source) => {
			const contents = BrowserWindow.getAllWindows()[0].webContents;
			// On a crashed page executeJavaScript never settles, so ask only a page that is there.
			return contents.isCrashed() ? undefined : contents.executeJavaScript(source);
		},
		code,
	);
/** Poll a page expression until it is true; an evaluation that fails mid-load counts as not yet. */
const until = (w, code, timeout = T) =>
	expect.poll(() => evalIn(w, code).catch(() => false), { timeout }).toBe(true);
const APP_READY = `location.protocol === 'file:' && document.readyState === 'complete' &&
	[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Add new project')`;
const appIsBack = (w) => until(w, APP_READY);

async function shoot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	const base64 = await w.app.evaluate(async ({ BrowserWindow }) =>
		(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"),
	);
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(base64, "base64"));
}

/** A real mouse click on the element the selector finds, through the input path. */
async function clickOn(w, selector) {
	const rect = await evalIn(
		w,
		`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
	);
	await w.app.evaluate(({ BrowserWindow }, at) => {
		const wc = BrowserWindow.getAllWindows()[0].webContents;
		wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
		wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
		wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
	}, rect);
}

const cardFacts = (w) =>
	evalIn(
		w,
		`({
			heading: document.querySelector('h1')?.textContent,
			alert: document.querySelector('div[role=alert]')?.textContent ?? '',
			main: document.querySelectorAll('main').length,
			scripts: document.scripts.length,
			focused: document.activeElement?.textContent,
			strip: getComputedStyle(document.querySelector('.drag')).height,
			background: getComputedStyle(document.body).backgroundColor,
			text: document.body.innerText,
		})`,
	);

async function setScheme(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}

/** Crash the window `times` times; each but the last is answered by a reload (0.5, 2 then 10 seconds). */
async function crashUntilCard(w, from = 0) {
	for (let index = 1; index <= 4; index++) {
		await crash(w);
		await expect.poll(async () => (await seen(w)).gone.length, { timeout: T }).toBe(from + index);
		if (index < 4) await appIsBack(w);
	}
	await expect.poll(() => onCard(w), { timeout: T }).toBe(true);
}

flow("a window that keeps crashing is reloaded three times, then shows the card", {}, async (w) => {
	await launch(w);
	await appIsBack(w);
	await watchWindow(w);
	await crashUntilCard(w);
	// Three reloads happened (the fourth crash got the card instead of a fifth load).
	assert.deepEqual((await seen(w)).loads.filter((u) => u === "app").length, 3);
	const card = await cardFacts(w);
	assert.equal(card.heading, "Namzu stopped working");
	assert.match(card.alert, /reloading it did not help/);
	assert.equal(card.main, 1, "the page keeps its main landmark");
	assert.equal(card.scripts, 0, "the card runs no script");
	assert.equal(card.focused, "Reload", "Reload has the focus");
	assert.equal(card.strip, "36px");
	assert.equal(card.background, "rgb(23, 23, 23)", "dark until main hears otherwise");
	assert.equal(await evalIn(w, "document.querySelector('div[role=alert]').parentElement.tagName"), "MAIN");
	await shoot(w, "card-crash-dark");
	await clickOn(w, "summary");
	await until(w, "document.body.innerText.includes('Namzu reloaded the window 3 times in the last minute.')");
	const details = await evalIn(w, "document.body.innerText");
	assert.match(details, /The window’s process crashed \(exit code \d+\)\./);
	assert.match(details, /Press Ctrl\+Shift\+L to open the diagnostic logs, which show what Namzu recorded\./);
	await shoot(w, "card-crash-details-dark");
	// The link works, and the count starts again.
	await clickOn(w, "a");
	await appIsBack(w);
	await crash(w);
	await expect.poll(async () => (await seen(w)).gone.length, { timeout: T }).toBe(5);
	await appIsBack(w);
});

flow("the card follows the scheme main last heard, and a window showing it can be closed", {}, async (w) => {
	await launch(w);
	await appIsBack(w);
	await setScheme(w, "light");
	await expect
		.poll(() => w.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), { timeout: T })
		.toBe("light");
	await watchWindow(w);
	await crashUntilCard(w);
	assert.equal((await cardFacts(w)).background, "rgb(247, 247, 247)");
	await shoot(w, "card-crash-light");
	const exited = new Promise((done) => w.app.process().once("exit", done));
	void w.app
		.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
		.catch(() => undefined);
	// The only window: closing it ends the app at once, with no page left to acknowledge anything.
	await exited;
});

flow("a page that does not load shows the card, keeps the window, and Reload loads it once it is back", {}, async (w) => {
	const page = join(freezeApp(w.root), "dist/renderer/index.html");
	const original = readFileSync(page);
	rmSync(page);
	await launch(w);
	await expect.poll(() => onCard(w), { timeout: T }).toBe(true);
	assert.equal(await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, "the window stays open");
	const card = await cardFacts(w);
	assert.equal(card.heading, "Namzu could not open its window");
	await clickOn(w, "summary");
	await until(w, "document.body.innerText.includes('files are missing or cannot be read')");
	await shoot(w, "card-load-failed-dark");
	writeFileSync(page, original);
	await clickOn(w, "a");
	await appIsBack(w);
});

flow("a development server that is not running reads as that", {
	seed: async (w) => {
		// A port that was free a moment ago and has nothing listening on it now.
		const server = createServer();
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		const { port } = server.address();
		await new Promise((done) => server.close(done));
		w.env = { ...w.env, NAMZU_DESKTOP_DEV_URL: `http://127.0.0.1:${port}/` };
	},
}, async (w) => {
	await launch(w);
	await expect.poll(() => onCard(w), { timeout: T }).toBe(true);
	await clickOn(w, "summary");
	await until(w, "document.body.innerText.includes('The development server did not answer')");
});

flow("a window that stops answering is ended after the grace period and reloaded", {}, async (w) => {
	await launch(w);
	await appIsBack(w);
	await watchWindow(w);
	// A real busy loop in the page. Chromium's own hang monitor only runs for a window the display
	// shows and focuses (the virtual display has no window manager), so the event it would raise
	// is raised on the window here; what Namzu does with it, and with the stuck process, is real.
	// (Started from main on a timer, so Playwright has no call in flight against the page it ends.)
	await w.app.evaluate(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows()[0];
		void win.webContents.executeJavaScript("setTimeout(() => { for (;;); }, 0)");
		win.emit("unresponsive");
	});
	await expect.poll(async () => (await seen(w)).unresponsive, { timeout: 120000 }).toBeGreaterThan(0);
	// Namzu ends the stuck process itself after its grace period, then reloads.
	await expect.poll(async () => (await seen(w)).gone.length, { timeout: 120000 }).toBe(1);
	await appIsBack(w);
});

const FILES = ["desktop-settings.json", "workspace-layout.json", "projects.json"];
const DAMAGED = "{ this is not json";
const TOLD = "document.body.innerText.includes('set aside, not deleted')";
flow("damaged settings, layout and project files are set aside, start on defaults, and are told once", {
	seed: (w) => {
		for (const name of FILES) writeFileSync(join(w.userData, name), `${DAMAGED} ${name}`);
	},
}, async (w) => {
	await launch(w);
	await appIsBack(w);
	for (const name of FILES)
		assert.equal(readFileSync(join(w.userData, `${name}.bad`), "utf8"), `${DAMAGED} ${name}`, `${name} kept as .bad`);
	assert.equal(existsSync(join(w.userData, "desktop-settings.json")), false, "no settings were invented");
	await until(w, TOLD);
	assert.match(await evalIn(w, "document.body.innerText"), /could not read your saved settings, window layout and project list/);
	await shoot(w, "notice-damaged-files");
	// The window dies with the notice unread: the reloaded page is handed it again.
	await watchWindow(w);
	await crash(w);
	await expect.poll(async () => (await seen(w)).gone.length, { timeout: T }).toBe(1);
	await appIsBack(w);
	await until(w, TOLD);
	// Dismissing is the acknowledgement. A second call with the same id is answered after the
	// first one was handled (one channel, in order), so no later reload can race it.
	const id = await evalIn(w, "window.namzu.boot.notice.id");
	await evalIn(w, "document.querySelector('button[aria-label=\"Dismiss notification\"]').click()");
	await until(w, `!(${TOLD})`);
	await evalIn(w, `window.namzu.acknowledgeNotice(${JSON.stringify(id)})`);
	await crash(w);
	await expect.poll(async () => (await seen(w)).gone.length, { timeout: T }).toBe(2);
	await appIsBack(w);
	assert.equal(await evalIn(w, "window.namzu.boot?.notice ?? null"), null);
	assert.equal(await evalIn(w, TOLD), false);
	// A restart on the repaired files says nothing either.
	await relaunch(w);
	await appIsBack(w);
	assert.equal(await w.page.evaluate(() => window.namzu.boot?.notice ?? null), null);
});

for (const name of FILES) {
	flow(`a damaged ${name} alone is set aside and the app still starts`, {
		seed: (w) => writeFileSync(join(w.userData, name), DAMAGED),
	}, async (w) => {
		await launch(w);
		await appIsBack(w);
		assert.equal(readFileSync(join(w.userData, `${name}.bad`), "utf8"), DAMAGED);
		await until(w, TOLD);
	});
}

flow("the graphics setting is a switch, saved on change and applied at the next start", {}, async (w) => {
	await launch(w);
	await appIsBack(w);
	// (A headless display has no graphics card, so the switch Electron sets is what shows the setting.)
	const accelerationOff = () => w.app.evaluate(({ app }) => app.commandLine.hasSwitch("disable-gpu"));
	assert.equal(await accelerationOff(), false);
	const openGeneral = async () => {
		await w.page.getByRole("button", { name: "Settings", exact: true }).click();
		const nav = w.page.getByRole("navigation", { name: "Settings sections" });
		await expect(nav).toBeVisible({ timeout: T });
		await nav.getByRole("button", { name: "General", exact: true }).click();
		return w.page.getByRole("switch", { name: "Use the graphics card" });
	};
	const toggle = await openGeneral();
	await expect(toggle).toBeChecked({ timeout: T });
	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect
		.poll(() => JSON.parse(readFileSync(join(w.userData, "desktop-settings.json"), "utf8")).hardwareAcceleration, { timeout: T })
		.toBe(false);
	await shoot(w, "settings-graphics-off");
	// The running window is unchanged; the next start draws in software.
	assert.equal(await accelerationOff(), false);
	await relaunch(w);
	await appIsBack(w);
	assert.equal(await accelerationOff(), true);
	await expect(await openGeneral()).not.toBeChecked({ timeout: T });
});
