import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DiskResidentStore,
	ProviderRegistry,
	generateTenantId,
	runAgent,
	runResident,
	stepResident,
} from "../../packages/sdk/dist/index.js";

const live = process.argv.includes("--live");
const root = await mkdtemp(join(tmpdir(), "namzu-resident-experiment-"));
const scope = {
	tenantId: generateTenantId(),
	agentKey: "continuity-researcher",
};
let store = new DiskResidentStore(root, scope);
const runs = [];
await store.create(
	"You are a concise research assistant.",
	"Develop a three-item checklist for assessing an agent runtime. First draft it, wait briefly, then critically revise it and finish. Do not request another user message.",
);
const signal = AbortSignal.timeout(90_000);
const model = live ? "muse-spark-1.3-contributor-free" : "mock-model";
const { ZenProvider } = live
	? await import("../../packages/providers/zen/dist/index.js")
	: {};
const step = async (state, abortSignal) => {
	const provider = live
		? new ZenProvider({ model })
		: ProviderRegistry.create({
				type: "mock",
				responseText: JSON.stringify(
					state.stepsAdmitted === 1
						? {
								kind: "wait",
								summary: "Draft: persistence, ownership, useful outcomes.",
							}
						: {
								kind: "complete",
								summary:
									"Verify crash recovery, exclusive admission, and useful outcomes against a baseline.",
							},
				),
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
		instructions: `${state.identity} Return only JSON with kind (wait or complete) and a short summary. Draft on the first admission; critically revise the saved draft and complete on the second.`,
		prompt: JSON.stringify({
			objective: state.objective,
			previous: state.summary,
			admission: state.stepsAdmitted,
			reason: state.reason,
		}),
	});
	runs.push({ stopReason: result.run.stopReason, output: result.output });
	if (result.run.stopReason !== "end_turn")
		throw new Error(`Unfinished provider run: ${result.run.stopReason}`);
	const decision = JSON.parse(
		result.output.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
	);
	if (
		!["wait", "complete"].includes(decision.kind) ||
		typeof decision.summary !== "string"
	)
		throw new Error("Invalid experimental decision");
	return decision.kind === "wait"
		? { ...decision, wakeAt: Date.now() + 1_000 }
		: decision;
};
try {
	await stepResident(store, step, signal);
	store = new DiskResidentStore(root, scope);
	await runResident({ store, step, signal, maxSteps: 2, maxIdleMs: 5_000 });
	const beforeIdle = runs.length;
	await stepResident(new DiskResidentStore(root, scope), step, signal);
	const state = await store.read();
	const evidence = {
		live,
		model,
		root,
		runs,
		state,
		idleModelCalls: runs.length - beforeIdle,
	};
	await writeFile(
		join(root, "evidence.json"),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	console.log(JSON.stringify(evidence, null, 2));
	if (
		state.phase !== "complete" ||
		runs.length !== 2 ||
		evidence.idleModelCalls !== 0
	)
		process.exitCode = 1;
} catch (error) {
	console.error(
		JSON.stringify(
			{ root, live, runs, error: String(error), state: await store.read() },
			null,
			2,
		),
	);
	process.exitCode = 1;
}
