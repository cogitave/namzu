// The app keeps its engine current by itself, against the real Electron app AND REAL ENGINES: nothing here
// is a stand-in for the engine. The engine inside the "installer" (A) is a real staged command line of
// this checkout; the engines on the feed are the same staged folder with a higher version where the
// command line reads it, asked again for kernel.json by the publisher's own step. Every piece of the
// feed is made with the publisher's functions (stage, pack, assemble, sign) with a throwaway key:
//   B  newer than A: the good update
//   C  newer than B: passes the self-check, but its host dies as soon as it starts in a project folder
//   D  newer still, with another data epoch: the app needs a newer version of itself
//   a later description of D that withdraws B
//   an older signed pair for B's version (for the tampering case)
// The scripted model answers the conversations; no network beyond loopback.
//
// SLOW: staging and packing take about 90 seconds before the first test, and each test is a real app
// start with real engines of 95 MB (3 to 65 s). The whole file took 224 seconds cold on the machine it was
// written on, 130 with the staged engines kept. `pnpm test:e2e` includes it through its glob; to leave it
// out, name the files you want. It needs `pnpm -r build` first.
//   NAMZU_E2E_REAL_ENGINE_DIR=<dir>   keep the staged engines and the feed in <dir> and reuse them on the
//                                     next run (a folder that holds ready.json); without it a temp folder
//                                     is made and removed.
//   ENGINE_REAL_SHOTS=<dir>           write pictures, dark and light for the main states.
// Run: pnpm -r build && xvfb-run -a node --test e2e/ux-engine-real.test.mjs
import assert from "node:assert/strict";
import {
	appendFileSync,
	cpSync,
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseTarget } from "../scripts/lean-cli.mjs";
import { kernelJsonText, readKernelFacts } from "../scripts/kernel/facts.mjs";
import { assembleManifest, manifestBytes, parseManifest, reissueManifest } from "../scripts/kernel/manifest.mjs";
import { packKernel } from "../scripts/kernel/pack.mjs";
import { makeKeyPair, privateKeyFromText, signManifest } from "../scripts/kernel/signing.mjs";
import { stageKernel } from "../scripts/kernel/stage.mjs";
import { createWorld, dispose, expect, launch, openModelMore, openProject, relaunch, send } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.ENGINE_REAL_SHOTS;
const TARGET = `${process.platform}-${process.arch}`;
const WRITE = {
	match: /write the file/i,
	steps: [{ tool: "write", args: { path: "out.txt", content: "hello from the model\n" } }, { text: "Wrote out.txt." }],
};

// ---------------------------------------------------------------------------------------------
// The release: real staged engines, packed, described and signed with the publisher's functions.
// ---------------------------------------------------------------------------------------------

const bump = (version, minor) => {
	const [major, m] = version.split(".").map(Number);
	return `${major}.${m + minor}.0`;
};
const iso = (at) => new Date(at).toISOString().replace(/\.\d{3}Z$/u, "Z");

/** Copy a staged folder, set the version where the command line reads it, optionally break it, ask it again. */
async function variant(from, to, version, mode) {
	rmSync(to, { recursive: true, force: true });
	cpSync(from, to, { recursive: true });
	const pj = join(to, "package.json");
	writeFileSync(pj, `${JSON.stringify({ ...JSON.parse(readFileSync(pj, "utf8")), version }, null, "\t")}\n`);
	if (mode === "epoch2") {
		const found = [];
		const walk = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.js$/u.test(entry.name) && /\bDATA_EPOCH = 1;/u.test(readFileSync(full, "utf8"))) found.push(full);
			}
		};
		walk(join(to, "dist"));
		walk(join(to, "node_modules", "@namzu", "sdk", "dist", "constants"));
		assert.ok(found.length >= 2, "the data epoch is found in the bundle and in the engine package");
		for (const file of found) writeFileSync(file, readFileSync(file, "utf8").replace(/\bDATA_EPOCH = 1;/u, "DATA_EPOCH = 2;"));
	}
	if (mode === "extra") writeFileSync(join(to, "ADDED.txt"), "a file the older build did not have\n");
	if (mode === "noproject") {
		// Answers `--version` and `initialize` as the real engine does; as a host it dies the moment it starts
		// in a folder that is a project, which the self-check (a scratch folder) never does.
		const bin = join(to, "dist", "bin.js");
		const lines = readFileSync(bin, "utf8").split("\n");
		const at = lines.findIndex((line) => line.startsWith("import { createRequire"));
		lines.splice(
			at + 2,
			0,
			"import { existsSync as __probe, appendFileSync as __note } from 'node:fs'; if (process.argv.includes('acp') && __probe(process.cwd() + '/.git')) { if (process.env.NAMZU_E2E_C_LOG) __note(process.env.NAMZU_E2E_C_LOG, 'start\\n'); console.error('this engine cannot serve a project'); process.exit(3) }",
		);
		writeFileSync(bin, lines.join("\n"));
	}
	const facts = await readKernelFacts({ cliDir: to, target: parseTarget(TARGET) });
	writeFileSync(join(to, "kernel.json"), kernelJsonText(facts));
	return facts;
}

