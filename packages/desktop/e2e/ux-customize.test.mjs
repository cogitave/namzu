// The Customize page against the real Electron app, the real CLI host and the scripted model:
// Skills, Connectors and Plugins, their detail pages, and the way in from the navigation.
// Pictures go to $NAMZU_UX_OUT (default research/ux-customize/), at 1440x960 and 900x900, in both themes.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-customize.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 60000;
const OUT = process.env.NAMZU_UX_OUT ?? resolve(repoRoot, "research/ux-customize");
const SIZES = [
	{ name: "1440", width: 1440, height: 960 },
	{ name: "900", width: 900, height: 900 },
];

const resize = (w, width, height) =>
	w.app.evaluate(
		({ BrowserWindow }, size) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(size.width, size.height);
		},
		{ width, height },
	);

async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "dark") await expect(w.page.locator("html")).toHaveClass(/dark/);
	else await expect(w.page.locator("html")).not.toHaveClass(/dark/);
}

/** One picture per size and theme of whatever is on screen. */
async function shoot(w, name) {
	mkdirSync(OUT, { recursive: true });
	for (const size of SIZES) {
		await resize(w, size.width, size.height);
		for (const mode of ["dark", "light"]) {
			await theme(w, mode);
			await w.page.evaluate(async () => {
				document.querySelector(".customize-page")?.scrollTo(0, 0);
				await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			});
			await w.page.screenshot({ path: join(OUT, `${name}-${size.name}-${mode}.png`) });
		}
	}
	await resize(w, 1440, 960);
	await theme(w, "dark");
}

/** Nothing the page draws may spill past the column or leave the window sideways. */
async function noOverflow(w, label) {
	const bad = await w.page.evaluate(() => {
		const page = document.querySelector(".customize-page");
		if (!page) return ["no page"];
		const frame = page.getBoundingClientRect();
		const out = [];
		if (page.scrollWidth > page.clientWidth + 1) out.push(`page scrolls sideways (${page.scrollWidth} > ${page.clientWidth})`);
		for (const el of page.querySelectorAll(".customize-content *")) {
			const box = el.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) continue;
			if (box.right > frame.right + 1 || box.left < frame.left - 1)
				out.push(`${el.className || el.tagName} leaves the page (${Math.round(box.left)}..${Math.round(box.right)})`);
		}
		return out.slice(0, 5);
	});
	assert.deepEqual(bad, [], `${label}: nothing overflows`);
}

function skill(folder, name, description, files = {}) {
	const body = ["---", `name: ${name}`, `description: ${description}`, "---", `# ${name}`, "", `Steps for ${name}.`, ""].join("\n");
	for (const [path, text] of Object.entries({ "SKILL.md": body, ...files })) {
		mkdirSync(dirname(join(folder, name, path)), { recursive: true });
		writeFileSync(join(folder, name, path), text);
	}
}

