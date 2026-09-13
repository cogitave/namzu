// Real interactive host and archive tools; scripted transport, no vendor inference.
// Seed using source-support-review-cli.mjs --roles --originals --case=conflicting-claim.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import {
	MockLLMProvider,
	ProviderRegistry,
	toolResultToText,
} from "../../packages/sdk/dist/index.js";

const runId = process.env.NAMZU_SOURCE_KIND_RUN;
const trace = process.env.NAMZU_SOURCE_KIND_TRACE;
assert.ok(
	runId && trace,
	"Supply an authorized fixture run and temporary trace",
);
ProviderRegistry.create = () => {
	const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						id: "locate",
						name: "search_conversation",
						args: { runId, query: "ORCHID", limit: 3 },
					},
				],
				usage,
			},
			{
				toolCalls: [
					{
						id: "observation",
						name: "read_conversation",
						args: { runId, seq: 2, part: 0 },
					},
					{
						id: "claim",
						name: "read_conversation",
						args: { runId, seq: 3, part: 0 },
					},
				],
				usage,
			},
			{
				text: "Source metadata preserved: one read result and one assistant claim. This check does not judge their truth.",
				usage,
			},
		],
	});
	const stream = provider.chatStream.bind(provider);
	let step = 0;
	provider.chatStream = async function* (params) {
		const results = params.messages.filter(
			(message) => message.role === "tool",
		);
		const parse = (message) => {
			assert.ok(message && !message.isError);
			return JSON.parse(toolResultToText(message.content));
		};
		if (step === 1) {
			const page = parse(
				results.find((message) => message.toolCallId === "locate"),
			);
			assert.deepEqual(
				page.matches.map((match) => match.recordKind),
				["tool_result", "assistant_message"],
			);
			await appendFile(trace, `${JSON.stringify({ step, page })}\n`);
		}
		if (step === 2) {
			const observation = parse(
				results.find((message) => message.toolCallId === "observation"),
			);
			const claim = parse(
				results.find((message) => message.toolCallId === "claim"),
			);
			assert.equal(observation.recordKind, "tool_result");
			assert.equal(observation.toolName, "read");
			assert.equal(observation.isError, false);
			assert.equal(claim.recordKind, "assistant_message");
			assert.equal(claim.toolName, undefined);
			assert.equal(claim.isError, undefined);
			for (const page of [observation, claim]) {
				assert.equal(page.complete, true);
				assert.match(page.recordKindGuidance, /not proof of observed state/);
			}
			await appendFile(
				trace,
				`${JSON.stringify({ step, observation, claim })}\n`,
			);
		}
		assert.ok(step < 3, "No unplanned follow-up inference");
		step++;
		yield* stream(params);
	};
	return { provider };
};
