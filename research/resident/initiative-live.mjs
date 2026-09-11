import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DiskResidentAgenda,
	ProviderRegistry,
	ResidentHost,
	createResidentSelector,
	generateTenantId,
	runAgent,
} from "../../packages/sdk/dist/index.js";

const live = process.argv.includes("--live");
const model = live ? "muse-spark-1.3-contributor-free" : "mock-model";
const { ZenProvider } = live
	? await import("../../packages/providers/zen/dist/index.js")
	: {};
const root = await mkdtemp(join(tmpdir(), "namzu-initiative-live-"));
const fixture = {
	name: "sample-package",
	version: "1.0.0",
	scripts: { build: "tsc --build" },
};
const scope = { tenantId: generateTenantId(), agentKey: "fixture-reviewer" };
let agenda = new DiskResidentAgenda(root, scope);
const parent = await agenda.add(
	await agenda.create(
		"You identify concrete quality gaps and propose bounded follow-up work.",
	),
	"Inspect the supplied package fixture and propose one useful follow-up concerning a missing test or lint script.",
);
const receipts = new Map();
const runs = [];
const selections = [];
const signal = AbortSignal.timeout(90_000);
let proposed;
const select = createResidentSelector({
	progressValue: 5_000,
	initialExpectedProgress: 0.25,
	initialExpectedCost: 50,
});
const options = {
	select: (state, now) => {
		const choice = select(state, now);
		selections.push(choice);
		return choice;
	},
	observe: async ({ state }) => {
		const receipt = receipts.get(state.claimId);
		assert.ok(receipt, "A model claim alone is not a receipt.");
		const saved = JSON.parse(await readFile(receipt.path, "utf8"));
		assert.deepEqual(saved, receipt.validated);
		return {
			evidenceKey: receipt.evidenceKey,
			source: "fixture-json-validator/v1; cost=provider-total-tokens",
			progress: 1,
			costUnits: receipt.tokens > 0 ? receipt.tokens : null,
		};
	},
};
const step = async (pursuit, abort) => {
	const child = Boolean(pursuit.origin);
	const canned = child
		? {
				field: proposed.field,
				patch: { [proposed.field]: "node --test" },
				note: "Suggested command; not executed.",
			}
		: {
				field: "test",
				question: "Suggest a test script for the package fixture.",
				reason: "scripts.test is absent.",
			};
	const provider = live
		? new ZenProvider({ model })
		: ProviderRegistry.create({
				type: "mock",
				responseText: JSON.stringify(canned),
			}).provider;
	const result = await runAgent({
		provider,
		model,
		effort: "low",
		workingDirectory: root,
		signal: abort,
		maxIterations: 2,
		tokenBudget: 6_000,
		timeoutMs: 30_000,
		instructions: child
			? "Return JSON only: field, patch (object containing only that scripts field with a nonempty proposed command), note. This is a suggestion, not an executed check. Do not claim tests passed."
			: "Return JSON only: field (test or lint), question (a useful follow-up within that missing script), reason (the concrete observed gap). The host has authorized proposing one fixture-review subgoal; it has not authorized running commands.",
		prompt: JSON.stringify({
			objective: pursuit.state.objective,
			fixture,
			...(child ? { field: proposed.field, parentProposal: proposed } : {}),
		}),
	});
	runs.push({
		pursuitId: pursuit.id,
		child,
		stopReason: result.run.stopReason,
		usage: result.run.tokenUsage,
		costInfo: result.run.costInfo,
		output: result.output,
	});
	assert.equal(result.run.stopReason, "end_turn");
	const parsed = JSON.parse(
		result.output.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
	);
	assert.ok(["test", "lint"].includes(parsed.field));
	assert.equal(fixture.scripts[parsed.field], undefined);
	if (child) {
		assert.equal(parsed.field, proposed.field);
		assert.deepEqual(Object.keys(parsed.patch), [parsed.field]);
		assert.equal(typeof parsed.patch[parsed.field], "string");
		assert.ok(
			parsed.patch[parsed.field].trim().length > 0 &&
				parsed.patch[parsed.field].length <= 1_000,
		);
	} else {
		assert.equal(typeof parsed.question, "string");
		assert.ok(parsed.question.trim().length > 0);
		assert.equal(typeof parsed.reason, "string");
		proposed = parsed;
	}
	const path = join(root, `${pursuit.id}.json`);
	await writeFile(path, JSON.stringify(parsed), { flag: "wx" });
	receipts.set(pursuit.state.claimId, {
		path,
		validated: parsed,
		evidenceKey: `fixture-suggestion:${pursuit.id}`,
		tokens: result.run.tokenUsage.totalTokens,
	});
	return {
		kind: "complete",
		summary: child
			? "Saved a structurally validated suggestion; command not executed."
			: "Observed a missing script and proposed one bounded follow-up.",
	};
};
try {
	await new ResidentHost(agenda, step, options).run({ signal, maxSteps: 1 });
	agenda = new DiskResidentAgenda(root, scope);
	const state = await agenda.read();
	const savedParent = state.pursuits.find((p) => p.id === parent.id);
	// This host's standing mandate allows exactly one missing-script suggestion.
	// The domain label alone would not validate arbitrary objectives or tool authority.
	const child = await agenda.admitProposal(
		state,
		{
			id: randomUUID(),
			parentId: parent.id,
			parentRevision: savedParent.state.revision,
			domain: "fixture-review",
			objective: proposed.question,
			reason: proposed.reason,
			evidenceKey: `missing-script:${proposed.field}`,
		},
		{ domains: ["fixture-review"], maxChildrenPerParent: 1, maxDepth: 1 },
	);
	await new ResidentHost(agenda, step, options).run({ signal, maxSteps: 1 });
	const beforeIdle = runs.length;
	const idle = await new ResidentHost(agenda, step, options).run({
		signal,
		maxSteps: 1,
	});
	const final = await agenda.read();
	assert.equal(runs.length, 2);
	assert.equal(final.pursuits.length, 2);
	assert.ok(final.pursuits.every((p) => p.state.phase === "complete"));
	assert.equal(
		final.pursuits.find((p) => p.id === child.id).origin.parentId,
		parent.id,
	);
	assert.equal(runs.length - beforeIdle, 0);
	const evidence = {
		live,
		model,
		effort: "low",
		fixture,
		runs,
		selections,
		final,
		idle,
		idleModelCalls: runs.length - beforeIdle,
		totalReportedTokens: runs.reduce(
			(sum, run) => sum + run.usage.totalTokens,
			0,
		),
		limitations:
			"One host-bounded model-proposed subgoal. The host checks a missing fixture field and patch shape and saves an artifact; it does not execute or validate the suggested command. This is continuity and admission evidence, not a real coding benchmark, free-form initiative, or external messaging.",
	};
	await writeFile(
		join(root, "evidence.json"),
		JSON.stringify(evidence, null, 2),
	);
	console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
	console.error(
		JSON.stringify(
			{ root, error: String(error), runs, state: await agenda.read() },
			null,
			2,
		),
	);
	process.exitCode = 1;
}
