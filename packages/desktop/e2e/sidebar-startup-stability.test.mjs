// The sidebar paints its final layout on the first frame and nothing already on screen moves
// because data arrived. A profile with three projects (one open, with its conversations), one Pal
// and conversations in each is closed and started again with the projects answering at times the
// test controls: a project's connection status and its conversation list wait on a file the test
// deletes (see cli-entry.mjs), so no step depends on how fast the machine is. Every animation
// frame is recorded from before the first paint (sidebar-frame-probe.js), keyed by id.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/sidebar-startup-stability.test.mjs
import assert from "node:assert/strict";
import {
	cpSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createWorld, dispose, expect, freezeApp, launch, relaunch } from "./harness.mjs";

const T = 60000;
const TOLERANCE = 0.5;
const here = dirname(fileURLToPath(import.meta.url));
const CHATS = [{ match: /chat/, steps: [{ text: "Reply." }] }];
const NAMES = ["alpha", "beta", "gamma"];

/** The frozen copy loads the probe before the bundle, so the very first frame is recorded. */
function instrument(world) {
	const renderer = join(freezeApp(world.root), "dist/renderer");
	cpSync(join(here, "sidebar-frame-probe.js"), join(renderer, "sidebar-frame-probe.js"));
	const index = join(renderer, "index.html");
	const html = readFileSync(index, "utf8");
	if (!html.includes("sidebar-frame-probe.js"))
		writeFileSync(
			index,
			html.replace("<title>", '<script src="./sidebar-frame-probe.js"></script><title>'),
		);
}

/** Resolves when `predicate` holds for the folder; re-checked on every file-system event. */
function untilFiles(directory, predicate) {
	return new Promise((resolve) => {
		const check = () => {
			const found = predicate(readdirSync(directory));
			if (found === undefined || found === false) return false;
			watcher.close();
			resolve(found);
			return true;
		};
		const watcher = watch(directory, check);
		check();
	});
}

async function addProject(w, name) {
	const dir = join(w.root, name);
	mkdirSync(join(dir, ".git"), { recursive: true });
	await w.app.evaluate((_e, path) => {
		globalThis.__e2eDialog.open = [path];
	}, dir);
	const add = w.page.getByRole("button", { name: "Add new project", exact: true });
	await add.last().click();
	await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	await expect(w.page.locator("[data-project-group]").filter({ hasText: name })).toHaveCount(1, {
		timeout: T,
	});
	return dir;
}

async function say(w, text) {
	const box = w.page.getByRole("textbox", { name: "Message Namzu" });
	await expect(box).toBeVisible({ timeout: T });
	await box.fill(text);
	await w.page.getByRole("button", { name: "Send message" }).click();
	await expect(w.page.getByText("Reply.", { exact: true })).toHaveCount(1, { timeout: T });
}

const savedPicture = (w) => {
	try {
		return JSON.parse(readFileSync(join(w.userData, "sidebar-snapshot.json"), "utf8"));
	} catch {
		return null;
	}
};

const recorder = (w) => (label, list) => {
	mkdirSync(w.shots, { recursive: true });
	writeFileSync(join(w.shots, `frames-${label.replace(/ /g, "-")}.json`), JSON.stringify(list));
};
const frames = (w) => w.page.evaluate(() => window.__sidebarFrames);
const kind = (key) => key.slice(0, key.indexOf(":"));
const withRows = (list) => list.filter((frame) => Object.keys(frame.rows).length > 0);

/** A state that has not failed never shows as failed: no frame of a start carries an error banner. */
function noBanner(label, list) {
	const shown = list.filter((frame) => frame.banner);
	assert.deepEqual(
		shown.map((frame) => `t=${frame.t}: ${frame.banner}`),
		[],
		`${label}: no frame shows an error banner`,
	);
}

