// The agent's tab in the Browser pane, driven through the relay with raw protocol calls against the
// real Electron main: a tab opens for a conversation, is driven while hidden, a popup becomes a second
// agent tab, and the rules hold (a file outside the work folder, a refused method, another
// conversation's tab, a person who has taken over, a second debugger).
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/agent-pane-relay.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { freezeApp } from "./harness.mjs";
import { createRequire } from "node:module";
import { desktopRoot } from "./harness.mjs";

const require = createRequire(join(desktopRoot, "package.json"));
const { _electron } = require("@playwright/test");
const here = dirname(fileURLToPath(import.meta.url));

const PAGES = {
	"/": `<title>Fixture</title><h1>Fixture page</h1><a id=go href="/popup" target="_blank">Open popup</a>`,
	"/popup": "<title>Popup page</title><h1>Popup</h1>",
	"/drop": `<title>Drop</title><div id=z style="width:200px;height:200px">zone</div><script>
window.dropped = null;
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); window.dropped = [...e.dataTransfer.files].map((f) => f.name); });
</script>`,
	"/cookie": "<title>Cookie</title><p>sets one</p>",
};

let root;
let app;
let server;
let base;
let work;

before(async () => {
	root = mkdtempSync(join(tmpdir(), "namzu-agent-pane-"));
	work = join(root, "work");
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "index.html"), "<title>Local page</title><p>from the work folder</p>");
	writeFileSync(join(root, "secret.txt"), "outside");
	server = createServer((request, response) => {
		const body = PAGES[request.url?.split("?")[0] ?? ""];
		const headers = { "content-type": "text/html" };
		if (request.url?.startsWith("/cookie")) headers["set-cookie"] = "sid=HTTPONLYSECRET; HttpOnly";
		response.writeHead(body ? 200 : 404, headers);
		response.end(body ?? "not found");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${server.address().port}`;
	const appDir = freezeApp(root);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	app = await _electron.launch({
		executablePath: require("electron"),
		args: [join(here, "agent-pane-lab-main.cjs"), `--user-data-dir=${join(root, "user-data")}`, "--no-sandbox"],
		env: {
			PATH: process.env.PATH ?? "",
			DISPLAY: process.env.DISPLAY ?? "",
			HOME: home,
			USERPROFILE: home,
			LAB_DIST: join(appDir, "dist"),
			LAB_WORK_FOLDERS: JSON.stringify({ c1: work, c2: join(root, "other") }),
		},
	});
	await app.evaluate(async () => {
		while (!globalThis.__lab) await new Promise((resolve) => setImmediate(resolve));
	});
});

after(async () => {
	await app?.close().catch(() => undefined);
	await new Promise((resolve) => server?.close(resolve));
	if (root) rmSync(root, { recursive: true, force: true });
});

const call = (name, input) => app.evaluate((_, [n, i]) => globalThis.__lab.call(n, i), [name, input]);
const cdp = (conversationId, tabId, method, params, sessionId) =>
	call("cdp", { conversationId, tabId, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) });
const evaluate = async (conversationId, tabId, expression) => {
	const answer = await cdp(conversationId, tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
	assert.equal(answer.ok, true, JSON.stringify(answer));
	return answer.value.result.value;
};
const next = (fields, from = 0) => app.evaluate((_, [f, n]) => globalThis.__lab.next(f, n), [fields, from]);
const eventCount = () => app.evaluate(() => globalThis.__lab.events.length);

/** Goes to an address and waits for the page's own load event, so a read after it sees the page. */
async function go(conversationId, tabId, url) {
	const from = await eventCount();
	const started = await cdp(conversationId, tabId, "Page.navigate", { url });
	assert.equal(started.ok, true, JSON.stringify(started));
	await next({ kind: "cdp", tabId, method: "Page.loadEventFired" }, from);
}

let tab;

test("opens an agent tab, drives it while hidden and reads the page", { timeout: 30000 }, async () => {
	const opened = await call("open", { conversationId: "c1" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	tab = opened.value.tabId;
	assert.match(String(opened.value.targetInfo.targetId), /^[0-9A-F]+$/i);
	for (const method of ["Page.enable", "Runtime.enable", "Network.enable"])
		assert.equal((await cdp("c1", tab, method)).ok, true, method);
	await go("c1", tab, `${base}/`);
	assert.equal(await evaluate("c1", tab, "document.title"), "Fixture");
	// (Playwright starts Electron with a debugging port of its own, so "the app opens none" is checked by
	// the source: nothing under src/main adds the switch.)
	// The picture of a page that is not on screen. Chromium takes about four seconds over the first one of a
	// view that has never been shown (it waits for a frame); the test's own timeout covers that.
	const shot = await cdp("c1", tab, "Page.captureScreenshot", { format: "png" });
	assert.equal(shot.ok, true, JSON.stringify(shot).slice(0, 200));
	assert.equal(Buffer.from(shot.value.data, "base64").subarray(1, 4).toString(), "PNG");
});

test("a popup of the agent's page becomes a second agent tab the agent is told about", { timeout: 30000 }, async () => {
	const from = await eventCount();
	await evaluate("c1", tab, "document.getElementById('go').click(), 1");
	const added = await next({ kind: "tab-added", conversationId: "c1" }, from);
	assert.equal(added.openerTabId, tab);
	assert.notEqual(added.tabId, tab);
	const count = await app.evaluate(() => globalThis.__lab.host.agentTabs("c1").length);
	assert.equal(count, 2);
	// The popup is driven like the first tab.
	await cdp("c1", added.tabId, "Page.enable");
	assert.equal(
		await (async () => {
			const result = await evaluate("c1", added.tabId, "new Promise(r => document.readyState === 'complete' ? r(document.title) : addEventListener('load', () => r(document.title)))");
			return result;
		})(),
		"Popup page",
	);
});

test("a file inside the work folder loads; one outside it is refused, even through Page.navigate", { timeout: 30000 }, async () => {
	await go("c1", tab, `file://${join(work, "index.html")}`);
	assert.equal(await evaluate("c1", tab, "document.title"), "Local page");
	for (const url of [`file://${join(root, "secret.txt")}`, `file://${work}/../secret.txt`, "file:///etc/hostname"]) {
		const refused = await cdp("c1", tab, "Page.navigate", { url });
		assert.equal(refused.ok, false, url);
		assert.equal(refused.code, "address-refused", url);
	}
	// The page itself reaching for a file outside the folder does not get it either.
	const read = await evaluate("c1", tab, `fetch('file://${join(root, "secret.txt")}').then(r => r.text()).catch(() => 'blocked')`);
	assert.equal(read, "blocked");
});

