import { describe, expect, it } from 'vitest'

import type { CompactionConfig } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import {
	type Message,
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type {
	PluginHookContext,
	PluginHookEvent,
	PluginHookResult,
} from '../../types/plugin/index.js'
import { asSessionId } from '../../utils/id.js'
import { type CompactionHookHost, CompactionRefusedError } from '../hooks.js'
import { compactNow, compactRegion } from '../manual.js'

/**
 * A pass a person asked for, an idle pass and a span a person chose fire
 * `pre_compact` and `post_compact` as an automatic one does, on the same
 * payload, which says who asked.
 */

const SESSION = asSessionId('0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b')

const config = (): CompactionConfig =>
	({
		strategy: 'structured',
		triggerThreshold: 0.7,
		keepRecentMessages: 4,
		clearToolResults: false,
		richStateThreshold: 100,
		llmVerification: false,
		maxCharsPerTask: 2_000,
	}) as CompactionConfig

function history(turns: number): Message[] {
	const out: Message[] = [createSystemMessage('you are a helper')]
	for (let i = 0; i < turns; i++) {
		out.push(createUserMessage(`question ${i}`))
		out.push(createAssistantMessage(`answer ${i}`))
	}
	return out
}

function host(answer: (event: PluginHookEvent) => PluginHookResult[] = () => []) {
	const calls: { event: PluginHookEvent; context: Partial<PluginHookContext> }[] = []
	const manager: CompactionHookHost = {
		executeHooks: async (event, context) => {
			calls.push({ event, context })
			return answer(event)
		},
	}
	return { manager, calls }
}

const provider = () => new MockLLMProvider({ turns: [{ text: 'a summary of the earlier turns' }] })

describe('a pass a person asked for', () => {
	it('fires pre_compact then post_compact with trigger manual and the typed instructions', async () => {
		const { manager, calls } = host()
		const result = await compactNow({
			messages: history(8),
			config: config(),
			provider: provider(),
			instructions: 'keep the failing tests',
			hooks: { manager, sessionId: SESSION },
		})
		expect(result).not.toBeNull()
		expect(calls.map((c) => c.event)).toEqual(['pre_compact', 'post_compact'])
		expect(calls[0]?.context.compaction).toMatchObject({
			reason: 'manual',
			trigger: 'manual',
			instructions: 'keep the failing tests',
		})
		expect(calls[0]?.context.sessionId).toBe(SESSION)
		expect(calls[1]?.context.compaction).toMatchObject({ trigger: 'manual' })
		expect(typeof calls[1]?.context.compaction?.summary).toBe('string')
		expect(typeof calls[1]?.context.compaction?.tokensAfter).toBe('number')
		expect(typeof calls[1]?.context.compaction?.tokensBefore).toBe('number')
	})

	it('sends null instructions when the person typed none', async () => {
		const { manager, calls } = host()
		await compactNow({
			messages: history(8),
			config: config(),
			provider: provider(),
			hooks: { manager, sessionId: SESSION },
		})
		expect(calls[0]?.context.compaction?.instructions).toBeNull()
	})

	it('is refused by a pre_compact hook: nothing is summarised and the reason is thrown', async () => {
		const { manager, calls } = host(() => [{ action: 'skip', reason: 'release freeze' }])
		const p = provider()
		const run = compactNow({
			messages: history(8),
			config: config(),
			provider: p,
			hooks: { manager, sessionId: SESSION },
		})
		await expect(run).rejects.toBeInstanceOf(CompactionRefusedError)
		await expect(run).rejects.toMatchObject({ reason: 'release freeze' })
		expect(calls.map((c) => c.event)).toEqual(['pre_compact'])
		expect(p.requests).toHaveLength(0)
	})

	it('does not fire a hook for a history with nothing to compact', async () => {
		const { manager, calls } = host()
		const result = await compactNow({
			messages: history(1),
			config: config(),
			provider: provider(),
			hooks: { manager, sessionId: SESSION },
		})
		expect(result).toBeNull()
		expect(calls).toEqual([])
	})

	it('fires for a chosen span too', async () => {
		const { manager, calls } = host()
		const result = await compactRegion({
			messages: history(8),
			start: 1,
			end: 9,
			config: config(),
			provider: provider(),
			hooks: { manager, sessionId: SESSION },
		})
		expect(result).not.toBeNull()
		expect(calls.map((c) => c.event)).toEqual(['pre_compact', 'post_compact'])
		expect(calls[0]?.context.compaction?.trigger).toBe('manual')
	})

	it('keeps the pass when a post_compact hook fails', async () => {
		const manager: CompactionHookHost = {
			executeHooks: async (event) => {
				if (event === 'post_compact') throw new Error('hook crashed')
				return []
			},
		}
		const result = await compactNow({
			messages: history(8),
			config: config(),
			provider: provider(),
			hooks: { manager, sessionId: SESSION },
		})
		expect(result).not.toBeNull()
	})
})

describe('an idle pass', () => {
	it('is an auto trigger with null instructions', async () => {
		const { manager, calls } = host()
		await compactNow({
			messages: history(8),
			config: config(),
			provider: provider(),
			instructions: 'ignored for an idle pass',
			hooks: { manager, sessionId: SESSION, trigger: 'idle' },
		})
		expect(calls[0]?.context.compaction).toMatchObject({ trigger: 'auto', instructions: null })
		expect(calls[1]?.context.compaction).toMatchObject({ trigger: 'auto' })
	})

	it('is cancelled quietly by a refusal', async () => {
		const { manager, calls } = host(() => [{ action: 'skip', reason: 'later' }])
		const p = provider()
		const result = await compactNow({
			messages: history(8),
			config: config(),
			provider: p,
			hooks: { manager, sessionId: SESSION, trigger: 'idle' },
		})
		expect(result).toBeNull()
		expect(calls.map((c) => c.event)).toEqual(['pre_compact'])
		expect(p.requests).toHaveLength(0)
	})
})

describe('what a pre_compact hook prints reaches the summariser', () => {
	const hookAnswer = (event: PluginHookEvent): PluginHookResult[] =>
		event === 'pre_compact' ? [{ action: 'annotate', text: 'keep ticket 4242 verbatim' }] : []

	it('joins the person’s instructions and the hook’s, hook last and framed', async () => {
		const { manager } = host(hookAnswer)
		const p = provider()
		await compactNow({
			messages: history(8),
			config: config(),
			provider: p,
			instructions: 'keep the failing tests',
			hooks: { manager, sessionId: SESSION },
		})
		const sent = p.requests.map((r) => JSON.stringify(r.messages)).join('\n')
		expect(sent).toContain('keep the failing tests')
		expect(sent).toContain("Context from the operator's hooks:")
		expect(sent).toContain('keep ticket 4242 verbatim')
		expect(sent.indexOf('keep the failing tests')).toBeLessThan(
			sent.indexOf('keep ticket 4242 verbatim'),
		)
	})

	it('runs the model step for a hook’s words even with no person instructions', async () => {
		const { manager } = host(hookAnswer)
		const p = provider()
		await compactNow({
			messages: history(8),
			config: config(),
			provider: p,
			hooks: { manager, sessionId: SESSION },
		})
		expect(p.requests.length).toBeGreaterThan(0)
	})

	it('reads several hooks in answer order and takes context beside a continue', async () => {
		const { manager } = host((event) =>
			event === 'pre_compact'
				? [
						{ action: 'continue', context: 'first' },
						{ action: 'annotate', text: 'second' },
					]
				: [],
		)
		const p = provider()
		await compactNow({
			messages: history(8),
			config: config(),
			provider: p,
			hooks: { manager, sessionId: SESSION },
		})
		const sent = p.requests.map((r) => JSON.stringify(r.messages)).join('\n')
		expect(sent.indexOf('first')).toBeLessThan(sent.indexOf('second'))
	})
})
