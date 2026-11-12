// The app keeps its engine current by itself, against the real Electron app: a stand-in feed on
// loopback holds a signed description and an archive of a small stand-in engine (it answers
// `--version` and the `initialize` exchange, nothing more, so no project is opened on it). A test key
// stands in for the signing key, and a stand-in for the engine inside the installer is named by
// NAMZU_KERNEL_TEST_BUNDLED_DIR; both are honoured only by an app that is not packaged.
//   - after the check, Settings > Updates says a newer engine is ready (and About still names the engine
//     that runs, because a running host is never swapped);
//   - a feed signed with another key changes nothing and says nothing alarming;
//   - with the setting off the feed is asked nothing, and turning it on asks;
//   - a feed that redirects every request is followed one hop at a time, with no cookie sent.
// Pictures go to ENGINE_SHOTS when it is set.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-engine-delivery.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildArchive,
	kernelFactsText,
	makeKey,
	manifestObject,
	signPair,
} from "../dist/main/kernel/kernel-test-support.js";
import { createWorld, dispose, expect, launch } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.ENGINE_SHOTS;
const PLATFORM = process.platform;
const ARCH = process.arch;

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** A stand-in engine: answers `--version`, and answers `initialize` as the real one does. */
function engineStub(version, engine) {
	return `
const fs = require('node:fs')
const VERSION = ${JSON.stringify(version)}
if (process.argv[2] === '--version') { console.log(VERSION); process.exit(0) }
let buffer = ''
process.stdin.on('data', (chunk) => {
	buffer += chunk
	for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
		const message = JSON.parse(buffer.slice(0, at))
		buffer = buffer.slice(at + 1)
		if (message.method === 'initialize') {
			if (process.env.NAMZU_E2E_ENGINE_LOG) fs.appendFileSync(process.env.NAMZU_E2E_ENGINE_LOG, VERSION + '\\n')
			process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
				agentInfo: { name: 'namzu' },
				extensions: ${JSON.stringify([
					"namzu/project/status",
					"namzu/project/trust",
					"namzu/conversations/list",
					"namzu/conversations/history",
					"namzu/providers/status",
					"namzu/providers/select",
					"namzu/jobs/list",
					"namzu/jobs/read",
					"namzu/jobs/stop",
				])},
				kernel: { engine: ${JSON.stringify(engine)}, dataEpoch: 1, commandLine: VERSION, desktopContract: 1 },
			} }) + '\\n')
		} else if (message.id !== undefined) {
			process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: /\\/list$/.test(message.method) ? [] : {} }) + '\\n')
		}
	}
})
process.stdin.on('end', () => process.exit(0))
`;
}

function files(version, engine) {
	return {
		"dist/bin.js": engineStub(version, engine),
		"package.json": JSON.stringify({ name: "@namzu/cli", version }),
		"kernel.json": kernelFactsText({ commandLine: version, engine, platform: PLATFORM, arch: ARCH }),
	};
}

/** The folder the app takes for the engine inside its installer. */
function bundledFolder(root) {
	const folder = join(root, "stand-in-installer-engine");
	for (const [name, text] of Object.entries(files("51.1.0", "62.13.0"))) {
		mkdirSync(join(folder, name, ".."), { recursive: true });
		writeFileSync(join(folder, name), text);
	}
	mkdirSync(join(folder, "node_modules", "@namzu", "sdk"), { recursive: true });
	writeFileSync(join(folder, "node_modules", "@namzu", "sdk", "package.json"), JSON.stringify({ version: "62.13.0" }));
	return folder;
}

/** A signed description of 52.0.0 and its archive, as the publisher makes them. */
function release(key, { keyId = key.id } = {}) {
	const built = buildArchive("52.0.0", files("52.0.0", "62.14.0"), { platform: PLATFORM, arch: ARCH });
	const iso = (at) => new Date(at).toISOString().replace(/\.\d{3}Z$/u, "Z");
	const now = Date.now();
	const pair = signPair(
		manifestObject({
			commandLine: "52.0.0",
			engine: "62.14.0",
			bundles: { [`${PLATFORM}-${ARCH}`]: built.bundle },
			issuedAt: iso(now - 60_000),
			expiresAt: iso(now + 14 * 86_400_000),
			minimumKernel: "51.0.0",
		}),
		key,
		{ keyId },
	);
	return new Map([
		["kernel-latest.json", pair.manifest],
		["kernel-latest.json.sig", pair.signature],
		[built.file, built.gz],
	]);
}

