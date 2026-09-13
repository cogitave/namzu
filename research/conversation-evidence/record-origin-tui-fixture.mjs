// Offline transport assertion for a seeded conflict conversation. No live provider request.
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { MockLLMProvider, ProviderRegistry } from '../../packages/sdk/dist/index.js'

assert.ok(process.env.NAMZU_ORIGIN_TRACE, 'Set NAMZU_ORIGIN_TRACE to a temporary trace path')
ProviderRegistry.create = () => {
	const provider = new MockLLMProvider()
	provider.chatStream = async function* (params) {
		const context = params.messages
			.filter(message => message.source?.type === 'runtime-context' && message.source.kind === 'step-context')
			.map(message => message.content).join('\n')
		const records = context.split('\n').filter(line => line.startsWith('{"runId":')).map(JSON.parse)
		assert.ok(records.some(record => record.recordKind === 'tool_result' && record.source === 'tool_completed'))
		assert.ok(records.some(record => record.recordKind === 'assistant_message' && record.source === 'message_completed'))
		assert.match(context, /not proof of observed state or successful action/)
		assert.ok(records.every(record => record.excerptComplete === true))
		assert.match(context, /Reading that unchanged part adds no text or independent support/)
		await appendFile(process.env.NAMZU_ORIGIN_TRACE, JSON.stringify({ context, records }) + '\n')
		yield { id: 'origin-fixture', delta: { content: 'Whole-part coverage verified: assistant claims and tool results remain separate.' } }
		yield { id: 'origin-fixture', delta: {}, finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 } }
	}
	return { provider }
}