/** The ids of the three projects, in the order the app lists them now. */
const listedProjects = (w) =>
	w.page.evaluate(async () => (await window.namzu.projects()).map((p) => [p.id, p.path, p.name]));

/**
 * The stability of a recorded run. `expectedKeys` are the rows the first frame must already hold
 * (the picture of last time); nothing the person did happens in these runs, so no row may move,
 * disappear, or be inserted above another one in its section.
 */
function assertStable(label, list, { projectOrder, expectedKeys, record }) {
	// Kept beside the failure screenshot, for reading what moved.
	record?.(label, list);
	const shown = withRows(list);
	assert.ok(shown.length > 0, `${label}: the sidebar drew rows`);
	noBanner(label, list);
	const first = shown[0].rows;
	const keys = Object.keys(first);
	for (const key of expectedKeys)
		assert.ok(key in first, `${label}: ${key} is on the first frame (has ${keys.join(", ")})`);
	// The order of the projects on the first frame is the saved order.
	const order = keys
		.filter((key) => kind(key) === "project")
		.sort((a, b) => first[a][0] - first[b][0])
		.map((key) => key.slice("project:".length));
	assert.deepEqual(order, projectOrder, `${label}: projects on the first frame are in the saved order`);
	let moved = 0;
	for (const frame of shown) {
		for (const key of keys) {
			const row = frame.rows[key];
			assert.ok(row, `${label}: ${key} stays on screen on every frame (t=${frame.t})`);
			const drift = Math.abs(row[0] - first[key][0]);
			if (drift > TOLERANCE)
				assert.fail(`${label}: ${key} moved ${drift}px at t=${frame.t} (first ${first[key][0]})`);
			moved += drift;
		}
	}
	// Nothing new is inserted above a row that was already there, in the same section.
	for (let i = 1; i < shown.length; i++) {
		const before = shown[i - 1].rows;
		const now = shown[i].rows;
		for (const key of Object.keys(now)) {
			if (key in before) continue;
			const [top, section] = now[key];
			for (const other of Object.keys(before))
				if (now[other]?.[1] === section && now[other][0] > top)
					assert.fail(`${label}: ${key} was inserted above ${other} in ${section}`);
		}
	}
	const last = shown.at(-1).rows;
	assert.deepEqual(
		Object.keys(last).sort(),
		keys.slice().sort(),
		`${label}: the settled sidebar holds the rows of the first frame, no more and no fewer`,
	);
	console.log(
		JSON.stringify({ label, frames: shown.length, rows: keys.length, projects: order.length, moved }),
	);
}

