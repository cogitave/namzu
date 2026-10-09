// Settings, updates and visual polish against the real Electron app, the real CLI host and the
// scripted model. Pictures go to research/ux-20261009/settings-visual/, in both themes.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-settings-visual.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/ux-20261009/settings-visual");

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "dark") await expect(w.page.locator("html")).toHaveClass(/dark/);
	else await expect(w.page.locator("html")).not.toHaveClass(/dark/);
}

/** Both themes of whatever is on screen, under one name. */
async function shootBoth(w, name) {
	await theme(w, "dark");
	await shot(w, `${name}-dark`);
	await theme(w, "light");
	await shot(w, `${name}-light`);
	await theme(w, "dark");
}

const resize = (w, width, height) =>
	w.app.evaluate(
		({ BrowserWindow }, size) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(size.width, size.height);
		},
		{ width, height },
	);

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld(options);
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
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

const pageText = (w) => w.page.locator("#settings-content").innerText();

/* ------------------------------------------------------------------------------------------------
 * Welcome
 * ---------------------------------------------------------------------------------------------- */

flow("the welcome screen has one wordmark, in the sidebar", {}, async (w) => {
	await expect(w.page.getByRole("heading", { level: 1, name: "What would you like to work on?" })).toBeVisible({
		timeout: T,
	});
	await expect(w.page.getByRole("img", { name: "Namzu", exact: true })).toHaveCount(1);
	await shootBoth(w, "welcome");
});

/* ------------------------------------------------------------------------------------------------
 * Settings pages
 * ---------------------------------------------------------------------------------------------- */

flow("Settings has one heading per page, no control-less shell row, and a search that reads Turkish capitals", {}, async (w) => {
	await openProject(w);
	await openSettings(w, "General");
	// The column title is the only "Settings"; the page heading is the section.
	await expect(w.page.getByRole("heading", { name: "Settings", exact: true })).toHaveCount(0);
	// On this system there is one shell, so the row would have nothing to click and is not drawn.
	await expect(w.page.getByText("Default terminal shell")).toHaveCount(0);
	await expect(w.page.getByText("Bring terminal tabs back").first()).toBeVisible();
	await shootBoth(w, "settings-general");

	const search = w.page.getByRole("searchbox", { name: "Search settings" });
	await search.fill("TERMİNAL");
	await expect(w.page.getByRole("button", { name: /^Bring terminal tabs back/ })).toBeVisible();
	await expect(w.page.getByText(/^No setting matches/)).toHaveCount(0);
	await search.fill("termınal");
	await expect(w.page.getByRole("button", { name: /^Bring terminal tabs back/ })).toBeVisible();
	// The shell row is hidden, so search does not lead to it either.
	await search.fill("shell");
	await expect(w.page.getByRole("button", { name: /^Default terminal shell/ })).toHaveCount(0);
	await search.fill("");
});

flow("every Settings section opens with the same header, so the search box never moves", {}, async (w) => {
	await openProject(w);
	let top;
	for (const section of ["General", "Models", "Projects", "Appearance", "Updates", "Speech", "About"]) {
		await openSettings(w, section);
		const searchbox = w.page.getByRole("searchbox", { name: "Search settings" });
		const title = w.page.getByRole("heading", { level: 1, name: section, exact: true });
		await expect(w.page.locator(".settings-page-header p")).toHaveText(/\S/);
		// The page eases in; measure once its animations have finished, against the first section's positions.
		await w.page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)));
		top ??= { search: Math.round((await box(searchbox)).top), heading: Math.round((await box(title)).top) };
		await expect.poll(async () => Math.round((await box(searchbox)).top), { timeout: T, message: `${section}: the search box stays put` }).toBe(top.search);
		await expect.poll(async () => Math.round((await box(title)).top), { timeout: T, message: `${section}: the heading stays put` }).toBe(top.heading);
		await shot(w, `settings-header-${section.toLowerCase()}`);
	}
});

flow("About says versions and system in plain words, with paths only under Data folders", {}, async (w) => {
	await openProject(w);
	await openSettings(w, "About");
	await expect(w.page.getByText("Namzu command line (bundled with this app)", { exact: true })).toBeVisible();
	await expect(w.page.getByText("Namzu engine (SDK)", { exact: true })).toBeVisible();
	await expect(w.page.getByText("Linux (64-bit Intel or AMD)")).toBeVisible();
	const text = await pageText(w);
	const beforeFolders = text.slice(0, text.indexOf("Data folders"));
	assert.doesNotMatch(beforeFolders, /linux x64/);
	assert.ok(!beforeFolders.includes(w.osHome) && !beforeFolders.includes(w.home), "no raw path above Data folders");
	assert.match(beforeFolders, /Namzu command line \(bundled with this app\)\s+\d+\.\d+\.\d+/);
	// Which folders are safe to clear, and which hold the person's work, is said in the page.
	assert.match(text, /safe to delete/i);
	await expect(w.page.getByText(/Your conversations, Pals and projects\. Keep this folder\./)).toBeVisible();
	await expect(w.page.getByRole("button", { name: "Copy version details" })).toBeVisible();
	await expect(w.page.getByRole("button", { name: /^Open / }).first()).toBeVisible();
	await shootBoth(w, "settings-about");
});

