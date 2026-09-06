import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { createAssistantMessage, createUserMessage } from '../../types/message/index.js'
import { extractFromAssistantMessage } from '../extractor.js'
import { WorkingStateManager } from '../manager.js'
import { compactNow } from '../manual.js'

const config = CompactionConfigSchema.parse({
	strategy: 'structured',
	llmVerification: false,
	keepRecentMessages: 2,
	clearToolResults: false,
})

describe('extractive summaries keep substantive statements with their source', () => {
	it('preserves negative constraints and explicitly stated decisions through a real compaction', async () => {
		const provider = new MockLLMProvider()
		const result = await compactNow({
			provider,
			config,
			messages: [
				createUserMessage('Choose a database'),
				createAssistantMessage(
					'Okay. No production writes are allowed. Node 24 is installed. I will not deploy without approval. The decision is PostgreSQL.',
				),
				createUserMessage('Continue the investigation'),
				createAssistantMessage('The schema contains two tables.'),
				createUserMessage('What happens next?'),
				createAssistantMessage('Ready to continue.'),
			],
		})

		expect(result?.shed).toBeGreaterThan(0)
		const summary = String(result?.summary.content)
		expect(summary).toContain('No production writes are allowed.')
		expect(summary).toContain('Node 24 is installed.')
		expect(summary).toContain('I will not deploy without approval.')
		expect(summary).toContain('## Key Decisions')
		expect(summary).toContain('Assistant stated: The decision is PostgreSQL.')
		expect(summary).not.toContain('Okay.')
		expect(provider.requests).toHaveLength(0)
	})

	it('keeps suggestions and third-party statements out of the decision slot', () => {
		const manager = new WorkingStateManager(config)
		extractFromAssistantMessage(
			manager,
			'Maybe we should use SQLite. The user decided to use Redis. If we decide to migrate, tests must pass. We decided to use PostgreSQL.',
			config,
		)

		expect(manager.getState().decisions).toEqual([
			'Assistant stated: We decided to use PostgreSQL.',
		])
		expect(manager.getState().userRequirements).toEqual([])
		expect(manager.getState().assistantNotes).toContain('The user decided to use Redis.')
	})

	it('marks requirement loss within the configured bound, without cutting a surrogate pair', () => {
		const manager = new WorkingStateManager(config)
		manager.addUserRequirement(`${'x'.repeat(286)}🧾DO_NOT_LOSE_THE_TAIL`)
		const requirement = manager.getState().userRequirements[0] ?? ''

		expect(requirement.length).toBeLessThanOrEqual(config.maxCharsPerRequirement)
		expect(requirement).toMatch(/… \[truncated\]$/)
		expect(requirement).not.toContain('DO_NOT_LOSE_THE_TAIL')
		expect(requirement).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
	})

	it('bounds attributed decisions without disguising a partial statement as complete', () => {
		const bounded = CompactionConfigSchema.parse({ maxCharsPerNote: 80 })
		const manager = new WorkingStateManager(bounded)
		extractFromAssistantMessage(
			manager,
			`We decided to use PostgreSQL because ${'a detailed reason '.repeat(40)}`,
			bounded,
		)
		const decision = manager.getState().decisions[0] ?? ''
		expect(decision).toMatch(/^Assistant stated: We decided to use PostgreSQL/)
		expect(decision).toMatch(/… \[truncated\]$/)
		expect(decision.length).toBeLessThanOrEqual(80)
	})

	it('leaves complete requirements unchanged and admits truncation with a tiny budget', () => {
		const manager = new WorkingStateManager(
			CompactionConfigSchema.parse({ maxCharsPerRequirement: 1 }),
		)
		manager.addUserRequirement('A')
		manager.addUserRequirement('An instruction that cannot fit')
		expect(manager.getState().userRequirements).toEqual(['A', '…'])
	})
})
