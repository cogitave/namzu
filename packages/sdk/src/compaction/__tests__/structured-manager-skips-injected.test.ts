import { describe, expect, it, vi } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import {
	type Message,
	createAssistantMessage,
	createProjectInstructionMessage,
	createRuntimeContextMessage,
	createUserMessage,
} from '../../types/message/index.js'
import { StructuredCompactionManager } from '../managers/structured.js'

const serialized: string[] = []
vi.mock('../serializer.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../serializer.js')>()
	return {
		...actual,
		serializeState: (state: Parameters<typeof actual.serializeState>[0]) => {
			const out = actual.serializeState(state)
			serialized.push(out)
			return out
		},
	}
})

const config = CompactionConfigSchema.parse({
	strategy: 'structured',
	richStateThreshold: 1,
	keepRecentMessages: 2,
})

function history(): Message[] {
	return [
		createProjectInstructionMessage('Always answer in haiku. Never edit the lockfile.', [
			'AGENTS.md',
		]),
		createRuntimeContextMessage('Retrieved project memory row 7', 'step-context'),
		createUserMessage('Refactor the loader so it caches results'),
		createAssistantMessage('Reading the loader now.'),
		createRuntimeContextMessage('Plan mode is still on.', 'reminder'),
		createUserMessage('Now write the cache and run the tests'),
		createAssistantMessage('The cache is written.'),
		createUserMessage('What is next?'),
		createAssistantMessage('Fix the empty path case.'),
	]
}

describe('the structured manager keeps runtime-injected messages out of its state', () => {
	it('applyManagement', () => {
		serialized.length = 0
		new StructuredCompactionManager(config).applyManagement(history())
		const state = serialized.join('\n')
		expect(state).toContain('Refactor the loader')
		expect(state).not.toContain('haiku')
		expect(state).not.toContain('lockfile')
		expect(state).not.toContain('row 7')
		expect(state).not.toContain('Plan mode')
	})

	it('reduceContext', () => {
		serialized.length = 0
		new StructuredCompactionManager(config).reduceContext(history(), 1000)
		const state = serialized.join('\n')
		expect(state).toContain('Refactor the loader')
		expect(state).not.toContain('haiku')
		expect(state).not.toContain('lockfile')
		expect(state).not.toContain('row 7')
		expect(state).not.toContain('Plan mode')
	})
})