flow("Speech before the download says what it does and offers one Download voice action, with no placeholders", {}, async (w) => {
	await openProject(w);
	await openSettings(w, "Speech");
	await expect(w.page.getByText("Reads replies aloud in Turkish")).toBeVisible();
	const text = await pageText(w);
	for (const jargon of ["Not measured", "EMA Lightning", "worker", "RAM", "VRAM", "Enable voice", "Free memory when idle"])
		assert.ok(!text.includes(jargon), `the Speech page does not say "${jargon}" before a download`);
	assert.ok(!text.includes(w.home) && !text.includes(w.osHome), "no raw path on the Speech page");
	await expect(w.page.getByRole("button", { name: "Download voice" })).toHaveCount(1);
	await expect(w.page.getByText(/MiB to download/)).toBeVisible();
	await shootBoth(w, "settings-speech");
});

flow("turning the re-ask check off says project, and one concrete consequence", {}, async (w) => {
	await openProject(w);
	await openSettings(w, "Projects");
	const ask = w.page.getByRole("switch", { name: "Ask again when a project’s automatic settings change" });
	await expect(ask).toBeEnabled({ timeout: T });
	// The switch stays on until the confirmation is accepted, so a plain click is the action, not uncheck().
	await ask.click();
	const confirm = w.page.getByRole("dialog", { name: "Stop asking when a project’s automatic settings change?" });
	await expect(confirm).toBeVisible();
	await expect(confirm.getByText("Hooks, servers and plugins a project adds later will run without asking.")).toBeVisible();
	await expect(confirm).not.toContainText("folder");
	await shootBoth(w, "settings-reask-dialog");
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(ask).toBeChecked();
});

/* ------------------------------------------------------------------------------------------------
 * Updates: stand-in programs behind a local registry. The stand-in npm waits for a release file, so
 * the "updating" state is on screen for as long as the flow wants it.
 * ---------------------------------------------------------------------------------------------- */

const FAKE_CODEX = (version) => `#!/usr/bin/env node
const VERSION = "${version}";
if (process.argv[2] === "--version") { console.log("codex-cli " + VERSION); process.exit(0); }
process.exit(2);
`;

const FAKE_CLAUDE = (version) => `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("${version} (Claude Code)"); process.exit(0); }
process.exit(2);
`;

const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.UX_CONTROL_DIR;
console.log("fake npm install, waiting for the release file");
const wait = () => fs.existsSync(dir + "/release") ? finish() : setTimeout(wait, 50);
const finish = () => {
	const file = dir + "/lib/node_modules/@openai/codex/bin/codex.js";
	fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/const VERSION = "[^"]*";/, 'const VERSION = "0.162.0";'));
	console.log("added 1 package, changed 1 package");
	process.exit(0);
};
wait();
`;

async function startRegistry() {
	const versions = { "@openai/codex": "0.162.0", "@anthropic-ai/claude-code": "2.1.295", "@namzu/cli": "1.0.0" };
	const server = createServer((req, res) => {
		const match = /^\/(.+)\/latest$/.exec(req.url ?? "");
		const version = match ? versions[decodeURIComponent(match[1])] : undefined;
		if (!version) return void res.writeHead(404).end("{}");
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version }));
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

function updateFlow(name, body) {
	test(name, { timeout: 240000 }, async () => {
		const control = mkdtempSync(join(tmpdir(), "namzu-ux-control-"));
		const bin = mkdtempSync(join(tmpdir(), "namzu-ux-bin-"));
		const lib = join(control, "lib/node_modules/@openai/codex/bin");
		mkdirSync(lib, { recursive: true });
		writeFileSync(join(lib, "codex.js"), FAKE_CODEX("0.154.0"));
		chmodSync(join(lib, "codex.js"), 0o755);
		symlinkSync(join(lib, "codex.js"), join(bin, "codex"));
		writeFileSync(join(bin, "npm"), FAKE_NPM);
		chmodSync(join(bin, "npm"), 0o755);
		const registry = await startRegistry();
		const world = await createWorld({
			pathPrefix: bin,
			env: {
				UX_CONTROL_DIR: control,
				NAMZU_ENGINE_REGISTRY: registry.url,
				NAMZU_ENGINE_FIRST_CHECK_MS: "300",
				SHELL: "/bin/sh",
			},
			seed: (w) => {
				const where = join(w.osHome, ".local/bin/claude");
				mkdirSync(join(where, ".."), { recursive: true });
				writeFileSync(where, FAKE_CLAUDE("2.1.290"));
				chmodSync(where, 0o755);
				symlinkSync(where, join(bin, "claude"));
			},
		});
		Object.assign(world, { control });
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
			await registry.close();
			rmSync(control, { recursive: true, force: true });
			rmSync(bin, { recursive: true, force: true });
		}
	});
}

const row = (w, id) => w.page.locator(`#setting-engine-${id}`);

