import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run after pnpm -r build: node research/resident/tool-loading-wire.mjs
// Real CLI session and SDK query, deterministic fake HTTP responses. There is
// no live mode. All fetch calls are intercepted before provider modules load.
// Captured bodies contain fixture prompts and schemas, never request headers.
const root = await mkdtemp(join(tmpdir(), "namzu-tool-loading-wire-"));
await chmod(root, 0o700);
const cwd = join(root, "project");
const previousNamzuHome = process.env.NAMZU_HOME;
const previousLogLevel = process.env.NAMZU_LOG_LEVEL;
const previousFetch = globalThis.fetch;
process.env.NAMZU_HOME = join(root, "home");
await mkdir(process.env.NAMZU_HOME, { mode: 0o700 });
process.env.NAMZU_LOG_LEVEL = "silent";
let activeCapture;
globalThis.fetch = async (_input, init) => {
	assert.ok(activeCapture, "No provider request is allowed outside a capture.");
	const request = JSON.parse(String(init?.body));
	assert.ok(Array.isArray(request.messages) && Array.isArray(request.tools));
	activeCapture.requests.push(request);
	return fakeResponse(activeCapture);
};

const guidance =
	"Before using a tool listed under deferred_tools, call search_tools with its exact name to load it. Loading a tool does not change its permissions.";

async function privateFile(path, value) {
	await writeFile(path, value, { flag: "wx", mode: 0o600 });
}