async function buildRelease(dir) {
	mkdirSync(dir, { recursive: true });
	const started = Date.now();
	const log = () => {};
	const A = join(dir, "A");
	await stageKernel({ out: A, target: parseTarget(TARGET), log });
	const a = JSON.parse(readFileSync(join(A, "package.json"), "utf8")).version;
	const versions = { A: a, B: bump(a, 1), C: bump(a, 2), D: bump(a, 3) };
	await variant(A, join(dir, "B"), versions.B);
	await variant(A, join(dir, "C"), versions.C, "noproject");
	await variant(A, join(dir, "D"), versions.D, "epoch2");
	await variant(A, join(dir, "B0"), versions.B, "extra");
	const feed = join(dir, "feed");
	mkdirSync(feed, { recursive: true });
	const entries = {};
	for (const name of ["B", "C", "D", "B0"]) {
		const packed = await packKernel({ kernelDir: join(dir, name), outDir: join(dir, "pack", name) });
		entries[name] = packed.entry;
		// B0 has B's version and file name: its archive is never served, only its signed description.
		if (name !== "B0") cpSync(packed.archive, join(feed, packed.entry.bundle.file));
	}
	const key = makeKeyPair("t1");
	const privateKey = privateKeyFromText(key.privatePem);
	const now = Date.now();
	const at = (minutesAgo) => iso(now - minutesAgo * 60_000);
	const sign = (name, bytes) => {
		writeFileSync(join(feed, `${name}.json`), bytes);
		writeFileSync(join(feed, `${name}.json.sig`), signManifest(bytes, privateKey, key.entry.id));
	};
	const MB0 = assembleManifest({ entries: [entries.B0], issuedAt: at(120), floor: versions.A });
	const MB = assembleManifest({ entries: [entries.B], issuedAt: at(60), floor: versions.A });
	const MC = assembleManifest({ entries: [entries.C], issuedAt: at(50), previous: MB });
	const MD = assembleManifest({ entries: [entries.D], issuedAt: at(40), previous: MB });
	const MW = reissueManifest({ previous: MD, issuedAt: at(30), withdraw: [versions.B] });
	for (const [name, m] of Object.entries({ MB0, MB, MC, MD, MW })) sign(name, manifestBytes(m));
	writeFileSync(join(dir, "keys.json"), JSON.stringify({ id: key.entry.id, publicKey: key.entry.publicKey, versions }));
	writeFileSync(join(dir, "ready.json"), JSON.stringify({ versions, builtInSeconds: Math.round((Date.now() - started) / 1000) }));
	return dir;
}

