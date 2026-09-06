import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { TokenBudget, type TokenBudgetSnapshot } from '../../../run/token-budget.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

describe('caller cancellation with the stream idle watchdog disabled', () => {
	it('returns a cancelled run with persisted partial spend while the provider remains blocked', async () => {
		const caller = new AbortController()
		const runId = generateRunId()
		let saved: TokenBudgetSnapshot | undefined
		const budget = TokenBudget.create(1_000, runId, {
			save: async (snapshot) => {
				saved = snapshot
			},
		})
		let enter!: () => void
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let cleanup!: () => void
		const closed = new Promise<void>((resolve) => {
			cleanup = resolve
		})
		const provider: LLMProvider = {
			id: 'blocked',
			name: 'Blocked driver',
			async *chatStream() {
				try {
					yield {
						id: 'partial',
						delta: { content: 'retained answer' },
						usage: {
							promptTokens: 100,
							completionTokens: 20,
							totalTokens: 120,
							cachedTokens: 0,
							cacheWriteTokens: 0,
						},
					}
					enter()
					await held
				} finally {
					cleanup()
				}
			},
		}
		const events: RunEvent[] = []
		const pending = drainQuery(
			{
				runId,
				provider,
				budget,
				tools: new ToolRegistry(),
				runStore: new InMemoryRunStore(),
				checkpointStore: new InMemoryCheckpointStore(),
				projectId: generateProjectId(),
				sessionId: generateSessionId(),
				topicId: generateTopicId(),
				tenantId: generateTenantId(),
				workingDirectory: process.cwd(),
				agentId: 'cancellation-observer',
				agentName: 'Cancellation observer',
				messages: [{ role: 'user', content: 'answer' }],
				signal: caller.signal,
				runConfig: {
					model: 'mock',
					tokenBudget: 1_000,
					maxIterations: 2,
					timeoutMs: 10_000,
					streamIdleTimeoutMs: 0,
				},
			},
			(event) => {
				events.push(event)
			},
		)
		await entered
		caller.abort(new Error('operator stopped'))
		try {
			const run = await pending
			expect(run.status).toBe('cancelled')
			expect({
				runTokens: run.tokenUsage.totalTokens,
				budget: budget.summary(),
				saved,
			}).toMatchObject({
				runTokens: 120,
				budget: { ownTokens: 120, poisoned: true },
				saved: { poisoned: true },
			})
			expect(saved?.poisoned).toBe(true)
			expect(saved?.requests).toHaveLength(1)
			expect(saved?.requests[0]?.usage?.totalTokens).toBe(120)
			expect(saved?.completedRequests).toHaveLength(0)
			expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(1)
		} finally {
			release()
			await closed
			await pending.catch(() => {})
		}
	})
})
