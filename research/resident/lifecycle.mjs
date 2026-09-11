import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as sdk from "../../packages/sdk/dist/index.js";

// A deterministic integration experiment, never a live-model benchmark. All
// recipients and fixtures belong to this invocation; no external message is sent.
const root = await mkdtemp(join(tmpdir(), "namzu-resident-lifecycle-"));
const scope = { tenantId: sdk.generateTenantId(), agentKey: "fixture-parser" };
const signal = AbortSignal.timeout(60_000);
const counters = {
	fixtureRuns: 0,
	residentSteps: 0,
	transportCalls: 0,
	networkAttempts: 0,
};
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => {
	counters.networkAttempts++;
	throw new Error("The resident lifecycle fixture forbids network access.");
};
const repository = new URL("../../", import.meta.url);
const files = [
	"packages/sdk/src/manager/resident/agenda.ts",
	"packages/sdk/src/manager/resident/host.ts",
	"packages/sdk/src/manager/resident/learning.ts",
	"packages/sdk/src/manager/resident/outbox.ts",
	"packages/sdk/src/manager/resident/delivery-window.ts",
	"packages/sdk/src/eval/experiment.ts",
	"packages/sdk/src/eval/harness-verification.ts",
	"packages/sdk/dist/manager/resident/agenda.js",
	"packages/sdk/dist/manager/resident/host.js",
	"packages/sdk/dist/manager/resident/learning.js",
	"packages/sdk/dist/eval/experiment.js",
	"packages/sdk/dist/eval/harness-verification.js",
	"research/resident/lifecycle.mjs",
];
const fingerprints = async () =>
	Object.fromEntries(
		await Promise.all(
			files.map(async (path) => [
				path,
				digest(await readFile(new URL(path, repository))),
			]),
		),
	);

const candidate = Object.freeze({
	name: "normalize-fixture-value",
	description:
		"Trim surrounding whitespace from the value in a key=value fixture.",
	body: JSON.stringify({ trimValue: true, uppercase: false }),
});
const regressingCandidate = Object.freeze({
	...candidate,
	body: JSON.stringify({ trimValue: true, uppercase: true }),
});

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function parseFixture(text, skill) {
	const rule = skill ? JSON.parse(skill.body) : {};
	assert.ok(
		Object.keys(rule).every((key) => ["trimValue", "uppercase"].includes(key)),
	);
	assert.ok(Object.values(rule).every((value) => typeof value === "boolean"));
	const separator = text.indexOf("=");
	assert.ok(separator > 0, "The fixture must contain a key and separator.");
	let value = text.slice(separator + 1);
	if (rule.trimValue) value = value.trim();
	if (rule.uppercase) value = value.toUpperCase();
	return { value, appliedRule: rule };
}

// These cases and expected answers are declared before any candidate is run.
// Confirmation uses new values/task IDs but the same small parser domain; it is
// a deterministic confirmation fixture, not independently sampled real tasks.
function fixtureCases(round) {
	const styles = [
		["plain", (value) => `mode=${value}`],
		["spaces", (value) => `mode=  ${value}  `],
		["tabs", (value) => `mode=\t${value}\t`],
		["nonbreaking-space", (value) => `mode=\u00a0${value}\u00a0`],
		["embedded-equals", (value) => `mode=${value}=kept`],
	];
	return styles.flatMap(([style, render]) =>
		[0, 1].map((trial) => {
			const value = `${round}-value-${trial}`;
			const input = render(value);
			return {
				name: `${round}/${style}/${trial}`,
				input,
				expected: style === "embedded-equals" ? `${value}=kept` : value,
				taskId: `${round}/${style}`,
				trial,
				conditions: digest(
					JSON.stringify({ parser: "fixture-parser/v1", input }),
				),
			};
		}),
	);
}

