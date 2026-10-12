// The Pal computer row when this PC has to be set up (Windows), walked on Linux with a stand-in for
// `namzu computer status | setup | stop-idle`. No engine, no paid model, no owner data.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-pal-computer-setup.test.mjs
// Set PAL_SETUP_SHOTS to a directory to keep the screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject } from "./harness.mjs";

const SHOTS = process.env.PAL_SETUP_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const MB = 1024 * 1024;
const step = (kind, extra = {}) => ({
	kind,
	elevated: kind === "install-wsl" || kind === "enable-windows-features",
	estimatedSeconds: 60,
	mayRequireRestart: kind === "install-wsl",
	...extra,
});
const plan = (id, steps, extra = {}) => ({
	id,
	state: "wsl-missing",
	steps,
	elevationPrompts: steps.some((s) => s.elevated) ? 1 : 0,
	mayRequireRestart: steps.some((s) => s.mayRequireRestart),
	...extra,
});
const FULL = plan("plan-full", [
	step("download-wsl", { downloadBytes: 351 * MB, estimatedSeconds: 120 }),
	step("install-wsl", { estimatedSeconds: 60 }),
	step("load-image", { estimatedSeconds: 20 }),
]);
const IMAGE = plan("plan-image", [step("load-image", { estimatedSeconds: 20 })], {
	state: "image-missing",
});
const READY = plan("plan-ready", [], { state: "ready" });
const status = (readiness, p) => ({ readiness: { state: readiness }, plan: p });

