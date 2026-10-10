// Switching the model and the engine in quick succession while the host's metadata reads are
// held by a gate: a read that a newer choice overtook is never an error, the model button never
// sits on "Not available", and the button ends on the choice made last.
// The gate lives in the frozen copy of the main process (as in pals-create.test.mjs): a held
// read starts, is overtaken by the next choice, and is released only when the flow says so, so
// nothing here waits on the clock.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-superseded-reads.test.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, freezeApp, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/hygiene-20261010/t4-desktop");

/** A `codex` that answers `app-server` with one model, "Fake Sol". */
const fakeCodex = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv[2] === "--version") { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
if (process.argv[2] !== "app-server") { setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0)); return; }
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const models = ${JSON.stringify([
	{
		id: "fake-sol",
		model: "fake-sol",
		displayName: "Fake Sol",
		isDefault: true,
		supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
		defaultReasoningEffort: "medium",
	},
])};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line);
	if (frame.id === undefined) return;
	if (frame.method === "initialize") send({ id: frame.id, result: { userAgent: "fake", codexHome: "/tmp" } });
	else if (frame.method === "account/read") send({ id: frame.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
	else if (frame.method === "model/list") send({ id: frame.id, result: { data: models, nextCursor: null } });
	else send({ id: frame.id, result: {} });
}).on("close", () => process.exit(0));
`;

/** The provider and engine status reads wait on a gate the flow controls, after they have started. */
function gateReads(world) {
	const file = join(freezeApp(world.root), "dist/main/operator.js");
	const source = readFileSync(file, "utf8");
	const pattern = /const (view|result) = \(await project\.client\.request\('namzu\/(harnesses\/list|providers\/status)'/g;
	const patched = source.replace(
		pattern,
		(hit) => `await (globalThis.__readGate ? globalThis.__readGate() : undefined);\n        ${hit}`,
	);
	assert.notEqual(patched, source, "the gate was placed on the metadata reads");
	writeFileSync(file, patched);
}
const hold = (world) =>
	world.app.evaluate(() => {
		const gate = { open: false, waiters: [], started: 0 };
		gate.wait = () => {
			gate.started += 1;
			return gate.open ? undefined : new Promise((resolve) => gate.waiters.push(resolve));
		};
		globalThis.__gate = gate;
		globalThis.__readGate = gate.wait;
	});
/** Waits until a read has reached the gate: the host's own state, not a pause. */
const reachedGate = (world) =>
	expect.poll(() => world.app.evaluate(() => globalThis.__gate.waiters.length), { timeout: T }).toBeGreaterThan(0);

/** Lets the held reads go; says how many were waiting, so a flow can prove the gate really held some. */
const release = (world) =>
	world.app.evaluate(() => {
		const gate = globalThis.__gate;
		gate.open = true;
		const held = gate.waiters.length;
		for (const resolve of gate.waiters.splice(0)) resolve();
		return held;
	});

function flow(name, body) {
	test(name, { timeout: 240000 }, async () => {
		const bin = mkdtempSync(join(tmpdir(), "namzu-e2e-sup-bin-"));
		writeFileSync(join(bin, "codex"), fakeCodex);
		chmodSync(join(bin, "codex"), 0o755);
		const world = await createWorld({
			models: ["gpt-e2e-0", "gpt-e2e-1"],
			env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
		});
		let failed = true;
		try {
			gateReads(world);
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
			rmSync(bin, { recursive: true, force: true });
		}
	});
}

const chip = (w) => w.page.getByRole("button", { name: /^Model/ }).first();
async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.waitForTimeout(300);
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
async function pickModel(w, model) {
	await chip(w).click();
	const change = w.page.getByRole("button", { name: /change model/ });
	if (await change.count()) await change.click();
	await w.page.getByRole("radio", { name: new RegExp(model) }).click();
	await w.page.keyboard.press("Escape");
}
async function pickEngine(w, engine) {
	await chip(w).click();
	await w.page.getByRole("button", { name: /^Engine:/ }).click();
	await w.page.getByRole("radio", { name: engine }).click();
	await w.page.keyboard.press("Escape");
}
async function nothingWrong(w) {
	await expect(w.page.getByText("Not available")).toHaveCount(0);
	await expect(w.page.getByText(/changed while|SupersededConversation|Error invoking|could not be loaded/i)).toHaveCount(0);
	await expect(w.page.getByRole("alert")).toHaveCount(0);
	await expect(w.page.locator(".model-picker-trigger-skeleton")).toHaveCount(0);
}

flow("two models, then an engine, while the reads are held: it ends on the engine's model", async (w) => {
	await openProject(w);
	await expect(chip(w)).toContainText(/gpt-e2e/, { timeout: T });
	await hold(w);
	await pickModel(w, "gpt-e2e-0");
	await pickModel(w, "gpt-e2e-1");
	await pickEngine(w, /Codex CLI/);
	await reachedGate(w);
	assert.ok((await release(w)) > 0, "reads were held while the choices were made");
	await expect(chip(w)).toContainText("Fake Sol", { timeout: T });
	await nothingWrong(w);
	await shot(w, "superseded-model-then-engine");
});

flow("the engine back to Namzu while its reads are held: it ends on a Namzu model", async (w) => {
	await openProject(w);
	await expect(chip(w)).toContainText(/gpt-e2e/, { timeout: T });
	await pickEngine(w, /Codex CLI/);
	await expect(chip(w)).toContainText("Fake Sol", { timeout: T });
	await hold(w);
	await pickEngine(w, /^Namzu/);
	await reachedGate(w);
	assert.ok((await release(w)) > 0, "reads were held while the engine was switched");
	await expect(chip(w)).toContainText(/gpt-e2e-[01]/, { timeout: T });
	await nothingWrong(w);
	await shot(w, "superseded-engine-back");
});