updateFlow(
	"two updates found together share one toast, and Update keeps the person in Settings with progress on the row",
	async (w) => {
		await openProject(w);
		// One toast names both programs; neither is stacked unreadably behind the other.
		const toast = w.page.getByText("Updates available for Codex CLI and Claude Code");
		await expect(toast).toBeVisible({ timeout: T });
		await expect(w.page.locator(".toast-root")).toHaveCount(1);
		await expect(w.page.getByText("Codex CLI 0.162.0 is available")).toHaveCount(0);
		await shootBoth(w, "updates-one-toast");

		// The toast's action opens Settings ▸ Updates.
		await w.page.getByRole("button", { name: "Update…" }).first().click();
		await expect(w.page.getByRole("heading", { level: 1, name: "Updates", exact: true })).toBeVisible({ timeout: T });
		const text = await pageText(w);
		// This build has no updater: nothing contradicts that, and no switch controls what cannot happen.
		await expect(w.page.getByRole("switch", { name: "Download updates automatically" })).toHaveCount(0);
		await expect(w.page.getByText("Namzu Desktop version")).toBeVisible();
		await expect(w.page.getByRole("button", { name: "Check for updates" })).toBeVisible();
		await expect(w.page.getByRole("button", { name: "Check the programs" })).toHaveCount(0);
		// This copy cannot update itself, so it claims no check of its own.
		assert.ok(!/Last checked/.test(text), "no Last checked on a copy that cannot update itself");
		assert.ok(!/You may be offline/.test(text), "no offline wording");
		assert.ok(!/Download updates automatically/.test(text));
		// One Namzu command line row, which says what bundled means.
		await expect(w.page.locator("[id^='setting-engine-namzu']")).toHaveCount(1);
		// The bundled one says it updates with the app; a copy the machine has on its own PATH is labelled as separate.
		await expect(row(w, "namzu-cli")).toContainText(
			/Bundled with Namzu Desktop, so it updates with the app\.|Namzu command line \(installed separately\)/,
		);
		await expect(row(w, "namzu-cli")).toContainText(/\d+\.\d+\.\d+/);
		await expect(row(w, "codex-cli")).toContainText("0.154.0 → 0.162.0");
		await shootBoth(w, "updates-page");

		// Update: the person stays in Settings and the row shows the progress with a way to the output.
		await row(w, "codex-cli").getByRole("button", { name: "Update Codex CLI" }).click();
		await expect(row(w, "codex-cli").getByRole("button", { name: "Updating…" })).toBeDisabled({ timeout: T });
		await expect(row(w, "codex-cli")).toContainText("Updating…");
		await expect(w.page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
		await expect(w.page.getByRole("heading", { level: 1, name: "Updates", exact: true })).toBeVisible();
		await expect(row(w, "codex-cli")).not.toContainText("--registry");
		await shootBoth(w, "updates-in-progress");

		// The link leads to the terminal tab that shows the output.
		await row(w, "codex-cli").getByRole("button", { name: "Show terminal output" }).click();
		await expect(w.page.getByRole("navigation", { name: "Settings sections" })).toHaveCount(0);
		// The strip may show a shorter whole-word title in a narrow window; the full one is the label.
		await expect(
			w.page.locator("[data-terminal-tab-id]").first().locator(".conversation-tab-label"),
		).toHaveAttribute("aria-label", /^Updating Codex CLI, terminal/);
		await shot(w, "updates-terminal-output");

		// Back in Settings the row finishes by itself once the update does.
		await openSettings(w, "Updates");
		await expect(row(w, "codex-cli")).toContainText("Updating…");
		writeFileSync(join(w.control, "release"), "");
		await expect(w.page.getByText("Codex CLI updated to 0.162.0")).toBeVisible({ timeout: T });
		await expect(row(w, "codex-cli")).toContainText("Up to date", { timeout: T });
		await expect(w.page.getByRole("heading", { level: 1, name: "Updates", exact: true })).toBeVisible();
		await shootBoth(w, "updates-finished");
	},
);

/* ------------------------------------------------------------------------------------------------
 * The composer, headings, time and the Changes panel
 * ---------------------------------------------------------------------------------------------- */

const box = (locator) => locator.evaluate((el) => {
	const r = el.getBoundingClientRect();
	return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
});

flow("the project strip shares the composer's edges, and the empty-state heading balances", {}, async (w) => {
	await openProject(w);
	for (const [width, height] of [[1440, 900], [900, 720]]) {
		await resize(w, width, height);
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible();
		const strip = w.page.locator('[data-slot="composer-context-strip"]').first();
		await expect(strip).toBeVisible();
		const host = w.page.locator('[data-slot="composer-host"]').first();
		await expect.poll(async () => {
			const [s, h] = [await box(strip), await box(host)];
			return Math.max(Math.abs(s.left - h.left), Math.abs(s.right - h.right));
		}, { timeout: T }).toBeLessThanOrEqual(1);
		// The strip is not a box behind the composer: nothing of it hides under the card.
		const [s, h] = [await box(strip), await box(host)];
		assert.ok(s.bottom <= h.top + 1, `the strip (${s.bottom}) ends above the composer card (${h.top})`);
		const heading = w.page.getByRole("heading", { level: 1 }).first();
		assert.equal(await heading.evaluate((el) => getComputedStyle(el).textWrap), "balance");
		await shootBoth(w, `composer-strip-${width}`);
	}
});

const WRITE = {
	match: /write the file/i,
	steps: [{ tool: "write", args: { path: "out.txt", content: "hello from the model\n" } }, { text: "Wrote out.txt." }],
};
const LONG = {
	match: /long please/i,
	steps: [{ text: Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`).join("\n\n") }],
};

flow("times read one way, the composer's edge is solid, and the Changes panel does not crush the chat at 900px", { rules: [WRITE, LONG, { match: /hello/, steps: [{ text: "Scripted hello back." }] }] }, async (w) => {
	await openProject(w);
	await send(w, "hello");
	await expect(w.page.getByText("Scripted hello back.")).toBeVisible({ timeout: T });
	// The day header and the message footers use one clock style, and the footer has no seconds.
	const header = (await w.page.locator(".transcript time").first().textContent()) ?? "";
	const footer = (await w.page.locator(".message-time").first().textContent()) ?? "";
	const twelveHour = (text) => /\b(AM|PM)\b/iu.test(text);
	assert.equal(twelveHour(header), twelveHour(footer), `header "${header}" and footer "${footer}" agree on 12 or 24 hours`);
	assert.doesNotMatch(footer, /:\d{2}:\d{2}/, `the footer "${footer}" shows no seconds`);
	const label = await w.page.locator(".message-time").first().getAttribute("aria-label");
	assert.match(label ?? "", /^(Sent at|Received at) /);

	// A long reply never shows through under the composer.
	await send(w, "long please");
	await expect(w.page.getByText("Paragraph 30:")).toBeAttached({ timeout: T });
	await resize(w, 1440, 900);
	const edge = await w.page.locator('[data-chat-composer-overlay]').evaluate((el) => {
		const after = getComputedStyle(el, "::after");
		return { height: after.height, background: after.backgroundColor, content: after.content };
	});
	assert.equal(edge.height, "24px");
	assert.notEqual(edge.background, "rgba(0, 0, 0, 0)");
	await shootBoth(w, "long-conversation");

	// The Changes panel at 900px: the transcript stays readable and the composer stays reachable.
	await send(w, "Please write the file");
	const card = w.page.getByRole("region", { name: "Tool approval" });
	await expect(card).toBeVisible({ timeout: T });
	await card.getByRole("button", { name: "Accept", exact: true }).click();
	await expect(w.page.getByText("Wrote out.txt.")).toBeVisible({ timeout: T });
	await resize(w, 900, 720);
	await w.page.getByRole("button", { name: "View changes" }).last().click();
	const panel = w.page.getByRole("complementary", { name: "Changes" });
	await expect(panel).toBeVisible({ timeout: T });
	const lane = await box(w.page.locator(".chat-stage").first());
	// The panel slides in; look at it once it has stopped.
	await expect
		.poll(async () => Math.round((await box(panel)).left), { timeout: T })
		.toBeLessThanOrEqual(Math.round(lane.left) + 1);
	await shootBoth(w, "changes-panel-900");
	const side = await box(panel);
	// Either the panel leaves the chat at least 420px, or it covers the chat entirely with a way back.
	const visibleChat = Math.max(0, side.left - lane.left);
	const covers = side.left <= lane.left + 1;
	assert.ok(visibleChat >= 420 || covers, `the chat keeps ${visibleChat}px beside the panel, or the panel covers it`);
	if (covers) {
		await panel.getByRole("button", { name: "Back to conversation" }).click();
		await expect(panel).toBeHidden();
		await expect(w.page.getByText("Wrote out.txt.")).toBeVisible();
		await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible();
	}
});