/** A scripted world: the stand-in answers from `script`, and the flow can read what was asked. */
async function scripted(script, extraEnv = {}) {
	const directory = mkdtempSync(join(tmpdir(), "namzu-cs-"));
	const file = join(directory, "script.json");
	writeFileSync(file, JSON.stringify(script));
	const world = await createWorld({
		rules: [],
		env: {
			NAMZU_E2E_PAL_COMPUTER: "fake",
			NAMZU_E2E_PAL_COMPUTER_SETUP: "1",
			NAMZU_E2E_COMPUTER_SCRIPT: file,
			...extraEnv,
		},
	});
	const calls = () => {
		try {
			return readFileSync(`${file}.calls`, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((entry) => JSON.parse(entry));
		} catch {
			return [];
		}
	};
	return {
		world,
		calls,
		go: () => writeFileSync(`${file}.go`, ""),
		rewrite: (next) => writeFileSync(file, JSON.stringify(next)),
	};
}

async function createKiro(world) {
	const page = world.page;
	await expect(async () => {
		await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 60000 });
	await expect(async () => {
		const dialog = page.getByRole("dialog", { name: "Customize your Pal" });
		if (
			!(await dialog.isVisible()) &&
			!(await page.getByRole("button", { name: "Customize your Pal" }).isVisible())
		)
			await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		if (!(await dialog.isVisible()))
			await page.getByRole("button", { name: "Customize your Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("dialog", { name: "Customize your Pal" })).toBeVisible({
			timeout: 2000,
		});
	}).toPass({ timeout: 60000 });
	const customize = page.getByRole("dialog", { name: "Customize your Pal" });
	await customize.getByRole("textbox", { name: "Pal name" }).fill("Kiro");
	await customize.getByRole("textbox", { name: "Pal name" }).press("Enter");
	await expect(page.getByRole("tab", { name: "Kiro" })).toBeVisible({ timeout: 60000 });
	return readdirSync(join(world.home, "pals"))[0];
}

async function open(script, extraEnv) {
	const flow = await scripted(script, extraEnv);
	await launch(flow.world);
	await flow.world.app.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) window.setSize(1440, 900);
	});
	await openProject(flow.world);
	await createKiro(flow.world);
	const context = flow.world.page.locator(".pal-context-body").first();
	await expect(context).toBeVisible({ timeout: 60000 });
	return { ...flow, context, page: flow.world.page };
}
const shot = async (flow, name) => {
	if (SHOTS) await flow.page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const rowStatus = (context) => context.locator(".pal-computer-entry");
const JARGON = /wslc|\bwsl\b|hcs|\bvmp\b|\bsku\b|hresult|0x[0-9a-f]{4,}|download-wsl|load-image/i;

test(
	"needs setup: Needs setup, then one sentence, then progress, then a restart",
	{ timeout: 280000 },
	async () => {
		const flow = await open({
			status: status("wsl-missing", FULL),
			setup: {
				before: [
					{ progress: { step: "download-wsl", phase: "started" } },
					{
						progress: {
							step: "download-wsl",
							phase: "progress",
							done: 120 * MB,
							total: 351 * MB,
							unit: "bytes",
						},
					},
				],
				gate: true,
				after: [
					{ progress: { step: "download-wsl", phase: "finished", result: "ok" } },
					{ progress: { step: "install-wsl", phase: "started" } },
					{ progress: { step: "install-wsl", phase: "finished", result: "restart-required" } },
					{ result: { outcome: "restart-required" } },
				],
			},
		});
		let failed = true;
		try {
			const { context, page } = flow;
			const action = context.getByRole("button", { name: "Set up and start Kiro" });
			await expect(action).toBeVisible({ timeout: 60000 });
			await page.mouse.move(0, 0);
			await expect(action.locator(".pal-status-rest")).toHaveText("Needs setup");
			await action.hover();
			await expect(action.locator(".pal-status-hover")).toHaveText("Set up and start Kiro");
			await expect(action.locator(".pal-status-hover")).toHaveCSS("opacity", "1");
			await expect(action).toHaveCSS("border-top-width", "0px");
			await shot(flow, "needs-setup-hover");

			// One inline sentence; two quiet text actions; no dialog.
			await action.click();
			await expect(context).toContainText("Namzu will add Linux support to Windows");
			await expect(context).toContainText("351 MB to download, about 3 minutes");
			await expect(context).toContainText("Windows will ask your permission once");
			await expect(context).toContainText("your PC may need to restart");
			await expect(page.getByRole("dialog")).toHaveCount(0);
			const yes = context.getByRole("button", { name: "Set up and start", exact: true });
			const no = context.getByRole("button", { name: "Not now" });
			await expect(yes).toBeVisible();
			await expect(yes).toHaveCSS("border-top-width", "0px");
			await expect(no).toBeVisible();
			await shot(flow, "needs-setup-consent");

			// "Not now" puts the row back and runs nothing.
			await no.click();
			await expect(context.getByRole("button", { name: "Set up and start Kiro" })).toBeVisible();
			assert.equal(flow.calls().filter((call) => call[0] === "setup").length, 0);

			await context.getByRole("button", { name: "Set up and start Kiro" }).click();
			await yes.click();
			const entry = rowStatus(context);
			await expect(entry).toContainText("Downloading Linux support · 120 MB of 351 MB", {
				timeout: 60000,
			});
			await shot(flow, "needs-setup-downloading");
			const run = flow.calls().find((call) => call[0] === "setup");
			assert.ok(run, "setup ran");
			assert.deepEqual(run.slice(0, 5), ["setup", "--json", "--plan", "plan-full", "--resume-command"]);
			assert.match(run[5], /^".+" --continue-pal-computer-setup$/);
			flow.go();

			await expect(entry).toContainText("Restart to finish setup", { timeout: 60000 });
			await expect(context).toContainText("Namzu continues by itself after you sign in again.");
			const restart = context.getByRole("button", { name: "Restart now" });
			await expect(restart).toBeVisible();
			await shot(flow, "restart-required");
			// A toast tells the person once; nothing is restarted by the test.
			assert.doesNotMatch(await context.innerText(), JARGON);
			assert.deepEqual(flow.world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(flow.world, { failed });
		}
	},
);

test(
	"image only: pressing Start is the consent; Preparing, then Starting, then Connected",
	{ timeout: 280000 },
	async () => {
		const flow = await open({
			status: status("image-missing", IMAGE),
			setup: {
				before: [{ progress: { step: "load-image", phase: "started" } }],
				gate: true,
				after: [
					{ progress: { step: "load-image", phase: "finished", result: "ok" } },
					{ result: { outcome: "ready" } },
				],
				then: status("ready", READY),
			},
		});
		let failed = true;
		try {
			const { context, page } = flow;
			const start = context.getByRole("button", { name: "Start Kiro" });
			await expect(start).toBeVisible({ timeout: 60000 });
			await page.mouse.move(0, 0);
			await expect(start.locator(".pal-status-rest")).toHaveText("Offline");
			await start.hover();
			await expect(start.locator(".pal-status-hover")).toHaveText("Start Kiro");
			await start.click();
			// No extra sentence: the image is local.
			await expect(rowStatus(context)).toContainText("Preparing Kiro’s computer…", {
				timeout: 60000,
			});
			await expect(context).not.toContainText("Windows will ask");
			await shot(flow, "image-preparing");
			flow.go();
			const stop = context.getByRole("button", { name: "Stop computer" });
			await expect(stop).toBeVisible({ timeout: 90000 });
			await expect(stop.locator(".pal-status-rest")).toHaveText("Connected");
			const run = flow.calls().find((call) => call[0] === "setup");
			assert.equal(run?.[2], "--plan");
			assert.equal(run?.[3], "plan-image");
			assert.deepEqual(flow.world.faults, []);
			failed = false;
		} finally {
			await dispose(flow.world, { failed });
		}
	},
);

test("blocked: virtualization off gives a plain sentence, no Start, and a Details fold", { timeout: 280000 }, async () => {
	const flow = await open({
		status: status("virtualization-off", plan("plan-blocked", [], { blocked: "virtualization-off" })),
	});
	let failed = true;
	try {
		const { context, page } = flow;
		await expect(context).toContainText("needs virtualization, and it is switched off on this PC", {
			timeout: 60000,
		});
		await expect(context.getByRole("button", { name: /^Start Kiro/ })).toHaveCount(0);
		await expect(context.getByRole("button", { name: /Set up and start/ })).toHaveCount(0);
		const help = context.locator("details.pal-setup-help", { hasText: "How to set up" });
		await expect(help).toBeVisible();
		assert.equal(await help.evaluate((node) => node.open), false, "the fold is collapsed by default");
		await help.locator("summary").click();
		await expect(help).toContainText("VT-x");
		await expect(context.getByText("Get Docker Desktop")).toHaveCount(0);
		await shot(flow, "blocked-virtualization");
		assert.doesNotMatch(await context.locator(".pal-computer-entry").innerText(), JARGON);
		await page.mouse.move(0, 0);
		assert.deepEqual(flow.world.faults, []);
		failed = false;
	} finally {
		await dispose(flow.world, { failed });
	}
});

test("cancelled: Setup needs your permission, with a quiet Try again", { timeout: 280000 }, async () => {
	const flow = await open({
		status: status("wsl-missing", FULL),
		setup: {
			before: [{ progress: { step: "download-wsl", phase: "started" } }],
			after: [{ result: { outcome: "cancelled" } }],
		},
	});
	let failed = true;
	try {
		const { context } = flow;
		await context.getByRole("button", { name: "Set up and start Kiro" }).click({ timeout: 60000 });
		await context.getByRole("button", { name: "Set up and start", exact: true }).click();
		await expect(context).toContainText("Setup needs your permission.", { timeout: 60000 });
		const again = context.getByRole("button", { name: "Try again" });
		await expect(again).toBeVisible();
		await expect(again).toHaveCSS("border-top-width", "0px");
		await shot(flow, "cancelled");
		// Trying again shows the one sentence again rather than asking Windows at once.
		await again.click();
		await expect(context).toContainText("Windows will ask your permission once");
		assert.deepEqual(flow.world.faults, []);
		failed = false;
	} finally {
		await dispose(flow.world, { failed });
	}
});

test(
	"idle: the Linux machine is stopped after the quiet period, never before a computer has stopped",
	{ timeout: 280000 },
	async () => {
		const flow = await open(
			{ status: status("ready", READY), idle: "stopped" },
			{ NAMZU_E2E_PAL_COMPUTER_IDLE_MS: "3000" },
		);
		let failed = true;
		try {
			const { context } = flow;
			const start = context.getByRole("button", { name: "Start Kiro" });
			await expect(start).toBeVisible({ timeout: 60000 });
			await start.click();
			const stop = context.getByRole("button", { name: "Stop computer" });
			await expect(stop).toBeVisible({ timeout: 90000 });
			const idleCalls = () => flow.calls().filter((call) => call[0] === "stop-idle").length;
			const before = idleCalls();
			await stop.click();
			await expect(context.getByRole("button", { name: "Start Kiro" })).toBeVisible({
				timeout: 60000,
			});
			// The stand-in is asked once the quiet period after the stop has passed.
			await expect(async () => {
				assert.ok(idleCalls() > before, "stop-idle was asked after the computer stopped");
			}).toPass({ timeout: 60000 });
			assert.deepEqual(flow.world.faults, []);
			failed = false;
		} finally {
			await dispose(flow.world, { failed });
		}
	},
);
