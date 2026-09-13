// Real CLI/storage/TUI, scripted inference. `node this-file --seed` creates an isolated fixture.
// Then preload this file for the CLI with NAMZU_PRESENTATION_ROOT set to the printed root.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const root = seeding
	? await mkdtemp(join(tmpdir(), "namzu-evidence-presentation-"))
	: process.env.NAMZU_PRESENTATION_ROOT;
assert.ok(root);
process.env.NAMZU_HOME = join(root, "home");
const sdk = await import("../../packages/sdk/dist/index.js");

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
	await writeFile(
		join(root, "home", "config.yaml"),
		// Isolate explicit archive presentation from automatic query planning.
		"web:\n  search: off\nmemory:\n  recall: false\nsandbox:\n  enabled: false\ncompaction:\n  recallEvidence: false\n",
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
	const store = new sdk.RunDiskStore({ baseDir: dirname(runDir) });
	await store.initRun(runId);
	const scope = {
		tenantId: sessions.tenantId,
		projectId: sessions.projectId,
		sessionId,
		runId,
	};
	await writeFile(
		join(runDir, "run.json"),
		JSON.stringify({ id: runId, status: "completed", metadata: { scope } }),
	);
	const long = `ARCHIVE original tool text. ${"retained 🦉 ".repeat(650)} END_OF_ORIGINAL`;
	for (const [index, event] of [
		{ type: "run_started" },
		{
			type: "tool_completed",
			toolName: "read",
			toolUseId: "original",
			isError: false,
			result: long,
		},
		{
			type: "message_completed",
			content: "ARCHIVE assistant claim; not an independent observation.",
		},
		{
			type: "tool_completed",
			toolName: "read",
			toolUseId: "preview",
			isError: true,
			result: "ARCHIVE RETAINED_PREVIEW: original tool reported an error.",
			outputTruncated: true,
		},
		{ type: "run_completed", stopReason: "end_turn" },
	].entries())
		await store.appendEvent({ ...event, runId, seq: index + 1 });
	await replaceConversation(sessions, sessionId, [
		sdk.createUserMessage(
			"Earlier ARCHIVE records were compacted. Inspect their retained output.",
		),
	]);
	const sourceFiles = ["run.json", "transcript.jsonl"];
	const sourceHashes = {};
	for (const file of sourceFiles)
		sourceHashes[file] = createHash("sha256")
			.update(await readFile(join(runDir, file)))
			.digest("hex");
	const seed = { root, sessionId, runId, runDir, sourceHashes, long };
	await writeFile(join(root, "seed.json"), JSON.stringify(seed, null, 2));
	console.log(JSON.stringify({ root, sessionId, runId }));
} else {
	const seed = JSON.parse(await readFile(join(root, "seed.json"), "utf8"));
	sdk.ProviderRegistry.create = () => {
		let step = 0;
		let prefix = "";
		return {
			provider: {
				id: "scripted",
				name: "Scripted archive presentation control",
				async *chatStream(params) {
					assert.ok(step < 7, "Six archive calls and final response only");
					const result = params.messages
						.filter((message) => message.role === "tool")
						.at(-1);
					const raw = result ? sdk.toolResultToText(result.content) : undefined;
					if (result)
						await appendFile(
							join(root, "trace.jsonl"),
							`${JSON.stringify({ step, call: result.toolCallId, isError: result.isError, raw })}\n`,
						);
					const page = raw && !result.isError ? JSON.parse(raw) : undefined;
					let call;
					switch (step++) {
						case 0:
							call = {
								id: "search",
								name: "search_conversation",
								args: { query: "ARCHIVE", runId: seed.runId, limit: 10 },
							};
							break;
						case 1:
							assert.ok(
								page.matches.some(
									(match) => match.recordKind === "assistant_message",
								),
							);
							assert.ok(
								page.matches.some(
									(match) =>
										match.retained === "preview" && match.isError === true,
								),
							);
							assert.equal(page.incomplete, true);
							call = {
								id: "first-page",
								name: "read_conversation",
								args: { runId: seed.runId, seq: 2, part: 0 },
							};
							break;
						case 2:
							assert.equal(page.complete, false);
							assert.equal(page.retainedPreview, false);
							assert.ok(page.nextCursor);
							prefix = page.text;
							call = {
								id: "last-page",
								name: "read_conversation",
								args: {
									runId: seed.runId,
									seq: 2,
									part: 0,
									cursor: page.nextCursor,
								},
							};
							break;
						case 3:
							assert.equal(page.complete, true);
							assert.ok(page.offset > 0);
							assert.equal(prefix + page.text, seed.long);
							call = {
								id: "assistant-claim",
								name: "read_conversation",
								args: { runId: seed.runId, seq: 3, part: 0 },
							};
							break;
						case 4:
							assert.equal(page.recordKind, "assistant_message");
							assert.equal(page.complete, true);
							call = {
								id: "retained-preview",
								name: "read_conversation",
								args: { runId: seed.runId, seq: 4, part: 0 },
							};
							break;
						case 5:
							assert.equal(page.retainedPreview, true);
							assert.equal(page.isError, true);
							assert.equal(
								result.isError,
								false,
								"Archive read succeeds even though original tool failed",
							);
							call = {
								id: "missing-address",
								name: "read_conversation",
								args: { runId: seed.runId, seq: 999, part: 0 },
							};
							break;
						case 6:
							assert.equal(result.isError, true);
							assert.match(raw, /Cannot read this evidence address/);
							for (const [file, hash] of Object.entries(seed.sourceHashes))
								assert.equal(
									createHash("sha256")
										.update(await readFile(join(seed.runDir, file)))
										.digest("hex"),
									hash,
								);
							break;
					}
					const turn = call
						? { toolCalls: [call] }
						: {
								text: "Archive presentation control finished. Partial pages, source attribution, a retained preview and an unavailable address were exercised; no original action was replayed.",
							};
					yield* new sdk.MockLLMProvider({ turns: [turn] }).chatStream(params);
				},
			},
		};
	};
}
