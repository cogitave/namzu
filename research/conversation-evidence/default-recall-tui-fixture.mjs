// Offline assertion provider, real CLI resume/storage/TUI. Seed with --seed,
// then preload with NAMZU_DEFAULT_RECALL_ROOT pointing to the printed root.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const seeding = process.argv[2] === "--seed";
const failQueryPlan = process.env.NAMZU_RECALL_FAIL_PLAN === "1";
const root = seeding
	? await mkdtemp(join(tmpdir(), "namzu-default-recall-tui-"))
	: process.env.NAMZU_DEFAULT_RECALL_ROOT;
assert.ok(root);
process.env.NAMZU_HOME = join(root, "home");
const sdk = await import("../../packages/sdk/dist/index.js");
const originalPrompt = "Inspect the DELTA record in sevkiyatlar.txt.";
const hash = (text) => createHash("sha256").update(text).digest("hex");

if (seeding) {
	await mkdir(join(root, "home"));
	await mkdir(join(root, "workspace"));
	await writeFile(
		join(root, "home", "preferences.json"),
		JSON.stringify({
			version: 3,
			providers: [{ id: "codex", model: "gpt-5.6-luna" }],
			subagents: { active: [] },
		}),
	);
	// Deliberately omit compaction settings: this is a default-wiring control.
	await writeFile(
		join(root, "home", "config.yaml"),
		"web:\n  search: off\nmemory:\n  recall: false\nsandbox:\n  enabled: false\n",
	);
	const { openSessions, startConversation, replaceConversation } = await import(
		"../../packages/cli/dist/integrations/sessions/store.js"
	);
	const { CliPathBuilder } = await import(
		"../../packages/cli/dist/integrations/sessions/paths.js"
	);
	const sessions = await openSessions(join(root, "workspace"));
	const sessionId = await startConversation(sessions);
	const runId = sdk.generateRunId();
	const runDir = new CliPathBuilder(sessions.root).runDir(
		sessions.projectId,
		sessionId,
		runId,
	);
	const original = [`TAKIP-${randomUUID()}`, `DEPO-${randomUUID()}`];
	const current = [`YENI-TAKIP-${randomUUID()}`, `YENI-DEPO-${randomUUID()}`];
	const currentText = `DELTA current identifiers: ${current.join(" ")}\n`;
	await writeFile(join(root, "workspace", "sevkiyatlar.txt"), currentText);
	const store = new sdk.RunDiskStore({ baseDir: dirname(runDir) });
	await store.initRun(runId);
	await writeFile(
		join(runDir, "run.json"),
		JSON.stringify({
			id: runId,
			status: "completed",
			metadata: {
				scope: {
					tenantId: sessions.tenantId,
					projectId: sessions.projectId,
					sessionId,
					runId,
				},
			},
		}),
	);
	for (const [index, event] of [
		{ type: "run_started" },
		{
			type: "tool_completed",
			toolName: "read",
			toolUseId: "original-read",
			isError: false,
			result: `DELTA original identifiers: ${original.join(" ")}`,
		},
		{ type: "run_completed", stopReason: "end_turn" },
	].entries())
		await store.appendEvent({ ...event, runId, seq: index + 1 });
	await replaceConversation(sessions, sessionId, [
		sdk.createUserMessage(originalPrompt),
		sdk.createAssistantMessage("DELTA has tracking and depot identifiers."),
	]);
	const sourceHashes = {};
	for (const file of ["run.json", "transcript.jsonl"])
		sourceHashes[file] = hash(await readFile(join(runDir, file)));
	await writeFile(
		join(root, "seed.json"),
		JSON.stringify(
			{
				root,
				sessionId,
				runId,
				runDir,
				original,
				current,
				currentText,
				sourceHashes,
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ root, sessionId, runId }));
} else {
	const seed = JSON.parse(await readFile(join(root, "seed.json"), "utf8"));
	sdk.ProviderRegistry.create = () => ({
		provider: {
			id: "scripted",
			name: "Default recall assertion provider",
			async *chatStream(params) {
				const planner =
					params.messages.length === 2 &&
					String(params.messages[0]?.content).startsWith(
						"Resolve a conversation-history search query.",
					);
				const contexts = params.messages.filter(
					(m) =>
						m.source?.type === "runtime-context" &&
						m.source.kind === "step-context",
				);
				let turn;
				if (planner) {
					const input = JSON.parse(params.messages[1].content);
					const current = input.current.includes("güncel");
					const row = input.tokens.find(([, value]) => value === "DELTA");
					const basis = input.history.find((m) =>
						m.text.includes(originalPrompt),
					);
					assert.ok(row && basis);
					turn = {
						text: JSON.stringify(
							current
								? {
										mode: "direct",
										time: "present",
										termIds: [],
										focusIds: [],
										basis: [],
									}
								: {
										mode: "contextual",
										time: "past",
										termIds: [row[0]],
										focusIds: [row[0]],
										basis: [{ message: basis.message, quote: originalPrompt }],
									},
						),
					};
					if (failQueryPlan) turn = { text: "INVALID_QUERY_PLAN_CONTROL" };
				} else {
					const operator = params.messages
						.filter((m) => m.role === "user" && !m.source)
						.at(-1);
					const current = String(operator?.content).includes("güncel");
					const text = contexts.map((m) => m.content).join("\n");
					if (current) {
						const result = params.messages
							.filter((m) => m.role === "tool")
							.at(-1);
						if (result?.toolCallId === "current-read") {
							for (const value of seed.current)
								assert.ok(String(result.content).includes(value));
							turn = { text: `Güncel dosya: ${seed.current.join(" · ")}` };
						} else
							turn = {
								toolCalls: [
									{
										id: "current-read",
										name: "read",
										args: { path: "sevkiyatlar.txt" },
									},
								],
							};
					} else if (failQueryPlan) {
						assert.ok(text.includes('"status":"unavailable"'));
						assert.ok(!text.includes("INVALID_QUERY_PLAN_CONTROL"));
						const result = params.messages
							.filter((m) => m.role === "tool")
							.at(-1);
						if (!result)
							turn = {
								toolCalls: [
									{
										id: "history-search",
										name: "search_conversation",
										args: { query: "DELTA" },
									},
								],
							};
						else {
							const raw = sdk.toolResultToText(result.content);
							const page = JSON.parse(
								raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
							);
							if (result.toolCallId === "history-search") {
								const match = page.matches.find((m) => m.toolName === "read");
								assert.ok(match);
								turn = {
									toolCalls: [
										{
											id: "history-read",
											name: "read_conversation",
											args: {
												runId: match.runId,
												seq: match.seq,
												part: match.part,
												byteOffset: match.byteOffset,
											},
										},
									],
								};
							} else {
								for (const value of seed.original)
									assert.ok(page.text.includes(value));
								turn = {
									text: `Arşivden doğrulandı: ${seed.original.join(" · ")}`,
								};
							}
						}
					} else {
						const ordinary = JSON.stringify(
							params.messages.filter((m) => !contexts.includes(m)),
						);
						for (const value of seed.original) {
							assert.ok(
								text.includes(value),
								"Default recall must supply the original",
							);
							assert.ok(
								!ordinary.includes(value),
								"Original must be missing from ordinary history",
							);
						}
						assert.match(text, /tool_result/);
						turn = { text: `Önceki gözlem: ${seed.original.join(" · ")}` };
					}
					for (const [file, expected] of Object.entries(seed.sourceHashes))
						assert.equal(
							hash(await readFile(join(seed.runDir, file))),
							expected,
						);
					assert.equal(
						await readFile(join(root, "workspace", "sevkiyatlar.txt"), "utf8"),
						seed.currentText,
					);
				}
				await appendFile(
					join(root, "trace.jsonl"),
					`${JSON.stringify({
						planner,
						contexts,
						turn,
						sourceHashes: seed.sourceHashes,
					})}\n`,
				);
				yield* new sdk.MockLLMProvider({ turns: [turn] }).chatStream(params);
			},
		},
	});
}
