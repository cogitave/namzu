// Offline provider fixture for manual TUI inspection of a seeded missing-SIGMA conversation.
// Import with node --import; NAMZU_FOCUS_TRACE must name a temporary trace file.
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { MockLLMProvider, ProviderRegistry } from '../../packages/sdk/dist/index.js'

assert.ok(process.env.NAMZU_FOCUS_TRACE, 'Set NAMZU_FOCUS_TRACE to a temporary trace path')
ProviderRegistry.create = () => {
	const provider = new MockLLMProvider()
	provider.chatStream = async function* (params) {
		const planner = params.messages.length === 2 && String(params.messages[0]?.content).startsWith('Resolve a conversation-history search query.')
		const context = params.messages.filter((m) => m.source?.type === 'runtime-context' && m.source.kind === 'step-context').map((m) => m.content)
		let text
		if (planner) {
			const input = JSON.parse(params.messages[1].content)
			const row = input.tokens.find(([, text]) => text === 'SIGMA')
			assert.ok(row, 'The fixture requires an explicit SIGMA question')
			text = JSON.stringify({ mode: 'direct', time: 'past', termIds: [row[0]], focusIds: [row[0]], basis: [] })
		} else {
			assert.match(context.join('\n'), /"queryFocus":\{"terms":\["SIGMA"\]/)
			assert.doesNotMatch(context.join('\n'), /(?:CODE|NEW)-[0-9a-f-]+/)
			text = 'FOCUS VERIFIED: SIGMA. No other record code entered automatic context.'
		}
		await appendFile(process.env.NAMZU_FOCUS_TRACE, JSON.stringify({ planner, context, text }) + '\n')
		yield { id: 'focus-fixture', delta: { content: text } }
		yield { id: 'focus-fixture', delta: {}, finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 } }
	}
	return { provider }
}
