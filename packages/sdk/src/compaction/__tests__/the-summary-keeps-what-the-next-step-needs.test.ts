import { describe, expect, it } from 'vitest'

import type { CompactionConfig } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import type { Message } from '../../types/message/index.js'
import { extractFromAssistantMessage, extractFromUserMessage } from '../extractor.js'
import { WorkingStateManager } from '../manager.js'
import { serializeState } from '../serializer.js'
import { buildVerifiedSummary } from '../verifier.js'

/**
 * After a compaction the summary is all the next step has. It keeps what is
 * still open (unresolved errors, what comes next) and the exact names and
 * values the next step needs, and it asks the verifier for everything it
 * lacks, because trimming can happen later and a gap cannot be recovered.
 */

function config(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
	return {
		strategy: 'structured',
		resetThreshold: 0.4,
		keepRecentMessages: 4,
		clearToolResults: true,
		keepRecentToolResults: 3,
		minToolResultCharsToClear: 1_000,
		maxToolResults: 30,
		maxListSize: 25,
		keepFirstEntries: 3,
		llmVerification: true,
		llmVerificationMaxTokens: 2048,
		richStateThreshold: 15,
		convoTextBudget: 12_000,
		maxSentencesPerTurn: 5,
		maxCharsPerNote: 500,
		maxCharsPerRequirement: 300,
		maxCharsPerTask: 400,
		...overrides,
	} as CompactionConfig
}

describe('the verifier asks for what the next step needs', () => {
	it('names unresolved errors, open items and exact values, and asks for everything missing', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })
		const older: Message[] = [{ role: 'user', content: 'port the loader' }]
		await buildVerifiedSummary(
			new WorkingStateManager(config()),
			older,
			provider,
			config(),
			undefined,
			'm',
		)
		const system = String(provider.requests[0]?.messages[0]?.content)
		expect(system).toContain('Unresolved errors, bugs and open questions')
		expect(system).toContain('Open items and the step that comes next')
		expect(system).toContain('Specific names, values and commands the next step needs')
		expect(system).toContain('list everything missing')
		expect(system).toContain('trimming happens later')
		expect(system).not.toMatch(/\b[A-Z]{4,}\b(?<!COMPLETE)/)
	})
})

describe('the summary template', () => {
	function stateAfter(turns: ReadonlyArray<readonly ['user' | 'assistant', string]>) {
		const manager = new WorkingStateManager(config())
		let first = true
		for (const [role, text] of turns) {
			if (role === 'user') {
				extractFromUserMessage(manager, text, first)
				first = false
			} else {
				extractFromAssistantMessage(manager, text, config())
			}
		}
		return manager
	}

	it('puts what is still to do in its own section, last, apart from the narration', () => {
		const manager = stateAfter([
			['user', 'Port the loader to the new store.'],
			['assistant', 'I will implement the loader next in src/loader.ts and then add tests.'],
			['assistant', 'The store keeps one row per revision.'],
		])
		const text = serializeState(manager.getState())
		const open = text.indexOf('## Open Items and Next Step')
		expect(open).toBeGreaterThan(-1)
		expect(text.slice(open)).toContain('src/loader.ts')
		// Narration stays where it was, and the next step is not filed under it.
		const notes = text.slice(text.indexOf('## Assistant Notes'), open)
		expect(notes).toContain('one row per revision')
		expect(notes).not.toContain('src/loader.ts')
		expect(text.indexOf('## Open Items and Next Step')).toBe(text.lastIndexOf('## '))
	})

	it('drops a note that only says the code was looked at', () => {
		const manager = stateAfter([
			['user', 'Port the loader.'],
			['assistant', 'We looked at the code. The loader reads rows lazily.'],
		])
		const text = serializeState(manager.getState())
		expect(text).not.toContain('We looked at the code.')
		expect(text).toContain('The loader reads rows lazily.')
	})

	it('marks the latest request without repeating it', () => {
		const manager = stateAfter([
			['user', 'Port the loader.'],
			['user', 'Then also rename the store.'],
			['user', 'Keep the migration reversible.'],
		])
		const text = serializeState(manager.getState())
		expect(text).toContain('- Latest request: Keep the migration reversible.')
		expect(text.split('Keep the migration reversible.')).toHaveLength(2)
		expect(text).not.toContain('Latest request: Then also')
	})

	it('writes no section for what is not there', () => {
		const text = serializeState(stateAfter([['user', 'Port the loader.']]).getState())
		expect(text).not.toContain('## Open Items and Next Step')
		expect(text).not.toContain('Latest request')
	})

	it('keeps an unresolved error with its exact text', () => {
		const manager = new WorkingStateManager(config())
		manager.addFailure('bash: ENOENT: no such file or directory, open ./data/store-v2.db')
		const text = serializeState(manager.getState())
		expect(text).toContain('## Errors & Failures')
		expect(text).toContain('ENOENT: no such file or directory, open ./data/store-v2.db')
	})
})
