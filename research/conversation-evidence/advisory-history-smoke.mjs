// Built SDK query with a real file observation and an optional single live
// advisor call. Main-model turns are scripted. This is not the interactive CLI.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = process.argv.includes("--live");
const root = await mkdtemp(join(tmpdir(), "namzu-advisory-observation-"));
const home = join(root, "home");
const cwd = join(root, "workspace");
await mkdir(home);
await mkdir(cwd);
process.env.NAMZU_HOME = home;
process.chdir(cwd);
await writeFile(
	join(home, "preferences.json"),
	JSON.stringify({
		version: 3,
		providers: [{ id: "codex", model: "gpt-5.6-luna" }],
		subagents: { active: [] },
	}),
);
const sdk = await import("../../packages/sdk/dist/index.js");
const fingerprints = async () =>
	Object.fromEntries(
		await Promise.all(
			[
				"packages/sdk/dist/advisory/history.js",
				"packages/sdk/dist/advisory/executor.js",
				"packages/sdk/dist/runtime/query/iteration/phases/advisory.js",
				"packages/providers/openai/dist/codex.js",
			].map(async (path) => [
				path,
				createHash("sha256")
					.update(await readFile(new URL(`../../${path}`, import.meta.url)))
					.digest("hex"),
			]),
		),
	);
const report = { live, root, buildBefore: await fingerprints(), requests: [] };
const observed = `OBSERVED-${randomUUID()}`;
const original = `receipt code: ${observed}\n`;
await writeFile(join(cwd, "receipt.txt"), original);
const tools = new sdk.ToolRegistry();
let reads = 0;
tools.register({
	name: "observe_receipt",
	description: "Read the fixture receipt.",
	inputSchema: sdk.mcpJsonSchemaToZod({
		type: "object",
		properties: {},
		additionalProperties: false,
	}),
	execute: async () => {
		reads++;
		const text = await readFile(join(cwd, "receipt.txt"), "utf8");
		return {
			success: true,
			output: text,
			content: [
				{ type: "text", text },
				{
					type: "image",
					mediaType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1EAAAAASUVORK5CYII=",
				},
			],
		};
	},
});
const main = new sdk.MockLLMProvider({
	turns: [
		{
			text: "My guess is receipt code CLAIM-ONLY.",
			toolCalls: [
				{ id: "receipt-observation", name: "observe_receipt", args: {} },
			],
		},
		{
			text: "Scripted transport control ended; inspect the advisor response in result.json.",
		},
	],
});
let advisor = new sdk.MockLLMProvider({
	turns: [{ text: `Scripted control: the read returned ${observed}.` }],
});
if (live) {
	const { constructProvider, probeAgentSession } = await import(
		"../../packages/cli/dist/tui/agent.js"
	);
	const { ensureRegistered } = await import(
		"../../packages/cli/dist/integrations/providers/register.js"
	);
	await ensureRegistered("codex");
	const probe = await probeAgentSession();
	const detected = probe.detected.find((entry) => entry.entry.id === "codex");
	assert.ok(detected, "A locally authenticated Codex provider is required");
	advisor = constructProvider("codex", detected, "gpt-5.6-luna");
}
const stream = advisor.chatStream.bind(advisor);
advisor.chatStream = async function* (params) {
	assert.equal(params.toolChoice, "none");
	const context = String(params.messages[1]?.content);
	const rows = context
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map(JSON.parse);
	const observation = rows.find(
		(row) => row.role === "tool" && row.toolCallId === "receipt-observation",
	);
	assert.equal(observation.isError, false);
	assert.equal(observation.content[0].text, original);
	assert.equal(observation.content[1].contentOmitted, true);
	assert.ok(
		rows.some((row) =>
			row.toolCalls?.some(
				(call) =>
					call.id === "receipt-observation" && call.name === "observe_receipt",
			),
		),
	);
	assert.ok(!context.includes("[object Object]") && !context.includes("iVBOR"));
	const record = {
		model: params.model,
		effort: "low",
		context,
		text: "",
		usage: [],
	};
	report.requests.push(record);
	for await (const chunk of stream({ ...params, effort: "low" })) {
		record.text += chunk.delta.content ?? "";
		if (chunk.usage) record.usage.push(chunk.usage);
		yield chunk;
	}
};
console.log(JSON.stringify({ root, live }));
const result = await sdk.drainQuery({
	provider: main,
	tools,
	workingDirectory: cwd,
	retry: false,
	tenantId: sdk.generateTenantId(),
	projectId: sdk.generateProjectId(),
	sessionId: sdk.generateSessionId(),
	topicId: sdk.generateTopicId(),
	agentId: "advisory-smoke",
	agentName: "Advisory smoke",
	messages: [
		sdk.createUserMessage(
			"Inspect the receipt and distinguish the guess from the observation.",
		),
	],
	runConfig: {
		model: "mock",
		tokenBudget: 3000,
		maxIterations: 3,
		timeoutMs: 30000,
	},
	advisory: {
		advisors: [
			{
				id: "reviewer",
				name: "Reviewer",
				model: live ? "gpt-5.6-luna" : "mock",
				provider: advisor,
				maxContextTokens: 2000,
				maxResponseTokens: 256,
			},
		],
		budget: { maxCallsPerRun: 1 },
		triggers: [
			{
				id: "after-observation",
				condition: { type: "on_iteration", everyN: 1 },
				questionTemplate:
					"Which receipt code is supported by the actual file observation? Distinguish the assistant guess. State whether this text projection contains image pixels. Keep the advice brief.",
			},
		],
	},
});
report.stopReason = result.stopReason;
report.usage = result.tokenUsage;
report.reads = reads;
report.observed = observed;
report.adviceReachedMain = main.requests
	.at(-1)
	.messages.some((m) => m.role === "user" && m.source?.kind === "advisory");
report.fileUnchanged =
	(await readFile(join(cwd, "receipt.txt"), "utf8")) === original;
report.buildAfter = await fingerprints();
await writeFile(
	join(root, "result.json"),
	`${JSON.stringify(report, null, 2)}\n`,
);
assert.equal(reads, 1);
assert.equal(report.requests.length, 1);
assert.equal(result.stopReason, "end_turn");
assert.ok(report.adviceReachedMain && report.fileUnchanged);
assert.deepEqual(report.buildAfter, report.buildBefore);
console.log(
	JSON.stringify({
		stopReason: report.stopReason,
		usage: report.usage,
		advice: report.requests[0].text,
	}),
);
