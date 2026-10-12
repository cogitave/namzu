// The Pal computer row when a Start does not work out on a Windows PC, and the Start under a waiting
// message, walked on Linux with a stand-in for `namzu computer ...` (see computer-stand-in.mjs).
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-pal-computer-setup-recovery.test.mjs
// Set PAL_SETUP_SHOTS to a directory to keep the screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

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
const BODY = "Check the note in your workspace and tell me what it says.";

async function open(script, extraEnv = {}, rules = []) {
	const directory = mkdtempSync(join(tmpdir(), "namzu-cr-"));
	const file = join(directory, "script.json");
	writeFileSync(file, JSON.stringify(script));
	const world = await createWorld({
		rules,
		env: {
			NAMZU_E2E_PAL_COMPUTER: "fake",
			NAMZU_E2E_PAL_COMPUTER_SETUP: "1",
			NAMZU_E2E_COMPUTER_SCRIPT: file,
			...extraEnv,
		},
	});
	await launch(world);
	await world.app.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) window.setSize(1440, 900);
	});
	await openProject(world);
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
	const palId = readdirSync(join(world.home, "pals"))[0];
	const context = page.locator(".pal-context-body").first();
	await expect(context).toBeVisible({ timeout: 60000 });
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
	return { world, page, context, palId, calls };
}
const shot = async (flow, name) => {
	if (SHOTS) await flow.page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const JARGON = /wslc|\bwsl\b|hcs|\bvmp\b|\bsku\b|hresult|0x[0-9a-f]{4,}|download-wsl|load-image|plan-changed/i;

test(
	"a setup that finds the PC already ready goes on to start the computer",
	{ timeout: 280000 },
	async () => {
		const flow = await open({
			status: status("image-missing", IMAGE),
			setup: { after: [{ result: { outcome: "plan-changed", plan: READY } }], then: status("ready", READY) },
		});
		let failed = true;
		try {
			const start = flow.context.getByRole("button", { name: "Start Kiro" });
			await expect(start).toBeVisible({ timeout: 60000 });
			await start.click();
			const stop = flow.context.getByRole("button", { name: "Stop computer" });
			await expect(stop).toBeVisible({ timeout: 90000 });
			await expect(stop.locator(".pal-status-rest")).toHaveText("Connected");
			assert.deepEqual(flow.world.faults, []);
			failed = false;
		} finally {
			await dispose(flow.world, { failed });
		}
	},
);

test(
	"a setup that ends with no answer says so instead of going back to Offline in silence",
	{ timeout: 280000 },
	async () => {
		const flow = await open({
			status: status("image-missing", IMAGE),
			setup: { after: [{ result: { outcome: "plan-changed", plan: IMAGE } }] },
		});
		let failed = true;
		try {
			const start = flow.context.getByRole("button", { name: "Start Kiro" });
			await expect(start).toBeVisible({ timeout: 60000 });
			await start.click();
			await expect(flow.context).toContainText("Setup stopped before it finished.", {
				timeout: 60000,
			});
			await expect(start).toBeVisible();
			await shot(flow, "recovery-setup-stopped");
			assert.doesNotMatch(await flow.context.locator(".pal-computer-entry").innerText(), JARGON);
			assert.deepEqual(flow.world.faults, []);
			failed = false;
		} finally {
			await dispose(flow.world, { failed });
		}
	},
);

test(
	"a computer that cannot start after setup says so, with Details and a quiet Try again",
	{ timeout: 280000 },
	async () => {
		const flow = await open({ status: status("ready", READY) }, { NAMZU_E2E_PAL_COMPUTER: "fake-fails" });
		let failed = true;
		try {
			const start = flow.context.getByRole("button", { name: "Start Kiro" });
			await expect(start).toBeVisible({ timeout: 60000 });
			await start.click();
			await expect(flow.context).toContainText("Kiro’s computer could not start. Try again.", {
				timeout: 90000,
			});
			const again = flow.context.getByRole("button", { name: "Try again" });
			await expect(again).toBeVisible();
			await expect(again).toHaveCSS("border-top-width", "0px");
			await expect(flow.context.locator("details.pal-setup-help", { hasText: "Details" })).toBeVisible();
			await shot(flow, "recovery-start-failed");
			assert.doesNotMatch(await flow.context.locator(".pal-computer-entry").innerText(), JARGON);
			// The computer view does not point back at the button that just failed.
			assert.doesNotMatch(await flow.page.locator("body").innerText(), /Namzu sets it up from the Pal computer/);
			assert.deepEqual(flow.world.faults, []);
			failed = false;
		} finally {
			await dispose(flow.world, { failed });
		}
	},
);

function rules(palId) {
	return [
		{
			match: /ask kiro to check the note/i,
			steps: [
				{ tool: "send_pal_message", args: { palId, body: BODY } },
				{ text: "I sent Kiro your request." },
			],
		},
		{ match: /check the note in your workspace/i, steps: [{ text: "The note says: all clear." }] },
	];
}
async function messageKiro(flow) {
	const page = flow.page;
	await page.getByRole("button", { name: "New conversation" }).first().click();
	await send(flow.world, "Ask Kiro to check the note");
	const approval = page.getByRole("region", { name: "Tool approval" });
	await expect(approval).toBeVisible({ timeout: 60000 });
	await approval.getByRole("button", { name: /Accept/ }).click();
	return page.getByRole("list", { name: "Messages sent to Pals" });
}

test(
	"the Start under a waiting message follows the same states: only the image to add",
	{ timeout: 280000 },
	async () => {
		const scripted = [];
		const flow = await open(
			{
				status: status("image-missing", IMAGE),
				setup: {
					before: [{ progress: { step: "load-image", phase: "started" } }],
					after: [{ progress: { step: "load-image", phase: "finished", result: "ok" } }, { result: { outcome: "ready" } }],
					then: status("ready", READY),
				},
			},
			{},
			scripted,
		);
		let failed = true;
		try {
			scripted.push(...rules(flow.palId));
			const receipt = await messageKiro(flow);
			const start = receipt.getByRole("button", { name: "Start Kiro" });
			await expect(start).toBeVisible({ timeout: 60000 });
			await shot(flow, "recovery-waiting-start");
			await start.click();
			await expect(receipt).toContainText("Kiro read your message.", { timeout: 120000 });
			const run = flow.calls().find((call) => call[0] === "setup");
			assert.equal(run?.[3], "plan-image");
			assert.deepEqual(flow.world.faults, []);
			failed = false;
		} finally {
			await dispose(flow.world, { failed });
		}
	},
);

test(
	"the receipt under a waiting message points at the row instead of its own Start when setup is needed",
	{ timeout: 280000 },
	async () => {
		const scripted = [];
		const flow = await open({ status: status("wsl-missing", FULL) }, {}, scripted);
		let failed = true;
		try {
			scripted.push(...rules(flow.palId));
			const receipt = await messageKiro(flow);
			await expect(receipt).toContainText("Set up and start Kiro", { timeout: 60000 });
			// The row says "Set up and start"; a second Start here would name the same step twice.
			await expect(receipt.getByRole("button", { name: "Start Kiro" })).toHaveCount(0);
			assert.equal(
				flow.calls().some((call) => call[0] === "setup"),
				false,
				"nothing ran before the person agreed",
			);
			await shot(flow, "recovery-waiting-needs-setup");
			assert.deepEqual(flow.world.faults, []);
			failed = false;
		} finally {
			await dispose(flow.world, { failed });
		}
	},
);