async function measure(
	round,
	before,
	after,
	baselineRevision,
	candidateRevision,
) {
	const fixtures = fixtureCases(round);
	const reportFor = async (label, skill) =>
		sdk.runExperiment({
			name: `${round}/${label}`,
			cases: fixtures,
			timeoutMs: 1_000,
			concurrency: 1,
			passThreshold: 1,
			run: async (input, _fixture, abort) => {
				abort.throwIfAborted();
				const started = performance.now();
				const output = JSON.stringify(parseFixture(input, skill));
				counters.fixtureRuns++;
				return {
					output,
					steps: [],
					toolCalls: [],
					stopReason: "fixture-complete",
					totalTokens: 0,
					totalCostUsd: 0,
					durationMs: performance.now() - started,
				};
			},
			scorers: [
				{
					name: "exact-parsed-value",
					severity: "gate",
					threshold: 1,
					score: (run, fixture) => {
						const actual = JSON.parse(run.output).value;
						const passed = actual === fixture.expected;
						return {
							score: Number(passed),
							reason: `Actual ${JSON.stringify(actual)} ${passed ? "equals" : "differs from"} expected ${JSON.stringify(fixture.expected)}.`,
							details: { actual, expected: fixture.expected },
						};
					},
				},
			],
		});
	const baselineReport = await reportFor("baseline", before);
	const candidateReport = await reportFor("candidate", after);
	const asTrials = (report, label) =>
		report.cases.map((result, index) => ({
			taskId: fixtures[index].taskId,
			trial: fixtures[index].trial,
			conditions: fixtures[index].conditions,
			trajectoryId: `${round}/${label}/${index}/${digest(result.run.output).slice(0, 16)}`,
			result,
		}));
	const baseline = asTrials(baselineReport, "baseline");
	const measuredCandidate = asTrials(candidateReport, "candidate");
	const attributions = [];
	for (const taskId of new Set(fixtures.map((fixture) => fixture.taskId))) {
		const beforeTrials = baseline.filter((trial) => trial.taskId === taskId);
		const afterTrials = measuredCandidate.filter(
			(trial) => trial.taskId === taskId,
		);
		const beforePassed = beforeTrials.every((trial) => trial.result.passed);
		const afterPassed = afterTrials.every((trial) => trial.result.passed);
		if (beforePassed === afterPassed) continue;
		attributions.push({
			taskId,
			effect: afterPassed ? "improvement" : "regression",
			reason: `Host exact-value trace review: baseline outputs ${JSON.stringify(beforeTrials.map((trial) => JSON.parse(trial.result.run.output).value))}; candidate outputs ${JSON.stringify(afterTrials.map((trial) => JSON.parse(trial.result.run.output).value))}; expected ${JSON.stringify(fixtures.filter((fixture) => fixture.taskId === taskId).map((fixture) => fixture.expected))}. Only the interpreted fixture rule changed.`,
			baselineTrajectories: beforeTrials.map((trial) => trial.trajectoryId),
			candidateTrajectories: afterTrials.map((trial) => trial.trajectoryId),
		});
	}
	return {
		baselineRevision,
		candidateRevision,
		baseline,
		candidate: measuredCandidate,
		attributions,
	};
}

async function evidence(key, reason) {
	const record = { key, source: "local-lifecycle-fixture/v1", reason };
	await writeFile(join(root, `${key}.json`), JSON.stringify(record), {
		flag: "wx",
	});
	return record;
}

// Integration below is kept in one invocation so no operator message is needed
// between the first pursuit admission and its continuation after reopening.
let agenda = new sdk.DiskResidentAgenda(root, scope);
const admissions = [];
const selections = [];
const receipts = new Map();
let parentId;
const findingId = randomUUID();
const fixedFindingInput = "mode=  Ready to report  ";
const fixedFindingExpected = "Ready to report";
const choose = sdk.createResidentSelector({
	progressValue: 10,
	initialExpectedProgress: 0.5,
	initialExpectedCost: 1,
});
const options = {
	learning: true,
	select: (snapshot, now) => {
		const selection = choose(snapshot, now);
		selections.push(selection);
		return selection;
	},
	observe: async (pursuit, decision) => ({
		evidenceKey: `admission:${pursuit.state.claimId}`,
		source: "local-fixture-assertions/v1; cost=callback-admissions",
		progress: decision.kind === "complete" ? 1 : 0.5,
		costUnits: 1,
	}),
	prepareMessage: async (pursuit, decision) => {
		if (pursuit.id !== parentId || decision.kind !== "complete") return null;
		const finding = JSON.parse(decision.summary);
		assert.equal(finding.value, fixedFindingExpected);
		return {
			id: findingId,
			pursuitId: pursuit.id,
			destination: "fixture:in-memory-recipient",
			body: `Checked fixture value: ${finding.value}`,
			notBefore: 0,
		};
	},
};

