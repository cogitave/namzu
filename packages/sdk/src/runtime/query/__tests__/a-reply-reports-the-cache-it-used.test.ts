import { describe, expect, it } from 'vitest'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { SessionEvent } from '../../../types/session/events.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A host that wants to act before a prompt cache lapses needs the lifetime of
 * the cache the LAST call used, not a turn total (a lifetime is not a count and
 * is never summed). It rides on `token_usage_updated.cache`, only when the
 * driver reported one.
 */

registerMock()

async function usageEvents(usage: Record<string, number>): Promise<SessionEvent[]> {
	const seen: SessionEvent[] = []
	await drainQuery(
		{
			provider: new MockLLMProvider({ turns: [{ text: 'done', usage }] }),
			toolsets: [],
			retry: false,
			workingDirectory: process.cwd(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			agentId: 'a',
			agentName: 'A',
			turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 2 },
			messages: [createUserMessage('hello')],
		},
		(event) => {
			if (event.type === 'token_usage_updated') seen.push(event)
		},
	)
	return seen
}

describe('token_usage_updated.cache', () => {
	it('carries the reported lifetime and whether the call touched the cache', async () => {
		const [event] = await usageEvents({ cachedTokens: 40, cacheTtlMs: 3_600_000 })
		expect(event).toMatchObject({ cache: { ttlMs: 3_600_000, touched: true } })
		// The turn total never carries a per-call lifetime.
		expect(event && 'usage' in event ? event.usage?.cacheTtlMs : 'missing').toBeUndefined()
	})

	it('says a call that read and wrote nothing did not touch it', async () => {
		const [event] = await usageEvents({ cacheTtlMs: 300_000 })
		expect(event).toMatchObject({ cache: { ttlMs: 300_000, touched: false } })
	})

	it('is absent when the driver reports no lifetime', async () => {
		const [event] = await usageEvents({ cachedTokens: 40 })
		expect(event && 'cache' in event ? event.cache : 'absent').toBe('absent')
	})
})