let release;
let keepRelease = false;
before(
	async () => {
		const given = process.env.NAMZU_E2E_REAL_ENGINE_DIR;
		keepRelease = Boolean(given);
		const dir = given ?? mkdtempSync(join(tmpdir(), "namzu-real-engines-"));
		if (!existsSync(join(dir, "ready.json"))) await buildRelease(dir);
		const keys = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"));
		release = {
			dir,
			A: join(dir, "A"),
			feed: join(dir, "feed"),
			key: { id: keys.id, publicKey: keys.publicKey },
			v: keys.versions,
		};
	},
	{ timeout: 900000 },
);
after(() => {
	if (release && !keepRelease) rmSync(release.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// The feed on loopback: records every request, serves one description at a time, can stop an archive halfway.
// ---------------------------------------------------------------------------------------------

async function startFeed(manifest) {
	const state = { manifest, requests: [], halfway: undefined, gate: undefined };
	const server = createServer(async (req, res) => {
		const name = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
		state.requests.push({ name, headers: req.headers });
		await state.gate?.();
		const file = name === "kernel-latest.json" || name === "kernel-latest.json.sig"
			? join(release.feed, `${state.manifest}${name.slice("kernel-latest".length)}`)
			: join(release.feed, name);
		if (name.includes("/") || !existsSync(file)) return void res.writeHead(404).end();
		const size = statSync(file).size;
		if (state.halfway && name.endsWith(".tar.gz")) {
			// Half the bytes, then silence until the connection is cut.
			const half = Math.floor(size / 2);
			res.writeHead(200, { "content-length": size });
			const chunks = createReadStream(file, { start: 0, end: half - 1 });
			chunks.pipe(res, { end: false });
			chunks.on("end", () => state.halfway(half));
			return;
		}
		res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size });
		createReadStream(file).pipe(res);
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	state.url = `http://127.0.0.1:${server.address().port}/`;
	state.close = () => {
		server.closeAllConnections();
		return new Promise((done) => server.close(done));
	};
	state.archives = () => state.requests.filter((r) => r.name.endsWith(".tar.gz")).map((r) => r.name);
	return state;
}

// ---------------------------------------------------------------------------------------------
// Looking at the processes: which engine does a host, a terminal tab or a short command run on?
// ---------------------------------------------------------------------------------------------

function processes(world) {
	const found = [];
	for (const pid of readdirSync("/proc").filter((n) => /^\d+$/u.test(n))) {
		try {
			const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
			const entry = argv.find((arg) => /dist[\\/]bin\.js$/u.test(arg));
			if (!entry) continue;
			const managed = /versions\/(\d+\.\d+\.\d+)\/dist\/bin\.js$/u.exec(entry);
			const bundled = entry === join(release.A, "dist", "bin.js");
			if (!(bundled || (managed && entry.startsWith(world.userData)))) continue;
			let cwd = "";
			try {
				cwd = readlinkSync(`/proc/${pid}/cwd`);
			} catch {}
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			found.push({
				pid: Number(pid),
				key: `${pid}:${stat.split(") ")[1].split(" ")[19]}`,
				engine: managed ? managed[1] : release.v.A,
				args: argv.slice(argv.indexOf(entry) + 1),
				cwd,
			});
		} catch {}
	}
	return found;
}
const hostsOn = (world, version) => processes(world).filter((p) => p.engine === version && p.args[0] === "acp");

/** Samples the processes while a test runs: every host, tab and short command ever seen, once. */
function watch(world) {
	const seen = new Map();
	const sample = () => {
		for (const p of processes(world)) if (!seen.has(p.key)) seen.set(p.key, p);
	};
	const timer = setInterval(sample, 40);
	world.seen = seen;
	world.stopWatch = () => clearInterval(timer);
	world.startsOn = (version, kind = "acp") =>
		[...seen.values()].filter((p) => p.engine === version && (kind === "any" || p.args[0] === kind));
}

// ---------------------------------------------------------------------------------------------
// World, screens and the kernel folder.
// ---------------------------------------------------------------------------------------------

async function realWorld(feed, { settings, noKey, rules = [WRITE] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "namzu-e2e-real-"));
	const world = await createWorld({
		keepRoot: root,
		// Without a key nothing fetches an engine, and an unpackaged app has no engine of its own: it takes the
		// checkout's, as every other e2e file does.
		noCli: !noKey,
		rules,
		seed: (ctx) => {
			if (settings)
				writeFileSync(join(ctx.userData, "desktop-settings.json"), JSON.stringify({ version: 1, showConversationTabs: true, ...settings }));
		},
		env: {
			...(noKey ? {} : { NAMZU_KERNEL_TEST_PUBLIC_KEY: `${release.key.id}:${release.key.publicKey}` }),
			NAMZU_KERNEL_FEED_URL: feed?.url ?? "http://127.0.0.1:9/",
			NAMZU_KERNEL_FIRST_CHECK_MS: "300",
			NAMZU_KERNEL_TEST_BUNDLED_DIR: release.A,
			NAMZU_E2E_C_LOG: join(root, "c-starts.log"),
		},
	});
	// The real engine reaches the scripted model through the base address its client reads.
	world.env.OPENAI_BASE_URL = `${world.model.url}/v1`;
	world.feed = feed;
	watch(world);
	return world;
}

async function finish(world, feed, failed) {
	world.stopWatch?.();
	await feed?.close().catch(() => undefined);
	await dispose(world, { failed });
}

const kernelDir = (w) => join(w.userData, "kernel");
const readState = (w) => JSON.parse(readFileSync(join(kernelDir(w), "state.json"), "utf8"));
const versionsOnDisk = (w) => (existsSync(join(kernelDir(w), "versions")) ? readdirSync(join(kernelDir(w), "versions")).sort() : []);
const logLines = (w) => (existsSync(join(kernelDir(w), "updates.log")) ? readFileSync(join(kernelDir(w), "updates.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
async function appearance(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}
async function shotBoth(w, name) {
	await appearance(w, "dark");
	await shot(w, `${name}-dark`);
	await appearance(w, "light");
	await shot(w, `${name}-light`);
	await appearance(w, "dark");
}

async function openSettings(w, section) {
	const sections = w.page.getByRole("navigation", { name: "Settings sections" });
	// The first click can land while the window is still restoring its tabs; ask again until it shows.
	await expect(async () => {
		if ((await sections.count()) === 0) await w.page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(sections).toBeVisible({ timeout: 5000 });
	}).toPass({ timeout: T });
	await expect(async () => {
		await sections.getByRole("button", { name: section, exact: true }).click();
		await expect(w.page.getByRole("heading", { level: 1, name: section, exact: true })).toBeVisible({ timeout: 5000 });
	}).toPass({ timeout: T });
}
/** Leaves Settings for the start of the app, where a project is opened. */
async function goHome(w) {
	if ((await w.page.getByRole("navigation", { name: "Settings sections" }).count()) > 0)
		await w.page.getByRole("button", { name: "Home", exact: true }).click();
}
const settingsPage = (w) => w.page.locator("#settings-content");

/** Holds the feed's answers until the app has a host running on `engine` (it starts one at launch). */
function holdUntilHost(feed, world, engine) {
	feed.gate = async () => {
		while (hostsOn(world, engine).length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
	};
}

/** The scripted conversation with a tool call, on whatever engine the open project runs. */
async function conversation(w) {
	await send(w, "please write the file");
	await w.page.getByRole("button", { name: "Accept", exact: true }).click({ timeout: T });
	// The tool call's effect on disk is the proof; the closing line shows the turn ended.
	const out = join(w.cwdOfOpen ?? w.project, "out.txt");
	await expect.poll(() => existsSync(out), { timeout: T }).toBe(true);
	assert.equal(readFileSync(out, "utf8"), "hello from the model\n");
	await expect(w.page.getByText("Wrote out.txt.").last()).toBeVisible({ timeout: T });
	rmSync(out);
}

/** A second project folder, opened through the same menu as the first. */
function secondProject(w) {
	const folder = join(w.root, "project-two");
	mkdirSync(join(folder, ".git"), { recursive: true });
	writeFileSync(join(folder, "namzu.config.json"), JSON.stringify({ sandbox: { enabled: false } }));
	return folder;
}
async function openAnotherProject(w, folder) {
	await w.app.evaluate((_e, f) => {
		globalThis.__e2eDialog.open = [f];
	}, folder);
	await w.page.getByRole("button", { name: "Add new project" }).first().click();
	await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	// A folder with a project config asks for trust; the first one of a run does, a later one may not.
	const consent = w.page.getByRole("dialog", { name: "Trust this folder?" });
	const heading = w.page.getByText("What should we work on in project-two?");
	await expect(async () => {
		if (await consent.isVisible()) await consent.getByRole("button", { name: "Trust and open" }).click();
		await expect(heading).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: T });
}

/** The state after a first start and the check: the engine is fetched and waiting. */
async function reachReady(w, feed) {
	holdUntilHost(feed, w, release.v.A);
	await launch(w);
	await openSettings(w, "Updates");
	await expect(settingsPage(w).getByText(`A newer engine (${release.v.B}) is ready.`)).toBeVisible({ timeout: 240000 });
}

/** The app with the good update installed and current, closed; the folder is the template for the next worlds. */
let installedTemplate;
async function installedB() {
	if (installedTemplate) return installedTemplate;
	const feed = await startFeed("MB");
	const w = await realWorld(feed);
	try {
		await reachReady(w, feed);
		await goHome(w);
		await openProject(w);
		await conversation(w);
		await w.app.close();
		await expect.poll(() => readState(w).current, { timeout: T }).toBe(release.v.B);
		installedTemplate = join(release.dir, "installed-b");
		rmSync(installedTemplate, { recursive: true, force: true });
		cpSync(kernelDir(w), installedTemplate, { recursive: true });
	} finally {
		w.stopWatch();
		await feed.close();
		await dispose(w, { failed: false });
	}
	return installedTemplate;
}

/** A world that starts with B installed and current, as a person's app is after the first update. */
async function worldWithB(manifest, options) {
	const template = await installedB();
	const feed = await startFeed(manifest);
	const w = await realWorld(feed, {
		...options,
		settings: options?.settings,
	});
	cpSync(template, kernelDir(w), { recursive: true });
	return { w, feed };
}

// ---------------------------------------------------------------------------------------------
// The ten proofs.
// ---------------------------------------------------------------------------------------------

test("1-3: the app finds B, checks it for real, runs the next project on it, and starts on it again", { timeout: 900000 }, async () => {
	const feed = await startFeed("MB");
	const w = await realWorld(feed);
	let failed = true;
	try {
		// 1. Starts on A; the check fetches B, verifies, unpacks, self-checks, and says it is ready.
		holdUntilHost(feed, w, release.v.A);
		await launch(w);
		await openSettings(w, "Updates");
		const page = settingsPage(w);
		await expect(page.getByText(`A newer engine (${release.v.B}) is ready.`)).toBeVisible({ timeout: 240000 });
		await expect(page.getByText("It takes effect the next time a project opens.")).toBeVisible();
		await shotBoth(w, "1-updates-ready");
		assert.deepEqual(feed.requests.map((r) => r.name), ["kernel-latest.json", "kernel-latest.json.sig", `namzu-kernel-${release.v.B}-${TARGET}.tar.gz`]);
		for (const { headers } of feed.requests) {
			assert.equal(headers["user-agent"], "namzu-desktop");
			assert.equal(headers.cookie, undefined);
			assert.equal(headers.authorization, undefined);
			console.log("request headers:", JSON.stringify(headers));
		}
		const state = readState(w);
		assert.equal(state.pending, release.v.B);
		assert.equal(state.current, undefined);
		assert.deepEqual(readdirSync(join(kernelDir(w), "tmp")), []);
		const check = logLines(w).find((l) => l.event === "check");
		assert.equal(check?.result, "ready");
		// The host the app started at launch is on A and stays there: a running host is never swapped.
		const launchHosts = hostsOn(w, release.v.A);
		assert.ok(launchHosts.length >= 1, "a host runs on A");
		await openSettings(w, "About");
		await expect(settingsPage(w).getByText("This app’s own engine.")).toBeVisible({ timeout: T });
		await shotBoth(w, "1-about-own");

		// 2. A project opened afterwards runs on B.
		await goHome(w);
		await openProject(w);
		await conversation(w);
		const project = hostsOn(w, release.v.B).filter((p) => p.cwd === w.project);
		assert.equal(project.length, 1, "the project's host runs on B");
		for (const p of launchHosts) assert.ok(processes(w).some((q) => q.pid === p.pid && q.engine === release.v.A), "the host that was already running was not swapped");
		assert.equal(hostsOn(w, release.v.A).filter((p) => p.cwd === w.project).length, 0, "nothing for the project ran on A");
		await openSettings(w, "About");
		await expect(settingsPage(w).getByText(/Updated by itself on/)).toBeVisible({ timeout: T });
		await expect(settingsPage(w).getByText(release.v.B, { exact: true }).first()).toBeVisible();
		await expect(settingsPage(w).getByText("Used if the newer engine cannot start.")).toBeVisible();
		await shotBoth(w, "2-about-updated");
		await openSettings(w, "Updates");
		await expect(settingsPage(w).getByText("The engine is up to date.", { exact: false })).toBeVisible({ timeout: T });
		await shotBoth(w, "2-updates-current");
		// A terminal tab of the Namzu command line runs on B too.
		await goHome(w);
		const before = w.startsOn(release.v.B, "any").length;
		await w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click();
		await expect(w.page.getByRole("dialog", { name: "Model picker" })).toBeVisible({ timeout: T });
		await w.page.getByRole("radio", { name: "OpenAI gpt-e2e-0" }).click();
		await w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click().catch(() => undefined);
		await openModelMore(w.page);
		await w.page.getByRole("radio", { name: "CLI", exact: true }).click();
		await w.page.keyboard.press("Escape");
		await w.page.keyboard.press("Escape");
		await w.page.getByRole("button", { name: "Open Namzu in a terminal" }).click();
		await expect.poll(() => w.startsOn(release.v.B, "any").length, { timeout: T }).toBeGreaterThan(before);
		const tab = [...w.seen.values()].filter((p) => p.engine === release.v.B && p.args[0] !== "acp");
		assert.ok(tab.length >= 1, `a terminal tab of the command line runs on B (saw ${JSON.stringify(tab.map((p) => p.args))})`);
		await shot(w, "2-terminal-tab-on-b");
		const bHosts = w.startsOn(release.v.B).length;
		const aHosts = w.startsOn(release.v.A).length;
		console.log(`host starts so far: A ${aHosts}, B ${bHosts}; short processes on B: ${JSON.stringify([...w.seen.values()].filter((p) => p.engine === release.v.B && p.args[0] !== "acp").map((p) => p.args.slice(0, 3)))}`);
		assert.deepEqual(w.faults, []);

		// The terminal tab is closed before the restart: a window that restores an ended terminal while the
		// settings open repaints its navigation, which is the window's business and not this file's.
		const terminal = w.page.locator("[data-terminal-tab-id]").first();
		await terminal.getByRole("button", { name: /^Close tab / }).click();
		await expect(w.page.locator("[data-terminal-tab-id]")).toHaveCount(0, { timeout: T });
		// 3. Restart: starts on B without a new download; the quick check passes; nothing newer is fetched.
		feed.requests.length = 0;
		feed.gate = undefined;
		await w.app.close();
		const hostsBefore = w.startsOn(release.v.A).length;
		await relaunch(w);
		// The window restores the last project a moment after it opens, which leaves Settings if it was opened
		// meanwhile; wait for it, as a person would.
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await expect.poll(() => hostsOn(w, release.v.B).length, { timeout: T }).toBeGreaterThan(0);
		await openSettings(w, "Updates");
		await expect.poll(() => feed.requests.length, { timeout: 120000 }).toBeGreaterThanOrEqual(2);
		await expect(settingsPage(w).getByText("The engine is up to date.", { exact: false })).toBeVisible({ timeout: T });
		assert.deepEqual(feed.requests.map((r) => r.name), ["kernel-latest.json", "kernel-latest.json.sig"], "the feed had nothing newer: no archive");
		assert.equal(w.startsOn(release.v.A).length, hostsBefore, "no host started on A after the restart");
		const after = readState(w);
		assert.equal(after.current, release.v.B);
		assert.deepEqual(after.bad, {});
		assert.deepEqual(versionsOnDisk(w).filter((n) => !n.includes(".manifest") && !n.includes(".sig")), [release.v.B]);
		await openSettings(w, "About");
		await expect(settingsPage(w).getByText(/Updated by itself on/)).toBeVisible({ timeout: T });
		await shot(w, "3-about-after-restart");
		failed = false;
	} finally {
		await finish(w, feed, failed);
	}
});

test("4: C passes the self-check, fails the next project, and the app goes back to B by itself, once", { timeout: 900000 }, async () => {
	const { w, feed } = await worldWithB("MC");
	let failed = true;
	try {
		// B is current; hold C until B's host is up so the launch host cannot be the one that promotes C.
		holdUntilHost(feed, w, release.v.B);
		await launch(w);
		await openSettings(w, "Updates");
		await expect(settingsPage(w).getByText(`A newer engine (${release.v.C}) is ready.`)).toBeVisible({ timeout: 240000 });
		assert.equal(readState(w).pending, release.v.C);
		assert.ok(!existsSync(w.env.NAMZU_E2E_C_LOG), "C has not been started as a host yet");
		const hostsBefore = w.startsOn(release.v.B).length;
		await goHome(w);
		await openProject(w);
		await conversation(w); // the open ends on a WORKING host
		const c = readFileSync(w.env.NAMZU_E2E_C_LOG, "utf8").trim().split("\n");
		assert.equal(c.length, 1, "C was started once for the project and not again");
		const project = hostsOn(w, release.v.B).filter((p) => p.cwd === w.project);
		assert.equal(project.length, 1, "the project's host ended on B");
		assert.equal(hostsOn(w, release.v.C).filter((p) => p.cwd === w.project).length, 0, "no project host stays on C");
		// The host for conversations outside any project (its folder is not a project) started on C and works there:
		// C was only given up for what it could not do. A running host is never swapped, so it stays until the app quits.
		console.log("hosts still on C:", JSON.stringify(hostsOn(w, release.v.C).map((p) => p.cwd.replace(w.root, "<root>"))));
		await openSettings(w, "Updates");
		await expect(settingsPage(w).getByText(new RegExp(`Could not use engine ${release.v.C}.*went back to ${release.v.B}`))).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("alert")).toHaveCount(0);
		await shotBoth(w, "4-went-back");
		const state = readState(w);
		assert.equal(state.current, release.v.B);
		assert.ok(state.bad[release.v.C], "C is marked bad");
		console.log("C marked bad:", JSON.stringify(state.bad[release.v.C]));
		// Its folder is removed as soon as no host runs from it: the chats host that started on C before it was
		// given up keeps the folder (clean-up never deletes a folder a live host started from) until the app quits.
		const stillOnC = hostsOn(w, release.v.C).length > 0;
		if (!stillOnC) await expect.poll(() => versionsOnDisk(w).filter((n) => n.startsWith(release.v.C)), { timeout: T }).toEqual([]);
		else assert.ok(versionsOnDisk(w).includes(release.v.C), "the folder a live host runs from is kept");
		console.log(`host starts: B ${w.startsOn(release.v.B).length - hostsBefore} new for the open, C attempts ${c.length}`);
		// C is never tried again: a restart and a new check (the feed still offers C) fetch nothing and start nothing on C.
		feed.requests.length = 0;
		feed.gate = undefined;
		await w.app.close();
		await relaunch(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await conversation(w);
		await expect.poll(() => feed.requests.length, { timeout: 120000 }).toBeGreaterThanOrEqual(2);
		assert.deepEqual(feed.archives(), [], "C is not fetched again");
		assert.equal(readFileSync(w.env.NAMZU_E2E_C_LOG, "utf8").trim().split("\n").length, 1, "C is not started again");
		assert.deepEqual(versionsOnDisk(w).filter((n) => n.startsWith(release.v.C)), []);
		failed = false;
	} finally {
		await finish(w, feed, failed);
	}
});

test("5: \"Use this app's own engine\" runs the next project on A, and the setting off asks nothing", { timeout: 900000 }, async () => {
	const { w, feed } = await worldWithB("MB");
	let failed = true;
	try {
		await launch(w);
		await goHome(w);
		await openProject(w);
		await conversation(w);
		assert.equal(hostsOn(w, release.v.B).filter((p) => p.cwd === w.project).length, 1, "the first project runs on B");
		await openSettings(w, "Updates");
		await shotBoth(w, "5-before-own");
		await settingsPage(w).getByRole("button", { name: /Use this app.s own engine/ }).click();
		const folder = secondProject(w);
		w.cwdOfOpen = folder;
		await goHome(w);
		await openAnotherProject(w, folder);
		await conversation(w);
		assert.equal(hostsOn(w, release.v.A).filter((p) => p.cwd === folder).length, 1, "the next project runs on A");
		assert.equal(hostsOn(w, release.v.B).filter((p) => p.cwd === folder).length, 0);
		assert.ok(readState(w).bad[release.v.B], "B is marked bad by the person's choice");
		await openSettings(w, "About");
		await expect(settingsPage(w).getByText("This app’s own engine.")).toBeVisible({ timeout: T });
		await shotBoth(w, "5-about-own-again");
		// The setting off: no request, and A.
		await openSettings(w, "Updates");
		feed.requests.length = 0;
		const toggle = settingsPage(w).getByRole("switch", { name: "Keep the engine up to date" });
		if (await toggle.isChecked()) await toggle.click();
		await expect(settingsPage(w).getByText("Off. This app runs the engine it was installed with.")).toBeVisible({ timeout: T });
		await shotBoth(w, "5-updates-off");
		await w.app.close();
		await relaunch(w);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
		await conversation(w);
		assert.equal(feed.requests.length, 0, "zero requests with the setting off, through a restart");
		assert.equal(hostsOn(w, release.v.A).filter((p) => p.cwd === folder).length, 1, "and the restored project runs on A again (a new host)");
		failed = false;
	} finally {
		await finish(w, feed, failed);
	}
});

test("6: an engine with another data epoch is not installed; the screen says it needs a newer app", { timeout: 900000 }, async () => {
	const feed = await startFeed("MD");
	const w = await realWorld(feed);
	let failed = true;
	try {
		await launch(w);
		await openSettings(w, "Updates");
		await expect(settingsPage(w).getByText("A newer engine is out, but it needs a newer version of this app.")).toBeVisible({ timeout: 240000 });
		await shotBoth(w, "6-needs-newer-app");
		assert.deepEqual(feed.archives(), [], "nothing is downloaded");
		assert.deepEqual(versionsOnDisk(w), []);
		assert.equal(readState(w).pending, undefined);
		await goHome(w);
		await openProject(w);
		await conversation(w);
		assert.equal(hostsOn(w, release.v.A).filter((p) => p.cwd === w.project).length, 1);
		failed = false;
	} finally {
		await finish(w, feed, failed);
	}
});

test("7: a description that withdraws B while B is current: the next open does not use B", { timeout: 900000 }, async () => {
	const { w, feed } = await worldWithB("MW");
	let failed = true;
	try {
		await launch(w);
		await openSettings(w, "Updates");
		await expect.poll(() => readState(w).bad?.[release.v.B]?.reason, { timeout: 240000 }).toBe("withdrawn");
		await expect(w.page.getByRole("alert")).toHaveCount(0);
		await goHome(w);
		await openProject(w);
		await conversation(w);
		assert.equal(hostsOn(w, release.v.B).filter((p) => p.cwd === w.project).length, 0, "B is not used");
		assert.equal(hostsOn(w, release.v.A).filter((p) => p.cwd === w.project).length, 1, "the project runs on A");
		await openSettings(w, "Updates");
		await shotBoth(w, "7-withdrawn");
		assert.deepEqual(feed.archives(), [], "the newer engine of that description needs a newer app: nothing fetched");
		await expect.poll(() => versionsOnDisk(w).filter((n) => n.startsWith(release.v.B)), { timeout: T }).toEqual([]);
		failed = false;
	} finally {
		await finish(w, feed, failed);
	}
});

const TAMPERS = {
	"one byte of dist/bin.js changed": (w) => {
		const file = join(kernelDir(w), "versions", release.v.B, "dist", "bin.js");
		const bytes = readFileSync(file);
		bytes[bytes.length - 1] ^= 0x01;
		writeFileSync(file, bytes);
	},
	"the stored signed pair deleted": (w) => {
		rmSync(join(kernelDir(w), "versions", `${release.v.B}.manifest.json`));
		rmSync(join(kernelDir(w), "versions", `${release.v.B}.manifest.json.sig`));
	},
	"an older signed pair put in its place": (w) => {
		for (const [from, to] of [
			["MB0.json", `${release.v.B}.manifest.json`],
			["MB0.json.sig", `${release.v.B}.manifest.json.sig`],
		])
			cpSync(join(release.feed, from), join(kernelDir(w), "versions", to));
	},
};
for (const [what, tamper] of Object.entries(TAMPERS)) {
	test(`8: after install, ${what}: the next open does not run B`, { timeout: 900000 }, async () => {
		const { w, feed } = await worldWithB("MB");
		let failed = true;
		try {
			const folder = join(kernelDir(w), "versions");
			console.log("stored files before:", readdirSync(folder).filter((n) => n.startsWith(release.v.B)).join(" "));
			tamper(w);
			feed.gate = async () => new Promise(() => {}); // no new check may repair it: the feed never answers
			await launch(w);
			await goHome(w);
		await openProject(w);
			await conversation(w);
			assert.equal(hostsOn(w, release.v.B).length, 0, "no host runs on B");
			assert.equal(hostsOn(w, release.v.A).filter((p) => p.cwd === w.project).length, 1, "the project runs on A");
			assert.ok(readState(w).bad[release.v.B], "B is marked bad");
			console.log(`${what}: marked bad: ${JSON.stringify(readState(w).bad[release.v.B])}`);
			await openSettings(w, "Updates");
			await shot(w, `8-${what.replace(/\W+/gu, "-")}`);
			failed = false;
		} finally {
			await finish(w, feed, failed);
		}
	});
}

test("9: the app killed in the middle of the download and of the unpacking starts again, clean, and gets the engine", { timeout: 900000 }, async () => {
	const feed = await startFeed("MB");
	const w = await realWorld(feed);
	let failed = true;
	try {
		// In the middle of the download: half the archive is sent, then the feed says nothing.
		const halfway = new Promise((resolve) => {
			feed.halfway = resolve;
		});
		holdUntilHost(feed, w, release.v.A);
		await launch(w);
		const bytes = await halfway;
		await expect.poll(() => existsSync(join(kernelDir(w), "tmp", "download.tar.gz")), { timeout: T }).toBe(true);
		console.log(`killed in the download after ${bytes} bytes were sent; partial file ${statSync(join(kernelDir(w), "tmp", "download.tar.gz")).size} bytes`);
		process.kill(w.app.process().pid, "SIGKILL");
		await w.app.waitForEvent?.("close").catch(() => undefined);
		feed.halfway = undefined;
		feed.requests.length = 0;
		feed.gate = undefined;
		await relaunch(w);
		await expect.poll(() => readState(w).pending, { timeout: 240000 }).toBe(release.v.B);
		assert.deepEqual(readdirSync(join(kernelDir(w), "tmp")), []);
		assert.deepEqual(versionsOnDisk(w).filter((n) => !/manifest|sig/u.test(n)), [release.v.B]);
		await openSettings(w, "Updates");
		await expect(settingsPage(w).getByText(`A newer engine (${release.v.B}) is ready.`)).toBeVisible({ timeout: T });
		await shot(w, "9-after-download-kill");
		console.log("after the download kill: restart installed B; requests:", feed.requests.map((r) => r.name).join(", "));
		failed = false;
	} finally {
		// The second half below starts from a fresh folder.
		await finish(w, feed, failed);
	}
	const feed2 = await startFeed("MB");
	const w2 = await realWorld(feed2);
	failed = true;
	try {
		// In the middle of the unpacking: the moment the unpacking folder appears, the app is killed.
		holdUntilHost(feed2, w2, release.v.A);
		await launch(w2);
		const unpacked = join(kernelDir(w2), "tmp", "unpacked");
		while (countFiles(unpacked) < 100) await new Promise((resolve) => setImmediate(resolve));
		const at = { files: countFiles(unpacked), installed: existsSync(join(kernelDir(w2), "versions", release.v.B)) };
		process.kill(w2.app.process().pid, "SIGKILL");
		console.log(`killed in the unpacking: ${at.files} files unpacked so far, installed already: ${at.installed}`);
		feed2.requests.length = 0;
		feed2.gate = undefined;
		await relaunch(w2);
		await expect.poll(() => readState(w2).pending, { timeout: 240000 }).toBe(release.v.B);
		assert.deepEqual(readdirSync(join(kernelDir(w2), "tmp")), []);
		assert.deepEqual(versionsOnDisk(w2).filter((n) => !/manifest|sig/u.test(n)), [release.v.B]);
		await goHome(w2);
		await openProject(w2);
		await conversation(w2);
		assert.equal(hostsOn(w2, release.v.B).filter((p) => p.cwd === w2.project).length, 1, "the engine arrived and runs the project");
		failed = false;
	} finally {
		await finish(w2, feed2, failed);
	}
});
function countFiles(dir) {
	let n = 0;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
	} catch {}
	return n;
}

test("10: with no key in the app the feed is never asked", { timeout: 900000 }, async () => {
	const feed = await startFeed("MB");
	const w = await realWorld(feed, { noKey: true });
	let failed = true;
	try {
		await launch(w);
		await openSettings(w, "Updates");
		await expect(settingsPage(w).getByText("Keep the engine up to date", { exact: true })).toHaveCount(0);
		await shotBoth(w, "10-updates-nokey");
		await openSettings(w, "About");
		await shotBoth(w, "10-about-nokey");
		await goHome(w);
		await openProject(w);
		await conversation(w);
		assert.equal(feed.requests.length, 0, "zero requests");
		assert.equal(existsSync(kernelDir(w)), false, "no engine folder is made");
		failed = false;
	} finally {
		await finish(w, feed, failed);
	}
});