const step = async (pursuit, abort, context) => {
	abort.throwIfAborted();
	counters.residentSteps++;
	assert.ok(context && Number.isSafeInteger(context.agendaRevision));
	const projection = sdk.projectResidentLearning(context.learning, {
		maxChars: 4_000,
		skillNames: [candidate.name],
	});
	const activeSkill = context.learning?.skills.find(
		(skill) => skill.name === candidate.name,
	);
	const profile = context.learning?.preferences.find(
		(preference) => preference.key === "response-style",
	);
	admissions.push({
		pursuitId: pursuit.id,
		admission: pursuit.state.stepsAdmitted,
		previous: pursuit.state.summary,
		stableIdentity: pursuit.state.identity,
		agendaRevision: context.agendaRevision,
		learning: context.learning,
		projection,
	});
	if (pursuit.origin) {
		assert.equal(
			activeSkill,
			undefined,
			"Rollback must reach the next admission.",
		);
		assert.equal(
			profile?.value,
			"concise",
			"Skill rollback must preserve preference correction.",
		);
		assert.deepEqual(projection.includedSkills, []);
		return {
			kind: "complete",
			summary:
				"Verified rolled-back skill is absent and corrected preference persists.",
		};
	}
	if (pursuit.state.stepsAdmitted === 1) {
		assert.equal(activeSkill, undefined);
		assert.equal(profile?.value, "verbose");
		const actual = parseFixture(fixedFindingInput, undefined);
		assert.notEqual(actual.value, fixedFindingExpected);
		return {
			kind: "wait",
			summary: JSON.stringify({
				input: fixedFindingInput,
				expected: fixedFindingExpected,
				actual: actual.value,
			}),
			wakeAt: Date.now() + 1_000,
		};
	}
	assert.equal(pursuit.state.stepsAdmitted, 2);
	assert.ok(
		activeSkill,
		"Approved skill must be supplied through the admitted context after reopening.",
	);
	assert.equal(activeSkill.hash, sdk.hashResidentSkill(candidate));
	assert.equal(profile?.value, "concise");
	assert.ok(projection.includedSkills.includes(candidate.name));
	assert.ok(
		projection.text
			.split("\n")
			.some((line) => JSON.parse(line).body === candidate.body),
	);
	const previous = JSON.parse(pursuit.state.summary);
	assert.equal(previous.input, fixedFindingInput);
	assert.equal(previous.actual, parseFixture(previous.input, undefined).value);
	const actual = parseFixture(previous.input, activeSkill);
	assert.equal(actual.value, previous.expected);
	return {
		kind: "complete",
		summary: JSON.stringify({
			value: actual.value,
			skillHash: activeSkill.hash,
		}),
	};
};