/** A feed on loopback that records every request and can hold the first manifest back. */
async function startFeed(served) {
	const state = { served, requests: [] };
	const server = createServer(async (req, res) => {
		const name = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
		state.requests.push({ name, headers: req.headers, url: req.url });
		// A feed behind a redirect (a release host sends downloads to another address).
		if (state.redirect && !(req.url ?? "").startsWith("/moved/"))
			return void res.writeHead(302, { location: `/moved${req.url}`, "set-cookie": "seen=1" }).end();
		await state.gate?.();
		const data = state.served.get(name);
		if (!data) return void res.writeHead(404).end();
		res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length }).end(data);
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	state.url = `http://127.0.0.1:${server.address().port}/`;
	state.close = () => new Promise((done) => server.close(done));
	return state;
}

async function openSettings(w, section) {
	const sections = w.page.getByRole("navigation", { name: "Settings sections" });
	if ((await sections.count()) === 0)
		await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(sections).toBeVisible({ timeout: T });
	await sections.getByRole("button", { name: section, exact: true }).click();
	await expect(w.page.getByRole("heading", { level: 1, name: section, exact: true })).toBeVisible({
		timeout: T,
	});
}

async function engineWorld(feed, { settings } = {}) {
	const key = makeKey("e2e1");
	const root = mkdtempSync(join(tmpdir(), "namzu-e2e-"));
	const world = await createWorld({
		keepRoot: root,
		noCli: true,
		seed: (ctx) => {
			ctx.bundled = bundledFolder(ctx.root);
			if (settings)
				writeFileSync(join(ctx.userData, "desktop-settings.json"), JSON.stringify({ version: 1, showConversationTabs: true, ...settings }));
		},
		env: {
			NAMZU_KERNEL_TEST_PUBLIC_KEY: `${key.id}:${key.publicKey}`,
			NAMZU_KERNEL_FEED_URL: feed?.url ?? "http://127.0.0.1:9/",
			NAMZU_KERNEL_FIRST_CHECK_MS: "300",
			NAMZU_E2E_ENGINE_LOG: join(root, "engine-hosts.log"),
		},
	});
	world.key = key;
	world.env.NAMZU_KERNEL_TEST_BUNDLED_DIR = world.bundled;
	return world;
}

/**
 * Holds the feed's answers until the app has started its first host (it starts one at launch for its
 * Pals), so a newer engine is never promoted by that start while a test is looking at "ready". A host
 * that never starts lets the answers through after a while; the assertions decide the outcome.
 */
function holdUntilFirstHost(feed, world) {
	const log = join(world.root, "engine-hosts.log");
	feed.gate = async () => {
		for (let waited = 0; !existsSync(log) && waited < 20000; waited += 50)
			await new Promise((resolve) => setTimeout(resolve, 50));
	};
}

const kernelDir = (w) => join(w.userData, "kernel");

