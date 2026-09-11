import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DiskResidentAgenda,
	ProviderRegistry,
	ResidentHost,
	generateTenantId,
	projectResidentLearning,
	runAgent,
} from "../../packages/sdk/dist/index.js";

const live = process.argv.includes("--live");
const model = live ? "muse-spark-1.3-contributor-free" : "mock-model";
const { ZenProvider } = live
	? await import("../../packages/providers/zen/dist/index.js")
	: {};
const root = await mkdtemp(join(tmpdir(), "namzu-resident-learning-live-"));
const files = [
	"packages/sdk/src/manager/resident/learning.ts",
	"packages/sdk/src/manager/resident/host.ts",
	"packages/sdk/dist/manager/resident/learning.js",
	"packages/sdk/dist/manager/resident/host.js",
	"research/resident/learning-live.mjs",
];
const fingerprint = async () =>
	Object.fromEntries(
		await Promise.all(
			files.map(async (file) => [
				file,
				createHash("sha256")
					.update(await readFile(new URL(`../../${file}`, import.meta.url)))
					.digest("hex"),
			]),
		),
	);
const fingerprints = await fingerprint();
const scope = { tenantId: generateTenantId(), agentKey: "preference-smoke" };
let agenda = new DiskResidentAgenda(root, scope);
const runs = [];
const signal = AbortSignal.timeout(90_000);
const evidence = (key) => ({
	key,
	source: "synthetic host preference",
	reason: "Controlled preference correction for the smoke test",
});

try {
	const pursuit = await agenda.add(
		await agenda.create("Report readiness using the current host preference."),
		"Report readiness in two successive steps.",
	);
	await agenda.updateProfile(await agenda.read(), {
		preferences: [{ key: "language", value: "English", supersedes: null }],
		evidence: evidence("language-1"),
	});
	const step = async (current, abort, context) => {
		const projection = projectResidentLearning(context.learning, {
			maxChars: 2_000,
			skillNames: [],
		});
		const language = context.learning.preferences.find(
			(item) => item.key === "language",
		).value;
		const provider = live
			? new ZenProvider({ model })
			: ProviderRegistry.create({
					type: "mock",
					responseText: language === "English" ? "Ready" : "Hazır",
				}).provider;
		const result = await runAgent({
			provider,
			model,
			effort: "low",
			signal: abort,
			workingDirectory: root,
			maxIterations: 1,
			tokenBudget: 2_000,
			timeoutMs: 30_000,
			instructions: `The following is a host-approved language preference. Respond with exactly one word meaning ready in that preferred language. Do not add any other text.\n${projection.text}`,
			prompt: JSON.stringify({
				objective: current.state.objective,
				previousSummary: current.state.summary,
			}),
		});
		runs.push({
			language,
			learningRevision: context.learning.revision,
			agendaRevision: context.agendaRevision,
			projectedChars: projection.text.length,
			stopReason: result.run.stopReason,
			output: result.output,
			usage: result.run.tokenUsage,
			costInfo: result.run.costInfo,
			previousSummary: current.state.summary,
		});
		assert.equal(result.run.stopReason, "end_turn");
		assert.equal(
			result.output.trim().replace(/[.!]$/u, "").toLocaleLowerCase("tr"),
			language === "English" ? "ready" : "hazır",
		);
		return current.state.stepsAdmitted === 1
			? {
					kind: "wait",
					wakeAt: null,
					summary: "Readiness was reported in the former preferred language.",
				}
			: {
					kind: "complete",
					summary: "Readiness was reported using the corrected preference.",
				};
	};
	await new ResidentHost(agenda, step, { learning: true }).run({
		signal,
		maxSteps: 1,
	});
	agenda = new DiskResidentAgenda(root, scope);
	await agenda.updateProfile(await agenda.read(), {
		preferences: [
			{ key: "language", value: "Turkish", supersedes: "language-1" },
		],
		evidence: evidence("language-2"),
	});
	const host = new ResidentHost(agenda, step, { learning: true });
	await host.wake(pursuit.id, "Host supplied a corrected language preference.");
	await host.run({ signal, maxSteps: 1 });
	const beforeIdle = runs.length;
	assert.equal((await host.run({ signal, maxSteps: 1 })).status, "idle");
	assert.equal(runs.length, beforeIdle);
	assert.equal(runs.length, 2);
	assert.ok(runs[1].previousSummary);
	assert.deepEqual(await fingerprint(), fingerprints);
	const result = {
		root,
		live,
		model,
		modelCalls: live ? runs.length : 0,
		scriptedSdkCalls: live ? 0 : runs.length,
		tokens: runs.reduce((sum, run) => sum + run.usage.totalTokens, 0),
		idleCalls: runs.length - beforeIdle,
		runs,
		fingerprints,
		state: await agenda.read(),
		limitations:
			"Two-step language-preference smoke only. Host supplies the correction; this does not measure skill learning or general intelligence. No tools, external messages or service installation.",
	};
	await writeFile(
		join(root, "evidence.json"),
		`${JSON.stringify(result, null, 2)}\n`,
	);
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	console.error(
		JSON.stringify(
			{ root, live, error: String(error), runs, state: await agenda.read() },
			null,
			2,
		),
	);
	process.exitCode = 1;
}
