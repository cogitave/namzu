// Real TUI and archive operations with a scripted transport; no live inference.
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	MockLLMProvider,
	ProviderRegistry,
	toolResultToText,
} from "../../packages/sdk/dist/index.js";

const root = process.env.NAMZU_MATCHING_RUNS_ROOT;
assert.ok(root);
const seed = JSON.parse(await readFile(join(root, "result.json"), "utf8")).seed;
ProviderRegistry.create = () => {
	let requests = 0;
	let searches = 0;
	return {
		provider: {
			id: "scripted",
			name: "Scripted terminal control",
			async *chatStream(params) {
				assert.ok(
					++requests <= 4,
					"Two search pages, one read and final response",
				);
				const result = params.messages
					.filter((message) => message.role === "tool")
					.at(-1);
				let turn;
				if (!result)
					turn = {
						toolCalls: [
							{
								id: "search-1",
								name: "search_conversation",
								args: { query: "DELTA" },
							},
						],
					};
				else {
					assert.ok(!result.isError);
					const page = JSON.parse(toolResultToText(result.content));
					await appendFile(
						join(root, "tui-trace.jsonl"),
						`${JSON.stringify({ requests, toolCallId: result.toolCallId, page })}\n`,
					);
					if (result.toolCallId.startsWith("search-")) {
						searches++;
						assert.ok(page.scannedBytes <= 8 * 1024 * 1024);
						assert.ok(Buffer.byteLength(JSON.stringify(page.matches)) <= 12000);
						if (searches === 1) assert.equal(page.matches.length, 5);
						const match = page.matches.find(
							(m) => m.runId === seed.runId && m.seq === seed.seq,
						);
						if (match) {
							assert.equal(searches, 2);
							turn = {
								toolCalls: [
									{
										id: "read-original",
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
							assert.ok(page.nextCursor);
							turn = {
								toolCalls: [
									{
										id: `search-${searches + 1}`,
										name: "search_conversation",
										args: { cursor: page.nextCursor },
									},
								],
							};
						}
					} else {
						assert.equal(page.retainedPreview, false);
						assert.ok(page.text.includes(seed.tracking));
						assert.ok(page.text.includes(seed.destination));
						turn = {
							text: `Original identifiers recovered through two search pages and one exact read: ${seed.tracking}; ${seed.destination}.`,
						};
					}
				}
				yield* new MockLLMProvider({ turns: [turn] }).chatStream(params);
			},
		},
	};
};
