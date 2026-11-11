// Dead ends: what Namzu shows must lead somewhere. Real Electron, real CLI host, scripted model.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test packages/desktop/e2e/ux-honest-dead-ends.test.mjs
// Screenshots land in $NAMZU_E2E_SHOTS (default: a folder in the temp directory) and are looked at, not asserted.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	answerDialogs,
	createWorld,
	dialogsSeen,
	dispose,
	expect,
	launch,
	openProject,
	relaunch,
	send,
} from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.NAMZU_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "namzu-dead-ends-"));
mkdirSync(SHOTS, { recursive: true });
const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}.png`) });

function flow(name, options, body) {
	test(name, { timeout: 180000 }, async () => {
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

const TICKETS = `import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
	let m; try { m = JSON.parse(l); } catch { return; }
	if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "tickets", version: "1.0.0" } } });
	if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ticket_lookup", description: "Look up a ticket", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] } });
	if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

flow("the navigation controls offer only places that exist, open and collapsed", {}, async (w) => {
	await openProject(w);
	// Open, the rail is not drawn: its controls are the foot of the sidebar, and Home is the New conversation row.
	const nav = w.page.getByRole("navigation", { name: "Main navigation" });
	await expect(nav.getByRole("button", { name: "Settings" })).toBeVisible({ timeout: T });
	assert.equal(await w.page.locator(".navigation-rail").count(), 0, "no rail while the sidebar is open");
	assert.equal(await nav.getByRole("button").count(), 1, "Settings only: Home is the New conversation row");
	await expect(w.page.locator("aside.sidebar").getByRole("button", { name: "New conversation" }).first()).toBeVisible();
	await shot(w, "foot");
	// Collapsed, the rail is drawn as it always was.
	await w.page.getByRole("button", { name: "Toggle sidebar" }).click();
	await expect(w.page.locator(".navigation-rail")).toBeVisible({ timeout: T });
	await expect(nav.getByRole("button", { name: "Home" })).toBeVisible({ timeout: T });
	await expect(nav.getByRole("button", { name: "Settings" })).toBeVisible();
	for (const gone of ["Spaces", "Scheduled", "Plugins"])
		assert.equal(await nav.getByRole("button", { name: gone }).count(), 0, `${gone} is not offered`);
	assert.equal(await nav.getByRole("button").count(), 2, "Home and Settings only");
	await shot(w, "rail");
});

flow(
	"a reply cut off by closing Namzu can be carried on, in words that say it is a new message",
	{
		rules: [
			{ match: /hello first/, steps: [{ text: "Hello back." }] },
			{ match: /look around/, steps: [{ tool: "read", args: { path: "package.json" } }, { hold: "slow", text: "Slow reply done." }] },
			{ match: /continue from where you stopped/, steps: [{ text: "Carrying on from the stop." }] },
		],
		files: { "package.json": '{"name":"shop"}\n' },
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello first");
		await expect(w.page.getByText("Hello back.")).toBeVisible({ timeout: T });
		await send(w, "look around the project");
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toBeVisible({ timeout: T });
		// Close only once the reply is parked at the model: the first message, the tool call and the
		// request that carries its result have all been asked. A close in the first instant of a
		// turn, before the host has written anything to stop it with, is not the case under test.
		await expect.poll(() => w.model.requests.length, { timeout: T }).toBeGreaterThanOrEqual(3);
		await answerDialogs(w, 1);
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
		// The next start reads what the old one left, so wait for the old one to be gone.
		const old = w.app.process();
		if (old.exitCode === null && old.signalCode === null) await once(old, "exit");
		await relaunch(w);
		await w.page.getByRole("button", { name: /hello first/ }).first().click();
		await expect(w.page.getByText("Stopped because Namzu was closed.")).toBeVisible({ timeout: T });
		const carryOn = w.page.getByRole("button", { name: "Ask Namzu to continue" });
		await expect(carryOn).toBeVisible();
		await expect(w.page.getByText("This sends a new message. The stopped reply cannot be resumed.")).toBeVisible();
		await shot(w, "stopped-with-continue");
		await carryOn.click();
		await expect(w.page.getByText("Carrying on from the stop.")).toBeVisible({ timeout: T });
		assert.equal(await w.page.getByText("Stopped because Namzu was closed.").count(), 0, "the old stop is settled");
		assert.equal(await carryOn.count(), 0, "nothing left to press");
		await shot(w, "continued");
	},
);

flow(
	"Settings lists the project's tool servers, shows the ones waiting for approval, and approves them",
	{
		seed: (w) => {
			writeFileSync(join(w.project, "tickets-mcp.mjs"), TICKETS);
			writeFileSync(
				join(w.project, ".mcp.json"),
				JSON.stringify({ mcpServers: { tickets: { command: process.execPath, args: [join(w.project, "tickets-mcp.mjs")] } } }),
			);
		},
		rules: [{ match: /say hi/, steps: [{ text: "Hi there." }] }],
	},
	async (w) => {
		await openProject(w);
		const open = async () => {
			await w.page.getByRole("button", { name: "Settings", exact: true }).click();
			await w.page.getByRole("button", { name: "Tools", exact: true }).click();
		};
		await open();
		const list = w.page.getByRole("list", { name: "Tool server list" });
		await expect(list.getByText("tickets")).toBeVisible({ timeout: T });
		await expect(list.getByText("Waiting for your approval")).toBeVisible();
		await expect(list.getByText(".mcp.json in this project")).toBeVisible();
		assert.equal(await w.page.locator("#setting-mcpServers").getByText("Not set").count(), 0, "no false 'Not set'");
		await shot(w, "servers-waiting");
		await w.page.getByRole("button", { name: "Approve this server" }).click();
		await expect(list.getByText("Not connected right now")).toBeVisible({ timeout: T });
		assert.equal(await w.page.getByRole("button", { name: "Approve this server" }).count(), 0);
		await shot(w, "servers-approved");
		await w.page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Home", exact: true }).click();
		await send(w, "say hi");
		await expect(w.page.getByText("Hi there.")).toBeVisible({ timeout: T });
		await open();
		await expect(w.page.getByRole("list", { name: "Tool server list" }).getByText("Connected")).toBeVisible({ timeout: T });
		await shot(w, "servers-connected");
	},
);

flow(
	"searching conversations finds what a reply said, with an excerpt, not only titles",
	{
		rules: [
			{ match: /fix the total/, steps: [{ text: "I fixed total() in src/cart.js: it ignored qty, so three items at 2 gave 2." }] },
			{ match: /header wraps/, steps: [{ text: "The header now wraps on narrow screens." }] },
		],
	},
	async (w) => {
		await openProject(w);
		await send(w, "Please fix the total");
		await expect(w.page.getByText("it ignored qty")).toBeVisible({ timeout: T });
		await w.page.keyboard.press("Control+n");
		await send(w, "Check the header wraps");
		await expect(w.page.getByText("The header now wraps")).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: "Search conversations" }).click();
		await w.page.keyboard.type("qty");
		const hit = w.page.locator("[data-command-id^='conversation:']");
		await expect(hit).toHaveCount(1, { timeout: T });
		await expect(hit.getByText("it ignored qty", { exact: false })).toBeVisible();
		await expect(hit.getByText("Please fix the total")).toBeVisible();
		await shot(w, "search-by-text");
		await w.page.keyboard.press("ArrowDown");
		await w.page.keyboard.press("Enter");
		await expect(w.page.getByText("it ignored qty").first()).toBeVisible({ timeout: T });
	},
);