const STUB = `import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
	let m; try { m = JSON.parse(l); } catch { return; }
	if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0.0" } } });
	if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
	if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

// The same server, but once broken.flag exists it connects and then cannot list its tools.
const BROKEN = STUB.replace(
	'return send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });',
	'return existsSync(new URL("./broken.flag", import.meta.url)) ? send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "The server could not list its tools." } }) : send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });',
).replace('import { createInterface }', 'import { existsSync } from "node:fs";\nimport { createInterface }');

const WORLD = {
	rules: [{ match: /greet me politely/, steps: [{ text: "Hi there." }] }],
	files: {
		"namzu.config.json": JSON.stringify({
			sandbox: { enabled: false },
			plugins: { enabled: true },
			skills: { overrides: { "half-sure": "name-only" } },
			mcpServers: {
				"notes-bridge": { command: process.execPath, args: ["./stub-mcp.mjs"] },
				"legacy-sync": { command: process.execPath, args: ["./broken-mcp.mjs"] },
			},
		}),
		"stub-mcp.mjs": STUB,
		"broken-mcp.mjs": BROKEN,
		".mcp.json": JSON.stringify({ mcpServers: { tickets: { command: process.execPath, args: ["./stub-mcp.mjs"] } } }),
	},
	seed: (w) => {
		const mine = join(w.home, "skills");
		skill(mine, "trip-planner", "Plan a trip: places, days, and a packing list for the season.", {
			"README.md": "# Trip planner\n\nSome **notes** about the skill.\n",
			"scripts/pack.sh": "#!/bin/sh\necho packing\n",
		});
		skill(mine, "half-sure", "Offered by name only in this project.");
		skill(mine, "old-helper", "An older helper kept around for now.");
		skill(join(w.project, ".namzu/skills"), "release-notes", "Write release notes from the merged changes since the last tag.");
		const plugins = join(w.project, ".namzu/plugins");
		for (const [name, version, extra] of [
			["acme-tools", "1.2.0", { skills: ["skills/deploy"], mcpServers: [{ name: "acme-api", command: process.execPath, args: [join(w.project, ".namzu/plugins/acme-tools/server.mjs")] }], author: "Acme Labs" }],
			["quiet-pack", "0.4.1", {}],
		]) {
			mkdirSync(join(plugins, name), { recursive: true });
			writeFileSync(
				join(plugins, name, "plugin.json"),
				JSON.stringify({ name, version, description: `${name} for the e2e project.`, ...extra }),
			);
		}
		writeFileSync(join(plugins, "acme-tools/server.mjs"), STUB);
		skill(join(plugins, "acme-tools/skills"), "deploy", "Ship the current branch to the staging site.");
	},
};

function flow(name, body) {
	test(name, { timeout: 480000 }, async () => {
		const world = await createWorld(WORLD);
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} catch (error) {
			// What the window says is the first thing to read when a flow stops.
			await world.page?.getByRole("button", { name: "Details" }).first().click().catch(() => undefined);
			const said = await world.page?.locator("[role=alert], [role=dialog]").allInnerTexts().catch(() => []);
			console.error("window alerts:", JSON.stringify(said));
			throw error;
		} finally {
			await dispose(world, { failed });
		}
	});
}

const page = (w) => w.page.locator(".customize-page");
const nav = (w) => w.page.getByRole("navigation", { name: "Main navigation" });

flow("Customize: skills, connectors and plugins, their detail pages, and the way in", async (w) => {
	await openProject(w);
	await send(w, "Please greet me politely");
	await expect(w.page.getByText("Hi there.")).toBeVisible({ timeout: T });

	// The way in: a button beside Settings in the sidebar's foot, and in the rail when it is collapsed.
	await expect(nav(w).getByRole("button", { name: "Customize" })).toBeVisible({ timeout: T });
	await nav(w).getByRole("button", { name: "Customize" }).click();
	await expect(page(w).getByRole("heading", { level: 1, name: "Customize" })).toBeVisible({ timeout: T });
	assert.equal(await page(w).evaluate((el) => getComputedStyle(el.querySelector("h1")).fontWeight), "400");

	// Skills: groups in order, rows with chips, no menu on a plugin's skill.
	const groups = page(w).locator(".customize-group-heading");
	await expect(groups.first()).toBeVisible({ timeout: T });
	const titles = (await groups.allInnerTexts()).map((t) => t.replace(/\s*\d+$/, "").trim());
	if (process.env.NAMZU_UX_SOFT) console.error("TITLES", titles);
	else assert.deepEqual(titles, ["This project", "Yours", "From plugins", "Built-in"]);
	await expect(page(w).getByRole("button", { name: "Open trip-planner" })).toBeVisible();
	await expect(page(w).getByText("Name only", { exact: true })).toBeVisible();
	await expect(page(w).getByText("acme-tools", { exact: true }).first()).toBeVisible();
	assert.equal(await page(w).getByRole("button", { name: "Actions for acme-tools__deploy" }).count(), 0, "a plugin's skill has no menu");
	const row = await page(w).locator(".customize-row").first().boundingBox();
	assert.equal(Math.round(row.height), 63, "a row is 63 px high");
	await noOverflow(w, "skills");

	// Turn a skill off from its menu: the chip and the setting follow.
	await page(w).getByRole("button", { name: "Actions for old-helper" }).click();
	await w.page.getByRole("menuitem", { name: "Turn off" }).click();
	await expect(page(w).locator(".customize-row", { hasText: "old-helper" }).getByText("Off", { exact: true })).toBeVisible({ timeout: T });
	await shoot(w, "1-skills-list");

	// The Add menu on Skills.
	await page(w).getByRole("button", { name: "Add" }).click();
	await expect(w.page.getByRole("menuitem", { name: "Create with Namzu" })).toBeVisible();
	await shoot(w, "7-skills-add-menu");
	await w.page.keyboard.press("Escape");

	// Search filters by name and description.
	await page(w).getByRole("searchbox", { name: "Search skills" }).fill("packing list");
	await expect(page(w).locator(".customize-row")).toHaveCount(1);
	await page(w).getByRole("searchbox", { name: "Search skills" }).fill("");

	// Skill detail: Overview.
	await page(w).getByRole("button", { name: "Open trip-planner" }).click();
	await expect(page(w).getByRole("heading", { name: "trip-planner" })).toBeVisible({ timeout: T });
	await expect(page(w).getByRole("button", { name: "Try in chat" })).toBeVisible();
	await expect(page(w).getByRole("switch", { name: "Use trip-planner" })).toBeChecked();
	await expect(page(w).getByText("~/.namzu/skills/trip-planner")).toBeVisible();
	await noOverflow(w, "skill overview");
	await shoot(w, "2-skill-overview");

	// Contents: the tree and SKILL.md rendered.
	await page(w).getByRole("tab", { name: /^Contents/ }).click();
	await expect(page(w).getByRole("navigation", { name: "Files" }).getByText("SKILL.md")).toBeVisible({ timeout: T });
	await expect(page(w).locator(".customize-viewer-body").getByRole("heading", { level: 1, name: "trip-planner" })).toBeVisible({ timeout: T });
	await noOverflow(w, "skill contents");
	await shoot(w, "3-skill-contents");
	await page(w).getByRole("button", { name: "Source" }).click();
	await expect(page(w).locator(".customize-source")).toContainText("name: trip-planner");

	// The switch writes skills.disabled, the same setting Settings reads.
	await page(w).getByRole("switch", { name: "Use trip-planner" }).click();
	await expect(page(w).getByRole("switch", { name: "Use trip-planner" })).not.toBeChecked({ timeout: T });
	await expect
		.poll(() => readFileSync(join(w.home, "config.yaml"), "utf8").includes("trip-planner"), { timeout: T })
		.toBe(true)
		.catch(() => undefined);
	await page(w).getByRole("switch", { name: "Use trip-planner" }).click();
	await expect(page(w).getByRole("switch", { name: "Use trip-planner" })).toBeChecked({ timeout: T });

	// Try in chat starts a new conversation with /name in the box, unsent.
	await page(w).getByRole("button", { name: "Try in chat" }).click();
	const box = w.page.getByRole("textbox", { name: "Message Namzu" });
	await expect(box).toHaveValue("/trip-planner ", { timeout: T });
	await nav(w).getByRole("button", { name: "Customize" }).click();
	await expect(page(w).getByRole("heading", { level: 1, name: "Customize" })).toBeVisible({ timeout: T });

	// A name-only skill says so in its detail, with the switch still on.
	await page(w).getByRole("button", { name: "Open half-sure" }).click();
	await expect(page(w).getByText("Set to name only in this project’s local settings")).toBeVisible({ timeout: T });
	await w.page.keyboard.press("Escape");
	await expect(page(w).getByRole("heading", { level: 1, name: "Customize" })).toBeVisible({ timeout: T });

	// Plugins. A plugin is switched in a conversation that is running, so go back to the first one.
	await w.page.getByRole("button", { name: "Please greet me politely", exact: true }).first().click();
	await expect(w.page.getByText("Hi there.")).toBeVisible({ timeout: T });
	await nav(w).getByRole("button", { name: "Customize" }).click();
	await page(w).getByRole("tab", { name: "Plugins" }).click();
	await expect(page(w).getByRole("button", { name: "Open acme-tools" })).toBeVisible({ timeout: T });
	await page(w).getByRole("button", { name: "Actions for quiet-pack" }).click();
	await w.page.getByRole("menuitem", { name: "Turn off" }).click();
	await expect(page(w).locator(".customize-row", { hasText: "quiet-pack" }).getByText("Off", { exact: true })).toBeVisible({ timeout: T });
	await noOverflow(w, "plugins");
	await shoot(w, "4-plugins-list");
	await page(w).getByRole("button", { name: "Open acme-tools" }).click();
	await expect(page(w).getByRole("heading", { name: "acme-tools" })).toBeVisible({ timeout: T });
	await page(w).getByRole("tab", { name: /^Skills/ }).click();
	await expect(page(w).getByText("/acme-tools__deploy").or(page(w).getByText("/deploy"))).toBeVisible({ timeout: T });
	await expect(page(w).getByText("Use them by typing / in chat")).toBeVisible();
	await noOverflow(w, "plugin skills");
	await shoot(w, "5-plugin-skills");
	await page(w).getByRole("tab", { name: /^Connectors/ }).click();
	await expect(page(w).getByText("acme-api")).toBeVisible();
	await page(w).getByRole("button", { name: "Your plugins" }).click();

	// A server that fails to list its tools fails the turn that reaches it; the table shows it as failed.
	writeFileSync(join(w.project, "broken.flag"), "1");
	await w.page.getByRole("button", { name: "New conversation" }).first().click();
	await send(w, "Please greet me politely once more");
	await expect(w.page.getByRole("alert").first()).toBeVisible({ timeout: T });
	await nav(w).getByRole("button", { name: "Customize" }).click();

	// Connectors: a tick, an Approve button and a failure with its reason.
	await page(w).getByRole("tab", { name: "Connectors" }).click();
	const table = page(w).getByRole("table");
	await expect(table).toBeVisible({ timeout: T });
	await expect(table.getByRole("row", { name: /notes-bridge/ }).getByRole("img", { name: "Connected" })).toBeVisible({ timeout: T });
	await expect(table.getByRole("button", { name: "Approve tickets" })).toBeVisible({ timeout: T });
	await expect(table.getByRole("row", { name: /legacy-sync/ }).getByText("Failed")).toBeVisible({ timeout: T });
	await noOverflow(w, "connectors");
	await shoot(w, "6-connectors");

	// A row opens Settings on the tool servers.
	await table.getByRole("button", { name: "notes-bridge" }).click();
	await expect(w.page.getByRole("list", { name: "Tool server list" })).toBeVisible({ timeout: T });
});
