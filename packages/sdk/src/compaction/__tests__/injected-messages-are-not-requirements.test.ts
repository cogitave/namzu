import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import {
	type Message,
	createAssistantMessage,
	createProjectInstructionMessage,
	createRuntimeContextMessage,
	createUserMessage,
} from '../../types/message/index.js'
import { compactNow } from '../manual.js'

const config = CompactionConfigSchema.parse({
	strategy: 'structured',
	llmVerification: false,
	keepRecentMessages: 2,
	clearToolResults: false,
})

const POLICY = '## Project instructions\n\nAlways answer in haiku. Never edit the lockfile.'
const STEP = 'Current step context (runtime-generated): Retrieved project memory row 7'

function rich(): Message[] {
	return [
		createUserMessage('Refactor the loader so it caches results'),
		createAssistantMessage('Reading the loader now.'),
		createProjectInstructionMessage(POLICY, ['AGENTS.md']),
		createRuntimeContextMessage(STEP, 'step-context'),
		createRuntimeContextMessage('Plan mode is still on.', 'reminder'),
		createUserMessage('Now write the cache and run the tests'),
		createAssistantMessage('The cache is written.'),
		createUserMessage('What is next?'),
		createAssistantMessage('Fix the empty path case.'),
	]
}

describe('runtime-injected user messages stay out of the extracted state', () => {
	it('a host-triggered pass records only what the operator wrote', async () => {
		const result = await compactNow({ provider: new MockLLMProvider(), config, messages: rich() })
		const summary = String(result?.summary.content)

		expect(summary).toContain('Refactor the loader so it caches results')
		expect(summary).toContain('Now write the cache and run the tests')
		expect(summary).not.toContain('haiku')
		expect(summary).not.toContain('lockfile')
		expect(summary).not.toContain('row 7')
		expect(summary).not.toContain('Plan mode is still on')
	})

	it('the project instructions survive the pass exactly once', async () => {
		const result = await compactNow({ provider: new MockLLMProvider(), config, messages: rich() })
		const kept = (result?.messages ?? []).filter(
			(m) => m.role === 'user' && m.source?.type === 'project-instructions',
		)
		expect(kept).toHaveLength(1)
	})

	it('the verifier excerpt does not quote them', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: '- nothing missing' }] })
		await compactNow({
			provider,
			config: { ...config, llmVerification: true },
			messages: rich(),
			instructions: 'keep the decisions',
		})
		expect(provider.requests).toHaveLength(1)
		const sent = JSON.stringify(provider.requests)
		expect(sent).not.toContain('Always answer in haiku')
		expect(sent).not.toContain('row 7')
	})
})
