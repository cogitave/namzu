/**
 * What the operator sees when their run changes hands, and what a sub-agent
 * does NOT inherit.
 *
 * The swap itself is the kernel's, and it is proven there. These two properties
 * are the CLI's own and neither is visible from the SDK: a swap nobody is told
 * about is the defect this feature would otherwise introduce, and a sub-agent
 * silently acquiring its parent's chain is the way that defect would come back
 * through a side door.
 */

import { describe, expect, it, vi } from 'vitest'

import {
	type AgentDefinition,
	AgentRegistry,
	type LLMProvider,
	LocalTaskScheduler,
	type RunEvent,
} from '@namzu/sdk'

import { createSubagentRuntime } from '../../integrations/subagents/runtime.js'
import { toAgentEvent } from '../agent.js'

function fallbackEvent(over: Partial<Record<string, unknown>> = {}): RunEvent {
	return {
		type: 'provider_fallback',
		runId: 'run_1',
		iteration: 2,
		fromIndex: 0,
		fromProviderId: 'anthropic',
		fromModel: 'claude-opus-4-7',
		toIndex: 1,
		toProviderId: 'openai',
		toModel: 'gpt-4o',
		code: 'rate_limit',
		status: 429,
		...over,
	} as unknown as RunEvent
}

describe('the operator is told, every time', () => {
	it('names the member that failed, why, and the member now serving', () => {
		const mapped = toAgentEvent(fallbackEvent())

		expect(mapped?.kind).toBe('provider-fallback')
		const text = (mapped as { text: string }).text

		// The member that FAILED, by the same position name the preferences file
		// and the doctor use. Naming only the replacement leaves an operator with
		// four declared members unable to tell which one went down.
		expect(text).toContain('primary provider')
		expect(text).toContain('Anthropic (Claude)')
		expect(text).toContain('claude-opus-4-7')

		// Why.
		expect(text).toContain('rate limited')
		expect(text).toContain('429')

		// And who is serving now.
		expect(text).toContain('fallback #1')
		expect(text).toContain('OpenAI')
		expect(text).toContain('gpt-4o')
	})

	it('still says something useful for a code it has no sentence for', () => {
		const text = (toAgentEvent(fallbackEvent({ code: 'some_new_code' })) as { text: string }).text
		expect(text).toContain('some_new_code')
		expect(text).toContain('fallback #1')
	})

	// A swap is not an error and must not close the assistant message or be
	// rendered as a failure — the run continues.
	it('is not an error event', () => {
		expect(toAgentEvent(fallbackEvent())?.kind).not.toBe('error')
	})
})

describe('a sub-agent resolves its provider independently', () => {
	it('is built with exactly the provider it was handed, never a chain', async () => {
		const registered: AgentDefinition[] = []
		vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation((def) => {
			for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
		})
		vi.spyOn(LocalTaskScheduler.prototype, 'createTask').mockResolvedValue({
			taskId: 'tsk_1',
		} as never)

		// A marked object, so the assertion is about IDENTITY. That is the whole
		// design of this test: `withProviderFallback` returns a NEW object for a
		// multi-member chain, so an edit that threaded the parent's chain into the
		// child would hand over a different object and this fails — where an
		// assertion on `provider.id` would pass, because the wrapper reports the
		// head's id on purpose.
		const own = { id: 'anthropic', name: 'own' } as unknown as LLMProvider
		await createSubagentRuntime({
			cwd: '/tmp',
			model: 'test-model',
			buildProvider: () => own,
			buildTools: () => ({}) as never,
		})

		const definition = registered.find((d) => typeof d.configBuilder === 'function')
		expect(definition).toBeDefined()
		const config = (await definition?.configBuilder?.({} as never)) as unknown as {
			provider: LLMProvider
			fallbackProviders?: unknown
		}

		expect(config.provider).toBe(own)
		// And no chain reached the child by any other name.
		expect(config.fallbackProviders).toBeUndefined()

		vi.restoreAllMocks()
	})
})
