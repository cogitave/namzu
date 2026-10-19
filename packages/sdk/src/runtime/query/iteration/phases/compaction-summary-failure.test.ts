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
import { compactionErrorNote, relieveOverflow } from './compaction.js'
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
})