test("a refused method, another conversation's tab and a made-up id are all refused", { timeout: 30000 }, async () => {
	const cookies = await cdp("c1", tab, "Network.getAllCookies");
	assert.deepEqual([cookies.ok, cookies.code], [false, "method-refused"]);
	const close = await cdp("c1", tab, "Browser.close");
	assert.deepEqual([close.ok, close.code], [false, "method-refused"]);
	const other = await call("open", { conversationId: "c2" });
	assert.equal(other.ok, true);
	const crossed = await cdp("c2", tab, "Runtime.evaluate", { expression: "1" });
	assert.deepEqual([crossed.ok, crossed.code], [false, "not-found"]);
	const back = await cdp("c1", other.value.tabId, "Runtime.evaluate", { expression: "1" });
	assert.deepEqual([back.ok, back.code], [false, "not-found"]);
	const made = await cdp("c1", "not-a-tab", "Runtime.evaluate", { expression: "1" });
	assert.deepEqual([made.ok, made.code], [false, "not-found"]);
	await call("close", { conversationId: "c2" });
});

test("a person's take-over pauses the agent, and a second debugger cannot attach", { timeout: 30000 }, async () => {
	const taken = await app.evaluate((_, id) => globalThis.__lab.relay.takeOver("c1", id), tab);
	assert.equal(taken, true);
	const paused = await cdp("c1", tab, "Runtime.evaluate", { expression: "1" });
	assert.deepEqual([paused.ok, paused.code], [false, "human-in-control"]);
	await app.evaluate((_, id) => globalThis.__lab.relay.handBack("c1", id), tab);
	assert.equal(await evaluate("c1", tab, "1 + 1"), 2);
	const second = await app.evaluate((_, id) => {
		const handle = globalThis.__lab.host.agentTab("c1", id);
		try {
			handle.contents.debugger.attach("1.3");
			return "attached";
		} catch (error) {
			return "refused";
		}
	}, tab);
	assert.equal(second, "refused");
});

test("a drop carries files only from the work folder", { timeout: 30000 }, async () => {
	await go("c1", tab, `${base}/drop`);
	const drag = (type, files) => cdp("c1", tab, "Input.dispatchDragEvent", { type, x: 50, y: 50, data: { items: [], files } });
	for (const type of ["dragEnter", "dragOver", "drop"]) {
		const refused = await drag(type, [join(root, "secret.txt")]);
		assert.deepEqual([refused.ok, refused.code], [false, "address-refused"], type);
	}
	assert.equal(await evaluate("c1", tab, "window.dropped"), null);
	// Another input method that could take a path does not exist; the ones a driver needs still work.
	const move = await cdp("c1", tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
	assert.equal(move.ok, true, JSON.stringify(move));
});

test("no cookie header reaches the agent, even a Set-Cookie seen while a response is paused", { timeout: 30000 }, async () => {
	for (const method of ["Page.enable", "Network.enable"]) await cdp("c1", tab, method);
	const on = await cdp("c1", tab, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
	assert.equal(on.ok, true, JSON.stringify(on));
	const from = await eventCount();
	// The navigation does not answer until the paused response is let go, so it is not awaited here.
	const started = cdp("c1", tab, "Page.navigate", { url: `${base}/cookie` });
	const paused = await next({ kind: "cdp", tabId: tab, method: "Fetch.requestPaused" }, from);
	const resumed = await cdp("c1", tab, "Fetch.continueResponse", { requestId: paused.params.requestId });
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	assert.equal((await started).ok, true);
	await next({ kind: "cdp", tabId: tab, method: "Page.loadEventFired" }, from);
	const seen = await app.evaluate((_, n) => JSON.stringify(globalThis.__lab.events.slice(n)), from);
	assert.doesNotMatch(seen, /HTTPONLYSECRET/);
	await cdp("c1", tab, "Fetch.disable");
});

test("closing lets go of every agent tab", { timeout: 30000 }, async () => {
	await call("close", { conversationId: "c1" });
	const left = await app.evaluate(() => globalThis.__lab.host.agentTabs("c1").length);
	assert.equal(left, 0);
	const gone = await cdp("c1", tab, "Runtime.evaluate", { expression: "1" });
	assert.equal(gone.ok, false);
});
