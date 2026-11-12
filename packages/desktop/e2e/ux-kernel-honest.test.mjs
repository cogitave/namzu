// The app says honestly which command line and engine it carries: a newer one in the registry is
// said under the bundled version in About and on the command line's row in Settings > Updates,
// with nothing to press and no command to run. A stand-in registry and a stand-in update feed run
// on loopback; the command line the app carries here is the checkout's own (the desktop package's
// version, and the engine in its node_modules).
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-kernel-honest.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld, dispose, expect, launch, openProject } from "./harness.mjs";

const T = 60000;
const here = dirname(fileURLToPath(import.meta.url));
const versionOf = (file) => JSON.parse(readFileSync(join(here, "..", file), "utf8")).version;
const BUNDLED_CLI = versionOf("package.json");
const BUNDLED_ENGINE = versionOf("node_modules/@namzu/sdk/package.json");

/** A stand-in npm registry that answers `latest` for the programs and the engine, and records what it was asked. */
async function startRegistry(versions) {
	const state = { versions, status: 200, requests: [] };
	const server = createServer((req, res) => {
		state.requests.push(req.url);
		const match = /^\/(.+)\/latest$/.exec(req.url ?? "");
		const version = match ? state.versions[decodeURIComponent(match[1])] : undefined;
		if (state.status !== 200 || !version) return void res.writeHead(state.status === 200 ? 404 : state.status).end("{}");
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version }));
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	state.url = `http://127.0.0.1:${server.address().port}`;
	state.close = () => new Promise((done) => server.close(done));
	return state;
}

/** A stand-in update feed that holds no release yet: enough for the app to know it can update itself. */
async function startFeed() {
	const server = createServer((_req, res) => res.writeHead(404).end());
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return {
		url: `http://127.0.0.1:${server.address().port}/`,
		close: () => new Promise((done) => server.close(done)),
	};
}

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const registry = await startRegistry(options.versions);
		const feed = options.updatesOff ? undefined : await startFeed();
		const world = await createWorld({
			env: {
				NAMZU_ENGINE_REGISTRY: registry.url,
				NAMZU_ENGINE_FIRST_CHECK_MS: "300",
				...(feed ? { NAMZU_UPDATE_FEED_URL: feed.url } : {}),
			},
		});
		world.registry = registry;
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
			await registry.close();
			await feed?.close();
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

const row = (w) => w.page.locator("#setting-engine-namzu-cli");
const about = (w) => w.page.locator("#setting-about");
const checked = (w) => expect.poll(() => w.registry.requests.length, { timeout: T }).toBeGreaterThanOrEqual(4);
const NEWER = (version) => `A newer one exists (${version}). It arrives with an update of this app.`;

flow(
	"a newer command line and engine in the registry are said in About and on the command line row, with nothing to press",
	{
		versions: {
			"@namzu/cli": "51.0.1",
			"@namzu/sdk": "63.1.0",
			"@openai/codex": "0.162.0",
			"@anthropic-ai/claude-code": "2.1.295",
		},
	},
	async (w) => {
		await openProject(w);
		await checked(w);
		// The engine is asked of the registry like the programs.
		assert.ok(w.registry.requests.includes("/@namzu/sdk/latest"), `asked for the engine: ${w.registry.requests}`);

		await openSettings(w, "About");
		await expect(about(w).getByText(NEWER("51.0.1"))).toBeVisible({ timeout: T });
		await expect(about(w).getByText(NEWER("63.1.0"))).toBeVisible({ timeout: T });
		const cliFact = about(w).locator("div", { has: w.page.getByText("Namzu command line (bundled with this app)") }).last();
		await expect(cliFact).toContainText(BUNDLED_CLI);
		await expect(cliFact).toContainText(NEWER("51.0.1"));
		const engineFact = about(w).locator("div", { has: w.page.getByText("Namzu engine", { exact: true }) }).last();
		await expect(engineFact).toContainText(BUNDLED_ENGINE);
		await expect(engineFact).toContainText(NEWER("63.1.0"));

		await openSettings(w, "Updates");
		await expect(row(w)).toContainText("A newer one exists", { timeout: T });
		await expect(row(w)).toContainText(
			`Bundled with this app: ${BUNDLED_CLI}. The newest known is 51.0.1. It arrives with an update of this app.`,
		);
		await expect(row(w)).not.toContainText("Up to date");
		// Nothing in the row installs anything or names a command to run.
		await expect(row(w).getByRole("button")).toHaveCount(0);
		await expect(row(w).locator("code")).toHaveCount(0);
		assert.ok(!/npm|install -g/u.test(await row(w).innerText()), "the row names no command");
		// The rail offers no update for a program the app cannot update by itself.
		await expect(w.page.getByRole("button", { name: /^Updates available\. Open Settings to update/ })).toHaveCount(0);
	},
);

flow(
	"a registry that holds the bundled versions, or older ones, leaves About and the row as they were",
	{
		versions: {
			"@namzu/cli": BUNDLED_CLI,
			"@namzu/sdk": "1.0.0",
			"@openai/codex": "0.162.0",
			"@anthropic-ai/claude-code": "2.1.295",
		},
	},
	async (w) => {
		await openProject(w);
		await checked(w);
		await openSettings(w, "Updates");
		await expect(row(w)).toContainText("Up to date", { timeout: T });
		await openSettings(w, "About");
		await expect(about(w).getByText(BUNDLED_CLI, { exact: true }).first()).toBeVisible();
		await expect(about(w)).not.toContainText("A newer one exists");
	},
);

flow(
	"a registry that does not answer says nothing in About",
	{ versions: {} },
	async (w) => {
		w.registry.status = 503;
		await openProject(w);
		await checked(w);
		await openSettings(w, "About");
		await expect(about(w).getByText(BUNDLED_ENGINE, { exact: true })).toBeVisible({ timeout: T });
		await expect(about(w)).not.toContainText("A newer one exists");
	},
);

flow(
	"where the app cannot update itself, a newer kernel is not promised as an app update",
	{
		updatesOff: true,
		versions: {
			"@namzu/cli": "51.0.1",
			"@namzu/sdk": "63.1.0",
			"@openai/codex": "0.162.0",
			"@anthropic-ai/claude-code": "2.1.295",
		},
	},
	async (w) => {
		await openProject(w);
		await checked(w);
		await openSettings(w, "About");
		await expect(about(w).getByText(BUNDLED_ENGINE, { exact: true })).toBeVisible({ timeout: T });
		await expect(about(w)).not.toContainText("A newer one exists");
		await openSettings(w, "Updates");
		await expect(row(w)).toContainText("Up to date", { timeout: T });
	},
);
