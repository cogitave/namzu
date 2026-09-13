// Interactive CLI transport control, not a live inference or factuality score.
// Run in an isolated cwd containing receipt.txt and with limits.tokenBudget: 1000.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import {
	MockLLMProvider,
	ProviderRegistry,
	toolResultToText,
} from "../../packages/sdk/dist/index.js";

const trace = process.env.NAMZU_FORCED_CLOSE_TRACE;
assert.ok(trace, "Supply a temporary trace path");
ProviderRegistry.create = () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{ id: "read-receipt", name: "read", args: { path: "receipt.txt" } },
				],
				usage: { promptTokens: 475, completionTokens: 475, totalTokens: 950 },
			},
			{
				text: "Receipt read. This closing summary is not an independently verified answer.",
				usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
			},
		],
	});
	const stream = provider.chatStream.bind(provider);
	let step = 0;
	provider.chatStream = async function* (params) {
		assert.ok(step < 2, "The limit must stop further requests");
		const result = params.messages
			.filter((message) => message.role === "tool")
			.at(-1);
		const closingInstruction = params.messages.find(
			(message) =>
				message.source?.type === "runtime-context" &&
				message.source.kind === "limit-finalization",
		)?.content;
		if (step === 1) {
			assert.ok(result && !result.isError);
			assert.match(toolResultToText(result.content), /ORCHID-CLOSING-CONTROL/);
			assert.equal(params.toolChoice, "none");
			assert.match(
				closingInstruction,
				/Attribute unverified statements to their source/,
			);
		}
		await appendFile(
			trace,
			`${JSON.stringify({ step, toolChoice: params.toolChoice, closingInstruction, result })}\n`,
		);
		step++;
		yield* stream(params);
	};
	return { provider };
};
