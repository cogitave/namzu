/** Synthetic policy comparison through the actual resident SDK; no inference. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	DiskResidentAgenda,
	ResidentHost,
	createResidentSelector,
	generateTenantId,
} from "../../packages/sdk/dist/index.js";

const args = process.argv.slice(2);
assert.ok(
	args.length === 0 || (args.length === 2 && args[0] === "--out"),
	"Usage: node research/resident/selection-eval.mjs [--out report.json]",
);
const outputPath = args[1] ? resolve(args[1]) : undefined;
const root = await mkdtemp(join(tmpdir(), "namzu-resident-selection-"));
const maxAdmissions = 12;
const policyConfig = Object.freeze({
	progressValue: 10,
	initialExpectedProgress: 0.25,
	initialExpectedCost: 1,
	maxStagnantSteps: 2,
});
const patientPolicyConfig = Object.freeze({
	...policyConfig,
	maxStagnantSteps: 4,
});
const policies = ["fair", "fixed-priority", "measured", "measured-patient"];
const families = ["productive", "stalled", "expensive", "delayed"];
const stressFamilies = ["delayed5", "fluctuating"];
const fluctuatingProgress = Object.freeze([0.3, 0.1, 0.3, 0.6, 0.6, 1]);
const seeds = [0, 1, 2, 3];
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
let logicalNow = 1_000_000;
Date.now = () => logicalNow;
globalThis.fetch = async () => {
	throw new Error("Network forbidden in the resident selection evaluation.");
};

function fixedPriority(agenda, now) {
	const selected = agenda.pursuits
		.filter(
			(p) =>
				p.state.phase === "waiting" &&
				p.state.wakeAt !== null &&
				p.state.wakeAt <= now,
		)
		.sort(
			(a, b) =>
				a.state.objective.localeCompare(b.state.objective) ||
				a.id.localeCompare(b.id),
		)[0];
	return {
		agendaRevision: agenda.revision,
		pursuitId: selected?.id ?? null,
		reason: selected ? "selected" : "no-useful-work",
		candidates: [],
	};
}

function selector(policy) {
	if (policy === "fair") return undefined;
	if (policy === "fixed-priority") return fixedPriority;
	return createResidentSelector(
		policy === "measured-patient" ? patientPolicyConfig : policyConfig,
	);
}

const fingerprintFiles = [
	"research/resident/selection-eval.mjs",
	...["initiative", "host", "agenda", "loop", "store", "proposal"].flatMap(
		(name) => [
			`packages/sdk/src/manager/resident/${name}.ts`,
			`packages/sdk/dist/manager/resident/${name}.js`,
		],
	),
];

async function implementationFingerprints() {
	return Object.fromEntries(
		await Promise.all(
			fingerprintFiles.map(async (path) => [
				path,
				createHash("sha256")
					.update(await readFile(new URL(`../../${path}`, import.meta.url)))
					.digest("hex"),
			]),
		),
	);
}

async function fixture(name, taskFamilies, seed) {
	const directory = join(root, `${name}-${seed}`, "initial");
	const scope = {
		tenantId: generateTenantId(),
		agentKey: "selection-evaluation",
	};
	const agenda = new DiskResidentAgenda(directory, scope);
	await agenda.create("Execute only the local synthetic fixture.");
	const rotated = taskFamilies.map(
		(_, index) => taskFamilies[(index + seed) % taskFamilies.length],
	);
	const tasks = [];
	for (const [index, family] of rotated.entries()) {
		const pursuit = await agenda.add(
			await agenda.read(),
			`slot-${index}: inspect the ${family} fixture`,
		);
		tasks.push({ pursuitId: pursuit.id, family });
	}
	return {
		name,
		seed,
		directory,
		scope,
		tasks,
		initialAgenda: await agenda.read(),
	};
}

// This executor is external ground truth. Only its observed current receipt is
// projected into the agenda; the selector cannot inspect future task outcomes.
function executeFixture(task) {
	task.calls++;
	const costUnits = task.family === "expensive" ? 8 : 1;
	let progress;
	switch (task.family) {
		case "stalled":
			progress = 0;
			break;
		case "delayed":
		case "delayed5":
			progress = task.calls >= (task.family === "delayed5" ? 5 : 3) ? 1 : 0;
			break;
		case "fluctuating":
			progress = fluctuatingProgress[task.calls - 1];
			assert.notEqual(progress, undefined);
			break;
		default:
			progress = Math.min(task.calls / 3, 1);
	}
	const progressDelta = progress - task.progress;
	const gain = Math.max(0, progress - task.bestProgress);
	task.progress = progress;
	task.bestProgress = Math.max(task.bestProgress, progress);
	task.costUnits += costUnits;
	return { progress, progressDelta, gain, costUnits, complete: progress === 1 };
}

async function trial(initial, policy) {
	logicalNow = 1_000_000;
	const directory = join(root, `${initial.name}-${initial.seed}`, policy);
	await cp(initial.directory, directory, { recursive: true });
	let agenda = new DiskResidentAgenda(directory, initial.scope);
	assert.deepEqual(await agenda.read(), initial.initialAgenda);
	const tasks = new Map(
		initial.tasks.map((task) => [
			task.pursuitId,
			{ ...task, calls: 0, progress: 0, bestProgress: 0, costUnits: 0 },
		]),
	);
	const receipts = [];
	const pending = new Map();
	const selections = [];
	const select = selector(policy);
	const step = async (pursuit, signal) => {
		signal.throwIfAborted();
		const task = tasks.get(pursuit.id);
		assert.ok(task, "Execution must refer to a fixture task.");
		assert.ok(task.progress < 1, "Completed effects must not be repeated.");
		const outcome = executeFixture(task);
		const receipt = {
			pursuitId: pursuit.id,
			step: pursuit.state.stepsAdmitted,
			family: task.family,
			evidenceKey: `${pursuit.id}:receipt-${task.calls}`,
			source: "independent-fixture-sensor",
			...outcome,
		};
		receipts.push(receipt);
		pending.set(pursuit.state.claimId, receipt);
		// Prose is deliberately identical for every outcome and every policy.
		const summary = "The fixture executor returned; inspect its receipt.";
		return outcome.complete
			? { kind: "complete", summary }
			: { kind: "wait", summary, wakeAt: logicalNow + 1 };
	};
	const options = {
		...(select
			? {
					select: (state, now) => {
						const selection = select(state, now);
						selections.push(selection);
						return selection;
					},
				}
			: {}),
		observe: async (pursuit, _decision, signal) => {
			signal.throwIfAborted();
			const receipt = pending.get(pursuit.state.claimId);
			assert.ok(
				receipt,
				"Every admitted effect needs its independent receipt.",
			);
			pending.delete(pursuit.state.claimId);
			return {
				evidenceKey: receipt.evidenceKey,
				source: receipt.source,
				progress: receipt.progress,
				costUnits: receipt.costUnits,
			};
		},
	};
	let host = new ResidentHost(agenda, step, options);
	let result;
	let settled = 0;
	for (let admission = 0; admission < maxAdmissions; admission++) {
		const before = receipts.length;
		result = await host.run({
			signal: AbortSignal.timeout(10_000),
			maxSteps: 1,
			maxIdleMs: 0,
		});
		settled += result.stepsSettled;
		assert.ok(["limit", "idle"].includes(result.status), result.status);
		if (receipts.length === before) break;
		logicalNow++;
		// Reopen on every admission; in-memory fixture effects remain external
		// ground truth while selection history must come from durable storage.
		agenda = new DiskResidentAgenda(directory, initial.scope);
		host = new ResidentHost(agenda, step, options);
	}
	const state = await agenda.read();
	assert.equal(pending.size, 0);
	assert.equal(settled, receipts.length);
	assert.ok(receipts.length <= maxAdmissions);
	assert.equal(
		state.pursuits.reduce((total, p) => total + p.state.stepsAdmitted, 0),
		receipts.length,
	);
	for (const pursuit of state.pursuits) {
		const task = tasks.get(pursuit.id);
		assert.equal(pursuit.state.phase === "complete", task.progress === 1);
		assert.equal(pursuit.feedback?.bestProgress ?? 0, task.bestProgress);
		for (const observed of pursuit.feedback?.observations ?? []) {
			const receipt = receipts.find(
				(item) => item.evidenceKey === observed.evidenceKey,
			);
			assert.ok(receipt, "Durable feedback must match an external receipt.");
			assert.equal(observed.costUnits, receipt.costUnits);
			assert.equal(observed.progress, receipt.progress);
			assert.ok(Math.abs(observed.gain - receipt.gain) < 1e-12);
		}
	}
	const taskResults = [...tasks.values()];
	const costUnits = receipts.reduce((sum, item) => sum + item.costUnits, 0);
	assert.equal(
		costUnits,
		taskResults.reduce((sum, task) => sum + task.costUnits, 0),
	);
	return {
		scenario: initial.name,
		suite:
			stressFamilies.includes(initial.name) || initial.name === "stress-mixed"
				? "stress"
				: "development",
		seed: initial.seed,
		policy,
		result,
		metrics: {
			usefulCompletions: taskResults.filter((task) => task.progress === 1)
				.length,
			actualCallbackCalls: receipts.length,
			costUnits,
			totalProgress: taskResults.reduce((sum, task) => sum + task.progress, 0),
			totalBestProgress: taskResults.reduce(
				(sum, task) => sum + task.bestProgress,
				0,
			),
			zeroProgressCalls: receipts.filter((item) => item.gain === 0).length,
			regressionCalls: receipts.filter((item) => item.progressDelta < 0).length,
			missedDelayed: taskResults.filter(
				(task) => task.family.startsWith("delayed") && task.progress < 1,
			).length,
			missedCompletable: taskResults.filter(
				(task) => task.family !== "stalled" && task.progress < 1,
			).length,
			modelCalls: 0,
			inferenceTokens: 0,
		},
		tasks: taskResults,
		receipts,
		selections,
		finalAgendaRevision: state.revision,
		finalPursuits: state.pursuits.map((p) => ({
			id: p.id,
			phase: p.state.phase,
			stepsAdmitted: p.state.stepsAdmitted,
			bestProgress: p.feedback?.bestProgress ?? 0,
			stagnantSteps: p.feedback?.stagnantSteps ?? 0,
		})),
	};
}

async function idleControl(policy) {
	logicalNow = 1_000_000;
	const scope = { tenantId: generateTenantId(), agentKey: "idle-control" };
	const agenda = new DiskResidentAgenda(join(root, "idle", policy), scope);
	const pursuit = await agenda.add(
		await agenda.create("Rest without polling a model."),
		"Await external fixture evidence.",
	);
	const execution = agenda.execution(pursuit.id);
	const claim = await execution.claim(pursuit.state, logicalNow);
	await execution.settle(
		claim,
		{ kind: "wait", summary: "No new fixture evidence.", wakeAt: null },
		logicalNow,
	);
	let calls = 0;
	let selectionCalls = 0;
	let observerCalls = 0;
	const select = selector(policy);
	const host = new ResidentHost(
		agenda,
		async () => {
			calls++;
			throw new Error("An idle control must not execute a callback.");
		},
		{
			...(select
				? {
						select: (...input) => {
							selectionCalls++;
							return select(...input);
						},
					}
				: {}),
			observe: async () => {
				observerCalls++;
				throw new Error("An idle control must not invoke an observer.");
			},
		},
	);
	for (let tick = 0; tick < maxAdmissions; tick++) {
		const result = await host.run({
			signal: AbortSignal.timeout(10_000),
			maxSteps: 1,
			maxIdleMs: 0,
		});
		assert.equal(result.status, "idle");
		assert.equal(result.stepsSettled, 0);
		logicalNow++;
	}
	assert.equal(calls, 0);
	assert.equal(selectionCalls, 0);
	assert.equal(observerCalls, 0);
	return {
		policy,
		hostChecks: maxAdmissions,
		actualCallbackCalls: calls,
		selectionCalls,
		observerCalls,
		modelCalls: 0,
	};
}

try {
	const fingerprints = await implementationFingerprints();
	const gitOptions = {
		cwd: new URL("../../", import.meta.url),
		encoding: "utf8",
	};
	const gitHead = execFileSync("git", ["rev-parse", "HEAD"], gitOptions).trim();
	const fixtures = [];
	const trials = [];
	const scenarios = [...families, "mixed", ...stressFamilies, "stress-mixed"];
	for (const name of scenarios) {
		for (const seed of seeds) {
			const initial = await fixture(
				name,
				name === "mixed"
					? families
					: name === "stress-mixed"
						? stressFamilies
						: [name],
				seed,
			);
			fixtures.push(initial);
			for (const policy of policies) trials.push(await trial(initial, policy));
		}
	}
	const idleControls = [];
	for (const policy of policies) idleControls.push(await idleControl(policy));
	const summarize = (included) =>
		policies.map((policy) => ({
			policy,
			...included
				.filter((trial) => trial.policy === policy)
				.reduce((total, trial) => {
					for (const [key, value] of Object.entries(trial.metrics))
						total[key] = (total[key] ?? 0) + value;
					return total;
				}, {}),
		}));
	assert.deepEqual(
		await implementationFingerprints(),
		fingerprints,
		"Implementation changed during evaluation; rebuild and rerun.",
	);
	assert.equal(
		execFileSync("git", ["rev-parse", "HEAD"], gitOptions).trim(),
		gitHead,
		"Git HEAD changed during evaluation; rerun against the settled revision.",
	);
	const report = {
		version: 2,
		generatedAt: new Date(originalNow()).toISOString(),
		nodeVersion: process.version,
		root,
		gitHead,
		fingerprintedFilesDirty: Boolean(
			execFileSync(
				"git",
				["status", "--porcelain", "--", ...fingerprintFiles],
				gitOptions,
			).trim(),
		),
		fingerprints,
		maxAdmissionsPerTrial: maxAdmissions,
		policyConfig,
		patientPolicyConfig,
		seeds,
		taskDefinitions: {
			productive: { progress: [1 / 3, 2 / 3, 1], costPerCall: 1 },
			stalled: {
				progress: "always zero, even with fresh evidence keys",
				costPerCall: 1,
			},
			expensive: { progress: [1 / 3, 2 / 3, 1], costPerCall: 8 },
			delayed: { progress: [0, 0, 1], costPerCall: 1 },
			delayed5: { progress: [0, 0, 0, 0, 1], costPerCall: 1, suite: "stress" },
			fluctuating: {
				progress: fluctuatingProgress,
				costPerCall: 1,
				suite: "stress",
			},
		},
		method:
			"Actual DiskResidentAgenda and ResidentHost. Each policy receives a copy of the same initial agenda for each scenario/seed. Seeds rotate task insertion order; UUIDs are random and paired only within the recorded fixture, not reproducible from the seed alone. A logical clock and one-step invocations make readiness independent of filesystem latency. The agenda and host reopen after each admitted step. Independent fixture receipts determine progress, completion and resource cost; answer prose is constant and no future outcomes reach selectors.",
		limitations: [
			"Synthetic deterministic mechanisms, no provider calls or general task-quality claim. Single-family seed trials repeat the same behavior and are not independent samples.",
			"Measured-patient changes maxStagnantSteps from 2 to 4 as a sensitivity check. The delayed5 and fluctuating stress fixtures were inspected during selector development, including mean-smoothing changes. These are development and tuning checks, not held-out validation or independent evidence of generalization. Both parameter configurations remain fixed for this recorded run.",
			"Equal admission caps do not imply equal spend: cost units are explicit fixture resource charges, not dollars, wall time, CPU time or inference tokens.",
			"Completion, current progress and resource use are reported separately. Total progress sums current independently graded fixture progress, including regressions; totalBestProgress sums the external ledger high-water marks. Zero-progress calls means no new high-water gain, so recovering an old best earns no credit. No combined winner score is computed.",
			"The finite stagnation allowance can abandon delayed rewards, and the cost-aware heuristic can reject expensive tasks that the controls finish. No policy is asserted to win universally.",
			"Fixed priority is a no-initiative control ordered by the seeded objective slots. It has the same observation plumbing but ignores its measurements.",
			"Fixed heartbeat is only a conceptual idle baseline: 12 ticks times one model poll would mean 12 model calls. No such model calls were executed or measured.",
			"Recent durable feedback contains at most eight receipts. The external report retains every fixture receipt for complete cost accounting; the feedback window is not a lifetime budget.",
		],
		totals: summarize(trials),
		suiteTotals: ["development", "stress"].map((suite) => ({
			suite,
			policies: summarize(trials.filter((trial) => trial.suite === suite)),
		})),
		idleControls,
		conceptualHeartbeatIdle: {
			ticks: maxAdmissions,
			assumedModelPollsPerTick: 1,
			conceptualModelPolls: maxAdmissions,
			measured: false,
		},
		fixtures,
		trials,
	};
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	await writeFile(join(root, "evidence.json"), serialized);
	if (outputPath) await writeFile(outputPath, serialized);
	console.log(serialized.trimEnd());
} finally {
	Date.now = originalNow;
	globalThis.fetch = originalFetch;
}
