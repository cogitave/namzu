import { describe, expect, it } from 'vitest'

import type { AgentInput, BaseAgentConfig, BaseAgentResult } from '../../types/agent/index.js'
import { defineAgent } from '../defineAgent.js'

describe('application-owned agent shell', () => {
	it('accepts a host type and isolates cancellation between delegated turns', async () => {
		const signals: AbortSignal[] = []
		const agent = defineAgent({
			type: 'inventory-reviewer',
			id: 'reviewer',
			name: 'Reviewer',
			version: '1.0.0',
			category: 'inventory',
			description: 'Reviews inventory.',
			async run(_input, _config, _listener, signal): Promise<BaseAgentResult> {
				signals.push(signal)
				return {} as BaseAgentResult
			},
		})
		const child = agent.forTurn?.()
		expect(child).toBeDefined()
		expect(child).not.toBe(agent)
		expect(child?.type).toBe('inventory-reviewer')
		const input = { messages: [] } as unknown as AgentInput
		const config = { model: 'mock', tokenBudget: 100, timeoutMs: 1000 } as BaseAgentConfig
		await agent.run(input, config)
		await child?.run(input, config)
		await child?.cancel()
		expect(signals).toHaveLength(2)
		expect(signals[0]?.aborted).toBe(false)
		expect(signals[1]?.aborted).toBe(true)
	})
})