test("the app finds a newer engine by itself, checks it, and says it is ready", { timeout: 240000 }, async () => {
	const feed = await startFeed(new Map());
	const world = await engineWorld(feed);
	feed.served = release(world.key);
	holdUntilFirstHost(feed, world);
	let failed = true;
	try {
		await launch(world);
		await openSettings(world, "Updates");
		const page = world.page.locator("#settings-content");
		await expect(page.getByText("A newer engine (52.0.0) is ready.")).toBeVisible({ timeout: T });
		await expect(page.getByText("It takes effect the next time a project opens.")).toBeVisible();
		await expect(page.getByRole("switch", { name: "Keep the engine up to date" })).toBeChecked();
		await shot(world, "updates-ready");

		// The three requests, in order, each with the one fixed header and nothing about the person.
		assert.deepEqual(
			feed.requests.map((r) => r.name),
			["kernel-latest.json", "kernel-latest.json.sig", "namzu-kernel-52.0.0-" + PLATFORM + "-" + ARCH + ".tar.gz"],
		);
		for (const { headers } of feed.requests) {
			assert.equal(headers["user-agent"], "namzu-desktop");
			assert.equal(headers.cookie, undefined);
			assert.equal(headers.authorization, undefined);
			console.log("request headers:", JSON.stringify(headers));
		}

		// On disk: the engine is kept, verified and waiting; nothing runs from it yet.
		const state = JSON.parse(readFileSync(join(kernelDir(world), "state.json"), "utf8"));
		assert.equal(state.pending, "52.0.0");
		assert.equal(state.current, undefined);
		assert.ok(existsSync(join(kernelDir(world), "versions", "52.0.0", "dist", "bin.js")));
		assert.ok(existsSync(join(kernelDir(world), "versions", "52.0.0.manifest.json")));
		assert.deepEqual(readdirSync(join(kernelDir(world), "tmp")), []);
		const log = readFileSync(join(kernelDir(world), "updates.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(log.some((entry) => entry.event === "check" && entry.result === "ready"));
		assert.ok(!JSON.stringify(log).includes(world.root), "the log names no folder of the person");

		// About says which engine runs, and that it is this app's own: a running host is never swapped.
		await openSettings(world, "About");
		const about = world.page.locator("#settings-content");
		await expect(about.getByText("This app’s own engine.")).toBeVisible({ timeout: T });
		await expect(about.getByText("51.1.0", { exact: true }).first()).toBeVisible();
		await shot(world, "about-own");
		console.log("hosts started:", existsSync(join(world.root, "engine-hosts.log")) ? readFileSync(join(world.root, "engine-hosts.log"), "utf8") : "none");
		assert.deepEqual(world.faults, []);
		failed = false;
	} finally {
		await feed.close();
		await dispose(world, { failed });
	}
});

test("a description signed with another key changes nothing and says nothing alarming", { timeout: 240000 }, async () => {
	const feed = await startFeed(new Map());
	const world = await engineWorld(feed);
	feed.served = release(makeKey("e2e1"));
	let failed = true;
	try {
		await launch(world);
		await openSettings(world, "Updates");
		const page = world.page.locator("#settings-content");
		await expect(page.getByText("Keep the engine up to date", { exact: true }).first()).toBeVisible({ timeout: T });
		// The check is certain to have happened once the feed was asked for the description.
		await expect.poll(() => feed.requests.length, { timeout: T }).toBeGreaterThanOrEqual(2);
		assert.ok(!feed.requests.some((r) => r.name.endsWith(".tar.gz")), "the archive is never fetched");
		await expect(page.getByText("Not checked yet.")).toBeVisible({ timeout: T });
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(page.getByText(/ready|Could not|went back/)).toHaveCount(0);
		await shot(world, "updates-foreign-key");
		const state = JSON.parse(readFileSync(join(kernelDir(world), "state.json"), "utf8"));
		assert.equal(state.pending, undefined);
		assert.equal(state.current, undefined);
		assert.deepEqual(state.bad, {});
		assert.deepEqual(readdirSync(join(kernelDir(world), "versions")), []);
		assert.deepEqual(world.faults, []);
		failed = false;
	} finally {
		await feed.close();
		await dispose(world, { failed });
	}
});

test("with the setting off nothing is asked, and turning it on asks", { timeout: 240000 }, async () => {
	const feed = await startFeed(new Map());
	const world = await engineWorld(feed, { settings: { keepEngineUpToDate: false } });
	feed.served = release(world.key);
	holdUntilFirstHost(feed, world);
	let failed = true;
	try {
		await launch(world);
		await openSettings(world, "Updates");
		const page = world.page.locator("#settings-content");
		const toggle = page.getByRole("switch", { name: "Keep the engine up to date" });
		await expect(toggle).not.toBeChecked({ timeout: T });
		await expect(page.getByText("Off. This app runs the engine it was installed with.")).toBeVisible();
		await shot(world, "updates-off");
		assert.equal(feed.requests.length, 0, "the feed was asked nothing with the setting off");
		await toggle.click();
		await expect(page.getByText("A newer engine (52.0.0) is ready.")).toBeVisible({ timeout: T });
		assert.ok(feed.requests.length >= 3, "turning the setting on made the check");
		// Off again: the screen says so, and no further request follows.
		const seen = feed.requests.length;
		await toggle.click();
		await expect(page.getByText("Off. This app runs the engine it was installed with.")).toBeVisible({ timeout: T });
		assert.equal(feed.requests.length, seen);
		assert.deepEqual(world.faults, []);
		failed = false;
	} finally {
		await feed.close();
		await dispose(world, { failed });
	}
});

test("a feed that redirects its answers is followed and ends ready, without a cookie", { timeout: 240000 }, async () => {
	const feed = await startFeed(new Map());
	feed.redirect = true;
	const world = await engineWorld(feed);
	feed.served = release(world.key);
	holdUntilFirstHost(feed, world);
	let failed = true;
	try {
		await launch(world);
		await openSettings(world, "Updates");
		const page = world.page.locator("#settings-content");
		await expect(page.getByText("A newer engine (52.0.0) is ready.")).toBeVisible({ timeout: T });
		assert.ok(feed.requests.some((request) => request.url?.startsWith("/moved/")));
		for (const request of feed.requests) assert.equal(request.headers.cookie, undefined);
		failed = false;
	} finally {
		await dispose(world, { failed });
		await feed.close();
	}
});
