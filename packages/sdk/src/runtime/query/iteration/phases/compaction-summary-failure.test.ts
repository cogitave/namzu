import { describe, expect, it } from 'vitest'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { estimateMessagesTokens } from '../../../../compaction/token-estimate.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import {
	type Message,
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../../../types/message/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { compactionErrorNote, deepenConfig, relieveOverflow } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * The verifier only ADDS to the extracted state. When its model call fails the
 * pass used to throw out of the overflow handler and replace the overflow with
 * the verifier's own error; it now relieves with the extracted state alone and
 * keeps the cause for the failure it may still end on.
 */
describe('a failed summary call does not stop relief', () => {
	it('sheds with the extracted state alone and remembers the cause', async () => {
		const config = CompactionConfigSchema.parse({
			strategy: 'structured',
			llmVerification: true,
			contextWindowTokens: 1_000_000,
			keepRecentMessages: 2,
		})
		const manager = new WorkingStateManager(config)
		manager.setTask('keep going')
		const messages: Message[] = [createSystemMessage('floor')]
		for (let i = 0; i < 8; i++) {
			messages.push(createUserMessage(`q${i} ${'x'.repeat(4_000)}`))
			messages.push(createAssistantMessage(`a${i} ${'y'.repeat(4_000)}`))
		}
		messages.push(createUserMessage('now'))
		const before = estimateMessagesTokens(messages)
		const ctx = {
			turnConfig: { model: 'mock', tokenBudget: 0 },
			compactionConfig: config,
			workingStateManager: manager,
			provider: {
				id: 'mock',
				name: 'mock',
				chatStream: () => {
					throw new Error('summary backend down')
				},
			},
			abortController: new AbortController(),
			log: NOOP_LOGGER,
			tools: { toLLMTools: () => [] },
			recorder: {
				id: '37ddff8e-e13f-4e57-937f-d048fa323f5e',
				currentIteration: 3,
				messages,
				lastPromptTokens: undefined,
				lastPromptMessageCount: undefined,
				clearLastPromptTokens: () => {},
				accumulateUsage: () => {},
			},
			emitEvent: async () => {},
		} as unknown as IterationContext

		await expect(relieveOverflow(ctx)).resolves.toBe(true)
		expect(estimateMessagesTokens(messages)).toBeLessThan(before / 2)
		expect(compactionErrorNote(ctx)).toBe('summary backend down')
	})

	it('reports the cause of the last rung that ran, not an earlier one', async () => {
		const config = CompactionConfigSchema.parse({
			strategy: 'structured',
			llmVerification: true,
			contextWindowTokens: 1_000_000,
			keepRecentMessages: 2,
		})
		const manager = new WorkingStateManager(config)
		manager.setTask('keep going')
		const messages: Message[] = [createSystemMessage('floor')]
		for (let i = 0; i < 12; i++) {
			messages.push(createUserMessage(`q${i} ${'x'.repeat(4_000)}`))
			messages.push(createAssistantMessage(`a${i} ${'y'.repeat(4_000)}`))
		}
		messages.push(createUserMessage('now'))
		let down = true
		const ctx = {
			turnConfig: { model: 'mock', tokenBudget: 0 },
			compactionConfig: config,
			workingStateManager: manager,
			provider: {
				id: 'mock',
				name: 'mock',
				chatStream: () => {
					if (down) throw new Error('summary backend down')
					return (async function* () {
						yield { id: 'r', delta: { content: 'COMPLETE' }, finishReason: 'stop' }
					})()
				},
			},
			abortController: new AbortController(),
			log: NOOP_LOGGER,
			tools: { toLLMTools: () => [] },
			recorder: {
				id: '37ddff8e-e13f-4e57-937f-d048fa323f5e',
				currentIteration: 3,
				messages,
				lastPromptTokens: undefined,
				lastPromptMessageCount: undefined,
				clearLastPromptTokens: () => {},
				accumulateUsage: () => {},
			},
			emitEvent: async () => {},
		} as unknown as IterationContext

		await relieveOverflow(ctx)
		expect(compactionErrorNote(ctx)).toBe('summary backend down')
		down = false
		for (let i = 0; i < 4; i++) {
			messages.push(createAssistantMessage(`more ${i} ${'z'.repeat(4_000)}`))
			messages.push(createUserMessage(`again ${i} ${'w'.repeat(4_000)}`))
		}
		await relieveOverflow(ctx, { deeper: true })
		expect(compactionErrorNote(ctx)).toBeUndefined()
	})
})

describe('the deeper rung never keeps more than the first rung did', () => {
	const config = CompactionConfigSchema.parse({ keepRecentMessages: 6 })
	const history = (tail: number): Message[] => {
		const out: Message[] = [createSystemMessage('floor')]
		for (let i = 0; i < 4; i++) {
			out.push(createUserMessage(`q${i}`), createAssistantMessage(`a${i}`))
		}
		out.push(createAssistantMessage('last'))
		for (let i = 0; i < tail; i++) out.push(createUserMessage(`tail ${i}`))
		return out
	}

	it('shrinks to the newest group when that is smaller', () => {
		expect(deepenConfig(config, history(1)).keepRecentMessages).toBe(2)
	})

	it('keeps the configured window when the newest group is bigger', () => {
		expect(deepenConfig(config, history(20)).keepRecentMessages).toBe(6)
	})

	it('applies the same rule to a token window', () => {
		const tokens = CompactionConfigSchema.parse({ keepRecentTokens: 20 })
		const big = history(20)
		expect(deepenConfig(tokens, big).keepRecentTokens).toBe(20)
		const small = deepenConfig(tokens, history(1)).keepRecentTokens
		expect(small).toBeLessThan(20)
	})

	it('clears tool results inside the window either way', () => {
		expect(deepenConfig(config, history(20)).keepRecentToolResults).toBe(0)
	})
})