try {
	const beforeFingerprints = await fingerprints();
	const revision = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repository,
		encoding: "utf8",
	}).trim();
	const workingTreeDirty = Boolean(
		execFileSync("git", ["status", "--porcelain"], {
			cwd: repository,
			encoding: "utf8",
		}).trim(),
	);
	await agenda.create(
		"An agent that checks synthetic fixture claims before reporting them.",
	);
	await agenda.updateProfile(await agenda.read(), {
		identity:
			"A fixture reviewer that retains checked rules and corrects stale preferences.",
		preferences: [
			{ key: "response-style", value: "verbose", supersedes: null },
		],
		evidence: await evidence(
			"initial-profile",
			"Synthetic initial preference record for the integration fixture.",
		),
	});
	const parent = await agenda.add(
		await agenda.read(),
		"Inspect the fixture, evaluate a whitespace rule, then continue from the saved finding and report the checked value.",
	);
	parentId = parent.id;
	let host = new sdk.ResidentHost(agenda, step, options);
	const first = await host.run({ signal, maxSteps: 1, maxIdleMs: 0 });
	assert.equal(first.stepsSettled, 1);
	await host.pause();
	agenda = new sdk.DiskResidentAgenda(root, scope);
	host = new sdk.ResidentHost(agenda, step, options);
	const beforePause = counters.residentSteps;
	const paused = await host.run({ signal, maxSteps: 1, maxIdleMs: 0 });
	assert.equal(paused.status, "paused");
	assert.equal(counters.residentSteps, beforePause);

	const revisionWithInitialPreference = (await agenda.read()).revision;
	await agenda.updateProfile(await agenda.read(), {
		preferences: [
			{
				key: "response-style",
				value: "concise",
				supersedes: "initial-profile",
			},
		],
		evidence: await evidence(
			"corrected-profile",
			"Synthetic explicit correction supersedes the earlier verbose preference; this is fixture administration, not an inferred user wish.",
		),
	});
	const beforePromotion = await agenda.read();
	const candidateHash = sdk.hashResidentSkill(candidate);
	const verification = await measure(
		"verification",
		undefined,
		candidate,
		"none",
		candidateHash,
	);
	const confirmation = await measure(
		"confirmation",
		undefined,
		candidate,
		"none",
		candidateHash,
	);
	const review = sdk.reviewHarnessCandidate(verification, confirmation);
	assert.equal(review.decision, "accept");
	assert.equal(
		verification.baseline.filter((trial) => trial.result.passed).length,
		4,
	);
	assert.equal(
		verification.candidate.filter((trial) => trial.result.passed).length,
		10,
	);
	assert.equal(
		confirmation.baseline.filter((trial) => trial.result.passed).length,
		4,
	);
	assert.equal(
		confirmation.candidate.filter((trial) => trial.result.passed).length,
		10,
	);
	await agenda.promoteSkill(
		beforePromotion,
		candidate,
		{ verification, confirmation },
		await evidence(
			"skill-promotion",
			"Exact-value fixture traces verify whitespace recovery with no observed regression in both paired rounds.",
		),
	);
	const promoted = await agenda.read();
	assert.equal(promoted.learning.skills[0].hash, candidateHash);

	agenda = new sdk.DiskResidentAgenda(root, scope);
	host = new sdk.ResidentHost(agenda, step, options);
	await host.resume();
	const continued = await host.run({ signal, maxSteps: 2, maxIdleMs: 5_000 });
	assert.equal(continued.stepsSettled, 1);
	const afterContinuation = await agenda.read();
	assert.equal(
		afterContinuation.pursuits.find((pursuit) => pursuit.id === parentId).state
			.phase,
		"complete",
	);
	assert.equal(
		afterContinuation.outbox.find((message) => message.id === findingId).phase,
		"pending",
	);
	assert.equal(counters.residentSteps, 2);

	const regressionHash = sdk.hashResidentSkill(regressingCandidate);
	const regressionVerification = await measure(
		"regression-verification",
		candidate,
		regressingCandidate,
		candidateHash,
		regressionHash,
	);
	const regressionConfirmation = await measure(
		"regression-confirmation",
		candidate,
		regressingCandidate,
		candidateHash,
		regressionHash,
	);
	const regressionReview = sdk.reviewHarnessCandidate(
		regressionVerification,
		regressionConfirmation,
	);
	assert.equal(regressionReview.decision, "reject");
	const beforeRejectedPromotion = await agenda.read();
	await assert.rejects(
		agenda.promoteSkill(
			beforeRejectedPromotion,
			regressingCandidate,
			{
				verification: regressionVerification,
				confirmation: regressionConfirmation,
			},
			await evidence(
				"rejected-regression",
				"Observed uppercase conversion breaks the exact-value assertions.",
			),
		),
	);
	assert.equal(
		(await agenda.read()).revision,
		beforeRejectedPromotion.revision,
	);

	await agenda.rollbackSkill(
		await agenda.read(),
		candidate.name,
		beforePromotion.revision,
		await evidence(
			"skill-rollback",
			"Synthetic rollback exercise restores the pre-promotion skill set while retaining corrected preferences.",
		),
	);
	const rolledBack = await agenda.read();
	assert.equal(rolledBack.learning.skills.length, 0);
	assert.equal(
		rolledBack.learning.preferences.find(
			(preference) => preference.key === "response-style",
		).value,
		"concise",
	);
	assert.equal(
		(await agenda.readRevision(revisionWithInitialPreference)).learning
			.preferences[0].value,
		"verbose",
	);
	assert.equal(
		(await agenda.readRevision(promoted.revision)).learning.skills[0].hash,
		candidateHash,
	);
	assert.ok(rolledBack.revision > beforeRejectedPromotion.revision);

	// One host-authorized bounded follow-up proves that the rollback projection
	// reaches a fresh admission. No user prompt or model-generated goal is claimed.
	const savedParent = rolledBack.pursuits.find(
		(pursuit) => pursuit.id === parentId,
	);
	const child = await agenda.admitProposal(
		rolledBack,
		{
			id: randomUUID(),
			parentId,
			parentRevision: savedParent.state.revision,
			domain: "fixture-review",
			objective:
				"Verify rollback is reflected in the next context and the corrected preference remains.",
			reason:
				"The fixture has activated a new rollback revision that must reach subsequent work.",
			evidenceKey: "skill-rollback",
		},
		{ domains: ["fixture-review"], maxChildrenPerParent: 1, maxDepth: 1 },
	);
	agenda = new sdk.DiskResidentAgenda(root, scope);
	host = new sdk.ResidentHost(agenda, step, options);
	const followup = await host.run({ signal, maxSteps: 2, maxIdleMs: 0 });
	assert.equal(followup.stepsSettled, 1);
	assert.equal(
		(await agenda.read()).pursuits.find((pursuit) => pursuit.id === child.id)
			.state.phase,
		"complete",
	);

	let clock = Date.parse("2026-09-11T08:59:59.000Z");
	const gate = sdk.createResidentDeliveryWindow({
		timeZone: "UTC",
		startMinute: 9 * 60,
		endMinute: 17 * 60,
	});
	const transport = async (message, abort) => {
		abort.throwIfAborted();
		counters.transportCalls++;
		assert.equal(message.destination, "fixture:in-memory-recipient");
		const previous = receipts.get(message.id);
		if (previous) assert.equal(previous.body, message.body);
		const receipt = previous ?? {
			body: message.body,
			id: `local-fixture:${message.id}`,
		};
		receipts.set(message.id, receipt);
		return { kind: "acknowledged", receiptId: receipt.id };
	};
	const deliveryOptions = { signal, gate, now: () => clock };
	const quiet = await sdk.deliverResidentMessage(
		agenda,
		transport,
		deliveryOptions,
	);
	assert.equal(quiet.status, "idle");
	assert.equal(quiet.reason, "window");
	assert.equal(counters.transportCalls, 0);
	clock = quiet.nextCheckAt;
	assert.equal(clock, Date.parse("2026-09-11T09:00:00.000Z"));
	const delivered = await sdk.deliverResidentMessage(
		agenda,
		transport,
		deliveryOptions,
	);
	assert.equal(delivered.status, "settled");
	assert.equal(delivered.message.phase, "acknowledged");
	assert.equal(receipts.size, 1);
	const beforeIdle = { ...counters };
	const idleHost = await host.run({ signal, maxSteps: 1, maxIdleMs: 0 });
	const idleDelivery = await sdk.deliverResidentMessage(
		agenda,
		transport,
		deliveryOptions,
	);
	assert.equal(idleHost.status, "idle");
	assert.equal(idleDelivery.reason, "empty");
	assert.deepEqual(counters, beforeIdle);

	const beforeArchive = await agenda.read();
	await agenda.archive(beforeArchive, {
		pursuitIds: [child.id, parentId],
		messageIds: [findingId],
	});
	const final = await agenda.read();
	assert.equal(final.pursuits.length, 0);
	assert.equal(final.outbox.length, 0);
	assert.equal(final.learning.preferences[0].value, "concise");
	assert.equal(
		(await agenda.readRevision(beforeArchive.revision)).outbox[0].phase,
		"acknowledged",
	);
	const archive = await agenda.listArchived({ limit: 5 });
	assert.equal(archive.entries.length, 1);
	assert.equal(archive.entries[0].pursuits.length, 2);
	assert.equal(archive.entries[0].messages.length, 1);
	assert.equal(archive.nextBeforeRevision, null);
	assert.equal(counters.fixtureRuns, 80);
	assert.equal(counters.residentSteps, 3);
	assert.equal(counters.transportCalls, 1);
	assert.equal(counters.networkAttempts, 0);
	assert.deepEqual(
		await fingerprints(),
		beforeFingerprints,
		"Source or build changed during the lifecycle experiment.",
	);
	const report = {
		kind: "resident-lifecycle-deterministic-fixture",
		revision,
		workingTreeDirty,
		fingerprints: beforeFingerprints,
		root,
		initialPursuits: 1,
		additionalUserPrompts: 0,
		counts: {
			...counters,
			modelCalls: 0,
			modelTokens: 0,
			modelCostUsd: 0,
			idleModelCalls: 0,
			quietTransportCalls: 0,
		},
		candidate,
		regressingCandidate,
		verification,
		confirmation,
		review,
		regressionVerification,
		regressionConfirmation,
		regressionReview,
		admissions,
		selections,
		first,
		paused,
		continued,
		followup,
		quiet,
		delivered,
		idleHost,
		idleDelivery,
		archive,
		final,
		limitations: [
			"The host interprets a developer-authored JSON guidance rule in a deterministic parser. No LLM, learned weights, spontaneous goals or intelligence improvement is demonstrated.",
			"Verification and confirmation use distinct declared fixture inputs from one narrow parser domain. These are real evaluated outputs, but not independent real-world generalization evidence.",
			"Preference correction, promotion, rollback and bounded follow-up are prescribed local host controls within this test, not autonomous preference discovery.",
			"The store reopens within one process. Separate process tests establish crash behavior; this experiment does not.",
			"The recipient is an in-memory fixture. Acknowledgment means fixture acceptance, not external delivery or human reading. Quiet hours use a controlled delivery clock.",
		],
	};
	await writeFile(
		join(root, "evidence.json"),
		`${JSON.stringify(report, null, 2)}\n`,
	);
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	console.error(
		JSON.stringify(
			{ root, counters, admissions, error: String(error), stack: error.stack },
			null,
			2,
		),
	);
	process.exitCode = 1;
} finally {
	globalThis.fetch = previousFetch;
}