test("the sidebar's first frame is its final layout, on a second launch, a reload and back from Settings", {
	timeout: 900000,
}, async () => {
	const w = await createWorld({ rules: CHATS });
	const gates = join(w.root, "gates");
	mkdirSync(gates, { recursive: true });
	instrument(w);
	let failed = true;
	try {
		// First launch: three projects, conversations in each, one Pal; only the last project open.
		await launch(w);
		const dirs = [];
		for (const name of NAMES) {
			dirs.push(await addProject(w, name));
			await say(w, `chat ${name} one`);
			if (name === "alpha") {
				await w.page.getByRole("button", { name: "New conversation", exact: true }).first().click();
				await say(w, "chat alpha two");
			}
		}
		// Only gamma's conversation stays open as a tab, so on the next start gamma connects first.
		const closers = w.page.getByRole("button", { name: /^Close tab chat (alpha|beta)/ });
		while ((await closers.count()) > 0) await closers.first().click({ timeout: T });
		await w.page.evaluate(() => window.namzu.createPal({ name: "Kiro" }));
		await w.page.reload();
		await w.page.waitForLoadState("domcontentloaded");
		await expect(w.page.getByRole("button", { name: "Kiro" })).toBeVisible({ timeout: T });
		const toggles = w.page.getByRole("button", { name: /^Collapse (alpha|beta) conversations$/ });
		while ((await toggles.count()) > 0) await toggles.first().click();
		await expect(w.page.locator("[data-project-group]")).toHaveCount(3);
		const projects = await listedProjects(w);
		const idOf = Object.fromEntries(projects.map(([id, , name]) => [name, id]));
		const savedOrder = NAMES.map((name) => idOf[name]);
		assert.deepEqual(
			projects.map(([id]) => id),
			savedOrder,
			"the projects are listed in the order they were added",
		);
		// The picture of this run is on disk before the app closes.
		await expect
			.poll(() => {
				const picture = savedPicture(w);
				return (
					picture?.conversations.length === 4 &&
					picture.pals.length === 1 &&
					picture.expandedProjects.length === 1
				);
			})
			.toBe(true);
		const picture = savedPicture(w);
		assert.deepEqual(picture.expandedProjects, [idOf.gamma]);
		const expectedKeys = [
			...savedOrder.map((id) => `project:${id}`),
			...picture.pals.map((pal) => `pal:${pal.id}`),
			...picture.conversations.map((row) => `conversation:${row.id}`),
			"heading:projects",
			"heading:recents",
		];

		// Second launch: gamma's tab opens first, so the projects connect in the order gamma, alpha,
		// beta, not in the order they are listed. Every status and every list waits for the test.
		await w.app.close();
		w.env = { NAMZU_E2E_GATE_DIR: gates };
		for (const name of NAMES) {
			writeFileSync(join(gates, `${name}.connect.hold`), "");
			writeFileSync(join(gates, `${name}.list.hold`), "");
		}
		await relaunch(w);
		await w.page.waitForFunction(() =>
			window.__sidebarFrames?.some((frame) => Object.keys(frame.rows).length > 0),
		);
		// Nothing has answered yet, and the sidebar already shows how it was left.
		const quiet = withRows(await frames(w));
		assert.equal(quiet.at(-1).settled, false, "nothing has answered, so the start is not settled");
		for (const key of expectedKeys)
			assert.ok(key in quiet[0].rows, `second launch: ${key} is on the very first frame`);
		const connected = [];
		for (let step = 0; step < NAMES.length; step++) {
			const held = await untilFiles(gates, (files) =>
				files.find((file) => file.endsWith(".connect.held") && !connected.includes(file)),
			);
			connected.push(held);
			const name = held.slice(0, held.indexOf("."));
			rmSync(join(gates, `${name}.connect.hold`));
			await untilFiles(gates, (files) => files.includes(`${name}.connect.done`));
		}
		assert.deepEqual(
			connected.map((file) => file.slice(0, file.indexOf("."))),
			["gamma", "alpha", "beta"],
			"the projects connected in a different order from the one they are listed in",
		);
		for (const name of NAMES) rmSync(join(gates, `${name}.list.hold`));
		await expect(w.page.locator("#namzu-sidebar")).toHaveAttribute("data-start-settled", "true", {
			timeout: T,
		});
		assertStable("second launch", await frames(w), { projectOrder: savedOrder, expectedKeys, record: recorder(w) });

		// A reload: the page starts again from what main holds, and still draws the final layout.
		const before = withRows(await frames(w)).at(-1).rows;
		await w.page.reload();
		await w.page.waitForLoadState("domcontentloaded");
		await expect(w.page.locator("#namzu-sidebar")).toHaveAttribute("data-start-settled", "true", {
			timeout: T,
		});
		const reloaded = await frames(w);
		assertStable("reload", reloaded, { projectOrder: savedOrder, expectedKeys, record: recorder(w) });
		for (const [key, [top]] of Object.entries(before))
			assert.ok(
				Math.abs(withRows(reloaded)[0].rows[key][0] - top) <= TOLERANCE,
				`reload: ${key} is where it was before the reload`,
			);

		// To Settings and back: every row returns where it was.
		const resting = withRows(await frames(w)).at(-1).rows;
		const sections = w.page.getByRole("navigation", { name: "Settings sections" });
		await w.page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(sections).toBeVisible({ timeout: T });
		await w.page.evaluate(() => {
			window.__sidebarMark = "back";
		});
		await w.page.getByRole("button", { name: "Home", exact: true }).click();
		await expect(sections).toHaveCount(0, { timeout: T });
		recorder(w)("settings", await frames(w));
		const back = withRows(await frames(w)).filter((frame) => frame.mark === "back");
		assert.ok(back.length > 0, "the sidebar came back");
		for (const frame of back)
			for (const [key, [top]] of Object.entries(resting)) {
				const row = frame.rows[key];
				assert.ok(row, `settings: ${key} is back on every frame (t=${frame.t})`);
				assert.ok(
					Math.abs(row[0] - top) <= TOLERANCE,
					`settings: ${key} moved ${row[0] - top}px (t=${frame.t})`,
				);
			}
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

// A fresh profile has no picture: it keeps its placeholders, and nothing is invented.
test("a fresh profile starts from its placeholders", { timeout: 300000 }, async () => {
	const w = await createWorld({ rules: CHATS });
	instrument(w);
	let failed = true;
	try {
		await launch(w);
		await expect(w.page.locator("#namzu-sidebar")).toHaveAttribute("data-start-settled", "true", {
			timeout: T,
		});
		// Nothing is remembered, so the first frame draws no conversation row (checked below).
		const list = await frames(w);
		noBanner("fresh profile", list);
		const keys = new Set(withRows(list).flatMap((frame) => Object.keys(frame.rows)));
		assert.equal([...keys].some((key) => kind(key) === "conversation"), false);
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

// A remembered row can be clicked before its project has connected. The click is kept while the
// start restores the tab that was in front, and carried out when the project lists the row.
test("a click on a remembered row before its project connects opens it, and an archive waits the same way", {
	timeout: 600000,
}, async () => {
	const rules = [
		{ match: /alpha/, steps: [{ text: "Reply alpha." }] },
		{ match: /beta/, steps: [{ text: "Reply beta." }] },
	];
	const w = await createWorld({ rules });
	const gates = join(w.root, "gates");
	mkdirSync(gates, { recursive: true });
	instrument(w);
	let failed = true;
	try {
		await launch(w);
		await addProject(w, "alpha");
		const box = w.page.getByRole("textbox", { name: "Message Namzu" });
		const send = async (text) => {
			await expect(box).toBeVisible({ timeout: T });
			await box.fill(text);
			await w.page.getByRole("button", { name: "Send message" }).click();
		};
		await send("alpha chat");
		await expect(w.page.getByText("Reply alpha.")).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: "New conversation tab" }).click();
		await send("beta chat");
		await expect(w.page.getByText("Reply beta.")).toBeVisible({ timeout: T });
		await expect
			.poll(() => savedPicture(w)?.conversations.length === 2)
			.toBe(true);

		await w.app.close();
		w.env = { NAMZU_E2E_GATE_DIR: gates };
		writeFileSync(join(gates, "alpha.connect.hold"), "");
		writeFileSync(join(gates, "alpha.list.hold"), "");
		await relaunch(w);
		const row = (title) =>
			w.page.locator("nav.conversations").getByRole("button", { name: title, exact: true });
		// Remembered, and the project has not answered: the row is there and the start is not settled.
		await expect(row("alpha chat")).toBeVisible({ timeout: T });
		await expect(w.page.locator("#namzu-sidebar")).toHaveAttribute("data-start-settled", "false");
		await row("alpha chat").click();
		await untilFiles(gates, (files) => files.includes("alpha.connect.held"));
		rmSync(join(gates, "alpha.connect.hold"));
		await untilFiles(gates, (files) => files.includes("alpha.list.held"));
		rmSync(join(gates, "alpha.list.hold"));
		await expect(w.page.getByText("Reply alpha.")).toBeVisible({ timeout: T });
		await expect(w.page.getByText("Reply beta.")).toHaveCount(0);

		// An archive asked for on a remembered row is carried out once the project lists it.
		await w.app.close();
		writeFileSync(join(gates, "alpha.connect.hold"), "");
		writeFileSync(join(gates, "alpha.list.hold"), "");
		for (const file of ["alpha.connect.held", "alpha.connect.done", "alpha.list.held", "alpha.list.done"])
			rmSync(join(gates, file), { force: true });
		await relaunch(w);
		await expect(row("beta chat")).toBeVisible({ timeout: T });
		await row("beta chat").click({ button: "right" });
		await w.page.getByRole("menuitem", { name: /^Archive/ }).click();
		await untilFiles(gates, (files) => files.includes("alpha.connect.held"));
		rmSync(join(gates, "alpha.connect.hold"));
		await untilFiles(gates, (files) => files.includes("alpha.list.held"));
		rmSync(join(gates, "alpha.list.hold"));
		await expect(w.page.getByText("Conversation archived.")).toBeVisible({ timeout: T });
		await expect(row("beta chat")).toHaveCount(0, { timeout: T });
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

// The pane in front reads its saved message choices as the first frame is drawn, before the start has
// decided which tab is in front. If main refuses that first read (the window is still being set up),
// nothing has failed for the person: no frame shows an error banner, the read is made again once the
// start settles, and the composer comes up with its choices.
/** The next start's preload refuses the calls `condition` (a page expression over name and args) names. */
function refuse(w, condition) {
	const preload = join(freezeApp(w.root), "dist/preload.cjs");
	const source = readFileSync(preload, "utf8");
	const call = "electron_1.ipcRenderer.invoke(`namzu:${name}`, ...args)";
	assert.ok(source.includes(call), "the preload still has the invoke the test replaces");
	writeFileSync(
		preload,
		source.replace(
			call,
			`((${condition}) ? Promise.reject(new Error("refused while the window starts")) : ${call})`,
		),
	);
}

/** The window's first read of something is refused once; the same call is answered afterwards. */
const once = (name) =>
	`name === ${JSON.stringify(name)} && !(globalThis.__refused ??= {})[${JSON.stringify(name)}] && ((globalThis.__refused[${JSON.stringify(name)}] = true))`;

for (const name of ["conversations"]) {
	test(`a first refusal of ${name} while the window starts is never shown as an error`, {
		timeout: 300000,
	}, async () => {
		const w = await createWorld({ rules: CHATS });
		instrument(w);
		let failed = true;
		try {
			await launch(w);
			await addProject(w, "alpha");
			await say(w, "chat alpha");
			await w.app.close();
			refuse(w, once(name));
			await relaunch(w);
			await expect(w.page.locator("#namzu-sidebar")).toHaveAttribute("data-start-settled", "true", {
				timeout: T,
			});
			await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({
				timeout: T,
			});
			await expect(w.page.getByText("Reply.", { exact: true })).toHaveCount(1, { timeout: T });
			noBanner(`a first refusal of ${name}`, await frames(w));
			await expect(w.page.locator(".connection-error")).toHaveCount(0);
			assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	});
}

test("a read that keeps failing after the start settled is shown, with a way to retry", {
	timeout: 300000,
}, async () => {
	const w = await createWorld({ rules: CHATS });
	instrument(w);
	let failed = true;
	try {
		await launch(w);
		await addProject(w, "alpha");
		await say(w, "chat alpha");
		await w.app.close();
		refuse(w, 'name === "draftSettings"');
		await relaunch(w);
		await expect(w.page.locator("#namzu-sidebar")).toHaveAttribute("data-start-settled", "true", {
			timeout: T,
		});
		const banner = w.page.locator(".connection-error");
		await expect(banner).toContainText("Saved message settings could not be loaded", {
			timeout: T,
		});
		await expect(banner.getByRole("button", { name: "Retry setup" })).toBeVisible();
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});

// The window is told about a project before main has reached it (the start opens them one at a
// time, and a slow disk makes the wait long), and main refuses every draft read for a project it has
// not registered ("Unknown project."). Nothing has failed then, so the pane must not ask: no read of
// a draft is made while its project is still connecting, and no frame shows an error banner.
// The preload stands in for main's refusal while the page's `main-has-not-registered` flag is set;
// every call it saw is kept in localStorage, so the test knows the stand-in ran.
test("no draft is read before its project is registered, so no first frame shows a failed read", {
	timeout: 300000,
}, async () => {
	const w = await createWorld({ rules: CHATS });
	const gates = join(w.root, "gates");
	mkdirSync(gates, { recursive: true });
	instrument(w);
	let failed = true;
	try {
		await launch(w);
		await addProject(w, "alpha");
		await say(w, "chat alpha");
		await w.app.close();
		const preload = join(freezeApp(w.root), "dist/preload.cjs");
		const source = readFileSync(preload, "utf8");
		const call = "electron_1.ipcRenderer.invoke(`namzu:${name}`, ...args)";
		assert.ok(source.includes(call), "the preload still has the invoke the test replaces");
		writeFileSync(
			preload,
			source.replace(
				call,
				`(() => {
					const note = (entry) => {
						const all = JSON.parse(localStorage.getItem("e2e-calls") || "[]");
						all.push(entry);
						localStorage.setItem("e2e-calls", JSON.stringify(all));
					};
					const draftRead = ["draft", "draftSettings", "attachments"].includes(name) && String(args[0]).startsWith("project:");
					note(name);
					if (draftRead && localStorage.getItem("main-has-not-registered") === "1") {
						note("refused " + name);
						return Promise.reject(new Error("Unknown project."));
					}
					return ${call};
				})()`,
			),
		);
		w.env = { NAMZU_E2E_GATE_DIR: gates };
		writeFileSync(join(gates, "alpha.connect.hold"), "");
		writeFileSync(join(gates, "alpha.list.hold"), "");
		await relaunch(w);
		await w.page.evaluate(() => {
			localStorage.removeItem("e2e-calls");
			localStorage.setItem("main-has-not-registered", "1");
		});
		await w.page.reload();
		await w.page.waitForLoadState("domcontentloaded");
		await untilFiles(gates, (files) => files.includes("alpha.connect.held"));
		await expect(w.page.locator("#namzu-sidebar")).toHaveAttribute("data-start-settled", "false");
		// The stand-in saw the page start (so it is in the path), and refused nothing the page asked.
		const calls = () => w.page.evaluate(() => JSON.parse(localStorage.getItem("e2e-calls") || "[]"));
		assert.ok((await calls()).includes("projects"), "the stand-in saw the page's own calls");
		assert.deepEqual(
			(await calls()).filter((entry) => entry.startsWith("refused ")),
			[],
			"no draft was read for a project main has not registered",
		);
		noBanner("while the project connects", await frames(w));
		// Main registers the project: the reads are made now and answered.
		await w.page.evaluate(() => localStorage.setItem("main-has-not-registered", "0"));
		rmSync(join(gates, "alpha.connect.hold"));
		await untilFiles(gates, (files) => files.includes("alpha.list.held"));
		rmSync(join(gates, "alpha.list.hold"));
		await expect(w.page.locator("#namzu-sidebar")).toHaveAttribute("data-start-settled", "true", {
			timeout: T,
		});
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({
			timeout: T,
		});
		assert.ok((await calls()).includes("draftSettings"), "the choices were read once the project connected");
		noBanner("a start whose project connects late", await frames(w));
		await expect(w.page.locator(".connection-error")).toHaveCount(0);
		assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
		failed = false;
	} finally {
		await dispose(w, { failed });
	}
});
