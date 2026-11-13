import { describe, expect, it, vi } from 'vitest'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import { MockLLMProvider } from '../../../../provider/mock.js'
import type { Message } from '../../../../types/message/index.js'
import type {
	PluginHookContext,
	PluginHookEvent,
	PluginHookResult,
} from '../../../../types/plugin/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * What an automatic pass tells `pre_compact` and `post_compact` (`trigger`,
 * the typed instructions, the summary), and where a hook's words go.
 */

function turn(answer: (event: PluginHookEvent) => PluginHookResult[], reducer?: boolean) {
	const config = CompactionConfigSchema.parse({
		strategy: 'salience',
		contextWindowTokens: 2_000,
		triggerThreshold: 0.7,
		resetThreshold: 0.4,
		keepRecentMessages: 2,
		clearToolResults: false,
		keepRecentToolResults: 0,
		llmVerification: false,
	})
	const manager = new WorkingStateManager(config)
	manager.setTask('Repair the configuration without changing its tenant.')
	for (let i = 0; i < 5; i++) manager.addDecision(`Decision ${i}: keep the originating job.`)
	const messages: Message[] = [
		{ role: 'system', content: 'Standing policy. '.repeat(360) },
		{ role: 'user', content: 'Historical details. '.repeat(500) },
		{ role: 'assistant', content: 'old reply' },
		{ role: 'user', content: 'current task' },
		{ role: 'assistant', content: 'working' },
	]
	const contexts: { event: PluginHookEvent; context: Partial<PluginHookContext> }[] = []
	const provider = new MockLLMProvider({ turns: [{ text: '- the ticket number 4242' }] })
	const ctx = {
		turnConfig: { model: 'mock', tokenBudget: 0 },
		compactionConfig: config,
		workingStateManager: manager,
		provider,
		tools: { toLLMTools: () => [] },
		log: NOOP_LOGGER,
		abortController: new AbortController(),
		...(reducer
			? { contextReducer: async (r: { messages: readonly Message[] }) => r.messages.slice(-2) }
			: {}),
		pluginManager: {
			executeHooks: vi.fn(async (event: PluginHookEvent, context: Partial<PluginHookContext>) => {
				contexts.push({ event, context })
				return answer(event)
			}),
		},
		recorder: {
			id: '38adc63f-8628-4f78-8554-036c8d7a57a0',
			sessionId: 's',
			turnId: 't',
			currentIteration: 1,
			messages,
			lastPromptTokens: 1_900,
			lastPromptMessageCount: messages.length,
			clearLastPromptTokens: vi.fn(),
			accumulateUsage: vi.fn(),
		},
		emitEvent: async () => {},
	} as unknown as IterationContext
	return { ctx, contexts, provider }
}

const sent = (provider: MockLLMProvider) =>
	provider.requests.map((r) => JSON.stringify(r.messages)).join('\n')

describe('the payload of an automatic pass', () => {
	it('says auto, with no typed instructions, and carries the summary on post_compact', async () => {
		const { ctx, contexts } = turn(() => [])
		await runCompactionCheck(ctx)
		const [pre, post] = contexts
		expect(pre?.event).toBe('pre_compact')
		expect(pre?.context.compaction).toMatchObject({
			reason: 'threshold',
			trigger: 'auto',
			instructions: null,
		})
		expect(post?.context.compaction).toMatchObject({ reason: 'threshold', trigger: 'auto' })
		expect(typeof post?.context.compaction?.summary).toBe('string')
	})

	it('says auto for a pass the provider forced, and that one cannot be refused', async () => {
		const { ctx, contexts } = turn((e) =>
			e === 'pre_compact' ? [{ action: 'skip', reason: 'no' }] : [],
		)
		await runCompactionCheck(ctx, { force: true })
		expect(contexts.map((c) => c.event)).toEqual(['pre_compact', 'post_compact'])
		expect(contexts[0]?.context.compaction).toMatchObject({ reason: 'overflow', trigger: 'auto' })
	})
})

describe('what a pre_compact hook prints, on an automatic pass', () => {
	const printing = (event: PluginHookEvent): PluginHookResult[] =>
		event === 'pre_compact' ? [{ action: 'annotate', text: 'keep ticket 4242' }] : []

	it('reaches the summariser, framed as a hook’s', async () => {
		const { ctx, provider } = turn(printing)
		await runCompactionCheck(ctx)
		expect(sent(provider)).toContain("Context from the operator's hooks:")
		expect(sent(provider)).toContain('keep ticket 4242')
	})

	it('is heard on a forced pass even when the same hook refused', async () => {
		const { ctx, provider } = turn((e) =>
			e === 'pre_compact' ? [{ action: 'skip', reason: 'no', context: 'keep ticket 4242' }] : [],
		)
		await runCompactionCheck(ctx, { force: true })
		expect(sent(provider)).toContain('keep ticket 4242')
	})

	it('has no place to go when a context reducer owns the pass: the pass runs, no summary is asked for', async () => {
		const { ctx, provider, contexts } = turn(printing, true)
		await runCompactionCheck(ctx)
		expect(provider.requests).toHaveLength(0)
		expect(contexts.map((c) => c.event)).toEqual(['pre_compact', 'post_compact'])
		expect(contexts[1]?.context.compaction?.summary).toBeUndefined()
	})
})
