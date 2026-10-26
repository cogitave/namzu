import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	parseBedrockUsage,
	supportsOneHourCache,
	toBedrockMessages,
	toBedrockToolConfig,
} from '../client.js'

/**
 * The one-hour cache point is sent only when asked for and only to a model
 * that accepts it; the usage reports the lifetime the service wrote.
 */

const params: ChatCompletionParams = {
	model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
	messages: [{ role: 'user', content: 'hi' }],
	tools: [
		{
			type: 'function',
			function: {
				name: 'look',
				description: 'd',
				parameters: { type: 'object', properties: {} },
			},
		},
	],
}

describe('cache lifetime on the Converse wire', () => {
	it('knows which models accept a one-hour point', () => {
		expect(supportsOneHourCache('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true)
		expect(supportsOneHourCache('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true)
		expect(supportsOneHourCache('us.anthropic.claude-opus-4-7-v1:0')).toBe(true)
		expect(supportsOneHourCache('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(false)
		expect(supportsOneHourCache('anthropic.claude-sonnet-4-20250514-v1:0')).toBe(false)
		expect(supportsOneHourCache('amazon.nova-pro-v1:0')).toBe(false)
	})

	it('sets the lifetime on the history and tool points when asked, and not otherwise', () => {
		const plain = toBedrockMessages(params.messages, { cachePoint: true })
		expect(JSON.stringify(plain)).toContain('"cachePoint":{"type":"default"}')
		expect(JSON.stringify(plain)).not.toContain('ttl')
		const longer = toBedrockMessages(params.messages, {
			cachePoint: true,
			cacheTtl: '1h',
		})
		expect(JSON.stringify(longer)).toContain('"cachePoint":{"type":"default","ttl":"1h"}')
		const tools = toBedrockToolConfig(params, true, '1h')
		expect(JSON.stringify(tools)).toContain('"ttl":"1h"')
		expect(JSON.stringify(toBedrockToolConfig(params, true))).not.toContain('ttl')
	})

	it('reports the lifetime from the write breakdown, else the requested one', () => {
		const written = parseBedrockUsage(
			{
				cacheWriteInputTokenCount: 30,
				cacheDetails: [{ ttl: '1h', inputTokens: 30 }],
			},
			'1h',
		)
		expect(written.cacheTtlMs).toBe(3_600_000)
		expect(written.cacheWriteTtlTokens).toEqual({ oneHour: 30 })
		const downgraded = parseBedrockUsage({ cacheDetails: [{ ttl: '5m', inputTokens: 30 }] }, '1h')
		expect(downgraded.cacheTtlMs).toBe(300_000)
		expect(parseBedrockUsage({ cacheReadInputTokenCount: 5 }, '1h').cacheTtlMs).toBe(3_600_000)
		expect(parseBedrockUsage({ inputTokens: 5 }).cacheTtlMs).toBeUndefined()
	})
})
