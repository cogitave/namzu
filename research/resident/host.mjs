import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DiskResidentAgenda,
	ProviderRegistry,
	ResidentHost,
	generateTenantId,
	runAgent,
} from "../../packages/sdk/dist/index.js";

const live = process.argv.includes("--live");
const root = await mkdtemp(join(tmpdir(), "namzu-resident-host-experiment-"));
const scope = { tenantId: generateTenantId(), agentKey: "research-assistant" };
const model = live ? "muse-spark-1.3-contributor-free" : "mock-model";
const { ZenProvider } = live
	? await import("../../packages/providers/zen/dist/index.js")
	: {};
const runs = [];
const signal = AbortSignal.timeout(150_000);
let agenda = new DiskResidentAgenda(root, scope);
await agenda.create(
	"You are a concise research assistant. Distinguish observations from claims.",
);
await agenda.add(
	await agenda.read(),
	"Draft then revise a three-item checklist for reliable agent cancellation.",
);
await agenda.add(
	await agenda.read(),
	"Draft then revise a three-item checklist for useful agent memory.",
);
const step = async ({ id, state }, abortSignal) => {
	const provider = live
		? new ZenProvider({ model })
		: ProviderRegistry.create({
				type: "mock",
				responseText: JSON.stringify({
					kind: state.stepsAdmitted === 1 ? "wait" : "complete",
					summary: `${state.stepsAdmitted === 1 ? "Draft" : "Revision"}: ${state.objective}`,
				}),
			}).provider;
	const result = await runAgent({
		provider,
		model,
		effort: "low",
		signal: abortSignal,
		workingDirectory: root,
		maxIterations: 2,
		tokenBudget: 6_000,
		timeoutMs: 30_000,
		instructions: `${state.identity} Return only JSON: kind (wait or complete) and a short summary (under 1000 characters). On admission 1 draft the checklist and wait. On admission 2 critically revise the saved draft and complete. Do not ask another question.`,
		prompt: JSON.stringify({
			objective: state.objective,
			previous: state.summary,
			admission: state.stepsAdmitted,
			reason: state.reason,
		}),
	});
	runs.push({
		pursuitId: id,
		admission: state.stepsAdmitted,
		previous: state.summary,
		stopReason: result.run.stopReason,
		output: result.output,
	});
	assert.equal(result.run.stopReason, "end_turn");
	const decision = JSON.parse(
		result.output.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
	);
	assert.equal(decision.kind, state.stepsAdmitted === 1 ? "wait" : "complete");
	return decision.kind === "wait"
		? { ...decision, wakeAt: Date.now() + 100 }
		: decision;
};
try {
	let host = new ResidentHost(agenda, step);
	await host.run({ signal, maxSteps: 1 });
	await host.pause();
	agenda = new DiskResidentAgenda(root, scope);
	host = new ResidentHost(agenda, step);
	const beforePauseCheck = runs.length;
	const paused = await host.run({ signal, maxSteps: 4 });
	assert.equal(paused.status, "paused");
	const pausedModelCalls = runs.length - beforePauseCheck;
	await host.resume();
	const result = await host.run({ signal, maxSteps: 4, maxIdleMs: 5_000 });
	const beforeIdle = runs.length;
	const idle = await host.run({ signal, maxSteps: 1 });
	const state = await agenda.read();
	const evidence = {
		live,
		model,
		effort: "low",
		root,
		runs,
		paused,
		result,
		idle,
		state,
		pausedModelCalls,
		idleModelCalls: runs.length - beforeIdle,
		limitations:
			"Two preassigned two-step pursuits. Store reopened in one process; no spontaneous initiative or live process crash. No tool effects, external messages, token or cost measurements.",
	};
	assert.equal(runs.length, 4);
	assert.equal(pausedModelCalls, 0);
	assert.equal(evidence.idleModelCalls, 0);
	assert.ok(
		state.pursuits.every(
			(p) => p.state.phase === "complete" && p.state.stepsAdmitted === 2,
		),
	);
	await writeFile(
		join(root, "evidence.json"),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
	console.error(
		JSON.stringify(
			{ root, live, runs, error: String(error), state: await agenda.read() },
			null,
			2,
		),
	);
	process.exitCode = 1;
}