function fakeResponse({ scenario, toolLoading, requests }) {
	const turn = requests.length;
	let tool;
	if (scenario === "task") {
		if (toolLoading === "deferred" && turn === 1) {
			tool = { name: "search_tools", input: { query: "task_create" } };
		} else if (turn === (toolLoading === "deferred" ? 2 : 1)) {
			tool = {
				name: "task_create",
				input: { subject: "Check fixture evidence" },
			};
		}
	}
	const chunk = {
		id: "chatcmpl-wire-audit",
		object: "chat.completion.chunk",
		created: 1,
		model: "deepseek-chat",
		choices: [
			{
				index: 0,
				delta: tool
					? {
							tool_calls: [
								{
									index: 0,
									id: `call_${turn}`,
									type: "function",
									function: {
										name: tool.name,
										arguments: JSON.stringify(tool.input),
									},
								},
							],
						}
					: { content: "Done." },
				finish_reason: tool ? "tool_calls" : "stop",
			},
		],
		// Required fixture protocol data, deliberately excluded from measurements.
		usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

try {
	const sdk = await import("../../packages/sdk/dist/index.js");
	const { createAgentSession } = await import(
		"../../packages/cli/dist/tui/agent.js"
	);
	const { PROVIDER_REGISTRY } = await import(
		"../../packages/cli/dist/integrations/providers/index.js"
	);
	await mkdir(join(cwd, ".namzu"), { recursive: true, mode: 0o700 });
	await privateFile(
		join(cwd, "AGENTS.md"),
		"WIRE_AUDIT_INSTRUCTION: retain project policy.",
	);
	await privateFile(
		join(cwd, ".namzu", "MEMORY.md"),
		"WIRE_AUDIT_MEMORY: retained project fact.",
	);
	const captures = {};
	const results = {};
	const signal = AbortSignal.timeout(60_000);
	for (const scenario of ["no-tools", "task"]) {
		for (const toolLoading of ["eager", "deferred"]) {
			const name = `${scenario}-${toolLoading}`;
			const requests = [];
			captures[name] = requests;
			activeCapture = { scenario, toolLoading, requests };
			const session = await createAgentSession(
				{
					version: 3,
					providers: [{ id: "deepseek" }],
					subagents: { active: [] },
				},
				[
					{
						entry: PROVIDER_REGISTRY.deepseek,
						source: { kind: "env", envName: "DEEPSEEK_API_KEY" },
						apiKey: "not-a-real-key",
						alternatives: [],
					},
				],
				{
					cwd,
					toolLoading,
					sandbox: { enabled: false },
					plugins: { enabled: false },
					web: { search: "live" },
					memory: { recall: false },
					limits: { maxIterations: 4 },
				},
			);
			try {
				assert.equal(session.hasProvider, true, session.errorHint ?? "");
				const events = [];
				for await (const event of session.send(
					[
						sdk.createUserMessage(
							scenario === "task"
								? "Create one task with subject Check fixture evidence, then finish."
								: "Return a short completion without tools.",
						),
					],
					{
						signal,
						permissionMode: "plan",
						extraSystem:
							"WIRE_AUDIT_CONTINUITY: use the retained objective and prior summary.",
					},
				)) {
					events.push(event);
				}
				assert.equal(
					events.at(-1)?.stopReason,
					"end_turn",
					JSON.stringify(events),
				);
				assert.equal(
					requests.length,
					scenario === "task" ? (toolLoading === "deferred" ? 3 : 2) : 1,
				);
			} finally {
				await session.close();
				activeCapture = undefined;
			}
			const measures = requests.map((request) => ({
				toolCount: request.tools.length,
				toolsChars: JSON.stringify(request.tools).length,
				messagesChars: JSON.stringify(request.messages).length,
				requestBodyChars: JSON.stringify(request).length,
			}));
			const first = requests[0];
			const allMessages = JSON.stringify(first.messages);
			const retained =
				[
					sdk.CODING_AGENT_WORKING_DOCTRINE,
					sdk.CODING_AGENT_DELEGATION_DOCTRINE,
					sdk.PLAN_MODE_DOCTRINE,
				].every((text) =>
					first.messages.some(
						(message) =>
							typeof message.content === "string" &&
							message.content.includes(text),
					),
				) &&
				[
					"WIRE_AUDIT_INSTRUCTION",
					"WIRE_AUDIT_MEMORY",
					"WIRE_AUDIT_CONTINUITY",
					cwd,
				].every((text) => allMessages.includes(text));
			assert.equal(retained, true);
			results[name] = {
				requests: requests.length,
				first: measures[0],
				total: measures.reduce(
					(total, measure) => ({
						toolsChars: total.toolsChars + measure.toolsChars,
						messagesChars: total.messagesChars + measure.messagesChars,
						requestBodyChars: total.requestBodyChars + measure.requestBodyChars,
					}),
					{ toolsChars: 0, messagesChars: 0, requestBodyChars: 0 },
				),
				retainedInstructionsAndPermissionDoctrine: retained,
			};
			await privateFile(
				join(root, `${name}.requests.json`),
				JSON.stringify(requests, null, 2),
			);
		}
	}
	for (const scenario of ["no-tools", "task"]) {
		const eager = captures[`${scenario}-eager`][0];
		const deferred = captures[`${scenario}-deferred`][0];
		const staticEqual =
			eager.messages[0].content ===
			deferred.messages[0].content.replace(`${guidance}\n\n`, "");
		assert.equal(staticEqual, true);
		const byName = new Map(
			eager.tools.map((tool) => [tool.function.name, tool]),
		);
		const sharedEqual = deferred.tools
			.filter((tool) => tool.function.name !== "search_tools")
			.every(
				(tool) =>
					JSON.stringify(tool) ===
					JSON.stringify(byName.get(tool.function.name)),
			);
		assert.equal(sharedEqual, true);
		results[`${scenario}-comparison`] = {
			staticSystemEqualExceptDiscoveryGuidance: staticEqual,
			sharedToolSchemasEqual: sharedEqual,
		};
	}
	const repository = new URL("../../", import.meta.url);
	const fingerprints = Object.fromEntries(
		await Promise.all(
			[
				"packages/cli/dist/tui/agent.js",
				"packages/sdk/dist/registry/tool/execute.js",
				"packages/sdk/dist/runtime/query/index.js",
				"research/resident/tool-loading-wire.mjs",
			].map(async (path) => [
				path,
				createHash("sha256")
					.update(await readFile(new URL(path, repository)))
					.digest("hex"),
			]),
		),
	);
	const metrics = {
		schemaVersion: 1,
		measurement:
			"UTF-16 JavaScript serialized character counts from fake transport, not provider tokens, compressed bytes, bill or latency.",
		localArtifactRoot: root,
		fingerprints,
		results,
	};
	await privateFile(
		join(root, "metrics.json"),
		`${JSON.stringify(metrics, null, 2)}\n`,
	);
	console.log(JSON.stringify(metrics, null, 2));
} finally {
	globalThis.fetch = previousFetch;
	if (previousNamzuHome === undefined)
		Reflect.deleteProperty(process.env, "NAMZU_HOME");
	else process.env.NAMZU_HOME = previousNamzuHome;
	if (previousLogLevel === undefined)
		Reflect.deleteProperty(process.env, "NAMZU_LOG_LEVEL");
	else process.env.NAMZU_LOG_LEVEL = previousLogLevel;
}
